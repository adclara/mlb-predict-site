-- D1 is the global authority for Radar Telegram quota/dedupe. KV remains a UI
-- projection and is deliberately not used for read-modify-write decisions.
CREATE TABLE IF NOT EXISTS poly_telegram_deliveries (
  reservation_id TEXT PRIMARY KEY,
  et_date TEXT NOT NULL,
  slot INTEGER,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'sent', 'failed', 'unknown')),
  reserved_at TEXT NOT NULL,
  sent_at TEXT,
  failed_at TEXT,
  telegram_message_id INTEGER,
  error TEXT,
  payload_hash TEXT NOT NULL,
  CHECK (
    (status IN ('reserved', 'sent', 'unknown') AND slot IN (1, 2))
    OR (status = 'failed' AND slot IS NULL)
  )
);

-- This physical invariant makes more than two active deliveries per ET day
-- impossible even when two cron invocations overlap.
CREATE UNIQUE INDEX IF NOT EXISTS uq_poly_tg_active_day_slot
  ON poly_telegram_deliveries (et_date, slot)
  WHERE status IN ('reserved', 'sent', 'unknown');

-- A reservation/ambiguous delivery for the same market can never race itself.
CREATE UNIQUE INDEX IF NOT EXISTS uq_poly_tg_one_open_dedupe
  ON poly_telegram_deliveries (dedupe_key)
  WHERE status IN ('reserved', 'unknown');

CREATE INDEX IF NOT EXISTS idx_poly_tg_sent_dedupe
  ON poly_telegram_deliveries (dedupe_key, sent_at)
  WHERE status = 'sent';
