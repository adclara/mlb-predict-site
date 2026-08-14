import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSeasons } from '../robot/nba_model.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'data', 'fase2', 'wnba')

test('WNBA conserva cinco temporadas cerradas y la temporada actual', () => {
  const seasons = loadSeasons(DIR)
  const cohort = seasons.filter((season) => Number(season.season) >= 2021 && Number(season.season) <= 2026)
  assert.deepEqual(cohort.map((season) => season.season), ['2021', '2022', '2023', '2024', '2025', '2026'])
  assert.deepEqual(cohort.slice(0, 5).map((season) => season.games.length), [211, 241, 262, 264, 312])
  assert.ok(cohort[5].games.length >= 253)
  for (const season of seasons) {
    assert.ok(season.games.every((game) => game.date && game.home && game.away && Number.isFinite(game.hs) && Number.isFinite(game.as)))
  }
})

test('reporte WNBA es cronológico, medido y no afirma mercado inexistente', () => {
  const report = JSON.parse(readFileSync(join(DIR, 'wnba_backtest.json'), 'utf8'))
  assert.deepEqual(report.burn_in, ['2021', '2022'])
  assert.deepEqual(Object.keys(report.per_season).slice(0, 4), ['2023', '2024', '2025', '2026'])
  assert.equal(report.n_eval, Object.values(report.per_season).reduce((sum, row) => sum + row.n, 0))
  assert.ok(report.n_eval >= 1091)
  assert.ok(Number.isFinite(report.metrics.brier))
  assert.ok(Number.isFinite(report.metrics.acc))
  assert.ok(report.metrics.brier < report.metrics.brier_baseline_local)
  assert.equal(report.market_comparison, null)
})
