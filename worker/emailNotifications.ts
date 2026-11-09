import type { Queryable } from './db.ts';

export type EmailNotificationEnv = {
	RESEND_API_KEY?: string;
	RESEND_FROM_EMAIL?: string;
	WATCHLY_APP_URL?: string;
};

type OutboxEvent = {
	id: string;
	lease_token: string;
	attempts: number;
	recipient_email: string;
	monitor_name: string;
	snapshot_captured_at: string;
	app_url: string;
	from_email: string;
};

export const MAX_EMAILS_PER_CRON = 2;
export const MAX_EMAIL_ATTEMPTS = 5;
const EMAIL_LEASE_SECONDS = 90;
const EMAIL_TIMEOUT_MS = 10_000;

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
	return /^(?:[^<>]*<)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(sender) ? sender : null;
}

function notificationPayload(event: OutboxEvent) {
	const appUrl = event.app_url;
	const htmlAppUrl = escapeHtml(appUrl);
	const name = escapeHtml(event.monitor_name);
	const captured = escapeHtml(event.snapshot_captured_at);
	const link = `${appUrl}/`;
	return {
		from: event.from_email,
		to: [event.recipient_email],
		subject: `Watchly: alterações detectadas em ${event.monitor_name.replace(/[\r\n]+/g, ' ').slice(0, 120)}`,
		text: `Foram detectadas alterações em "${event.monitor_name}".\n\nVer monitorização: ${link}\nData: ${event.snapshot_captured_at}`,
		html: `<p>Foram detectadas alterações em <strong>${name}</strong>.</p><p><a href="${htmlAppUrl}/">Ver monitorização no Watchly</a></p><p>Data: ${captured}</p>`,
	};
}

async function recordConfigurationIssue(db: Queryable, now: number, reason: string): Promise<void> {
	await db.run(
		`UPDATE email_notification_outbox
		 SET last_error = ?, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP
		 WHERE status = 'pending' AND next_attempt_at <= ? AND attempts < ?`,
		[reason, now + 3600, now, MAX_EMAIL_ATTEMPTS],
	);
}

async function suppressDisabledEvents(db: Queryable): Promise<void> {
	await db.run(
		`UPDATE email_notification_outbox
		 SET status = 'failed', last_error = 'EMAIL_NOTIFICATIONS_DISABLED',
		     updated_at = CURRENT_TIMESTAMP
		 WHERE status = 'pending'
		   AND EXISTS (SELECT 1 FROM users u WHERE u.id = email_notification_outbox.user_id
		               AND u.email_notifications_enabled = 0)`,
	);
}

async function claimNext(
	db: Queryable,
	now: number,
	appUrl: string,
	fromEmail: string,
): Promise<OutboxEvent | null> {
	const token = crypto.randomUUID();
	return db.one<OutboxEvent>(
		`UPDATE email_notification_outbox
		 SET status = 'sending', lease_token = ?, lease_expires_at = ?,
		     attempts = attempts + 1, app_url = COALESCE(app_url, ?),
		     from_email = COALESCE(from_email, ?), first_attempt_at = COALESCE(first_attempt_at, ?),
		     updated_at = CURRENT_TIMESTAMP
		 WHERE id = (
		   SELECT e.id FROM email_notification_outbox e
		   JOIN users u ON u.id = e.user_id
		   WHERE u.email_notifications_enabled = 1 AND e.attempts < ?
		     AND ((e.status = 'pending' AND e.next_attempt_at <= ?)
		       OR (e.status = 'sending' AND e.lease_expires_at <= ?))
		   ORDER BY e.next_attempt_at ASC, e.created_at ASC LIMIT 1
		 )
		 AND attempts < ?
		 AND ((status = 'pending' AND next_attempt_at <= ?)
		   OR (status = 'sending' AND lease_expires_at <= ?))
		RETURNING id, lease_token, attempts, recipient_email, monitor_name,
		          snapshot_captured_at, app_url, from_email`,
		[token, now + EMAIL_LEASE_SECONDS, appUrl, fromEmail, now, MAX_EMAIL_ATTEMPTS, now, now, MAX_EMAIL_ATTEMPTS, now, now],
	);
}

async function finishAttempt(
	db: Queryable,
	event: OutboxEvent,
	now: number,
	status: 'sent' | 'pending' | 'failed',
	errorCode: string | null,
): Promise<void> {
	const sentAt = status === 'sent' ? new Date(now * 1000).toISOString() : null;
	const nextAttemptAt = status === 'pending' ? now + retryDelaySeconds(event.attempts) : now;
	await db.run(
		`UPDATE email_notification_outbox
		 SET status = ?, last_error = ?, next_attempt_at = ?, sent_at = COALESCE(?, sent_at),
		     lease_token = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
		 WHERE id = ? AND status = 'sending' AND lease_token = ? AND lease_expires_at > ?`,
		[status, errorCode, nextAttemptAt, sentAt, event.id, event.lease_token, now],
	);
}

/** Sends a bounded number of due outbox events; failures never escape into the scheduler. */
export async function dispatchEmailNotifications(
	db: Queryable,
	env: EmailNotificationEnv,
	now = Math.floor(Date.now() / 1000),
	limit = MAX_EMAILS_PER_CRON,
): Promise<{ sent: number; failed: number; deferred: number }> {
	const stats = { sent: 0, failed: 0, deferred: 0 };
	try {
		await suppressDisabledEvents(db);
		// A worker killed during a provider call must not leave an exhausted event in `sending` forever.
		await db.run(
			`UPDATE email_notification_outbox
			 SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
			     last_error = 'MAX_ATTEMPTS_REACHED', updated_at = CURRENT_TIMESTAMP
			 WHERE status = 'sending' AND lease_expires_at <= ? AND attempts >= ?`,
			[now, MAX_EMAIL_ATTEMPTS],
		);
		// Resend retains idempotency keys for 24 h. Stop retries with margin
		// before expiry so an ambiguous prior send cannot become a duplicate.
		await db.run(
			`UPDATE email_notification_outbox
			 SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
			     last_error = 'IDEMPOTENCY_WINDOW_EXPIRED', updated_at = CURRENT_TIMESTAMP
			 WHERE attempts > 0 AND first_attempt_at <= ?
			   AND (status = 'pending' OR (status = 'sending' AND lease_expires_at <= ?))`,
			[now - 23 * 60 * 60, now],
		);
		const appUrl = safeAppUrl(env.WATCHLY_APP_URL);
		const fromEmail = safeFromEmail(env.RESEND_FROM_EMAIL);
		const apiKey = env.RESEND_API_KEY?.trim();
		if (!apiKey || !fromEmail || !appUrl) {
			const reason = !apiKey || !env.RESEND_FROM_EMAIL || !env.WATCHLY_APP_URL
				? 'EMAIL_CONFIGURATION_MISSING'
				: 'EMAIL_CONFIGURATION_INVALID';
			await recordConfigurationIssue(db, now, reason);
			return stats;
		}

		for (let index = 0; index < Math.min(Math.max(0, limit), MAX_EMAILS_PER_CRON); index += 1) {
			const event = await claimNext(db, now, appUrl, fromEmail);
			if (!event) break;
			const payload = notificationPayload(event);
			let status: 'sent' | 'failed' = 'failed';
			let errorCode: string | null = null;
			try {
				const response = await fetch('https://api.resend.com/emails', {
					method: 'POST',
					headers: {
						authorization: `Bearer ${apiKey}`,
						'content-type': 'application/json',
						'idempotency-key': `watchly-notification-${event.id}`,
					},
					body: JSON.stringify(payload),
					signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
				});
				if (!response.ok) errorCode = `RESEND_HTTP_${response.status}`;
				else status = 'sent';
			} catch (error) {
				errorCode = error instanceof Error && error.name === 'TimeoutError'
					? 'RESEND_TIMEOUT'
					: 'RESEND_NETWORK_ERROR';
			}
			if (status === 'sent') {
				await finishAttempt(db, event, now, 'sent', null);
				stats.sent += 1;
			} else {
				const nextStatus = event.attempts >= MAX_EMAIL_ATTEMPTS ? 'failed' : 'pending';
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
