-- One fail-closed ledger for every modeled market. New writers start in
-- `shadow`; the Worker only exposes rows explicitly promoted to `public` by a
-- passed gate and a separate human approval.
CREATE TABLE IF NOT EXISTS sport_market_predictions (
  sport TEXT NOT NULL CHECK (sport IN ('mlb', 'wnba', 'nfl', 'ncaaf', 'nhl', 'ncaam')),
  date TEXT NOT NULL,
  event_id TEXT NOT NULL,
  market_key TEXT NOT NULL CHECK (market_key IN ('winner', 'total', 'player_prop', 'combo')),
  selection_key TEXT NOT NULL,
  family TEXT,
  player_id TEXT,
  player_name TEXT,
  pick TEXT,
  side TEXT,
  line REAL,
  price REAL,
  market_prob REAL,
  prob REAL,
  edge REAL,
  projection REAL,
  combo_json TEXT,
  league TEXT,
  home TEXT,
  away TEXT,
  start_time TEXT,
  feature_as_of TEXT,
  frozen_at TEXT,
  status TEXT,
  result TEXT CHECK (result IS NULL OR result IN ('win', 'loss', 'push', 'void')),
  engine_version TEXT NOT NULL,
  gate_version TEXT NOT NULL,
  public_scope TEXT NOT NULL DEFAULT 'shadow' CHECK (public_scope IN ('shadow', 'public')),
  gate_passed INTEGER NOT NULL DEFAULT 0 CHECK (gate_passed IN (0, 1)),
  human_approved INTEGER NOT NULL DEFAULT 0 CHECK (human_approved IN (0, 1)),
  invalidated INTEGER NOT NULL DEFAULT 0 CHECK (invalidated IN (0, 1)),
  invalidated_reason TEXT,
  source_hash TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sport, date, event_id, market_key, selection_key)
);

CREATE INDEX IF NOT EXISTS idx_sport_market_slate
  ON sport_market_predictions (sport, date, market_key, public_scope, status);

CREATE INDEX IF NOT EXISTS idx_sport_market_gate
  ON sport_market_predictions (sport, market_key, gate_passed, human_approved, result);
