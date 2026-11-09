-- Preferências de notificação e outbox transaccional por snapshot alterado.
-- Opt-in explícito: contas existentes e novas começam com notificações desligadas.
ALTER TABLE users
    ADD COLUMN email_notifications_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (email_notifications_enabled IN (0, 1));

CREATE TABLE email_notification_outbox (
    id TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snapshot_id INTEGER NOT NULL UNIQUE REFERENCES snapshots(id) ON DELETE CASCADE,
    recipient_email TEXT NOT NULL,
    monitor_name TEXT NOT NULL,
    snapshot_captured_at TEXT NOT NULL,
    app_url TEXT,
    from_email TEXT,
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
    last_error TEXT
);

CREATE INDEX idx_email_outbox_due
    ON email_notification_outbox (status, next_attempt_at, created_at);
CREATE INDEX idx_email_outbox_user
    ON email_notification_outbox (user_id, created_at DESC);
