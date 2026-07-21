import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeDay, rankTopSignals, toD1Rows } from '../cloudflare/lib/normalize.mjs'

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
    pick: null, prob: null, prob_pct: null, price: null, confidence: null, engine_version: null,
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
    starter_invalidations: { 7: {
      reason: 'probable_starter_changed', detected_at: '2026-07-21T17:00:00Z',
      scheduled_start_utc: frozen.first_pitch, phase: 'pregame', note: 'Abridor cambió',
    } },
    plays: [{
      game_pk: 7, pick: 'NYY', prob_v2: 0.57, confidence: 'alta',
      price: -121,
      scratch_warning: true, scratch_note: 'Abridor cambió',
      record_scope: 'public_live', eligible_public_record: true,
    }],
    locks: [{
      game_pk: 7, pick: 'NYY', prob_v2: 0.57, tier: 'oro',
      price: -121,
      scratch_warning: true, scratch_note: 'Abridor cambió',
      record_scope: 'public_live', eligible_public_record: true,
    }],
  }
  const scratchedRow = {
    ...frozen,
    learning_eligible: false,
    invalid_reason: 'probable_starter_changed_pregame',
    integrity: {
      ...frozen.integrity,
      training_eligible: false,
      reason: 'probable_starter_changed_pregame',
    },
  }
  const event = normalizeDay('2026-07-21', { games: [scratchedRow] }, daily, null, [], null).events[0]
  assert.equal(event.pending, false)
  assert.equal(event.prediction.pick, null)
  assert.equal(event.prediction.prob, null)
  assert.equal(event.prediction.prob_pct, null)
  assert.equal(event.prediction.price, null)
  assert.equal(event.prediction.confidence, null)
  assert.equal(event.prediction.engine_version, null)
  assert.equal(event.prediction.invalidated, true)
  assert.equal(event.prediction.invalidated_reason, 'probable_starter_changed')
  assert.deepEqual(event.badges, [])
  assert.deepEqual(event.metrics, [])
  assert.equal(event.summary_es, null)
  assert.equal(event.snapshot, null)
  assert.equal(event.risk, null)
})

test('predictions conserva la cuota real pero no mezcla flags del ledger público', () => {
  const daily = {
    selection_snapshot_verified: true,
    locks: [{
      game_pk: 7, pick: 'NYY', prob_v2: 0.57, tier: 'oro', price: -121,
      record_scope: 'public_live', eligible_public_record: true,
    }],
  }
  const doc = normalizeDay('2026-07-21', { games: [frozen] }, daily, null, [], null)
  const prediction = doc.events[0].prediction
  const row = toD1Rows(doc)[0]
  assert.equal(prediction.price, -121)
  assert.equal(row.price, -121)
  for (const key of ['public_play', 'public_lock', 'public_gem']) {
    assert.equal(Object.hasOwn(prediction, key), false, `${key} no pertenece a prediction`)
    assert.equal(Object.hasOwn(row, key), false, `${key} no pertenece a predictions D1`)
  }

  daily.locks[0].price = 0
  const missing = normalizeDay('2026-07-21', { games: [frozen] }, daily, null, [], null)
  assert.equal(missing.events[0].prediction.price, null)
  assert.equal(toD1Rows(missing)[0].price, null)
})

test('invalidación de abridor aplica al juego general y a un daily legacy', () => {
  const legacyDaily = {
    selection_snapshot_verified: false,
    starter_invalidations: {
      7: {
        reason: 'probable_starter_changed', note: 'Abridor cambió',
        detected_at: '2026-07-21T17:00:00Z', scheduled_start_utc: frozen.first_pitch,
        phase: 'pregame',
      },
    },
    plays: [], locks: [], gems: [],
  }
  const event = normalizeDay('2026-07-21', { games: [frozen] }, legacyDaily, null, [], null).events[0]
  assert.equal(event.prediction.invalidated, true)
  assert.equal(event.prediction.invalidated_reason, 'probable_starter_changed')
  assert.equal(event.prediction.pick, null)
  assert.equal(event.prediction.prob_pct, null)
  assert.deepEqual(event.badges, [])
  assert.deepEqual(event.metrics, [])
  assert.equal(event.snapshot, null)
})

test('la observación factual del row también detecta un cambio de abridor', () => {
  const row = {
    ...frozen,
    home_probable_pitcher_id: 101,
    home_probable_pitcher_name: 'Starter One',
    away_probable_pitcher_id: 202,
    away_probable_pitcher_name: 'Starter Away',
    observed: {
      ...frozen.observed,
      captured_at: '2026-07-21T22:30:00Z',
      status: 'Scheduled',
      pitchers: {
        home: { id: 303, name: 'Starter Three' },
        away: { id: 202, name: 'Starter Away' },
      },
    },
  }
  const event = normalizeDay('2026-07-21', { games: [row] }, null, null, [], null).events[0]
  assert.equal(event.prediction.invalidated, true)
  assert.equal(event.prediction.pick, null)
  assert.equal(event.snapshot, null)
})

test('cambio de abridor observado después del inicio no borra el pick', () => {
  const row = {
    ...frozen,
    home_probable_pitcher_id: 101,
    home_probable_pitcher_name: 'Starter One',
    away_probable_pitcher_id: 202,
    away_probable_pitcher_name: 'Starter Away',
    observed: {
      ...frozen.observed,
      captured_at: '2026-07-22T01:00:00Z',
      status: 'Final',
      pitchers: {
        home: { id: 303, name: 'Starter Three' },
        away: { id: 202, name: 'Starter Away' },
      },
    },
  }
  const event = normalizeDay('2026-07-21', { games: [row] }, null, null, [], null).events[0]
  assert.equal(event.prediction.invalidated, false)
  assert.equal(event.prediction.pick, 'NYY')
  assert.equal(event.result, null)
  assert.notEqual(event.snapshot, null)
})

test('p_final causal tiene prioridad y ninguna métrica vuelve a publicar el porcentaje clásico', () => {
  const row = { ...frozen, model_p: 0.60 }
  const legacyDaily = {
    selection_snapshot_verified: false,
    plays: [{ game_pk: 7, pick: 'NYY', prob_v2: 0.99, badge: 'fijo', record_scope: 'public_live', eligible_public_record: true }],
  }
  const event = normalizeDay('2026-07-21', { games: [row] }, legacyDaily, null, [], null).events[0]
  assert.equal(event.prediction.prob, 0.55)
  assert.equal(event.prediction.prob_pct, 55)
  assert.deepEqual(event.metrics, [
    { key: 'metric_prob_cal', label: 'Prob. AA calibrada', value: '55%', kind: 'pct' },
    { key: 'metric_edge', label: 'Ventaja vs mercado', value: '+1%', kind: 'edge' },
  ])
  assert.equal(event.metrics.some(metric => /modelo|adrián/i.test(metric.label)), false)
  assert.deepEqual(event.badges, [])
})

test('p_final HOME se convierte correctamente a la probabilidad del pick visitante', () => {
  const row = {
    ...frozen,
    observed: null,
    ml_pick: 'BOS',
    p_final: 0.42,
    model_p: 0.75,
  }
  const event = normalizeDay('2026-07-21', { games: [row] }, null, null, [], null).events[0]
  assert.equal(event.prediction.pick, 'BOS')
  assert.equal(event.prediction.prob, 0.58)
  assert.equal(event.prediction.prob_pct, 58)
})

test('Top señales usa únicamente el ranking server-side de eventos válidos', () => {
  const baseEvent = (id, prob, extra = {}) => ({
    event_id: id, status: 'pre', start: `2026-07-21T${id.padStart(2, '0')}:00:00Z`,
    pending: false, badges: [], prediction: { pick: 'NYY', prob, invalidated: false },
    ...extra,
  })
  const ranked = rankTopSignals([
    baseEvent('1', 0.54),
    baseEvent('2', 0.61),
    baseEvent('3', 0.59, { badges: ['fijo'] }),
    baseEvent('4', 0.58),
    baseEvent('5', 0.99, { pending: true }),
    baseEvent('6', 0.98, { status: 'final' }),
    baseEvent('7', 0.97, { prediction: { pick: null, prob: null, invalidated: true } }),
  ])
  assert.deepEqual(ranked, [
    { event_id: '2', rank: 1, basis: 'calibrated_probability', verified: false },
    { event_id: '3', rank: 2, basis: 'calibrated_probability', verified: true },
    { event_id: '4', rank: 3, basis: 'calibrated_probability', verified: false },
  ])
})

test('normalizeDay adjunta Top señales sin convertirlas en badges verificados', () => {
  const games = [
    { id: 21, p: 0.54 }, { id: 22, p: 0.62 },
    { id: 23, p: 0.58 }, { id: 24, p: 0.56 },
  ].map(({ id, p }) => ({
    ...frozen,
    game_pk: id,
    observed: null,
    p_final: p,
    game_datetime: `2026-07-21T${String(id - 1).padStart(2, '0')}:00:00Z`,
    first_pitch: `2026-07-21T${String(id - 1).padStart(2, '0')}:00:00Z`,
  }))
  const doc = normalizeDay('2026-07-21', { games }, null, null, [], null)
  const signals = doc.events.filter(event => event.top_signal)
    .sort((a, b) => a.top_signal.rank - b.top_signal.rank)
  assert.deepEqual(signals.map(event => [event.event_id, event.top_signal.rank]), [
    ['22', 1], ['23', 2], ['24', 3],
  ])
  assert.ok(signals.every(event => event.badges.length === 0))
  assert.equal(doc.events.find(event => event.event_id === '21').top_signal, undefined)
})
