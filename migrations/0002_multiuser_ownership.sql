-- 0002_multiuser_ownership.sql
-- Evolução multiutilizador:
--   - nova tabela users (identidade por auth_subject do Cloudflare Access);
--   - monitors.user_id (temporariamente nullable para os registos antigos);
--   - snapshots.source_url (preserva o URL que deu origem a cada versão);
--   - backfill do source_url dos snapshots existentes a partir do monitor;
--   - índices de consulta por proprietário e por URL.
-- NÃO altera nem apaga dados existentes: IDs, hashes, conteúdos e datas
-- dos snapshots são preservados.

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    auth_subject TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT
);

-- Pesquisa de email sem distinção entre maiúsculas/minúsculas.
-- Os emails são também guardados normalizados, mas o índice garante
-- correcto funcionamento caso venham a ser guardados com caixa original.
CREATE INDEX idx_users_email_lower
ON users (LOWER(email));

-- Propriedade das monitorizações.
-- Coluna temporariamente nullable: os registos criados antes da migração
-- não têm proprietário. O backend nunca associa registos sem proprietário
-- a utilizadores que não sejam LEGACY_OWNER_EMAIL.
ALTER TABLE monitors
    ADD COLUMN user_id TEXT
    REFERENCES users(id)
    ON DELETE CASCADE;

CREATE INDEX idx_monitors_user
ON monitors (user_id, created_at);

-- URL que deu origem a cada snapshot (necessário para comparar apenas
-- versões recolhidas do mesmo endereço, mesmo depois de editar o URL).
ALTER TABLE snapshots
    ADD COLUMN source_url TEXT;

CREATE INDEX idx_snapshots_monitor_url
ON snapshots (monitor_id, source_url, captured_at DESC);

-- backfill: dá a cada snapshot antigo o URL actual do respectivo monitor.
UPDATE snapshots
SET source_url = (
    SELECT monitors.url
    FROM monitors
    WHERE monitors.id = snapshots.monitor_id
)
WHERE source_url IS NULL;
