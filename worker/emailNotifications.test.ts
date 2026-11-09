import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkMonitor, performCheck, type UserRecord } from './api.ts';
import { dispatchEmailNotifications, MAX_EMAIL_ATTEMPTS } from './emailNotifications.ts';
import { runScheduler } from './scheduler.ts';
import { SqliteQueryable, applyMigrationFile } from './testSupport.ts';

const MONITOR = '52c0e46a-5f32-4b90-bb8d-8a67b0808a01';
const NOW = Math.floor(Date.now() / 1000);
const OWNER: UserRecord = {
	id: 'owner-1', auth_subject: 'sub-1', email: 'owner@example.test', name: null,
	created_at: '', last_login_at: null, email_notifications_enabled: 1,
};

function database() {
	const db = SqliteQueryable.open();
	for (const file of [
		'0001_initial_schema.sql', '0002_multiuser_ownership.sql', '0003_scheduled_checks.sql',
		'0004_expired_lease_backoff.sql', '0005_google_daily_usage.sql', '0006_email_notifications.sql',
	]) applyMigrationFile(db, file);
	db.run('INSERT INTO users (id, auth_subject, email, email_notifications_enabled) VALUES (?, ?, ?, 1)', [OWNER.id, OWNER.auth_subject, OWNER.email]);
	db.run(
		`INSERT INTO monitors (id, name, url, user_id, last_status, lease_token, lease_expires_at)
		 VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
		[MONITOR, 'Monitor <um>', 'https://example.test/', OWNER.id, 'lease-1', NOW + 180],
	);
	return db;
}

async function addSnapshot(db: ReturnType<typeof database>, content: string, hash: string, captured = '2026-11-08 10:00:00') {
	await db.run(
		'INSERT INTO snapshots (monitor_id, source_url, content, content_hash, captured_at) VALUES (?, ?, ?, ?, ?)',
		[MONITOR, 'https://example.test/', content, hash, captured],
	);
}

const emailEnv = {
	RESEND_API_KEY: 'test-key', RESEND_FROM_EMAIL: 'Watchly <watchly@example.test>',
	WATCHLY_APP_URL: 'https://watchly.example.test',
};

afterEach(() => vi.unstubAllGlobals());

describe('atomic outbox from check persistence', () => {
	it('creates one owner-bound notification only for changed snapshots', async () => {
		const db = database();
		await addSnapshot(db, 'old', 'old-hash');
		vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>new contents</p>', { status: 200 })));

		const result = await performCheck(db, MONITOR, 'lease-1', emailEnv);
		expect(result.outcome).toBe('changed');
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots WHERE monitor_id = ?', [MONITOR])).toBe(2);
		expect(db.count('SELECT COUNT(*) AS total FROM email_notification_outbox WHERE monitor_id = ?', [MONITOR])).toBe(1);
		const event = await db.one<Record<string, unknown>>('SELECT * FROM email_notification_outbox');
		expect(event).toMatchObject({ user_id: OWNER.id, recipient_email: OWNER.email, monitor_name: 'Monitor <um>', status: 'pending' });
		expect(event?.snapshot_id).toBe(2);
	});

	it.each([
		{ name: 'initial', seed: false, html: '<p>same</p>', status: 200 },
		{ name: 'unchanged', seed: true, html: '<p>same</p>', status: 200 },
		{ name: 'error', seed: true, html: '<p>failure</p>', status: 500 },
	])('does not enqueue for $name outcomes', async ({ seed, html, status }) => {
		const db = database();
		if (seed) await addSnapshot(db, 'same', await (async () => {
			// Hash the extracted content using the same shared Worker hash implementation.
			const { sha256Hex } = await import('./api.ts');
			return sha256Hex('same');
		})());
		vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status })));
		const result = await performCheck(db, MONITOR, 'lease-1', emailEnv);
		expect(result.outcome).toBe(seed && status === 200 ? 'unchanged' : seed ? 'error' : 'initial');
		expect(db.count('SELECT COUNT(*) AS total FROM email_notification_outbox')).toBe(0);
	});

	it('does not enqueue when the owner disabled notifications', async () => {
		const db = database();
		await db.run('UPDATE users SET email_notifications_enabled = 0 WHERE id = ?', [OWNER.id]);
		await addSnapshot(db, 'old', 'old-hash');
		vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>new</p>', { status: 200 })));
		await performCheck(db, MONITOR, 'lease-1', emailEnv);
		expect(db.count('SELECT COUNT(*) AS total FROM email_notification_outbox')).toBe(0);
	});

	it('rejects a stale lease without persisting either snapshot or notification', async () => {
		const db = database();
		await addSnapshot(db, 'old', 'old-hash');
		vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>stale result</p>', { status: 200 })));
		await expect(performCheck(db, MONITOR, 'lease-from-old-executor', emailEnv)).rejects.toThrow();
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots WHERE monitor_id = ?', [MONITOR])).toBe(1);
		expect(db.count('SELECT COUNT(*) AS total FROM email_notification_outbox')).toBe(0);
	});

	it('rolls back the snapshot when transactional outbox insertion fails', async () => {
		const db = database();
		await addSnapshot(db, 'old', 'old-hash');
		db.exec(`CREATE TRIGGER reject_outbox BEFORE INSERT ON email_notification_outbox
			BEGIN SELECT RAISE(ABORT, 'forced test failure'); END;`);
		vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>new contents</p>', { status: 200 })));
		await expect(performCheck(db, MONITOR, 'lease-1', emailEnv)).rejects.toThrow();
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots WHERE monitor_id = ?', [MONITOR])).toBe(1);
		expect(db.count('SELECT COUNT(*) AS total FROM email_notification_outbox')).toBe(0);
		expect((await db.one<{ last_status: string }>('SELECT last_status FROM monitors WHERE id = ?', [MONITOR]))?.last_status).toBe('pending');
	});

	it('enqueues from a changed manual check through the shared persistence path', async () => {
		const db = database();
		await addSnapshot(db, 'old', 'old-hash');
		await db.run('UPDATE monitors SET lease_token = NULL, lease_expires_at = NULL WHERE id = ?', [MONITOR]);
		vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>manual changed</p>', { status: 200 })));
		expect((await checkMonitor(db, OWNER, MONITOR, emailEnv)).outcome).toBe('changed');
		expect(db.count('SELECT COUNT(*) AS total FROM email_notification_outbox')).toBe(1);
	});

	it('enqueues from a changed scheduled check through the shared persistence path', async () => {
		const db = database();
		await addSnapshot(db, 'old', 'old-hash');
		await db.run(
			'UPDATE monitors SET lease_token = NULL, lease_expires_at = NULL, frequency_minutes = 15, next_check_at = ? WHERE id = ?',
			[NOW - 1, MONITOR],
		);
		vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>cron changed</p>', { status: 200 })));
		expect((await runScheduler(db, NOW, emailEnv)).checked).toBe(1);
		expect(db.count('SELECT COUNT(*) AS total FROM email_notification_outbox')).toBe(1);
	});
});

describe('Resend outbox dispatcher', () => {
	async function queuedEvent() {
		const db = database();
		await addSnapshot(db, 'changed', 'changed-hash');
		await db.run(
			`INSERT INTO email_notification_outbox
			 (id, monitor_id, user_id, snapshot_id, recipient_email, monitor_name, snapshot_captured_at)
			 VALUES ('event-1', ?, ?, 1, ?, 'Monitor <um>', '2026-11-08 10:00:00')`,
			[MONITOR, OWNER.id, OWNER.email],
		);
		return db;
	}

	it('sends once and marks sent; escapes HTML and uses stable idempotency key', async () => {
		const db = await queuedEvent();
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		expect(await dispatchEmailNotifications(db, emailEnv, NOW, 1)).toMatchObject({ sent: 1 });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://api.resend.com/emails');
		expect(new Headers(init.headers).get('idempotency-key')).toBe('watchly-notification-event-1');
		const payload = JSON.parse(String(init.body));
		expect(payload.to).toEqual([OWNER.email]);
		expect(payload.html).toContain('Monitor &lt;um&gt;');
		expect(payload.html).not.toContain('Monitor <um>');
		expect((await db.one<{ status: string; attempts: number }>('SELECT status, attempts FROM email_notification_outbox')))
			.toMatchObject({ status: 'sent', attempts: 1 });
	});

	it('retries provider failures with identical body and idempotency key', async () => {
		const db = await queuedEvent();
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response('{}', { status: 500 }))
			.mockResolvedValueOnce(new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		const pending = await db.one<{ status: string; attempts: number; next_attempt_at: number; last_error: string }>(
			'SELECT status, attempts, next_attempt_at, last_error FROM email_notification_outbox',
		);
		expect(pending).toMatchObject({ status: 'pending', attempts: 1, last_error: 'RESEND_HTTP_500' });
		await dispatchEmailNotifications(db, emailEnv, pending!.next_attempt_at, 1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const first = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
		expect(first[1].body).toBe(second[1].body);
		expect(new Headers(first[1].headers).get('idempotency-key')).toBe(new Headers(second[1].headers).get('idempotency-key'));
	});

	it('does not send or consume an attempt when configuration is missing', async () => {
		const db = await queuedEvent();
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		await dispatchEmailNotifications(db, {}, NOW);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await db.one<{ status: string; attempts: number; last_error: string }>(
			'SELECT status, attempts, last_error FROM email_notification_outbox',
		)).toMatchObject({ status: 'pending', attempts: 0, last_error: 'EMAIL_CONFIGURATION_MISSING' });
	});

	it('atomically claims due events so concurrent Cron dispatchers cannot send twice', async () => {
		const db = await queuedEvent();
		let unblock!: () => void;
		let markStarted!: () => void;
		const wait = new Promise<void>((resolve) => { unblock = resolve; });
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const fetchMock = vi.fn(async () => { markStarted(); await wait; return new Response('{}', { status: 200 }); });
		vi.stubGlobal('fetch', fetchMock);
		const first = dispatchEmailNotifications(db, emailEnv, NOW, 1);
		await started;
		const second = dispatchEmailNotifications(db, emailEnv, NOW, 1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		unblock();
		await Promise.all([first, second]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('retries no more than the configured maximum', async () => {
		const db = await queuedEvent();
		const fetchMock = vi.fn(async () => new Response('{}', { status: 503 }));
		vi.stubGlobal('fetch', fetchMock);
		let now = NOW;
		for (let i = 0; i < MAX_EMAIL_ATTEMPTS; i += 1) {
			await dispatchEmailNotifications(db, emailEnv, now, 1);
			const row = await db.one<{ status: string; next_attempt_at: number }>('SELECT status, next_attempt_at FROM email_notification_outbox');
			if (row?.status !== 'pending') break;
			now = row.next_attempt_at;
		}
		expect(fetchMock).toHaveBeenCalledTimes(MAX_EMAIL_ATTEMPTS);
		expect(await db.one<{ status: string }>('SELECT status FROM email_notification_outbox')).toEqual({ status: 'failed' });
	});

	it('stops an ambiguous retry before Resend idempotency retention expires', async () => {
		const db = await queuedEvent();
		const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
		vi.stubGlobal('fetch', fetchMock);
		await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		await dispatchEmailNotifications(db, emailEnv, NOW + 23 * 60 * 60, 1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await db.one<{ status: string; last_error: string }>(
			'SELECT status, last_error FROM email_notification_outbox',
		)).toEqual({ status: 'failed', last_error: 'IDEMPOTENCY_WINDOW_EXPIRED' });
	});
});
