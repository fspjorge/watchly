-- 0003_scheduled_checks.sql
-- Verificações automáticas:
--   - frequency_minutes: frequência configurada da monitorização, em minutos.
--     NULL = manual (sem verificações automáticas). Valores válidos:
--     15, 30, 60, 360, 720 e 1440 — a validação é feita pelo Worker.
--   - next_check_at: próxima verificação agendada, em epoch unix (segundos
--     UTC). NULL = nada agendado (manual, ou verificação já em curso sem
--     frequência aplicável).
--   - lease_expires_at / lease_token: reserva de apropriação. Só existe
--     durante uma verificação em curso; expira após o TTL do lease
--     (definido pelo Worker) e o token garante que apenas o executor que
--     a adquiriu a pode libertar ou finalizar.
-- NÃO altera nem apaga dados existentes: os monitores antigos ficam com
-- todas as colunas novas a NULL (comportamento manual, tal como antes).

ALTER TABLE monitors
    ADD COLUMN frequency_minutes INTEGER;

ALTER TABLE monitors
    ADD COLUMN next_check_at INTEGER;

ALTER TABLE monitors
    ADD COLUMN lease_expires_at INTEGER;

ALTER TABLE monitors
    ADD COLUMN lease_token TEXT;

-- Selector do agendador: poucos índices de linha para as monitorizações
-- com verificação agendada.
CREATE INDEX idx_monitors_due
ON monitors (next_check_at)
WHERE next_check_at IS NOT NULL;
