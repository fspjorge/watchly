
-- Páginas que o utilizador pretende monitorizar
CREATE TABLE monitors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_checked_at TEXT,
    last_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT
);

-- Versões do conteúdo recolhido
CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (monitor_id)
        REFERENCES monitors(id)
        ON DELETE CASCADE
);

-- Facilita a consulta das versões de cada página
CREATE INDEX idx_snapshots_monitor
ON snapshots (monitor_id, captured_at DESC);
