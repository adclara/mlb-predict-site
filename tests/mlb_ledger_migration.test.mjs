import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { rebuildIndex, scheduleFact } from '../robot/migrate_mlb_ledger.mjs'

const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const historyFiles = readdirSync('data/history')
  .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
  .sort()
const gameFiles = readdirSync('data/history/games')
  .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
  .sort()

test('ledger público cuenta únicamente decisiones anteriores al primer lanzamiento', () => {
  let wins = 0, losses = 0, pushes = 0
  for (const file of historyFiles) {
    const doc = read(`data/history/${file}`)
    // El histórico migrado conserva false; los slates nativos nuevos usan true.
    // Ambos deben obedecer las guardas temporales pick por pick de abajo.
    assert.equal(typeof doc.selection_snapshot_verified, 'boolean')
    for (const pick of doc.plays || []) {
      if (pick.eligible_public_record && pick.scratch_warning !== true) {
        assert.equal(pick.record_scope, 'public_live')
        assert.ok(Date.parse(pick.posted_at) < Date.parse(pick.scheduled_start_utc), `${file}:${pick.game_pk}`)
        if (pick.result === 'win') wins++
        else if (pick.result === 'loss') losses++
        else if (pick.result === 'push') pushes++
      } else if (!pick.eligible_public_record) {
        assert.notEqual(pick.record_scope, 'public_live')
      }
    }
  }
  const index = read('data/history/index.json')
  assert.deepEqual(index.record, { wins, losses, pushes, win_rate: wins + losses ? Math.round(wins / (wins + losses) * 1000) / 1000 : null })
  assert.equal(index.record_scope, 'public_live_pregame_only')
  const pricedLocks = historyFiles.flatMap((file) => {
    const doc = read(`data/history/${file}`)
    return (doc.locks || []).filter((pick) => pick.eligible_public_record && pick.scratch_warning !== true
      && (pick.result === 'win' || pick.result === 'loss')
      && Number.isFinite(Number(pick.price)) && Math.abs(Number(pick.price)) >= 100)
  })
  const units = pricedLocks.reduce((sum, pick) => {
    const price = Number(pick.price)
    return sum + (pick.result === 'loss' ? -1 : price > 0 ? price / 100 : 100 / Math.abs(price))
  }, 0)
  assert.equal(index.locks_record.priced_n, pricedLocks.length)
  assert.equal(index.locks_record.units, pricedLocks.length ? Math.round(units * 100) / 100 : null)
})

test('duplicados se conservan para auditoría pero solo un game_pk puede entrenar', () => {
  const eligibleByPk = new Map()
  let duplicates = 0
  for (const file of gameFiles) {
    const doc = read(`data/history/games/${file}`)
    for (const row of doc.games || []) {
      if (row.integrity?.duplicate_of) duplicates++
      if (!row.integrity?.training_eligible) continue
      const key = String(row.game_pk)
      eligibleByPk.set(key, (eligibleByPk.get(key) || 0) + 1)
    }
  }
  assert.equal(duplicates, 16)
  assert.ok([...eligibleByPk.values()].every((n) => n === 1))
})

test('migración recupera resultados F5 oficiales sin publicarlos como gate aprobado', () => {
  let f5 = 0
  for (const file of gameFiles) {
    const doc = read(`data/history/games/${file}`)
    for (const row of doc.games || []) {
      if (row.f5_home_score != null && row.f5_away_score != null) f5++
    }
  }
  assert.ok(f5 >= 1500, `solo ${f5} marcadores F5`)
  const report = read('data/history/ledger_migration.json')
  assert.equal(report.counts.backtest, 12)
  assert.equal(report.counts.late_invalid, 1)
  assert.deepEqual(report.public_record, { wins: 18, losses: 16, pushes: 0, win_rate: 0.529 })
})

test('migración F5 exige carreras explícitas en las cinco entradas', () => {
  const innings = Array.from({ length: 5 }, (_, index) => ({
    num: index + 1, home: { runs: 0 }, away: { runs: 0 },
  }))
  innings[4].away.runs = null
  const incomplete = scheduleFact({ gamePk: 1, linescore: { innings } }, '2026-07-21')
  assert.equal(incomplete.f5_home_score, null)
  assert.equal(incomplete.f5_away_score, null)

  innings[4].away.runs = 2
  const complete = scheduleFact({ gamePk: 1, linescore: { innings } }, '2026-07-21')
  assert.equal(complete.f5_home_score, 0)
  assert.equal(complete.f5_away_score, 2)
})

test('rebuild one-shot ignora void y cuotas que no sean americanas reales', () => {
  const causal = (game_pk, result, extra = {}) => ({
    game_pk, result, record_scope: 'public_live', eligible_public_record: true,
    ...extra,
  })
  const index = rebuildIndex([{
    date: '2026-07-21',
    plays: [causal(1, 'win'), causal(2, 'loss'), causal(3, 'push'), causal(4, 'void')],
    locks: [causal(5, 'win', { price: 1.91 }), causal(6, 'loss', { price: -120 }), causal(7, 'void', { price: -110 })],
    gems: [],
  }], null)
  assert.deepEqual(index.record, { wins: 1, losses: 1, pushes: 1, win_rate: 0.5 })
  assert.equal(index.locks_record.pushes, 0)
  assert.equal(index.locks_record.priced_n, 1)
  assert.equal(index.locks_record.units, -1)
})

test('la tendencia del Cerebro contiene solo la cohorte causal comparable', () => {
  const journal = read('data/history/learning_journal.json')
  assert.equal(journal.cohort_version, 'causal_ledger_v2')
  assert.ok(Array.isArray(journal.history) && journal.history.length >= 1)
  assert.ok(journal.history.every((point) => point.cohort_version === journal.cohort_version))
  assert.ok(journal.history.every((point) => point.n <= journal.n_graded))
  assert.equal(journal.history.some((point) => point.n > 1332), false)
})
