-- AA Sports audit report — reproducible SQLite materialization.
-- Run from the repository root with:
--   sqlite3 -json :memory: < docs/analysis/aa_sports_report_source.sql
-- Every value comes from aa_sports_audit_snapshot.json or is an explicit
-- rollout-policy label. These queries power the portable report datasets.

-- dataset: headline
WITH s(doc) AS (
  SELECT json(readfile('docs/analysis/aa_sports_audit_snapshot.json'))
)
SELECT
  CAST(json_extract(doc, '$.mlb.history.graded_v2') AS INTEGER) AS graded_v2,
  json_extract(doc, '$.mlb.lock_gate_market_agree5_starter_v1.test.rate') AS oro_test_rate,
  CAST(json_extract(doc, '$.mlb.lock_gate_market_agree5_starter_v1.test.n') AS INTEGER) AS oro_test_n,
  CAST(json_extract(doc, '$.mlb.market_lab_shadow_v1.over.gate_passes') AS INTEGER)
    + CAST(json_extract(doc, '$.mlb.market_lab_shadow_v1.f5.gate_passes') AS INTEGER)
    + CAST(json_extract(doc, '$.mlb.market_lab_shadow_v1.pitcher_f5.gate_passes') AS INTEGER)
    AS secondary_markets_ready,
  CAST(json_extract(doc, '$.radar.alert_snapshot_before_change.rare_v1_eligible_if_evaluated_now') AS INTEGER)
    AS telegram_eligible,
  CAST(json_extract(doc, '$.radar.rare_v1_policy.max_per_et_day') AS INTEGER) AS telegram_max_day
FROM s;

-- dataset: selection_comparison
WITH s(doc) AS (
  SELECT json(readfile('docs/analysis/aa_sports_audit_snapshot.json'))
), rows AS (
  SELECT 1 AS sort_order, 'AA global' AS segment,
    '$.mlb.global_forecast.aa_model' AS p, 'All priced v2 games' AS basis
  UNION ALL SELECT 2, 'Market global', '$.mlb.global_forecast.market', 'De-vig favorite, same games'
  UNION ALL SELECT 3, 'ORO production before change', '$.mlb.production_record_before_change.locks', 'Public live record'
  UNION ALL SELECT 4, 'ORO v1 · train', '$.mlb.lock_gate_market_agree5_starter_v1.train', 'Before June 13 cut'
  UNION ALL SELECT 5, 'ORO v1 · reserved test', '$.mlb.lock_gate_market_agree5_starter_v1.test', 'June 13 onward'
)
SELECT sort_order, segment,
  json_extract(doc, p || '.rate') AS rate,
  CAST(COALESCE(json_extract(doc, p || '.n'),
    json_extract(doc, p || '.wins') + json_extract(doc, p || '.losses')) AS INTEGER) AS n,
  CAST(json_extract(doc, p || '.wins') AS INTEGER) AS wins,
  CAST(json_extract(doc, p || '.losses') AS INTEGER) AS losses,
  json_extract(doc, p || '.wilson_lo') AS wilson_lo,
  json_extract(doc, p || '.wilson_hi') AS wilson_hi,
  basis
FROM s CROSS JOIN rows
ORDER BY sort_order;

-- dataset: market_lab
WITH s(doc) AS (
  SELECT json(readfile('docs/analysis/aa_sports_audit_snapshot.json'))
), markets(market, p, needed) AS (
  VALUES
    ('F5 team ahead', '$.mlb.market_lab_shadow_v1.f5', 'Real F5 price + interval above threshold'),
    ('Over', '$.mlb.market_lab_shadow_v1.over', '100+ forward decisions with opening line'),
    ('Pitcher/F5', '$.mlb.market_lab_shadow_v1.pitcher_f5', 'Real F5 price + interval above threshold')
)
SELECT market,
  printf('%d–%d (%.1f%%)', json_extract(doc, p || '.train.wins'),
    json_extract(doc, p || '.train.losses'), 100 * json_extract(doc, p || '.train.rate')) AS train_record,
  printf('%d–%d', json_extract(doc, p || '.test.wins'), json_extract(doc, p || '.test.losses')) AS test_record,
  json_extract(doc, p || '.test.rate') AS test_rate,
  printf('%.1f%%–%.1f%%', 100 * json_extract(doc, p || '.test.wilson_lo'),
    100 * json_extract(doc, p || '.test.wilson_hi')) AS test_ci,
  CAST(json_extract(doc, p || '.forward.n') AS INTEGER) AS forward_n,
  CASE json_extract(doc, p || '.gate_passes') WHEN 1 THEN 'YES' ELSE 'NO' END AS gate,
  needed
FROM s CROSS JOIN markets
ORDER BY market;

-- dataset: radar_evidence
WITH s(doc) AS (
  SELECT json(readfile('docs/analysis/aa_sports_audit_snapshot.json'))
)
SELECT 1 AS sort_order, 'Raw alerts in 24 hours' AS metric,
  printf('%d', json_extract(doc, '$.radar.alert_snapshot_before_change.alerts_last_24h')) AS value,
  'High-volume tape is noise, not a Telegram product.' AS interpretation FROM s
UNION ALL SELECT 2, 'Past–future wallet rank correlation',
  printf('ρ = %.3f (n=%s)', json_extract(doc, '$.radar.production_snapshot.honesty.spearman_past_vs_future'),
    printf('%,d', json_extract(doc, '$.radar.production_snapshot.honesty.n'))),
  'Past rank barely predicts future rank.' FROM s
UNION ALL SELECT 3, 'Delayed copy edge at 5 minutes',
  printf('%.3f/action', json_extract(doc, '$.radar.copy_study.copy_edge_5m_net')),
  'The replication gate fails.' FROM s
UNION ALL SELECT 4, 'Delayed copy edge at 60 minutes',
  printf('%.3f/action', json_extract(doc, '$.radar.copy_study.copy_edge_60m_net')),
  'Longer delay still loses in the study.' FROM s
UNION ALL SELECT 5, 'Current consensuses passing rare_v1',
  printf('%d of %d', json_extract(doc, '$.radar.alert_snapshot_before_change.rare_v1_eligible_if_evaluated_now'),
    json_extract(doc, '$.radar.alert_snapshot_before_change.consensus')),
  'Silence is the expected outcome when evidence is weak.' FROM s
ORDER BY sort_order;

-- dataset: rollout (explicit implementation policy, not a performance result)
WITH rollout(phase, scope, state, trigger, guardrail) AS (
  VALUES
    ('1 · Deploy', 'ORO v1 + Radar anti-noise + Telegram rare_v1', 'Ready after QA',
      'Merge and poke-deploy; poke daily robot', 'Zero is valid; no guarantee language'),
    ('2 · Forward shadow', 'Over + F5 + pitcher/F5', 'Private only',
      'Daily capture and grading', 'No frontend candidates or forced quota'),
    ('3 · Gate review', 'Secondary markets', 'Blocked today',
      '100+ forward decisions and real prices', 'Lower 95% bound above break-even'),
    ('4 · Live monitoring', 'ORO and rare_v1', 'Continuous',
      '30–50 new decisions / sufficient alert outcomes', 'Disable or keep shadow if the gate degrades')
)
SELECT * FROM rollout ORDER BY phase;
-- ARCHIVO SUPERADO: la auditoría causal posterior excluyó precios sin timestamp
-- y filas nativas mutables. Este replay no autoriza publicar ORO.
