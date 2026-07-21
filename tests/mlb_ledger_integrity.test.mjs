import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPublicIndex,
  buildSlateRecord,
  capturePhaseFor,
  contextRows,
  enrichGamesFromIngest,
  freezeFeatureRow,
  gradeGames,
  ingestPregameFacts,
  learningRows,
  mergeGameRows,
  parseGame,
} from '../robot/daily.mjs'

const game = ({
  pk = 1,
  start = '2026-07-21T23:00:00Z',
  status = 'Scheduled',
  innings = [],
  homeScore = null,
  awayScore = null,
} = {}) => ({
  gamePk: pk,
  officialDate: '2026-07-21',
  gameDate: start,
  status: { detailedState: status, abstractGameState: /final/i.test(status) ? 'Final' : 'Preview' },
  teams: {
    home: { score: homeScore, team: { id: 10, abbreviation: 'NYY', name: 'Yankees' } },
    away: { score: awayScore, team: { id: 20, abbreviation: 'BOS', name: 'Red Sox' } },
  },
  linescore: { innings },
})

const innings = (home = [0, 1, 0, 2, 0], away = [1, 0, 0, 0, 1]) =>
  home.map((runs, i) => ({ num: i + 1, home: { runs }, away: { runs: away[i] } }))

test('F5 exige cinco innings explícitos y nunca convierte null en cero', () => {
  const incomplete = innings()
  incomplete[4] = { num: 5, home: { runs: null }, away: { runs: 0 } }
  const bad = parseGame(game({ innings: incomplete }))
  assert.equal(bad.f5_home_score, null)
  assert.equal(bad.f5_away_score, null)

  const complete = parseGame(game({ innings: innings() }))
  assert.equal(complete.f5_home_score, 3)
  assert.equal(complete.f5_away_score, 2)
})

test('snapshot pregame queda inmutable y las actualizaciones van a observed', () => {
  const original = freezeFeatureRow({
    game_pk: 7,
    date: '2026-07-21',
    game_date: '2026-07-21',
    game_datetime: '2026-07-21T23:00:00Z',
    status: 'Scheduled',
    model_p: 0.54,
    ml_pick: 'NYY',
    odds: { ml_home: -120, capture_phase: 'pregame', captured_at: '2026-07-21T12:00:00Z' },
  }, '2026-07-21T12:05:00Z')
  assert.equal(original.integrity.training_eligible, true)

  const [merged] = mergeGameRows([original], [{
    ...original,
    status: 'Final',
    home_score: 5,
    away_score: 3,
    model_p: 0.99,
    ml_pick: 'BOS',
    odds: { ml_home: -180, capture_phase: 'postgame', captured_at: '2026-07-22T03:00:00Z' },
    observed: { status: 'Final', odds: { ml_home: -180, capture_phase: 'postgame', captured_at: '2026-07-22T03:00:00Z' } },
  }], { asOf: '2026-07-22T03:00:00Z', freezeFeatures: true })
  assert.equal(merged.model_p, 0.54)
  assert.equal(merged.ml_pick, 'NYY')
  assert.equal(merged.feature_hash, original.feature_hash)
  assert.equal(merged.integrity.training_eligible, true)
  assert.equal(merged.observed.status, 'Final')
  assert.equal(merged.observed.odds.ml_home, -180)
  assert.deepEqual(merged.observed.scores, { home: 5, away: 3 })
})

test('upsert lógico conserva el veredicto integrity de una fila migrada', () => {
  const old = {
    game_pk: 9,
    date: '2026-07-20',
    game_date: '2026-07-20',
    game_datetime: '2026-07-20T20:00:00Z',
    status: 'Final',
    model_p: 0.51,
    integrity: { ledger_version: 'v2', cohort: 'legacy_native_mutable', training_eligible: false, reason: 'pregame_features_were_overwritten_intraday' },
  }
  const [sealed] = mergeGameRows([old], [{ ...old, model_p: 0.88 }], {
    asOf: '2026-07-21T12:00:00Z',
    freezeFeatures: true,
  })
  assert.equal(sealed.model_p, 0.51)
  assert.deepEqual(sealed.integrity, old.integrity)
  assert.equal(sealed.learning_eligible, false)
  assert.match(sealed.feature_hash, /^[a-f0-9]{64}$/)
})

test('un slate vacío también se congela; ORO y laboratorios nacen en sombra', () => {
  const rows = [{ game_pk: 1, game_datetime: '2026-07-21T23:00:00Z' }]
  const first = buildSlateRecord(null, {
    rows,
    plays: [],
    locks: [{ game_pk: 1, market: 'ml', pick: 'NYY' }],
    gems: [],
    marketLab: { over: [{ game_pk: 1, market: 'total', side: 'over' }], f5: [], pitcher_f5: [] },
    pitcherMap: {},
  }, { date: '2026-07-21', publishedAt: '2026-07-21T12:00:00Z' })
  assert.deepEqual(first.plays, [])
  assert.deepEqual(first.locks, [])
  assert.equal(first.selection_snapshot_verified, true)
  assert.equal(first.shadow.locks[0].record_scope, 'shadow_forward_gate')
  assert.equal(first.shadow.market_lab.over[0].record_scope, 'shadow_experiment')

  const rerun = buildSlateRecord(first, {
    rows,
    plays: [{ game_pk: 1, market: 'ml', pick: 'NYY' }],
    locks: [], gems: [], marketLab: null, pitcherMap: {},
  }, { date: '2026-07-21', publishedAt: '2026-07-21T13:00:00Z' })
  assert.deepEqual(rerun.plays, [])
  assert.equal(rerun.slate_frozen_at, '2026-07-21T12:00:00Z')
})

test('candidatos publicados después del inicio jamás entran al ledger público', () => {
  const rec = buildSlateRecord(null, {
    rows: [{ game_pk: 1, game_datetime: '2026-07-21T11:00:00Z' }],
    plays: [{ game_pk: 1, market: 'ml', pick: 'NYY', result: 'win' }],
    locks: [], gems: [], marketLab: null, pitcherMap: {},
  }, { date: '2026-07-21', publishedAt: '2026-07-21T12:00:00Z' })
  assert.equal(rec.plays.length, 0)
  assert.equal(rec.shadow.late_plays[0].record_scope, 'late_invalid')

  const forged = { date: '2026-07-20', graded: true, plays: [{
    result: 'win', record_scope: 'public_live', eligible_public_record: true,
    posted_at: '2026-07-20T13:00:00Z', scheduled_start_utc: '2026-07-20T12:00:00Z',
  }] }
  const forgedIndex = buildPublicIndex([forged], { updatedAt: 'x' })
  assert.deepEqual(forgedIndex.record, { wins: 0, losses: 0, pushes: 0, win_rate: null })
  assert.equal(forgedIndex.locks_record.priced_n, 0)
  assert.equal(forgedIndex.locks_record.units, null)

  const causal = { record_scope: 'public_live', eligible_public_record: true,
    posted_at: '2026-07-20T10:00:00Z', scheduled_start_utc: '2026-07-20T12:00:00Z' }
  const priced = buildPublicIndex([{ date: '2026-07-20', plays: [], gems: [], locks: [
    { ...causal, result: 'win' }, // missing price must not become an invented -110
    { ...causal, result: 'loss', price: -120 },
  ] }], { updatedAt: 'x' })
  assert.equal(priced.locks_record.priced_n, 1)
  assert.equal(priced.locks_record.units, -1)
})

test('consumer D1 solo enriquece hechos medidos antes del primer lanzamiento', () => {
  const raw = { games: {
    1: {
      first_pitch: '2026-07-21T23:00:00Z',
      opening_market: { provider: 'Book', home_ml: -120, away_ml: 110, total: 8.5, over_price: -105, under_price: -115,
        captured_at_open: '2026-07-21T10:00:00Z', source_hash: 'open-1' },
      latest_pregame: { captured_at: '2026-07-21T21:00:00Z', source_hash: 'facts-1', stage: 'pregame',
        home: { pitcher_id: 101, pitcher: 'Home P', lineup: [1, 2, 3] },
        away: { pitcher_id: 202, pitcher: 'Away P', lineup: [4, 5, 6] } },
    },
    2: {
      first_pitch: '2026-07-21T18:00:00Z',
      opening_market: { home_ml: -130, away_ml: 120, captured_at_open: '2026-07-21T19:00:00Z' },
    },
  } }
  const facts = ingestPregameFacts(raw)
  assert.equal(facts.size, 1)
  assert.equal(facts.get('1').odds.open_provenance, 'explicit_pregame')
  assert.equal(facts.get('1').odds.captured_at_open, '2026-07-21T10:00:00Z')
  assert.equal(facts.get('1').odds.over_price_open, -105)
  assert.equal(facts.get('1').odds.under_price_open, -115)

  const base = [{ game_pk: 1, game_datetime: '2026-07-21T23:00:00Z',
    home_probable_pitcher_id: 999, home_probable_pitcher_name: 'Official P',
    away_probable_pitcher_id: null, away_probable_pitcher_name: null,
    home_lineup: [{ id: 99, name: 'Official hitter' }], away_lineup: [] }]
  const enriched = enrichGamesFromIngest(base, raw).games[0]
  assert.equal(enriched.home_probable_pitcher_id, 999)
  assert.equal(enriched.home_probable_pitcher_name, 'Official P')
  assert.equal(enriched.away_probable_pitcher_id, 202)
  assert.deepEqual(enriched.home_lineup, base[0].home_lineup)
  assert.deepEqual(enriched.away_lineup.map((p) => p.id), [4, 5, 6])
})

test('aprendizaje deduplica y acepta solo cohortes causales explícitas', () => {
  const base = {
    game_pk: 1, date: '2026-07-20', game_date: '2026-07-20',
    game_datetime: '2026-07-20T23:00:00Z', first_pitch: '2026-07-20T23:00:00Z',
    status: 'Scheduled', formula_version: 'v2', graded: true, home_win: 1, final: '2-3',
    feature_as_of: '2026-07-20T12:00:00Z', feature_hash: 'a'.repeat(64),
    integrity: { cohort: 'native_pregame_immutable', training_eligible: true },
    odds: { open_provenance: 'explicit_pregame', captured_at_open: '2026-07-20T11:00:00Z',
      p_home_open: 0.55, p_home_close: 0.7, wp_curve: [{ inn: 1 }] },
    observed: { status: 'Final' },
  }
  const duplicate = { ...base, integrity: { cohort: 'native_pregame_immutable', training_eligible: true, duplicate_of: '2026-07-20:1' } }
  const mutable = { ...base, game_pk: 2, feature_hash: undefined,
    integrity: { cohort: 'legacy_native_mutable', training_eligible: false } }
  const rows = learningRows([base, duplicate, mutable])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].observed, undefined)
  assert.equal(rows[0].odds.p_home_close, undefined)
  assert.equal(rows[0].odds.wp_curve, undefined)
})

test('contexto excluye pospuestos y duplicados, y la gradación guarda outcome F5', () => {
  const good = { game_pk: 1, date: '2026-07-20', game_date: '2026-07-20', graded: true, home_win: 1, final: '2-3', status: 'Final' }
  const duplicate = { ...good, integrity: { duplicate_of: '2026-07-20:1' } }
  const voided = { ...good, game_pk: 2, status: 'Postponed' }
  assert.deepEqual(contextRows([duplicate, good, voided]).map((r) => r.game_pk), [1])

  const row = { game_pk: 3, ml_pick: 'NYY', line: 8.5, side: 'over', integrity: { training_eligible: true } }
  const final = parseGame(game({ pk: 3, status: 'Final', homeScore: 5, awayScore: 3, innings: innings() }))
  assert.equal(gradeGames({ games: [row] }, new Map([[3, final]])), true)
  assert.equal(row.f5_complete, true)
  assert.equal(row.f5_result, 'home')
  assert.equal(row.f5_total_runs, 5)
})

test('fase de captura combina estado oficial y reloj', () => {
  const scheduled = { status: 'Scheduled', game_datetime: '2026-07-21T23:00:00Z' }
  assert.deepEqual(capturePhaseFor(scheduled, '2026-07-21T22:59:59Z'), { capture_phase: 'pregame', is_pregame: true })
  assert.deepEqual(capturePhaseFor(scheduled, '2026-07-21T23:00:00Z'), { capture_phase: 'live', is_pregame: false })
  assert.deepEqual(capturePhaseFor({ ...scheduled, status: 'Final' }, '2026-07-22T02:00:00Z'), { capture_phase: 'postgame', is_pregame: false })
})
