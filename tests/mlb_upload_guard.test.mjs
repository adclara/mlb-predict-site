import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPublicRecordBackfillSql,
  buildSql,
  publicRecordRows,
  shouldPublishLatest,
} from '../cloudflare/upload.mjs'

const date = '2026-07-21'
const postedAt = '2026-07-21T12:00:00Z'
const startTime = '2026-07-21T23:00:00Z'
const normalized = {
  updated_at: '2026-07-22T03:00:00Z',
  events: [{
    event_id: '7', start: startTime,
    home: { code: 'NYY' }, away: { code: 'BOS' },
  }],
}
const publicMeta = {
  game_pk: 7, matchup: 'BOS @ NYY', posted_at: postedAt,
  scheduled_start_utc: startTime, record_scope: 'public_live',
  eligible_public_record: true, engine: 'v2',
}

test('mlb:today acepta exclusivamente la fecha ET actual', () => {
  assert.equal(shouldPublishLatest('2026-07-21', '2026-07-20', '2026-07-21'), false)
  assert.equal(shouldPublishLatest('2026-07-20', '2026-07-21', '2026-07-21'), true)
  assert.equal(shouldPublishLatest('2026-07-21', '2026-07-22', '2026-07-21'), false)
})

test('la fecha correcta repara un KV remoto futuro; candidato inválido no', () => {
  assert.equal(shouldPublishLatest('2026-07-22', '2026-07-21', '2026-07-21'), true)
  assert.equal(shouldPublishLatest(null, '2026-07-21', '2026-07-21'), true)
  assert.equal(shouldPublishLatest('2026-07-21', 'ayer', '2026-07-21'), false)
})

test('predictions persiste el modelo actual sin flags del récord público', () => {
  const row = {
    sport: 'mlb', date: '2026-07-21', event_id: '7', league: 'MLB',
    start_time: '2026-07-21T23:00:00Z', status: 'final', home: 'NYY', away: 'BOS',
    pick: 'NYY', prob: 0.57, price: -121, confidence: 'oro', engine_version: 'v2',
    result: 'win', updated_at: '2026-07-22T03:00:00Z',
  }
  const current = buildSql([row])
  assert.match(current, /INSERT OR REPLACE INTO predictions/)
  assert.match(current, /pick, prob, price, confidence/)
  assert.doesNotMatch(current, /public_play|public_lock|public_gem/)
  assert.match(current, /0\.57, -121, 'oro'/)
})

test('mlb_public_picks separa moneyline y total del mismo juego', () => {
  const daily = {
    selection_snapshot_verified: true,
    plays: [
      { ...publicMeta, market: 'ml', pick: 'NYY', side: null, line: null, prob_v2: 0.57, result: 'win' },
      { ...publicMeta, market: 'total', pick: null, side: 'over', line: 8.5, prob_v2: 0.592, result: 'win' },
    ],
    locks: [
      // `line` omitida debe ser la misma identidad ML que `line:null`.
      { ...publicMeta, market: 'ml', pick: 'NYY', side: null, prob_v2: 0.57, price: -121, tier: 'oro', result: 'win' },
    ],
    gems: [],
  }
  const rows = publicRecordRows(date, daily, normalized)
  assert.equal(rows.length, 2)
  const ml = rows.find((row) => row.market === 'ml')
  const total = rows.find((row) => row.market === 'total')
  assert.ok(ml)
  assert.ok(total)
  assert.equal(ml.selection_key, 'ml|NYY||')
  assert.equal(ml.start_time, startTime)
  assert.ok(Date.parse(ml.posted_at) < Date.parse(ml.start_time))
  assert.notEqual(ml.selection_key, total.selection_key)
  assert.deepEqual(
    (({ pick, prob, price, public_play, public_lock, public_gem, result, source_scope }) =>
      ({ pick, prob, price, public_play, public_lock, public_gem, result, source_scope }))(ml),
    { pick: 'NYY', prob: 0.57, price: -121, public_play: 1, public_lock: 1, public_gem: 0, result: 'win', source_scope: 'causal_verified' },
  )
  assert.deepEqual(
    (({ pick, side, line, prob, price, public_play, public_lock, result }) =>
      ({ pick, side, line, prob, price, public_play, public_lock, result }))(total),
    { pick: null, side: 'over', line: 8.5, prob: 0.592, price: null, public_play: 1, public_lock: 0, result: 'win' },
  )

  const backfill = buildPublicRecordBackfillSql(rows)
  assert.match(backfill, /INSERT INTO mlb_public_picks/)
  assert.match(backfill, /ON CONFLICT\(date, event_id, selection_key\) DO UPDATE SET/)
  assert.match(backfill, /public_play = excluded\.public_play/)
  assert.match(backfill, /-121/)
  assert.match(backfill, /'total'/)
})

test('ledger legacy conserva el resultado factual pero no publica probabilidad no verificable', () => {
  const daily = {
    selection_snapshot_verified: false,
    plays: [{
      ...publicMeta, market: 'total', pick: null, side: 'over', line: 8.5,
      prob: 0.758, prob_v2: 0.592, confidence: 'alta', result: 'win',
    }],
  }
  const [row] = publicRecordRows(date, daily, normalized)
  assert.equal(row.market, 'total')
  assert.equal(row.pick, null)
  assert.equal(row.side, 'over')
  assert.equal(row.line, 8.5)
  assert.equal(row.result, 'win')
  assert.equal(row.prob, null)
  assert.equal(row.confidence, null)
  assert.equal(row.engine_version, null)
  assert.equal(row.source_scope, 'legacy_public_record')
})

test('ledger causal no convierte una probabilidad ausente en 0%', () => {
  const daily = {
    selection_snapshot_verified: true,
    plays: [{ ...publicMeta, market: 'ml', pick: 'NYY', prob: null, prob_v2: null, result: 'win' }],
  }
  const [row] = publicRecordRows(date, daily, normalized)
  assert.equal(row.prob, null)
})

test('invalidación conserva identidad auditable pero borra selección, cuota y resultado', () => {
  const daily = {
    selection_snapshot_verified: true,
    starter_invalidations: { 7: {
      reason: 'probable_starter_changed', detected_at: '2026-07-21T17:00:00Z',
      scheduled_start_utc: startTime, phase: 'pregame',
    } },
    plays: [{
      ...publicMeta, market: 'ml', pick: 'NYY', side: null, line: null,
      prob_v2: 0.57, price: -121, confidence: 'alta', result: 'loss',
    }],
  }
  const [row] = publicRecordRows(date, daily, normalized)
  assert.equal(row.market, 'ml')
  assert.match(row.selection_key, /^ml\|NYY\|/)
  assert.equal(row.public_play, 1)
  assert.equal(row.invalidated, 1)
  assert.equal(row.invalidated_reason, 'probable_starter_changed')
  for (const key of ['pick', 'side', 'line', 'prob', 'price', 'confidence', 'result', 'engine_version']) {
    assert.equal(row[key], null, `${key} debe quedar borrado`)
  }
})

test('observación tardía y scratch huérfano no reescriben el récord público', () => {
  const daily = {
    selection_snapshot_verified: true,
    starter_invalidations: { 7: {
      reason: 'probable_starter_changed', detected_at: '2026-07-22T01:00:00Z',
      scheduled_start_utc: startTime, phase: 'late_or_unknown',
    } },
    plays: [{
      ...publicMeta, market: 'ml', pick: 'NYY', prob_v2: 0.57,
      price: -121, confidence: 'alta', result: 'loss', scratch_warning: true,
    }],
  }
  const [row] = publicRecordRows(date, daily, normalized)
  assert.equal(row.invalidated, 0)
  assert.equal(row.pick, 'NYY')
  assert.equal(row.result, 'loss')
  assert.equal(row.price, -121)
})
