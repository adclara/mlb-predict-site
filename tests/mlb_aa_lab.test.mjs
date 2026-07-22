import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aaLabFeatures,
  aaLabProbability,
  buildAaLabForwardReport,
  buildAaLabSlate,
  replayAaLabState,
} from '../robot/aa_lab.mjs'
import { buildSlateRecord } from '../robot/daily.mjs'
import { normalizeDay } from '../cloudflare/lib/normalize.mjs'

const parity = {
  pyth20_diff: -0.14258382761343463,
  blended_pyth_diff: -0.059091737886378504,
  split_form_diff: -0.10000000000000003,
  prior_pyth_diff: 0.02599294993408674,
  elo_diff: -0.5453017562073478,
  rest_diff: 0,
  density7_diff: 1,
  streak_diff: -3,
  h2h_diff: -4,
  park_runs_factor: 0.9705186141596728,
  league_runs_environment: 4.647,
  season_progress: 0.6454545454545455,
}

test('runtime JS reproduce la probabilidad calibrada del artefacto Python', () => {
  const probability = aaLabProbability(parity)
  assert.ok(Math.abs(probability.raw - 0.48575690541232575) < 1e-12)
  assert.ok(Math.abs(probability.calibrated - 0.48779530656817105) < 1e-12)
})

test('replay AA Lab excluye resultados de la fecha objetivo y del futuro', () => {
  const past = [{
    game_pk: 1, date: '2026-04-01', home: 'NYY', away: 'BOS',
    home_win: 1, final: '2-4', graded: true,
  }]
  const forbidden = [{
    game_pk: 2, date: '2026-04-02', home: 'NYY', away: 'BOS',
    home_win: 0, final: '9-1', graded: true,
  }, {
    game_pk: 3, date: '2026-04-03', home: 'NYY', away: 'BOS',
    home_win: 0, final: '8-0', graded: true,
  }]
  const base = aaLabFeatures(replayAaLabState(past, '2026-04-02'), { date: '2026-04-02', home: 'NYY', away: 'BOS' })
  const withFuture = aaLabFeatures(replayAaLabState([...past, ...forbidden], '2026-04-02'), { date: '2026-04-02', home: 'NYY', away: 'BOS' })
  assert.deepEqual(withFuture, base)
})

test('slate AA Lab selecciona máximo dos y sigue privado al congelarse', () => {
  const generatedAt = '2026-07-22T11:00:00Z'
  const games = ['NYY', 'CLE', 'LAD'].map((home, index) => ({
    game_pk: index + 1, home, away: ['BOS', 'MIN', 'SF'][index],
    ml_pick: home, p_learn: 0.91, p_final: 0.52 + index / 100,
    first_pitch: `2026-07-22T${18 + index}:00:00Z`,
  }))
  const lab = buildAaLabSlate({ date: '2026-07-22', games, historyRows: [], generatedAt })
  assert.equal(lab.published, false)
  assert.equal(lab.changes_public_model, false)
  assert.equal(lab.predictions.filter((prediction) => prediction.selected).length, 2)
  assert.deepEqual(lab.predictions.map((prediction) => prediction.aa_home_prob), [0.52, 0.53, 0.54])
  const rec = buildSlateRecord(null, {
    rows: games, plays: [], locks: [], gems: [], marketLab: null, pitcherMap: {}, aaLab: lab,
  }, { date: '2026-07-22', publishedAt: generatedAt })
  assert.equal(rec.shadow.aa_lab.published, false)
  assert.equal(rec.shadow.aa_lab.predictions.length, 3)
  assert.ok(rec.shadow.aa_lab.predictions.every((prediction) => prediction.record_scope === 'shadow_forward_gate'))
  assert.ok(rec.shadow.aa_lab.predictions.every((prediction) => prediction.eligible_public_record === false))
})

test('reporte forward nunca autoriza publicación automática', () => {
  const doc = {
    date: '2026-07-22', shadow: { aa_lab: { predictions: [{
      game_pk: 1, home: 'NYY', away: 'BOS', pick: 'NYY', home_prob: 0.6,
      aa_home_prob: 0.55, selected: true, agrees_with_aa: true, result: 'win',
      temporal_scope: 'public_live',
    }, {
      game_pk: 2, home: 'CLE', away: 'MIN', pick: 'CLE', home_prob: 0.99,
      aa_home_prob: 0.55, selected: false, agrees_with_aa: true, result: 'win',
      temporal_scope: 'late_invalid',
    }] } },
  }
  const report = buildAaLabForwardReport([doc], { updatedAt: '2026-07-23T04:00:00Z' })
  assert.equal(report.all.n, 1)
  assert.equal(report.excluded_nonpregame, 1)
  assert.equal(report.selected_top_two.accuracy, 1)
  assert.equal(report.published, false)
  assert.equal(report.gate.passes, false)
  assert.equal(report.gate.human_approval_required, true)
})

test('normalizador público nunca expone el bloque privado AA Lab', () => {
  const game = {
    game_pk: 1, home: 'NYY', away: 'BOS', status: 'Pre-Game',
    game_datetime: '2026-07-22T23:00:00Z', first_pitch: '2026-07-22T23:00:00Z',
  }
  const privateDaily = {
    date: '2026-07-22', plays: [], locks: [], gems: [],
    shadow: { aa_lab: { published: false, predictions: [{
      game_pk: 1, pick: 'NYY', home_prob: 0.987654, features: { elo_diff: 9.99 },
    }] } },
  }
  const publicDoc = normalizeDay('2026-07-22', { games: [game] }, privateDaily, null, [], null)
  const serialized = JSON.stringify(publicDoc)
  assert.equal(serialized.includes('aa_lab'), false)
  assert.equal(serialized.includes('0.987654'), false)
  assert.equal(serialized.includes('elo_diff'), false)
})
