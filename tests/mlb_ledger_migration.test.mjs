import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { scheduleFact } from '../robot/migrate_mlb_ledger.mjs'

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
    assert.equal(doc.selection_snapshot_verified, false)
    for (const pick of doc.plays || []) {
      if (pick.eligible_public_record) {
        assert.equal(pick.record_scope, 'public_live')
        assert.ok(Date.parse(pick.posted_at) < Date.parse(pick.scheduled_start_utc), `${file}:${pick.game_pk}`)
        if (pick.result === 'win') wins++
        else if (pick.result === 'loss') losses++
        else if (pick.result === 'push') pushes++
      } else {
        assert.notEqual(pick.record_scope, 'public_live')
      }
    }
  }
  const index = read('data/history/index.json')
  assert.deepEqual(index.record, { wins, losses, pushes, win_rate: wins + losses ? Math.round(wins / (wins + losses) * 1000) / 1000 : null })
  assert.equal(index.record_scope, 'public_live_pregame_only')
  const pricedLocks = historyFiles.flatMap((file) => {
    const doc = read(`data/history/${file}`)
    return (doc.locks || []).filter((pick) => pick.eligible_public_record
      && (pick.result === 'win' || pick.result === 'loss')
      && Number.isFinite(Number(pick.price)) && Number(pick.price) !== 0)
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
  assert.deepEqual(report.public_record, { wins: 18, losses: 18, pushes: 0, win_rate: 0.5 })
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
