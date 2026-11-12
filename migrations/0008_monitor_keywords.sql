-- Keywords opcionais usadas para filtrar alterações relevantes por monitor.
-- A string vazia preserva o comportamento existente: todas as alterações contam.
ALTER TABLE monitors
    ADD COLUMN keywords TEXT NOT NULL DEFAULT '';
