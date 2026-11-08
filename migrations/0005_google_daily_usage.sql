-- Quota global diária de invocações Cloud Run, por dia UTC.
-- Mantém uma contagem independente por data e não altera dados existentes.
CREATE TABLE google_daily_usage (
    utc_date TEXT PRIMARY KEY,
    request_count INTEGER NOT NULL CHECK (request_count >= 0)
);
