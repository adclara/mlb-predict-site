import test from 'node:test'
import assert from 'node:assert/strict'
import { backtestWnbaMarkets, createWnbaTotalForecaster } from '../robot/wnba_market_model.mjs'

const report = backtestWnbaMarkets({ write: false })

test('WNBA totals challenger is causal, measured and remains fail-closed', () => {
  assert.equal(report.schema, 'aa_multisport_simulation_v1')
  assert.deepEqual(report.burn_in, ['2021', '2022'])
  assert.equal(report.total.historical.n, 1091)
  assert.ok(report.total.historical.mae > 0)
  assert.ok(report.total.historical.baseline_mae > 0)
  assert.equal(report.total.market_line_coverage, 0)
  assert.equal(report.total.gate.public, false)
  assert.equal(report.total.gate.reason, 'market_lines_unavailable')
})

test('WNBA player challengers use causal box scores but remain closed without real prop lines', () => {
  for (const family of ['pts', 'reb', 'ast']) {
    assert.ok(report.players[family].historical.n > 1000)
    assert.equal(report.players[family].historical.timestamp_violations, 0)
    assert.equal(report.players[family].market_line_coverage, 0)
    assert.equal(report.players[family].gate.public, false)
    assert.equal(report.players[family].gate.reason, 'market_lines_unavailable')
    assert.equal(report.players[family].gate.min_forward, 200)
  }
  assert.equal(report.combos.gate.public, false)
  assert.equal(report.combos.gate.min_forward, 100)
})

test('WNBA hourly total forecaster is measured, causal and keeps coefficients private', () => {
  const forecaster = createWnbaTotalForecaster()
  const before = forecaster.predict({ date: '2026-08-14', home: 'NY', away: 'LA', neutral: false })
  assert.ok(before > 100 && before < 230)
  assert.ok(forecaster.residual_sd > 0)
  assert.match(forecaster.latest_date, /^2026-/)
  assert.equal(Object.hasOwn(forecaster, 'coefficients'), false)
  assert.equal(forecaster.update({ date: '2026-08-13', home: 'NY', away: 'LA', hs: 82, as: 79 }), true)
  assert.ok(Number.isFinite(forecaster.predict({ date: '2026-08-15', home: 'NY', away: 'LA', neutral: false })))
})
