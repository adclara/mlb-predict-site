import test from 'node:test'
import assert from 'node:assert/strict'

import { backtestWnbaPlayerWinner, createWnbaPlayerWinnerForecaster } from '../robot/wnba_player_winner.mjs'

const report = backtestWnbaPlayerWinner({ write: false })

test('WNBA player-aware winner challenger is causal and nearly complete', () => {
  assert.equal(report.schema, 'aa_wnba_player_aware_winner_v1')
  assert.equal(report.method.current_game_leakage, false)
  assert.equal(report.data_audit.timestamp_violations, 0)
  assert.ok(report.data_audit.match_coverage > .99)
  assert.ok(report.data_audit.both_team_feature_coverage > .95)
  assert.ok(report.data_audit.player_rows > 25_000)
})

test('WNBA player signal improves rolling selection but remains shadow on probability gate', () => {
  assert.ok(report.selected.brier < report.elo_rolling_2023_2025.brier)
  assert.ok(report.player_aware_selection.heldout_2026.n >= 100)
  assert.ok(report.player_aware_selection.heldout_2026.accuracy
    >= report.player_aware_selection.elo_only_heldout_2026.accuracy)
  assert.equal(report.gate.public, false)
  assert.equal(report.gate.approved, false)
  assert.equal(report.gate.reason, 'forward_sample_pending')
})

test('WNBA operational challenger emits only a private, covered forward probability', () => {
  const forecaster = createWnbaPlayerWinnerForecaster()
  const prediction = forecaster.predict({ home: 'NY', away: 'IND' }, 0.6)
  assert.ok(prediction)
  assert.ok(prediction.home_prob > 0 && prediction.home_prob < 1)
  assert.ok(prediction.home_coverage >= 0.5)
  assert.ok(prediction.away_coverage >= 0.5)
  assert.equal(prediction.public, false)
  assert.equal(forecaster.public, false)
  assert.equal(forecaster.predict({ home: 'UNKNOWN', away: 'IND' }, 0.6), null)
})
