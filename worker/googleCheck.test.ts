import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, checkMonitor, type MonitorRow } from './api.ts';
import { SqliteQueryable, applyMigrationFile } from './testSupport.ts';
import { runScheduler } from './scheduler.ts';
import { reserveGoogleDailyRequest } from './googleQuota.ts';
import { ApiError } from './api.ts';
import {
	checkWithGoogle,
	configuredCheckEngine,
	GoogleCheckError,
	type CheckEngineEnv,
} from './googleCheck.ts';
import type { UserRecord } from './auth.ts';

const secret = 'unit-test-secret-never-logged';
const env: CheckEngineEnv = {
	CHECK_ENGINE: 'google',
	CLOUD_RUN_URL: 'https://watchly-test-uc.a.run.app',
	WATCHLY_HMAC_SECRET: secret,
};
const content = 'conteúdo normalizado';
const hash = 'a'.repeat(64);
const monitorId = '9250a15e-1111-4a10-9e1a-111111111111';
const success = {
	outcome: 'initial', message: 'Referência inicial criada.', content, contentHash: hash,
	httpStatus: 200, contentType: 'text/html; charset=utf-8',
	metrics: { durationMs: 7, fetchMs: 3, extractMs: 1, normalizeMs: 1, hashMs: 1, bytesReceived: 128 },
};

function response(data: unknown, status = 200): Response {
	return new Response(typeof data === 'string' ? data : JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Cloud Run engine adapter', () => {
	it('defaults to Cloudflare and selects Google only from environment configuration', () => {
		expect(configuredCheckEngine({})).toBe('cloudflare');
		expect(configuredCheckEngine({ CHECK_ENGINE: 'google' })).toBe('google');
		expect(() => configuredCheckEngine({ CHECK_ENGINE: 'other' })).toThrow(GoogleCheckError);
	});

	it('signs the exact UTF-8 request body bytes and sends those same bytes', async () => {
		let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined;
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			captured = { input, init };
			return response(success);
		}));
		await checkWithGoogle('https://example.com/path?q=1', env);
		const requestBody = captured?.init?.body;
		expect(requestBody).toBeInstanceOf(Uint8Array);
		const bytes = requestBody as Uint8Array;
		expect(new TextDecoder().decode(bytes)).toBe('{"url":"https://example.com/path?q=1"}');
		const timestamp = new Headers(captured?.init?.headers).get('x-watchly-timestamp')!;
		const providedSignature = new Headers(captured?.init?.headers).get('x-watchly-signature')!;
		const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const prefix = new TextEncoder().encode(`${timestamp}\n`);
		const signedBytes = new Uint8Array(prefix.length + bytes.length);
		signedBytes.set(prefix);
		signedBytes.set(bytes, prefix.length);
		const expected = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, signedBytes)),
			(byte) => byte.toString(16).padStart(2, '0')).join('');
		expect(providedSignature).toBe(expected);
		expect(new URL(captured!.input.toString()).pathname).toBe('/v1/check');
		expect(captured?.init?.method).toBe('POST');
	});

	it('accepts a well-formed Cloud Run response and returns only normalized content/hash', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => response(success)));
		expect(await checkWithGoogle('https://example.com', env)).toEqual({ content, contentHash: hash });
	});

	it.each([401, 500])('rejects HTTP %s without parsing it as a valid result', async (status) => {
		vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'nope' }, status)));
		await expect(checkWithGoogle('https://example.com', env)).rejects.toThrow(`HTTP ${status}`);
	});

	it('reports a timeout without exposing request credentials', async () => {
		vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
		})));
		await expect(checkWithGoogle('https://example.com', { ...env, CLOUD_RUN_TIMEOUT_MS: '2' }))
			.rejects.toThrow('Timeout ao contactar');
	});

	it('rejects invalid JSON and incomplete/invalid result fields', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => response('{not json')));
		await expect(checkWithGoogle('https://example.com', env)).rejects.toThrow('JSON inválida');
		vi.stubGlobal('fetch', vi.fn(async () => response({ ...success, contentHash: 'bad' })));
		await expect(checkWithGoogle('https://example.com', env)).rejects.toThrow('Resposta inválida');
	});

	it('fails closed when secret or endpoint configuration is missing', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		await expect(checkWithGoogle('https://example.com', { ...env, WATCHLY_HMAC_SECRET: undefined }))
			.rejects.toThrow('WATCHLY_HMAC_SECRET');
		expect(fetchMock).not.toHaveBeenCalled();
		await expect(checkWithGoogle('https://example.com', { ...env, CLOUD_RUN_URL: undefined }))
			.rejects.toThrow('CLOUD_RUN_URL');
	});
});

describe('Worker engine integration under lease', () => {
	function database(): ReturnType<typeof SqliteQueryable.open> {
		const db = SqliteQueryable.open();
		for (const migration of ['0001_initial_schema.sql', '0002_multiuser_ownership.sql', '0003_scheduled_checks.sql', '0004_expired_lease_backoff.sql', '0005_google_daily_usage.sql', '0006_email_notifications.sql']) {
			applyMigrationFile(db, migration);
		}
		db.run('INSERT INTO users (id, auth_subject, email) VALUES (?, ?, ?)', ['u1', 'sub1', 'u1@example.test']);
		db.run(`INSERT INTO monitors (id, name, url, user_id, last_status)
			VALUES (?, ?, ?, ?, 'pending')`, [monitorId, 'Monitor', 'https://example.com/', 'u1']);
		return db;
	}
	const user: UserRecord = { id: 'u1', auth_subject: 'sub1', email: 'u1@example.test', name: null, created_at: '', last_login_at: null, email_notifications_enabled: 1 };

	it('uses Cloudflare by default and retains its existing persistence path', async () => {
		const db = database();
		const network = vi.fn(async () => new Response('<p>local cloudflare engine</p>', { status: 200, headers: { 'content-type': 'text/html' } }));
		vi.stubGlobal('fetch', network);
		const result = await checkMonitor(db, user, monitorId);
		expect(result.outcome).toBe('initial');
		expect(network).toHaveBeenCalledTimes(1);
		expect(db.count('SELECT COUNT(*) AS total FROM google_daily_usage')).toBe(0);
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots')).toBe(1);
		const state = await db.one<Pick<MonitorRow, 'last_status'> & { lease_token: string | null }>(
			'SELECT last_status, lease_token FROM monitors WHERE id = ?', [monitorId]);
		expect(state).toMatchObject({ last_status: 'unchanged', lease_token: null });
	});

	it('Google executes after lease acquisition and Worker persists its result in D1', async () => {
		const db = database();
		const contentHash = await sha256Hex(content);
		const googleResponse = { ...success, contentHash };
		let leaseWasHeldDuringRequest = false;
		const call = vi.fn(async () => {
			leaseWasHeldDuringRequest = (await db.one<{ lease_token: string | null }>(
				'SELECT lease_token FROM monitors WHERE id = ?', [monitorId]))?.lease_token !== null;
			return response(googleResponse);
		});
		vi.stubGlobal('fetch', call);
		const result = await checkMonitor(db, user, monitorId, env);
		expect(result.outcome).toBe('initial');
		expect(call).toHaveBeenCalledTimes(1);
		expect(leaseWasHeldDuringRequest).toBe(true);
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots')).toBe(1);
		const snapshot = await db.one<{ content: string; content_hash: string }>(
			'SELECT content, content_hash FROM snapshots WHERE monitor_id = ?', [monitorId]);
		expect(snapshot).toEqual({ content, content_hash: contentHash });
		const state = await db.one<{ lease_token: string | null; last_status: string }>(
			'SELECT lease_token, last_status FROM monitors WHERE id = ?', [monitorId]);
		expect(state).toEqual({ lease_token: null, last_status: 'unchanged' });
	});

	it('scheduled checks use Google after the D1 lease and keep D1 persistence authoritative', async () => {
		const db = database();
		const now = Math.floor(Date.now() / 1000);
		await db.run('UPDATE monitors SET frequency_minutes = 15, next_check_at = ? WHERE id = ?', [now - 1, monitorId]);
		const contentHash = await sha256Hex(content);
		let leaseWasHeldDuringRequest = false;
		vi.stubGlobal('fetch', vi.fn(async () => {
			leaseWasHeldDuringRequest = (await db.one<{ lease_token: string | null }>(
				'SELECT lease_token FROM monitors WHERE id = ?', [monitorId]))?.lease_token !== null;
			return response({ ...success, contentHash });
		}));
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const stats = await runScheduler(db, now, env);
		expect(stats.checked).toBe(1);
		expect(leaseWasHeldDuringRequest).toBe(true);
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots')).toBe(1);
		const state = await db.one<{ lease_token: string | null; last_status: string; next_check_at: number }>(
			'SELECT lease_token, last_status, next_check_at FROM monitors WHERE id = ?', [monitorId]);
		expect(state?.lease_token).toBeNull();
		expect(state?.last_status).toBe('unchanged');
		expect(state?.next_check_at).toBeGreaterThan(now);
	});

	it('Cloud Run failure records the existing error outcome, releases the lease, and never falls back', async () => {
		const db = database();
		const call = vi.fn(async () => response({ error: 'unauthorized' }, 401));
		vi.stubGlobal('fetch', call);
		const result = await checkMonitor(db, user, monitorId, env);
		expect(result.outcome).toBe('error');
		expect(call).toHaveBeenCalledTimes(1);
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots')).toBe(0);
		const state = await db.one<{ lease_token: string | null; last_status: string }>(
			'SELECT lease_token, last_status FROM monitors WHERE id = ?', [monitorId]);
		expect(state).toEqual({ lease_token: null, last_status: 'error' });
		expect(await db.one<{ request_count: number }>(
			'SELECT request_count FROM google_daily_usage WHERE utc_date = ?', [new Date().toISOString().slice(0, 10)]))
			.toEqual({ request_count: 1 });
	});

	it('limite atingido liberta o lease, mantém pending e não chama Google nem fallback', async () => {
		const db = database();
		await reserveGoogleDailyRequest(db, 1);
		const network = vi.fn();
		vi.stubGlobal('fetch', network);
		await expect(checkMonitor(db, user, monitorId, { ...env, GOOGLE_DAILY_LIMIT: '1' }))
			.rejects.toMatchObject({ status: 429, message: 'GOOGLE_DAILY_LIMIT_REACHED' } satisfies Partial<ApiError>);
		expect(network).not.toHaveBeenCalled();
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots')).toBe(0);
		const state = await db.one<{ lease_token: string | null; last_status: string; last_error: string; last_checked_at: string | null }>(
			'SELECT lease_token, last_status, last_error, last_checked_at FROM monitors WHERE id = ?', [monitorId]);
		expect(state).toEqual({
			lease_token: null, last_status: 'pending', last_error: 'GOOGLE_DAILY_LIMIT_REACHED', last_checked_at: null,
		});
		expect(db.count('SELECT request_count AS total FROM google_daily_usage')).toBe(1);
	});

	it('HTTP 500 da Cloud Run consome uma reserva diária e não repete automaticamente', async () => {
		const db = database();
		const network = vi.fn(async () => response({ error: 'failure' }, 500));
		vi.stubGlobal('fetch', network);
		const result = await checkMonitor(db, user, monitorId, { ...env, GOOGLE_DAILY_LIMIT: '3' });
		expect(result.outcome).toBe('error');
		expect(network).toHaveBeenCalledTimes(1);
		expect(db.count('SELECT request_count AS total FROM google_daily_usage')).toBe(1);
	});

	it('timeout remoto consome a reserva diária', async () => {
		const db = database();
		vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
		})));
		const result = await checkMonitor(db, user, monitorId, { ...env, GOOGLE_DAILY_LIMIT: '3', CLOUD_RUN_TIMEOUT_MS: '1' });
		expect(result.outcome).toBe('error');
		expect(db.count('SELECT request_count AS total FROM google_daily_usage')).toBe(1);
	});

	it('falha de processamento indicada pelo Cloud Run consome a reserva', async () => {
		const db = database();
		const network = vi.fn(async () => response({
			outcome: 'error', message: 'Falha remota de processamento.', metrics: success.metrics,
		}));
		vi.stubGlobal('fetch', network);
		const result = await checkMonitor(db, user, monitorId, { ...env, GOOGLE_DAILY_LIMIT: '3' });
		expect(result.outcome).toBe('error');
		expect(network).toHaveBeenCalledTimes(1);
		expect(db.count('SELECT request_count AS total FROM google_daily_usage')).toBe(1);
	});

	it('scheduler pára verificações Google do resto do dia sem adquirir leases', async () => {
		const db = database();
		const now = Math.floor(Date.now() / 1000);
		await db.run('UPDATE monitors SET frequency_minutes = 15, next_check_at = ? WHERE id = ?', [now - 1, monitorId]);
		await reserveGoogleDailyRequest(db, 1);
		const network = vi.fn();
		vi.stubGlobal('fetch', network);
		const stats = await runScheduler(db, now, { ...env, GOOGLE_DAILY_LIMIT: '1' });
		expect(stats.quotaLimited).toBe(true);
		expect(stats.inspected).toBe(0);
		expect(network).not.toHaveBeenCalled();
		const state = await db.one<{ lease_token: string | null; next_check_at: number }>(
			'SELECT lease_token, next_check_at FROM monitors WHERE id = ?', [monitorId]);
		expect(state).toEqual({ lease_token: null, next_check_at: now - 1 });
	});

	it('scheduler retoma pendentes no novo dia UTC após a quota de ontem', async () => {
		const db = database();
		const now = Math.floor(Date.now() / 1000);
		await db.run('UPDATE monitors SET frequency_minutes = 15, next_check_at = ? WHERE id = ?', [now - 1, monitorId]);
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		await db.run('INSERT INTO google_daily_usage (utc_date, request_count) VALUES (?, 1)', [yesterday]);
		const contentHash = await sha256Hex(content);
		const network = vi.fn(async () => response({ ...success, contentHash }));
		vi.stubGlobal('fetch', network);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const stats = await runScheduler(db, now, { ...env, GOOGLE_DAILY_LIMIT: '1' });
		expect(stats.checked).toBe(1);
		expect(network).toHaveBeenCalledTimes(1);
		expect(await db.one<{ utc_date: string; request_count: number }>(
			'SELECT utc_date, request_count FROM google_daily_usage WHERE utc_date = ?', [new Date().toISOString().slice(0, 10)]))
			.toEqual({ utc_date: new Date().toISOString().slice(0, 10), request_count: 1 });
	});
});
