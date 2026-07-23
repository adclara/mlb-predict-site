-- Shared factual ingestion for NFL, FBS college football, NHL and men's
-- Division-I college basketball. Model code never runs in the Worker.
CREATE TABLE IF NOT EXISTS sports_ingest_slots (
  sport TEXT NOT NULL CHECK (sport IN ('nfl', 'ncaaf', 'nhl', 'ncaam')),
  slot_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  source TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  n_games INTEGER NOT NULL CHECK (n_games >= 0),
  missingness TEXT NOT NULL,
  payload TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (sport, slot_id)
);

CREATE INDEX IF NOT EXISTS idx_sports_ingest_latest
  ON sports_ingest_slots (sport, scheduled_at DESC);

-- One event can hold both a winner and a total. Predictions are written only
-- by the private model repository after its public gate is explicitly opened.
CREATE TABLE IF NOT EXISTS sports_predictions (
  sport TEXT NOT NULL CHECK (sport IN ('nfl', 'ncaaf', 'nhl', 'ncaam')),
  date TEXT NOT NULL,
  event_id TEXT NOT NULL,
  selection_key TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('moneyline', 'total')),
  pick TEXT,
  side TEXT,
  line REAL,
  price REAL,
  market_prob REAL,
  prob REAL,
  confidence TEXT,
  league TEXT,
  home TEXT,
  away TEXT,
  start_time TEXT,
  feature_as_of TEXT,
  status TEXT,
  result TEXT CHECK (result IS NULL OR result IN ('win', 'loss', 'push', 'void')),
  engine_version TEXT NOT NULL,
  gate_version TEXT NOT NULL,
  public_scope TEXT NOT NULL DEFAULT 'shadow' CHECK (public_scope IN ('shadow', 'public')),
  invalidated INTEGER NOT NULL DEFAULT 0 CHECK (invalidated IN (0, 1)),
  invalidated_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sport, date, event_id, selection_key)
);

CREATE INDEX IF NOT EXISTS idx_sports_predictions_slate
  ON sports_predictions (sport, date, public_scope, status);

CREATE INDEX IF NOT EXISTS idx_sports_predictions_market_result
  ON sports_predictions (sport, market, result);
