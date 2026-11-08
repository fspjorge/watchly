-- Contador de execuções automáticas interrompidas (ex.: CPU 1102).
-- Default 0 preserva os monitores e snapshots existentes sem backfill destrutivo.
ALTER TABLE monitors ADD COLUMN consecutive_lease_failures INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_monitors_expired_lease
  ON monitors(lease_expires_at)
  WHERE lease_token IS NOT NULL;
