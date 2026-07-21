-- One event may have distinct public selections (for example Over plus an ML
-- lock), so the track record cannot share the one-row-per-event predictions
-- table. This ledger stores one row per factual selection/market identity.
CREATE TABLE IF NOT EXISTS mlb_public_picks (
  date TEXT NOT NULL,
  event_id TEXT NOT NULL,
  selection_key TEXT NOT NULL,
  market TEXT NOT NULL,
  pick TEXT,
  side TEXT,
  line REAL,
  home TEXT,
  away TEXT,
  prob REAL,
  price REAL,
  confidence TEXT,
  public_play INTEGER NOT NULL DEFAULT 0 CHECK (public_play IN (0, 1)),
  public_lock INTEGER NOT NULL DEFAULT 0 CHECK (public_lock IN (0, 1)),
  public_gem INTEGER NOT NULL DEFAULT 0 CHECK (public_gem IN (0, 1)),
  result TEXT CHECK (result IS NULL OR result IN ('win', 'loss', 'push', 'void')),
  posted_at TEXT,
  start_time TEXT,
  engine_version TEXT,
  source_scope TEXT NOT NULL,
  invalidated INTEGER NOT NULL DEFAULT 0 CHECK (invalidated IN (0, 1)),
  invalidated_reason TEXT,
  updated_at TEXT,
  PRIMARY KEY (date, event_id, selection_key)
);

CREATE INDEX IF NOT EXISTS idx_mlb_public_picks_active_date
  ON mlb_public_picks (invalidated, date DESC);
