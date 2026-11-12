import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkMonitor, performCheck, type UserRecord } from './api.ts';
import { dispatchEmailNotifications, MAX_EMAIL_ATTEMPTS, MAX_EMAILS_PER_UTC_DAY } from './emailNotifications.ts';
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
		'0004_expired_lease_backoff.sql', '0005_google_daily_usage.sql', '0006_email_notifications.sql', '0007_brevo_notification_events.sql', '0008_monitor_keywords.sql',
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
	BREVO_API_KEY: 'test-key', BREVO_SENDER_EMAIL: 'fspjorge@gmail.com', BREVO_SENDER_NAME: 'Watchly',
	WATCHLY_APP_URL: 'https://watchly.example.test',
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

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
		expect(event).toMatchObject({ user_id: OWNER.id, recipient_email: OWNER.email, monitor_name: 'Monitor <um>', status: 'pending', notification_type: 'change', source_url: 'https://example.test/' });
		expect(event?.snapshot_id).toBe(2);
		expect(event?.previous_snapshot_id).toBe(1);
	});

	it.each([
		{ name: 'initial', seed: false, html: '<p>same</p>', status: 200 },
		{ name: 'unchanged', seed: true, html: '<p>same</p>', status: 200 },
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
		expect(db.count("SELECT COUNT(*) AS total FROM email_notification_outbox WHERE notification_type = 'change'")).toBe(0);
	});

	it('enqueues one email on a new monitoring error incident with HTTP status', async () => {
		const db = database();
		vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
		expect((await performCheck(db, MONITOR, 'lease-1', emailEnv)).outcome).toBe('error');
		expect(await db.one<Record<string, unknown>>("SELECT * FROM email_notification_outbox WHERE notification_type = 'error'")).toMatchObject({
			user_id: OWNER.id, recipient_email: OWNER.email, source_url: 'https://example.test/', http_status: 403,
			error_description: 'A página devolveu o estado HTTP 403.',
		});
	});

	it('does not enqueue repeated notifications for consecutive failures, but rearms after recovery', async () => {
		const db = database();
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
			.mockResolvedValueOnce(new Response('still forbidden', { status: 403 }))
			.mockResolvedValueOnce(new Response('<p>recovered</p>', { status: 200 }))
			.mockResolvedValueOnce(new Response('again forbidden', { status: 403 }));
		vi.stubGlobal('fetch', fetchMock);
		for (let index = 0; index < 4; index += 1) {
			const lease = `incident-${index}`;
			await db.run('UPDATE monitors SET lease_token = ?, lease_expires_at = ? WHERE id = ?', [lease, NOW + 180, MONITOR]);
			await performCheck(db, MONITOR, lease, emailEnv);
			await db.run('UPDATE monitors SET lease_token = NULL, lease_expires_at = NULL WHERE id = ?', [MONITOR]);
		}
		expect(db.count("SELECT COUNT(*) AS total FROM email_notification_outbox WHERE notification_type = 'error'")).toBe(2);
	});

	it('does not enqueue when the owner disabled notifications', async () => {
		const db = database();
		await db.run('UPDATE users SET email_notifications_enabled = 0 WHERE id = ?', [OWNER.id]);
		await addSnapshot(db, 'old', 'old-hash');
		vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>new</p>', { status: 200 })));
		await performCheck(db, MONITOR, 'lease-1', emailEnv);
		expect(db.count('SELECT COUNT(*) AS total FROM email_notification_outbox')).toBe(0);
	});

	it('does not enqueue an error notification when the owner disabled email notifications', async () => {
		const db = database();
		await db.run('UPDATE users SET email_notifications_enabled = 0 WHERE id = ?', [OWNER.id]);
		vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
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

describe('Brevo outbox dispatcher', () => {
	const eventId = '550e8400-e29b-41d4-a716-446655440000';
	async function queuedEvent() {
		const db = database();
		await addSnapshot(db, 'old body', 'old-hash');
		const previous = await db.one<{ id: number }>('SELECT id FROM snapshots ORDER BY id DESC LIMIT 1');
		await addSnapshot(db, 'changed body', 'changed-hash');
		const current = await db.one<{ id: number }>('SELECT id FROM snapshots ORDER BY id DESC LIMIT 1');
		await db.run(
			`INSERT INTO email_notification_outbox
			 (id, event_key, notification_type, monitor_id, user_id, snapshot_id, previous_snapshot_id,
			  source_url, recipient_email, monitor_name, snapshot_captured_at, next_attempt_at)
			 VALUES (?, ?, 'change', ?, ?, ?, ?, 'https://example.test/', ?, 'Monitor <um>', '2026-11-08 10:00:00', ?)`,
			[eventId, eventId, MONITOR, OWNER.id, current!.id, previous!.id, OWNER.email, NOW],
		);
		return db;
	}

	async function addSentEvents(db: ReturnType<typeof database>, count: number, at: number): Promise<void> {
		const timestamp = new Date(at * 1000).toISOString();
		for (let index = 0; index < count; index += 1) {
			await addSnapshot(db, `sent-${at}-${index}`, `hash-${at}-${index}`, timestamp);
			const snapshot = await db.one<{ id: number }>('SELECT id FROM snapshots ORDER BY id DESC LIMIT 1');
			await db.run(
				`INSERT INTO email_notification_outbox
				 (id, event_key, notification_type, monitor_id, user_id, snapshot_id, source_url, recipient_email, monitor_name,
				  snapshot_captured_at, status, attempts, first_attempt_at, updated_at, sent_at)
				 VALUES (?, ?, 'change', ?, ?, ?, 'https://example.test/', ?, 'Sent', ?, 'sent', 1, ?, ?, ?)`,
				[crypto.randomUUID(), crypto.randomUUID(), MONITOR, OWNER.id, snapshot!.id, OWNER.email, timestamp, at, timestamp, timestamp],
			);
		}
	}

	it('sends the Brevo payload with api-key and marks sent only for HTTP 201 with messageId', async () => {
		const db = await queuedEvent();
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: '<brevo-id>' }), { status: 201 }));
		vi.stubGlobal('fetch', fetchMock);
		expect(await dispatchEmailNotifications(db, emailEnv, NOW, 1)).toMatchObject({ sent: 1 });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://api.brevo.com/v3/smtp/email');
		expect(new Headers(init.headers).get('api-key')).toBe(emailEnv.BREVO_API_KEY);
		expect(new Headers(init.headers).get('content-type')).toBe('application/json');
		const payload = JSON.parse(String(init.body));
		expect(payload.sender).toEqual({ name: 'Watchly', email: 'fspjorge@gmail.com' });
		expect(payload.to).toEqual([{ email: OWNER.email }]);
		expect(payload.headers.idempotencyKey).toBe(eventId);
		expect(payload.headers.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		expect(payload.htmlContent).toContain('Monitor &lt;um&gt;');
		expect(payload.htmlContent).not.toContain('Monitor <um>');
		expect(payload.htmlContent).toContain('https://example.test/');
		expect(payload.htmlContent).toContain('old body');
		expect(payload.htmlContent).toContain('changed body');
		expect(payload).not.toHaveProperty('textContent');
		expect((await db.one<{ status: string; attempts: number }>('SELECT status, attempts FROM email_notification_outbox')))
			.toMatchObject({ status: 'sent', attempts: 1 });
		expect(await db.one<{ message_id: string }>('SELECT message_id FROM email_notification_outbox'))
			.toEqual({ message_id: '<brevo-id>' });
	});

	it('sends an incident email with HTTP status and persists Brevo messageId', async () => {
		const db = database();
		await db.run(`INSERT INTO email_notification_outbox
			(id, event_key, notification_type, monitor_id, user_id, source_url, recipient_email,
			 monitor_name, snapshot_captured_at, http_status, error_description, next_attempt_at)
			VALUES ('error-event', 'error-event', 'error', ?, ?, 'https://example.test/', ?, 'Monitor',
			 '2026-11-09 10:00:00', 403, 'A página devolveu o estado HTTP 403.', ?)`,
		[MONITOR, OWNER.id, OWNER.email, NOW]);
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: 'brevo-error-id' }), { status: 201 }));
		vi.stubGlobal('fetch', fetchMock);
		await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		const payload = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
		expect(payload.subject).toContain('falha');
		expect(payload.htmlContent).toContain('HTTP 403');
		expect(payload.htmlContent).toContain('A página devolveu o estado HTTP 403.');
		expect(payload.htmlContent).toContain('https://example.test/');
		expect(payload).not.toHaveProperty('textContent');
		expect(await db.one<{ status: string; message_id: string }>(
			"SELECT status, message_id FROM email_notification_outbox WHERE id = 'error-event'",
		)).toEqual({ status: 'sent', message_id: 'brevo-error-id' });
	});

	it('retries Brevo failures with identical body and idempotency key', async () => {
		const db = await queuedEvent();
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response('{}', { status: 500 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ messageId: 'accepted' }), { status: 201 }));
		vi.stubGlobal('fetch', fetchMock);
		await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		const pending = await db.one<{ status: string; attempts: number; next_attempt_at: number; last_error: string }>(
			'SELECT status, attempts, next_attempt_at, last_error FROM email_notification_outbox',
		);
		expect(pending).toMatchObject({ status: 'pending', attempts: 1, last_error: 'BREVO_HTTP_500' });
		await dispatchEmailNotifications(db, emailEnv, pending!.next_attempt_at, 1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const first = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
		expect(first[1].body).toBe(second[1].body);
		expect(first[1].body).toBe(second[1].body);
		expect(JSON.parse(String(first[1].body)).headers.idempotencyKey).toBe(eventId);
		expect(JSON.parse(String(second[1].body)).headers.idempotencyKey).toBe(eventId);
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

	it.each([200, 401, 500])('records HTTP %s as a retryable provider error', async (status) => {
		const db = await queuedEvent();
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
		await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		expect(await db.one<{ status: string; last_error: string }>(
			'SELECT status, last_error FROM email_notification_outbox',
		)).toMatchObject({ status: 'pending', last_error: `BREVO_HTTP_${status}` });
	});

	it('stores only sanitized Brevo error code and message, never the API key or personal details', async () => {
		const db = await queuedEvent();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
			code: 'invalid_parameter',
			message: 'Invalid sender fspjorge@gmail.com; diagnostic test-key https://brevo.example/path?token=secret-value',
		}), { status: 400 })));
		await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		const row = await db.one<{ last_error: string }>('SELECT last_error FROM email_notification_outbox');
		expect(row?.last_error).toBe('BREVO_HTTP_400: invalid_parameter: Invalid sender [email]; diagnostic [redacted] [url]');
		expect(row?.last_error).not.toContain(emailEnv.BREVO_API_KEY);
		expect(row?.last_error).not.toContain('fspjorge@gmail.com');
		expect(row?.last_error).not.toContain('secret-value');
	});

	it('keeps the HTTP status diagnostic when the provider error body is invalid JSON', async () => {
		const db = await queuedEvent();
		vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 400 })));
		await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		expect(await db.one<{ last_error: string }>('SELECT last_error FROM email_notification_outbox'))
			.toEqual({ last_error: 'BREVO_HTTP_400' });
	});

	it('does not mark an HTTP 201 as sent without a messageId', async () => {
		const db = await queuedEvent();
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 201 })));
		await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		expect(await db.one<{ status: string; last_error: string }>(
			'SELECT status, last_error FROM email_notification_outbox',
		)).toMatchObject({ status: 'pending', last_error: 'BREVO_INVALID_SUCCESS_RESPONSE' });
	});

	it('does not retry a Brevo duplicate_parameter response', async () => {
		const db = await queuedEvent();
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'duplicate_parameter' }), { status: 409 }));
		vi.stubGlobal('fetch', fetchMock);
		await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		await dispatchEmailNotifications(db, emailEnv, NOW + 60, 1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await db.one<{ status: string; last_error: string }>(
			'SELECT status, last_error FROM email_notification_outbox',
		)).toEqual({ status: 'failed', last_error: 'BREVO_IDEMPOTENCY_KEY_ALREADY_USED' });
	});

	it('records timeouts and network failures without logging the API key', async () => {
		const db = await queuedEvent();
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(emailEnv.BREVO_API_KEY); }));
		await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		expect(await db.one<{ last_error: string }>('SELECT last_error FROM email_notification_outbox'))
			.toEqual({ last_error: 'BREVO_NETWORK_ERROR' });
		expect(log.mock.calls.flat().join(' ')).not.toContain(emailEnv.BREVO_API_KEY);

		const timeoutDb = await queuedEvent();
		vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError'); }));
		await dispatchEmailNotifications(timeoutDb, emailEnv, NOW, 1);
		expect(await timeoutDb.one<{ last_error: string }>('SELECT last_error FROM email_notification_outbox'))
			.toEqual({ last_error: 'BREVO_TIMEOUT' });
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

	it('marks an ambiguous event failed and does not retry after the 25-minute safety window', async () => {
		const db = await queuedEvent();
		const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
		vi.stubGlobal('fetch', fetchMock);
		await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		await dispatchEmailNotifications(db, emailEnv, NOW + 25 * 60 + 1, 1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await db.one<{ status: string; last_error: string }>(
			'SELECT status, last_error FROM email_notification_outbox',
		)).toEqual({ status: 'failed', last_error: 'BREVO_IDEMPOTENCY_WINDOW_EXPIRED' });
	});

	it('stops at 250 notifications per UTC day and leaves further events pending', async () => {
		const db = await queuedEvent();
		await addSentEvents(db, MAX_EMAILS_PER_UTC_DAY, NOW);
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const result = await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		expect(result.dailyLimitReached).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await db.one<{ status: string; attempts: number }>(
			"SELECT status, attempts FROM email_notification_outbox WHERE id = ?", [eventId],
		)).toEqual({ status: 'pending', attempts: 0 });
	});

	it('applies the daily limit atomically to concurrent reservations', async () => {
		const db = await queuedEvent();
		await addSentEvents(db, MAX_EMAILS_PER_UTC_DAY - 1, NOW);
		const secondId = '550e8400-e29b-41d4-a716-446655440001';
		await addSnapshot(db, 'another pending event', 'another-hash');
		const secondSnapshot = await db.one<{ id: number }>('SELECT id FROM snapshots ORDER BY id DESC LIMIT 1');
		await db.run(
			`INSERT INTO email_notification_outbox
			 (id, event_key, notification_type, monitor_id, user_id, snapshot_id, source_url,
			  recipient_email, monitor_name, snapshot_captured_at, next_attempt_at)
			 VALUES (?, ?, 'change', ?, ?, ?, 'https://example.test/', ?, 'Second', '2026-11-09 00:00:00', ?)`,
			[secondId, secondId, MONITOR, OWNER.id, secondSnapshot!.id, OWNER.email, NOW],
		);
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: 'accepted' }), { status: 201 }));
		vi.stubGlobal('fetch', fetchMock);
		const results = await Promise.all([
			dispatchEmailNotifications(db, emailEnv, NOW, 1),
			dispatchEmailNotifications(db, emailEnv, NOW, 1),
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(results.some((result) => result.dailyLimitReached)).toBe(true);
		expect(db.count("SELECT COUNT(*) AS total FROM email_notification_outbox WHERE status = 'sent' AND date(updated_at) = date(?, 'unixepoch')", [NOW])).toBe(MAX_EMAILS_PER_UTC_DAY);
		expect(db.count("SELECT COUNT(*) AS total FROM email_notification_outbox WHERE status = 'pending' AND attempts = 0")).toBe(1);
	});

	it('uses the quota anew at the next UTC date', async () => {
		const db = await queuedEvent();
		await addSentEvents(db, MAX_EMAILS_PER_UTC_DAY, NOW - 24 * 60 * 60);
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: 'accepted' }), { status: 201 }));
		vi.stubGlobal('fetch', fetchMock);
		const result = await dispatchEmailNotifications(db, emailEnv, NOW, 1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.sent).toBe(1);
	});
});
