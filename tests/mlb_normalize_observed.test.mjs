import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeDay } from '../cloudflare/lib/normalize.mjs'

const frozen = {
  game_pk: 7,
  date: '2026-07-21',
  game_date: '2026-07-21',
  game_datetime: '2026-07-21T23:00:00Z',
  first_pitch: '2026-07-21T23:00:00Z',
  feature_as_of: '2026-07-21T12:05:00Z',
  decision_captured_at: '2026-07-21T12:05:00Z',
  feature_scope: 'pregame_immutable',
  feature_hash: 'a'.repeat(64),
  integrity: { ledger_version: 'v2', cohort: 'native_pregame_immutable', training_eligible: true },
  status: 'Scheduled',
  home: 'NYY',
  away: 'BOS',
  matchup: 'BOS @ NYY',
  ml_pick: 'NYY',
  adrian_p: 0.56,
  p_final: 0.55,
  odds: {
    provider: 'OpenBook', ml_home: -120, ml_away: 110,
    p_home_mkt: 0.54, p_away_mkt: 0.46,
    p_home_open: 0.54, captured_at_open: '2026-07-21T12:00:00Z',
    open_provenance: 'explicit_pregame',
  },
  observed: {
    captured_at: '2026-07-22T03:10:00Z',
    status: 'Final', scores: { home: 5, away: 3 },
    odds: {
      provider: 'CloseBook', ml_home: -150, ml_away: 130,
      p_home_mkt: 0.58, p_away_mkt: 0.42,
      p_home_open: 0.54, line_move: 0.04,
    },
  },
}

test('normalizador conserva decisión pregame y muestra observación factual actual', () => {
  const doc = normalizeDay('2026-07-21', { games: [frozen] }, null, null, [], null)
  const event = doc.events[0]
  assert.equal(event.status, 'final')
  assert.equal(event.final, '3-5')
  assert.equal(event.prediction.pick, 'NYY')
  assert.equal(event.odds.provider, 'CloseBook')
  assert.equal(event.odds.ml_home, -150)
  assert.equal(event.snapshot.market.p_home_pct, 58)
  assert.equal(event.snapshot.market.p_home_open_pct, 54)
  assert.equal(event.updated_at, '2026-07-22T03:10:00Z')
  assert.equal(frozen.odds.ml_home, -120)
})

test('status final sin scores explícitos jamás fabrica un 0-0', () => {
  const row = { ...frozen, observed: { status: 'Final', scores: { home: null, away: null } } }
  const event = normalizeDay('2026-07-21', { games: [row] }, null, null, [], null).events[0]
  assert.equal(event.status, 'final')
  assert.equal(event.final, null)
})

test('fila provisional conserva hechos públicos pero no expone ninguna salida del modelo', () => {
  const provisional = {
    ...frozen,
    observed: null,
    status: 'Scheduled',
    feature_hash: undefined,
    feature_scope: 'provisional_pregame',
    decision_captured_at: null,
    integrity: { ledger_version: 'v2', cohort: 'provisional', training_eligible: false },
    brief: { reasons: ['Razón que todavía no se puede publicar'] },
    risk: { level: 'bajo', score: 10 },
  }
  const daily = { selection_snapshot_verified: true, plays: [{
    game_pk: 7, pick: 'NYY', prob_v2: 0.91, confidence: 'alta',
    record_scope: 'public_live', eligible_public_record: true,
  }], locks: [{
    game_pk: 7, pick: 'NYY', prob_v2: 0.91, tier: 'oro',
    record_scope: 'public_live', eligible_public_record: true,
  }] }
  const event = normalizeDay('2026-07-21', { games: [provisional] }, daily, null, [], null).events[0]
  assert.equal(event.pending, true)
  assert.deepEqual(event.prediction, {
    pick: null, prob: null, prob_pct: null, confidence: null, engine_version: null,
  })
  assert.deepEqual(event.metrics, [])
  assert.equal(event.summary_es, null)
  assert.equal(event.snapshot, null)
  assert.equal(event.risk, null)
  assert.deepEqual(event.badges, [])
  assert.equal(event.result, null)
  assert.equal(event.odds.provider, 'OpenBook')
})

test('cambio de abridor invalida la predicción congelada y elimina toda promoción', () => {
  const daily = {
    selection_snapshot_verified: true,
    plays: [{
      game_pk: 7, pick: 'NYY', prob_v2: 0.57, confidence: 'alta',
      scratch_warning: true, scratch_note: 'Abridor cambió',
      record_scope: 'public_live', eligible_public_record: true,
    }],
    locks: [{
      game_pk: 7, pick: 'NYY', prob_v2: 0.57, tier: 'oro',
      scratch_warning: true, scratch_note: 'Abridor cambió',
      record_scope: 'public_live', eligible_public_record: true,
    }],
  }
  const event = normalizeDay('2026-07-21', { games: [frozen] }, daily, null, [], null).events[0]
  assert.equal(event.pending, false)
  assert.equal(event.prediction.pick, 'NYY')
  assert.equal(event.prediction.prob_pct, 57)
  assert.equal(event.prediction.invalidated, true)
  assert.equal(event.prediction.invalidated_reason, 'probable_starter_changed')
  assert.deepEqual(event.badges, [])
  assert.deepEqual(event.metrics, [])
  assert.equal(event.summary_es, null)
  assert.equal(event.snapshot, null)
  assert.equal(event.risk, null)
})

test('un daily legacy no puede pisar la probabilidad de una fila causal nueva', () => {
  const row = { ...frozen, model_p: 0.60 }
  const legacyDaily = {
    selection_snapshot_verified: false,
    plays: [{ game_pk: 7, pick: 'NYY', prob_v2: 0.99, badge: 'fijo', record_scope: 'public_live', eligible_public_record: true }],
  }
  const event = normalizeDay('2026-07-21', { games: [row] }, legacyDaily, null, [], null).events[0]
  assert.equal(event.prediction.prob, 0.535)
  assert.deepEqual(event.badges, [])
})
