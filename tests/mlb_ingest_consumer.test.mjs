import test from 'node:test'
import assert from 'node:assert/strict'
import { materializeMlbIngest } from '../robot/mlb_ingest_consumer.mjs'

const row = (slot, captured, game = {}, stage = 'pregame') => ({
  slot_id: slot, captured_at: captured, stage, source_hash: `hash-${slot}`,
  payload: JSON.stringify({
    captured_at: captured, stage, games: [{
      id: '824409', mlb_id: '824409', start: '2026-07-21T22:40:00Z',
      status: 'pre', espn_status: 'pre',
      home: { pitcher_id: 1, lineup: [] }, away: { pitcher_id: 2, lineup: [] },
      market: null, ...game,
    }],
  }),
})

test('consumer conserva apertura y última observación pregame por game_pk', () => {
  const doc = materializeMlbIngest([
    row(1, '2026-07-21T11:00:00Z', { market: { home_ml: -125, away_ml: 110, total: 8.5 } }),
    row(2, '2026-07-21T18:00:00Z', {
      home: { pitcher_id: 10, lineup: [1, 2, 3] }, away: { pitcher_id: 20, lineup: [4, 5, 6] },
      market: { home_ml: -140, away_ml: 120, total: 9 },
    }),
  ], '2026-07-21')
  const game = doc.games['824409']
  assert.equal(game.opening_market.home_ml, -125)
  assert.equal(game.opening_market.captured_at_open, '2026-07-21T11:00:00Z')
  assert.equal(game.latest_pregame.home.pitcher_id, 10)
  assert.deepEqual(game.latest_pregame.home.lineup, [1, 2, 3])
  assert.equal(game.latest_pregame.stage, 'pre')
  assert.equal(doc.watermark_slot_id, 2)
})

test('matiné live no invalida la captura pregame individual de un juego nocturno', () => {
  const doc = materializeMlbIngest([
    row(5, '2026-07-21T18:00:00Z', {
      status: 'pre', espn_status: 'pre',
      home: { pitcher_id: 10, lineup: [1, 2, 3] },
      market: { home_ml: -125, away_ml: 110 },
    }, 'live'),
  ], '2026-07-21')
  assert.equal(doc.games['824409'].latest_pregame.stage, 'pre')
  assert.equal(doc.games['824409'].latest_pregame.slate_stage, 'live')
  assert.equal(doc.games['824409'].opening_market.home_ml, -125)

  const alreadyLive = materializeMlbIngest([
    row(6, '2026-07-21T18:20:00Z', { status: 'live', espn_status: 'live' }, 'live'),
  ], '2026-07-21')
  assert.deepEqual(alreadyLive.games, {})
})

test('apertura espera ML completa y total completo con ambos precios', () => {
  const doc = materializeMlbIngest([
    row(10, '2026-07-21T11:00:00Z', {
      market: { provider: 'Book', home_ml: -125, total: 8.5, over_price: -105 },
    }),
    row(11, '2026-07-21T11:20:00Z', {
      market: { provider: 'Book', home_ml_open: -130, home_ml: -126, away_ml: 112, total: 8.5, over_price: -106 },
    }),
    row(12, '2026-07-21T11:40:00Z', {
      market: { provider: 'Book', home_ml: -128, away_ml: 114, total: 9, over_price: -108, under_price: -112 },
    }),
  ], '2026-07-21')
  const opening = doc.games['824409'].opening_market
  // No mezcla un solo precio "open" con la otra cara corriente: congela el
  // primer par observado completo del mismo snapshot.
  assert.equal(opening.home_ml, -126)
  assert.equal(opening.away_ml, 112)
  assert.equal(opening.ml_provenance, 'first_complete_capture')
  assert.equal(opening.captured_at_ml_open, '2026-07-21T11:20:00Z')
  assert.equal(opening.total, 9)
  assert.equal(opening.over_price, -108)
  assert.equal(opening.under_price, -112)
  assert.equal(opening.captured_at_total_open, '2026-07-21T11:40:00Z')
  assert.equal(opening.captured_at_open, '2026-07-21T11:40:00Z')
  assert.equal(opening.ml_source_hash, 'hash-11')
  assert.equal(opening.total_source_hash, 'hash-12')
  assert.equal(opening.source_hash, 'hash-12')
})

test('consumer rechaza cualquier slot capturado al comenzar o después', () => {
  const doc = materializeMlbIngest([
    row(3, '2026-07-21T22:40:00Z', { market: { home_ml: -200 } }),
    row(4, '2026-07-21T23:00:00Z', { market: { home_ml: -210 } }),
  ], '2026-07-21')
  assert.deepEqual(doc.games, {})
})
