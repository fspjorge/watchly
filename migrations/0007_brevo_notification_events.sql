-- Generaliza a outbox existente para alterações e novos incidentes de erro.
-- Preserva os registos existentes como notificações de alteração.
CREATE TABLE email_notification_outbox_v2 (
    id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    notification_type TEXT NOT NULL CHECK (notification_type IN ('change', 'error')),
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snapshot_id INTEGER REFERENCES snapshots(id) ON DELETE CASCADE,
    previous_snapshot_id INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
    source_url TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    monitor_name TEXT NOT NULL,
    snapshot_captured_at TEXT NOT NULL,
    http_status INTEGER,
    error_description TEXT,
    app_url TEXT,
    from_email TEXT,
    from_name TEXT,
    message_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    first_attempt_at INTEGER,
    next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT,
    lease_token TEXT,
    lease_expires_at INTEGER,
    last_error TEXT,
    CHECK ((notification_type = 'change' AND snapshot_id IS NOT NULL)
        OR (notification_type = 'error' AND snapshot_id IS NULL))
);

INSERT INTO email_notification_outbox_v2 (
    id, event_key, notification_type, monitor_id, user_id, snapshot_id,
    previous_snapshot_id, source_url, recipient_email, monitor_name,
    snapshot_captured_at, app_url, from_email, status, attempts,
    first_attempt_at, next_attempt_at, created_at, updated_at, sent_at,
    lease_token, lease_expires_at, last_error
)
SELECT old.id, old.id, 'change', old.monitor_id, old.user_id, old.snapshot_id,
       NULL, s.source_url, old.recipient_email, old.monitor_name,
       old.snapshot_captured_at, old.app_url, old.from_email, old.status,
       old.attempts, old.first_attempt_at, old.next_attempt_at, old.created_at,
       old.updated_at, old.sent_at, old.lease_token, old.lease_expires_at,
       old.last_error
FROM email_notification_outbox old
JOIN snapshots s ON s.id = old.snapshot_id;

DROP TABLE email_notification_outbox;
ALTER TABLE email_notification_outbox_v2 RENAME TO email_notification_outbox;

CREATE INDEX idx_email_outbox_due
    ON email_notification_outbox (status, next_attempt_at, created_at);
CREATE INDEX idx_email_outbox_user
    ON email_notification_outbox (user_id, created_at DESC);
