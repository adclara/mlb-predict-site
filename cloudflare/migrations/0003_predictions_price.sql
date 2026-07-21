-- Public MLB units must use the American price captured with the selection.
-- Existing production databases already have `predictions`; the CREATE makes
-- this migration reproducible on a fresh local D1 before adding the new column.
CREATE TABLE IF NOT EXISTS predictions (
  sport TEXT NOT NULL,
  date TEXT NOT NULL,
  event_id TEXT NOT NULL,
  league TEXT,
  start_time TEXT,
  status TEXT,
  home TEXT,
  away TEXT,
  pick TEXT,
  prob REAL,
  confidence TEXT,
  engine_version TEXT,
  result TEXT,
  updated_at TEXT,
  market_prob REAL,
  PRIMARY KEY (sport, date, event_id)
);

ALTER TABLE predictions ADD COLUMN price REAL;
