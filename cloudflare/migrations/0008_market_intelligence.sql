-- Compact provider-neutral snapshots. One JSON row per 30-minute slot avoids
-- per-trade D1 writes while preserving an immutable forward audit trail.
CREATE TABLE IF NOT EXISTS market_intelligence_snapshots (
  slot_at TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('fresh', 'degraded', 'stale')),
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  kv_writes INTEGER NOT NULL CHECK (kv_writes BETWEEN 0 AND 120),
  d1_rows INTEGER NOT NULL CHECK (d1_rows BETWEEN 0 AND 5000),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_intelligence_date
  ON market_intelligence_snapshots (date, slot_at DESC);

CREATE TABLE IF NOT EXISTS cross_sport_combo_ledger (
  date TEXT NOT NULL,
  combo_id TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  start_time TEXT NOT NULL,
  legs_json TEXT NOT NULL,
  joint_prob REAL,
  independence_prob REAL,
  ci_low REAL,
  ci_high REAL,
  result TEXT CHECK (result IS NULL OR result IN ('win', 'loss', 'void')),
  engine_version TEXT NOT NULL,
  gate_version TEXT NOT NULL,
  public_scope TEXT NOT NULL DEFAULT 'shadow' CHECK (public_scope IN ('shadow', 'public')),
  gate_passed INTEGER NOT NULL DEFAULT 0 CHECK (gate_passed IN (0, 1)),
  human_approved INTEGER NOT NULL DEFAULT 0 CHECK (human_approved IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, combo_id)
);

CREATE INDEX IF NOT EXISTS idx_cross_sport_combo_gate
  ON cross_sport_combo_ledger (public_scope, gate_passed, human_approved, result);
