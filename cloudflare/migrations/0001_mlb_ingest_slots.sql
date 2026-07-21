-- Capturas compactas de hechos públicos MLB cada 20 minutos.
-- Una fila por slot hace el proceso idempotente y limita el volumen en D1.
CREATE TABLE IF NOT EXISTS mlb_ingest_slots (
  slot_id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'error')),
  stage TEXT NOT NULL CHECK (stage IN ('early', 'pregame', 'live', 'final')),
  source_mask INTEGER NOT NULL CHECK (source_mask BETWEEN 0 AND 3),
  sources TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  n_games INTEGER NOT NULL CHECK (n_games >= 0),
  missingness TEXT NOT NULL,
  payload TEXT NOT NULL,
  error TEXT
);

-- La captura borra por fecha todo lo anterior a la ventana de retención.
CREATE INDEX IF NOT EXISTS idx_mlb_ingest_slots_scheduled_at
  ON mlb_ingest_slots (scheduled_at);
