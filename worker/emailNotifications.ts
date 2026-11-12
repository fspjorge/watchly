import type { Queryable } from './db.ts';

export type EmailNotificationEnv = {
	BREVO_API_KEY?: string;
	BREVO_SENDER_EMAIL?: string;
	BREVO_SENDER_NAME?: string;
	WATCHLY_APP_URL?: string;
};

type OutboxEvent = {
	id: string;
	lease_token: string;
	attempts: number;
	recipient_email: string;
	monitor_name: string;
	snapshot_captured_at: string;
	notification_type: 'change' | 'error';
	source_url: string;
	snapshot_id: number | null;
	previous_snapshot_id: number | null;
	http_status: number | null;
	error_description: string | null;
	app_url: string;
	from_email: string;
	from_name: string;
};

type EventContent = { content: string | null };

export const MAX_EMAILS_PER_CRON = 2;
export const MAX_EMAIL_ATTEMPTS = 5;
export const MAX_EMAILS_PER_UTC_DAY = 250;
const EMAIL_LEASE_SECONDS = 90;
const EMAIL_TIMEOUT_MS = 10_000;
export const BREVO_IDEMPOTENCY_WINDOW_SECONDS = 25 * 60;

function retryDelaySeconds(attempt: number): number {
	return Math.min(60 * 2 ** Math.max(0, attempt - 1), 6 * 60 * 60);
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[character] ?? character));
}

function safeAppUrl(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
		return url.toString().replace(/\/$/, '');
	} catch {
		return null;
	}
}

function safeFromEmail(value: string | undefined): string | null {
	const sender = value?.trim();
	if (!sender || sender.length > 254 || /[\r\n]/.test(sender)) return null;
	return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender) ? sender : null;
}

function notificationPayload(event: OutboxEvent, previousContent: string, newContent: string) {
	const appUrl = event.app_url;
	const htmlAppUrl = escapeHtml(appUrl);
	const name = escapeHtml(event.monitor_name);
	const captured = escapeHtml(event.snapshot_captured_at);
	const url = escapeHtml(event.source_url);
	const excerpt = (value: string) => value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
	if (event.notification_type === 'error') {
		const description = event.error_description ?? 'Falha de monitorização.';
		const status = event.http_status === null ? '' : ` (HTTP ${event.http_status})`;
		return {
			sender: { name: event.from_name, email: event.from_email },
			to: [{ email: event.recipient_email }],
			subject: `Watchly: falha na monitorização ${event.monitor_name.replace(/[\r\n]+/g, ' ').slice(0, 120)}`,
			htmlContent: `<p>A monitorização <strong>${name}</strong> falhou${escapeHtml(status)}.</p><p>URL: <a href="${url}">${url}</a></p><p>Erro: ${escapeHtml(description)}</p><p>Data: ${captured}</p><p><a href="${htmlAppUrl}/">Ver no Watchly</a></p>`,
			headers: { idempotencyKey: event.id },
		};
	}
	const oldExcerpt = excerpt(previousContent);
	const newExcerpt = excerpt(newContent);
	return {
		sender: { name: event.from_name, email: event.from_email },
		to: [{ email: event.recipient_email }],
		subject: `Watchly: alterações detectadas em ${event.monitor_name.replace(/[\r\n]+/g, ' ').slice(0, 120)}`,
		htmlContent: `<p>Foram detectadas alterações em <strong>${name}</strong>.</p><p>URL: <a href="${url}">${url}</a></p><p>Data: ${captured}</p><h3>Conteúdo anterior</h3><pre>${escapeHtml(oldExcerpt || '(indisponível)')}</pre><h3>Novo conteúdo</h3><pre>${escapeHtml(newExcerpt)}</pre><p><a href="${htmlAppUrl}/">Ver monitorização no Watchly</a></p>`,
		headers: { idempotencyKey: event.id },
	};
}

const MAX_PROVIDER_ERROR_LENGTH = 400;

function sanitizeProviderText(value: string, apiKey: string): string {
	let safe = value;
	if (apiKey) safe = safe.split(apiKey).join('[redacted]');
	return safe
		.replace(/xkeysib-[a-z\d_-]+/gi, '[redacted]')
		.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
		.replace(/https?:\/\/\S+/gi, '[url]')
		.replace(/\b[a-f\d]{32,}\b/gi, '[redacted]')
		.split('').map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 ? ' ' : character;
		}).join('')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_PROVIDER_ERROR_LENGTH);
}

async function brevoHttpError(response: Response, apiKey: string): Promise<{ error: string; code: string | null }> {
	let body: unknown;
	try { body = await response.json(); } catch { body = null; }
	const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : null;
	const rawCode = typeof record?.code === 'string' ? record.code : null;
	const code = rawCode ? sanitizeProviderText(rawCode, apiKey).replace(/[^a-z\d_.-]/gi, '').slice(0, 80) || null : null;
	const rawMessage = typeof record?.message === 'string' ? record.message : null;
	const message = rawMessage ? sanitizeProviderText(rawMessage, apiKey) : null;
	const detail = [code, message].filter((part): part is string => Boolean(part)).join(': ');
	return { error: `BREVO_HTTP_${response.status}${detail ? `: ${detail}` : ''}`, code };
}

async function loadEventContent(db: Queryable, event: OutboxEvent): Promise<[string, string]> {
	const [previous, current] = await Promise.all([
		event.previous_snapshot_id === null ? Promise.resolve(null)
			: db.one<EventContent>('SELECT content FROM snapshots WHERE id = ?', [event.previous_snapshot_id]),
		event.snapshot_id === null ? Promise.resolve(null)
			: db.one<EventContent>('SELECT content FROM snapshots WHERE id = ?', [event.snapshot_id]),
	]);
	return [previous?.content ?? '', current?.content ?? ''];
}

async function recordConfigurationIssue(db: Queryable, now: number, reason: string): Promise<void> {
	await db.run(
		`UPDATE email_notification_outbox
		 SET last_error = ?, next_attempt_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch')
		 WHERE status = 'pending' AND next_attempt_at <= ? AND attempts < ?`,
		[reason, now + 3600, now, now, MAX_EMAIL_ATTEMPTS],
	);
}

async function suppressDisabledEvents(db: Queryable, now: number): Promise<void> {
	await db.run(
		`UPDATE email_notification_outbox
		 SET status = 'failed', last_error = 'EMAIL_NOTIFICATIONS_DISABLED',
		     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch')
		 WHERE status = 'pending'
		   AND EXISTS (SELECT 1 FROM users u WHERE u.id = email_notification_outbox.user_id
		               AND u.email_notifications_enabled = 0)`,
		[now],
	);
}

async function claimNext(
	db: Queryable,
	now: number,
	appUrl: string,
	fromEmail: string,
	fromName: string,
): Promise<OutboxEvent | null> {
	const token = crypto.randomUUID();
	const attemptedToday = `(SELECT COUNT(*) FROM email_notification_outbox used
		WHERE used.attempts > 0 AND date(used.updated_at) = date(?, 'unixepoch'))`;
	return db.one<OutboxEvent>(
		`UPDATE email_notification_outbox
		 SET status = 'sending', lease_token = ?, lease_expires_at = ?,
		     attempts = attempts + 1, app_url = COALESCE(app_url, ?),
		     from_email = COALESCE(from_email, ?), from_name = COALESCE(from_name, ?),
		     first_attempt_at = COALESCE(first_attempt_at, ?),
		     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch')
		 WHERE id = (
		   SELECT e.id FROM email_notification_outbox e
		   JOIN users u ON u.id = e.user_id
		   WHERE u.email_notifications_enabled = 1 AND e.attempts < ?
		     AND ((e.status = 'pending' AND e.next_attempt_at <= ?)
		       OR (e.status = 'sending' AND e.lease_expires_at <= ?))
		     AND ((e.attempts > 0 AND date(e.updated_at) = date(?, 'unixepoch')) OR ${attemptedToday} < ?)
		   ORDER BY e.next_attempt_at ASC, e.created_at ASC LIMIT 1
		 )
		 AND attempts < ?
		 AND ((status = 'pending' AND next_attempt_at <= ?)
		   OR (status = 'sending' AND lease_expires_at <= ?))
		RETURNING id, lease_token, attempts, recipient_email, monitor_name,
		          snapshot_captured_at, notification_type, source_url, snapshot_id,
		          previous_snapshot_id, http_status, error_description, app_url,
		          from_email, from_name`,
		[
			token, now + EMAIL_LEASE_SECONDS, appUrl, fromEmail, fromName, now, now,
			MAX_EMAIL_ATTEMPTS, now, now, now, now, MAX_EMAILS_PER_UTC_DAY,
			MAX_EMAIL_ATTEMPTS, now, now,
		],
	);
}

async function finishAttempt(
	db: Queryable,
	event: OutboxEvent,
	now: number,
	status: 'sent' | 'pending' | 'failed',
	errorCode: string | null,
	messageId?: string | null,
): Promise<void> {
	const sentAt = status === 'sent' ? new Date(now * 1000).toISOString() : null;
	const nextAttemptAt = status === 'pending' ? now + retryDelaySeconds(event.attempts) : now;
	await db.run(
		`UPDATE email_notification_outbox
		 SET status = ?, last_error = ?, next_attempt_at = ?, sent_at = COALESCE(?, sent_at),
		     message_id = COALESCE(?, message_id),
		     lease_token = NULL, lease_expires_at = NULL,
		     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch')
		 WHERE id = ? AND status = 'sending' AND lease_token = ? AND lease_expires_at > ?`,
		[status, errorCode, nextAttemptAt, sentAt, messageId ?? null, now, event.id, event.lease_token, now],
	);
}

async function dailyLimitReached(db: Queryable, now: number): Promise<boolean> {
	const row = await db.one<{ used: number }>(
		`SELECT COUNT(*) AS used FROM email_notification_outbox
		 WHERE attempts > 0 AND date(updated_at) = date(?, 'unixepoch')`,
		[now],
	);
	return (row?.used ?? 0) >= MAX_EMAILS_PER_UTC_DAY;
}

/** Sends a bounded number of due outbox events; failures never escape into the scheduler. */
export async function dispatchEmailNotifications(
	db: Queryable,
	env: EmailNotificationEnv,
	now = Math.floor(Date.now() / 1000),
	limit = MAX_EMAILS_PER_CRON,
): Promise<{ sent: number; failed: number; deferred: number }> {
	const stats: { sent: number; failed: number; deferred: number; dailyLimitReached?: boolean } = {
		sent: 0, failed: 0, deferred: 0,
	};
	try {
		await suppressDisabledEvents(db, now);
		// A worker killed during a provider call must not leave an exhausted event in `sending` forever.
		await db.run(
			`UPDATE email_notification_outbox
			 SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
			     last_error = 'MAX_ATTEMPTS_REACHED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch')
			 WHERE status = 'sending' AND lease_expires_at <= ? AND attempts >= ?`,
			[now, now, MAX_EMAIL_ATTEMPTS],
		);
		// Brevo retains these UUIDv4 keys for 30 minutes. Stop at 25 minutes
		// so an ambiguous send is never retried outside the provider's window.
		await db.run(
			`UPDATE email_notification_outbox
			 SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
			     last_error = 'BREVO_IDEMPOTENCY_WINDOW_EXPIRED',
			     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch')
			 WHERE attempts > 0 AND first_attempt_at <= ?
			   AND (status = 'pending' OR (status = 'sending' AND lease_expires_at <= ?))`,
			[now, now - BREVO_IDEMPOTENCY_WINDOW_SECONDS, now],
		);
		const appUrl = safeAppUrl(env.WATCHLY_APP_URL);
		const fromEmail = safeFromEmail(env.BREVO_SENDER_EMAIL);
		const fromName = env.BREVO_SENDER_NAME?.trim();
		const apiKey = env.BREVO_API_KEY?.trim();
		if (!apiKey || !fromEmail || !fromName || fromName.length > 100 || /[\r\n]/.test(fromName) || !appUrl) {
			const reason = !apiKey || !env.BREVO_SENDER_EMAIL || !fromName || !env.WATCHLY_APP_URL
				? 'EMAIL_CONFIGURATION_MISSING'
				: 'EMAIL_CONFIGURATION_INVALID';
			await recordConfigurationIssue(db, now, reason);
			return stats;
		}

		for (let index = 0; index < Math.min(Math.max(0, limit), MAX_EMAILS_PER_CRON); index += 1) {
			const event = await claimNext(db, now, appUrl, fromEmail, fromName);
			if (!event) {
				if (await dailyLimitReached(db, now)) {
					stats.dailyLimitReached = true;
					console.log(JSON.stringify({ emailDispatcher: 'daily_limit_reached', limit: MAX_EMAILS_PER_UTC_DAY }));
				}
				break;
			}
			const [previousContent, newContent] = await loadEventContent(db, event);
			const payload = notificationPayload(event, previousContent, newContent);
			let status: 'sent' | 'failed' = 'failed';
			let errorCode: string | null = null;
			let messageId: string | null = null;
			let terminalProviderError = false;
			try {
				const response = await fetch('https://api.brevo.com/v3/smtp/email', {
					method: 'POST',
					headers: {
						'api-key': apiKey,
						'content-type': 'application/json',
					},
					body: JSON.stringify(payload),
					signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
				});
				if (response.status === 201) {
					let result: unknown;
					try { result = await response.json(); } catch { result = null; }
					if (typeof result === 'object' && result !== null &&
						typeof (result as { messageId?: unknown }).messageId === 'string' &&
						(result as { messageId: string }).messageId.length > 0) {
						status = 'sent';
						messageId = (result as { messageId: string }).messageId.slice(0, 255);
					}
					else errorCode = 'BREVO_INVALID_SUCCESS_RESPONSE';
				} else {
					const providerError = await brevoHttpError(response, apiKey);
					errorCode = providerError.error;
					if (response.status === 409 && providerError.code === 'duplicate_parameter') {
						errorCode = 'BREVO_IDEMPOTENCY_KEY_ALREADY_USED';
						terminalProviderError = true;
					}
				}
			} catch (error) {
				errorCode = error instanceof Error && error.name === 'TimeoutError'
					? 'BREVO_TIMEOUT'
					: 'BREVO_NETWORK_ERROR';
			}
			if (status === 'sent') {
				await finishAttempt(db, event, now, 'sent', null, messageId);
				stats.sent += 1;
			} else {
				const nextStatus = terminalProviderError || event.attempts >= MAX_EMAIL_ATTEMPTS ? 'failed' : 'pending';
				await finishAttempt(db, event, now, nextStatus, errorCode);
				if (nextStatus === 'failed') stats.failed += 1;
				else stats.deferred += 1;
			}
		}
	} catch (error) {
		// Do not log provider responses, credentials, recipient addresses, or payloads.
		console.error(
			'email dispatcher failed',
			error instanceof Error ? `${error.name}: ${error.message.slice(0, 160)}` : 'unknown',
		);
	}
	return stats;
}
