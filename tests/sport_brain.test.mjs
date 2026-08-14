import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSportBrain, calibrationEce, forwardMetrics } from '../robot/sport_brain.mjs'

const basketBacktest = {
  n_eval: 1091,
  metrics: { acc: 0.663, brier: 0.2132, logloss: 0.616, brier_baseline_local: 0.248 },
  calibration: [
    { n: 500, p_media: 0.55, freq_real: 0.54 },
    { n: 591, p_media: 0.72, freq_real: 0.70 },
  ],
}

test('ECE pondera por muestra y acepta escala porcentaje', () => {
  assert.ok(Math.abs(calibrationEce([{ n: 50, p_media: 0.6, freq_real: 0.5 }, { n: 50, pred: 70, real: 60 }]) - 0.1) < 1e-12)
})

test('métricas forward usan la probabilidad del lado elegido', () => {
  const m = forwardMetrics([
    { date: '2026-08-01', result: 'win', prob: 0.6, market_prob: 0.55 },
    { date: '2026-08-02', result: 'loss', prob: 0.7, market_prob: 0.6 },
  ])
  assert.equal(m.n, 2)
  assert.equal(m.wins, 1)
  assert.equal(m.dates, 2)
  assert.ok(Math.abs(m.brier - 0.325) < 1e-12)
})

test('WNBA permanece en sombra aunque el histórico sea bueno si falta forward', () => {
  const doc = buildSportBrain({ sport: 'wnba', backtest: basketBacktest, rows: [], now: '2026-08-14T00:00:00Z' })
  assert.equal(doc.historical.n, 1091)
  assert.equal(doc.gate.historical_passed, true)
  assert.equal(doc.gate.passed, false)
  assert.equal(doc.gate.public, false)
  assert.equal(doc.gate.reason, 'forward_sample_pending')
})

test('un gate estadístico WNBA aprobado por datos aún exige aprobación humana', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    date: `2026-${String(5 + Math.floor((index % 40) / 30)).padStart(2, '0')}-${String((index % 30) + 1).padStart(2, '0')}`,
    result: index < 180 ? 'win' : 'loss', prob: 0.9, market_prob: 0.75,
  }))
  const doc = buildSportBrain({ sport: 'wnba', backtest: basketBacktest, rows })
  assert.equal(doc.gate.passed, true)
  assert.equal(doc.gate.approved, false)
  assert.equal(doc.gate.public, false)
  assert.equal(doc.gate.reason, 'human_approval_pending')
})

test('NBA tampoco abre sin comparación forward contra mercado', () => {
  const rows = Array.from({ length: 320 }, (_, i) => ({
    date: `2026-11-${String((i % 30) + 1).padStart(2, '0')}`,
    result: i % 2 ? 'win' : 'loss', prob: 0.6, market_prob: null,
  }))
  const doc = buildSportBrain({ sport: 'nba', backtest: basketBacktest, rows })
  assert.equal(doc.gate.public, false)
  assert.equal(doc.gate.reason, 'forward_calibration_pending')
})

test('documento sin backtest no inventa métricas', () => {
  const doc = buildSportBrain({ sport: 'tennis', backtest: null, rows: [] })
  assert.equal(doc.historical.n, 0)
  assert.equal(doc.historical.accuracy, null)
  assert.equal(doc.gate.historical_passed, false)
})
