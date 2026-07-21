import test from 'node:test'
import assert from 'node:assert/strict'

import { buildTeamContext } from '../robot/context.mjs'
import { simulateF5, simulateGame, stableSeed } from '../robot/engine.js'
import {
  auditableClosingMarketHome,
  auditableOpeningMarketHome,
  authorizedMarketAnchor,
  bootstrapStability,
  buildSnapshot,
  dedupeGameRows,
  marketAnchorReport,
  marketResidualChallengerReport,
  oddsReport,
  prepareTrainingRows,
  walkForwardMarketResidual,
} from '../robot/learn.js'
import { totalAtMarket } from '../robot/market_lab.mjs'
import { hasAuditableOpening, mergeOddsBlocks } from '../robot/odds.js'

function row(gamePk, date = '2026-07-01', overrides = {}) {
  const homeWin = gamePk % 2
  return {
    game_pk: gamePk, date, game_date: date, start: `${date}T23:00:00Z`,
    home: 'CLE', away: 'MIN', matchup: 'MIN @ CLE',
    status: 'Scheduled', capture_phase: 'pregame', graded: true,
    feature_as_of: `${date}T11:00:00Z`, feature_hash: 'a'.repeat(64),
    integrity: {
      ledger_version: 'v2', cohort: 'native_pregame_immutable', training_eligible: true,
      reason: 'feature_snapshot_before_first_pitch', first_pitch: `${date}T23:00:00Z`,
    },
    formula_version: 'v2', home_win: homeWin, final: homeWin ? '2-4' : '4-2',
    model_p: 0.55, adrian_p: 0.55, p_learn: 0.54, ml_pick: 'CLE', ml_result: homeWin ? 'win' : 'loss',
    factor_leans: {
      momentum: (gamePk % 5 - 2) / 20, pitching: (gamePk % 7 - 3) / 25,
      f5: (gamePk % 3 - 1) / 20, bats: (gamePk % 4 - 2) / 25,
      schedule: (gamePk % 6 - 3) / 30, manager: (gamePk % 8 - 4) / 40,
    },
    news_delta: 0, p_over: 0.55, total_runs: 9, line: 8.5, total_result: 'win',
    components: { aStart: 1, hStart: 1, homeContact: 1, awayContact: 1, aFat: 0, hFat: 0 },
    odds: {
      p_home_open: 0.53, ml_home_open: -115, ml_away_open: 105,
      over_under_open: 8.5, over_price_open: -110, under_price_open: -110,
      open_provenance: 'explicit_pregame', captured_at_open: `${date}T12:00:00Z`,
    },
    ...overrides,
  }
}

test('Monte Carlo is reproducible by inputs and by an explicit seed', () => {
  const a = simulateGame(4.8, 4.1, 8.5, 500)
  const b = simulateGame(4.8, 4.1, 8.5, 500)
  assert.deepEqual(a, b)
  assert.deepEqual(simulateGame(4.8, 4.1, 8.5, 500, 42), simulateGame(4.8, 4.1, 8.5, 500, 42))
  assert.notDeepEqual(simulateGame(4.8, 4.1, 8.5, 500, 42), simulateGame(4.8, 4.1, 8.5, 500, 43))

  const f = { muHome: 4.8, muAway: 4.1, homeSp: 3.2, homePen: 4.1, awaySp: 4.8, awayPen: 4.0 }
  assert.deepEqual(simulateF5(f, 4.5, 500), simulateF5(f, 4.5, 500))
  assert.equal(stableSeed('same', 1), stableSeed('same', 1))
})

test('bootstrap is deterministic and resamples whole date slates', () => {
  const y = [1, 0, 1, 0, 1, 1]
  const ps = { classic: [.6, .55, .7, .4, .52, .8], combined: [.62, .48, .68, .35, .57, .75] }
  const opts = { B: 100, seed: 1234, blocks: ['d1', 'd1', 'd2', 'd2', 'd3', 'd3'] }
  const a = bootstrapStability(y, ps, opts), b = bootstrapStability(y, ps, opts)
  assert.deepEqual(a, b)
  assert.equal(a.method, 'date_block')
  assert.equal(a.n_blocks, 3)
})

test('training rows are de-duplicated and late/final feature captures are quarantined', () => {
  const pregame = row(1)
  const sameGameLate = row(1, '2026-07-01', { status: 'Final', capture_phase: null, model_p: 0.99 })
  const lateOnly = row(2, '2026-07-02', { status: 'In Progress', capture_phase: null })
  const postponed = row(3, '2026-07-03', { status: 'Postponed' })
  const noFinal = row(4, '2026-07-04', { final: null })
  const backfilled = row(5, '2026-07-05', { status: 'Final', capture_phase: null, backfilled: true,
    feature_as_of: null, feature_hash: null,
    integrity: { ledger_version: 'v2', cohort: 'backfill_asof', training_eligible: true,
      reason: 'asof_backfill', first_pitch: '2026-07-05T23:00:00Z' } })
  const ledgerExcluded = row(6, '2026-07-06', { integrity: { training_eligible: false } })
  const forgedEligible = row(7, '2026-07-07', { integrity: { training_eligible: true } })
  const unknownCohort = row(8, '2026-07-08', { integrity: { cohort: 'legacy_unknown', training_eligible: true } })
  const nativeWithoutHash = row(9, '2026-07-09', { feature_hash: null })
  const deduped = dedupeGameRows([sameGameLate, pregame, lateOnly, postponed, noFinal, backfilled,
    ledgerExcluded, forgedEligible, unknownCohort, nativeWithoutHash])
  assert.equal(deduped.length, 9)
  assert.equal(deduped.find((r) => r.game_pk === 1).model_p, 0.55)
  assert.deepEqual(prepareTrainingRows(deduped).map((r) => r.game_pk).sort(), [1, 5])
})

test('team context counts only played, finalized appearances', () => {
  const played = row(11, '2026-07-01')
  const ungradedPlaceholder = row(12, '2026-07-02', { graded: false, home_win: null, final: null })
  const postponed = row(13, '2026-07-03', { status: 'Postponed' })
  const ctx = buildTeamContext([played, ungradedPlaceholder, postponed])
  assert.deepEqual(ctx('2026-07-04', 'CLE'), {
    homeForm10: null, roadForm10: null, pyth20: null,
    rest: 3, dens7: 1, prevParkAbbr: 'CLE',
  })
})

test('opening and closing odds keep auditable provenance; late capture cannot invent an open', () => {
  const lateOnly = mergeOddsBlocks(null, {
    stage: 'open', p_home_mkt: 0.56, ml_home: -125, ml_away: 110,
    over_under: 8, over_price: -105, under_price: -115,
    captured_at: '2026-07-01T23:30:00Z',
  })
  assert.equal(lateOnly.p_home_open, undefined)
  assert.equal(hasAuditableOpening(lateOnly), false)

  const legacyThenPregame = mergeOddsBlocks(
    { p_home_open: 0.91, over_under_open: 14, open_provenance: 'legacy_unknown' },
    { capture_phase: 'pregame', captured_at: '2026-07-01T12:00:00Z', p_home_mkt: 0.56,
      ml_home: -125, ml_away: 110, over_under: 8, over_price: -105, under_price: -115 },
  )
  assert.equal(legacyThenPregame.p_home_open, 0.56)
  assert.equal(legacyThenPregame.over_under_open, 8)

  const open = mergeOddsBlocks(null, {
    capture_phase: 'pregame', provider: 'book', captured_at: '2026-07-01T12:00:00Z',
    p_home_mkt: 0.56, ml_home: -125, ml_away: 110,
    over_under: 8, over_price: -105, under_price: -115,
  })
  const close = mergeOddsBlocks(open, {
    capture_phase: 'postgame', provider: 'book', captured_at: '2026-07-02T03:00:00Z',
    p_home_mkt: 0.59, ml_home: -145, ml_away: 125,
    over_under: 9, over_price: -110, under_price: -110,
  })
  assert.equal(close.p_home_open, 0.56)
  assert.equal(close.p_home_close, 0.59)
  assert.equal(close.over_under_open, 8)
  assert.equal(close.over_under_close, 9)
  assert.equal(close.open_provenance, 'explicit_pregame')
  assert.equal(close.captured_at_open, '2026-07-01T12:00:00Z')
  assert.equal(close.captured_at_close, '2026-07-02T03:00:00Z')
  assert.equal(close.close_provenance, 'explicit_close_capture')
  assert.equal(hasAuditableOpening(close, 'total'), true)

  const game = row(20, '2026-07-01', { adj_total: 9.2, odds: close })
  assert.equal(auditableOpeningMarketHome(game), 0.56)
  assert.equal(auditableClosingMarketHome(game), 0.59)
  assert.equal(auditableClosingMarketHome({ ...game, odds: { ...close, close_provenance: 'unknown' } }), null)
  assert.equal(totalAtMarket(game).publicable, true)
  assert.equal(auditableOpeningMarketHome({ ...game, start: '2026-07-01T10:00:00Z' }), null)
})

test('market-residual learner remains shadow and insufficient until its forward gate matures', () => {
  const rows = []
  for (let d = 1; d <= 8; d++) {
    const date = `2026-07-${String(d).padStart(2, '0')}`
    for (let i = 0; i < 3; i++) rows.push(row(d * 10 + i, date))
  }
  const run = walkForwardMarketResidual(rows, { minTrain: 6, lambda: 3 })
  assert.ok(run.n > 0)
  const report = marketResidualChallengerReport(rows, { minTrain: 6, minForward: 100, B: 50 })
  assert.equal(report.shadow, true)
  assert.equal(report.published, false)
  assert.equal(report.changes_public_model, false)
  assert.equal(report.gate.passes, false)
  assert.equal(report.gate.status, 'insufficient_data')
  assert.equal(report.cohorts.auditable_open, rows.length)
})

test('legacy market alpha never authorizes the public probability chain', () => {
  const rows = []
  for (let d = 1; d <= 8; d++) {
    const date = `2026-07-${String(d).padStart(2, '0')}`
    for (let i = 0; i < 3; i++) rows.push(row(d * 10 + i, date, {
      odds: { p_home_mkt: 0.56, fav_side: 'home' },
    }))
  }
  const report = marketAnchorReport(rows, { minTrain: 6, minForward: 10, minDates: 2, B: 50 })
  assert.ok(report.n > 0)
  assert.equal(report.legacy_improves_descriptive === true || report.legacy_improves_descriptive === false, true)
  assert.equal(report.improves, false)
  assert.equal(report.changes_public_model, false)
  assert.equal(report.production_chain.n, 0)
  assert.equal(report.production_chain.gate.passes, false)
  assert.equal(report.production_chain.status, 'insufficient_data')
  const today = row(999, '2026-07-21')
  assert.equal(authorizedMarketAnchor({ ml: { market_anchor: {
    improves: true, alpha: 0.2, production_chain: { gate: { passes: false }, changes_public_model: false },
  } } }, today), null)
  assert.equal(authorizedMarketAnchor({ ml: { market_anchor: { production_chain: {
    alpha: 0.3, gate: { passes: true }, changes_public_model: true,
  } } } }, { ...today, odds: { p_home_mkt: 0.9 } }), null)
  assert.deepEqual(authorizedMarketAnchor({ ml: { market_anchor: { production_chain: {
    alpha: 0.3, gate: { passes: true }, changes_public_model: true,
  } } } }, today), { alpha: 0.3, market: 0.53 })
})

test('market comparison counts only timestamped opening prices', () => {
  const audited = [row(201), row(202), row(203), row(204)]
  const measured = oddsReport(audited, { minN: 2, B: 50 })
  assert.equal(measured.auditable, true)
  assert.equal(measured.cohort, 'auditable_open_only')
  assert.equal(measured.n, 4)

  const legacy = audited.map((r) => ({ ...r, odds: { p_home_mkt: 0.53, fav_side: 'home' } }))
  const withheld = oddsReport(legacy, { minN: 2, B: 50 })
  assert.equal(withheld.n, 0)
  assert.equal(withheld.verdict, 'sin dato')
  assert.equal(withheld.market, null)
})

test('snapshot reports de-duplication and exclusion reasons without leaking late rows', () => {
  const input = [
    row(31),
    row(31, '2026-07-01', { status: 'Final', capture_phase: null, model_p: 0.99 }),
    row(32, '2026-07-02', { status: 'Final', capture_phase: null }),
    row(33, '2026-07-03', { status: 'Postponed' }),
    row(34, '2026-07-04', { graded: false, home_win: null, final: null }),
  ]
  const snap = buildSnapshot(input, { now: '2026-07-21T12:00:00Z' })
  assert.equal(snap.n_total, 4)
  assert.equal(snap.n_graded, 1)
  assert.equal(snap.training_quality.duplicate_game_pk_removed, 1)
  assert.equal(snap.training_quality.excluded.temporal_cohort_unverified, 1)
  assert.equal(snap.training_quality.excluded.invalid_status, 1)
  assert.equal(snap.training_quality.excluded.ungraded, 1)
  assert.equal(snap.ml.market_residual_challenger.published, false)
})
