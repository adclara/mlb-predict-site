-- The old KV-only Worker can still be finishing one scheduled invocation while
-- the new D1-authoritative Worker deploys. Keep the new sender silent for the
-- first 24 hours, then inherit the legacy daily counter from KV. This closes
-- the only cross-version overlap where neither implementation could see the
-- other's reservation.
CREATE TABLE IF NOT EXISTS poly_telegram_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cutover_at TEXT NOT NULL
);

INSERT OR IGNORE INTO poly_telegram_policy (id, cutover_at)
VALUES (1, datetime('now'));
