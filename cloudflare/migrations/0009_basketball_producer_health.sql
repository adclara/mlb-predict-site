-- Independent producer evidence; no prediction rows or model gates are changed.
CREATE TABLE IF NOT EXISTS basketball_producer_health (
  sport TEXT PRIMARY KEY CHECK(sport IN ('nba','wnba')),
  run_id TEXT NOT NULL,
  attempt_started_at TEXT NOT NULL,
  attempt_finished_at TEXT,
  attempt_status TEXT NOT NULL CHECK(attempt_status IN ('running','success','failed')),
  last_success_at TEXT,
  evidence_json TEXT
);
