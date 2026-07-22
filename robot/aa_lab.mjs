// AA Lab MLB — forward-only shadow challenger.
//
// The fitted parameters come from the audited 2021-2025 rolling-season study.
// This module reconstructs ONLY facts known before the target date, writes a
// private shadow ledger, and never changes AA's public probability or picks.
import fs from 'node:fs'
import { createHash } from 'node:crypto'

const DEFAULT_MODEL = JSON.parse(fs.readFileSync(new URL('./models/aa_lab_mlb_v1.json', import.meta.url), 'utf8'))
const EXP = 1.83
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null
const round6 = (value) => value == null ? null : Math.round(value * 1e6) / 1e6
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value
const hash = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const sigmoid = (value) => value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value))
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const dateGap = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5)
const dayNumber = (day) => dateGap(day, `${day.slice(0, 4)}-03-01`)

function pythag(runsFor, runsAgainst) {
  if (!(runsFor + runsAgainst > 0)) return null
  const a = runsFor ** EXP, b = runsAgainst ** EXP
  return a / (a + b)
}

function summary(games) {
  if (!games.length) return { win: 0.5, pyth: 0.5, rf: 4.5, ra: 4.5, n: 0 }
  const wins = games.filter((game) => game.won).length
  const rf = games.reduce((sum, game) => sum + game.rf, 0)
  const ra = games.reduce((sum, game) => sum + game.ra, 0)
  return { win: wins / games.length, pyth: pythag(rf, ra), rf: rf / games.length, ra: ra / games.length, n: games.length }
}

function rolling(games, window) {
  const sample = games.slice(-window)
  if (!sample.length) return { win: null, rf: null, ra: null, rd: null, pyth: null }
  const rf = sample.reduce((sum, game) => sum + game.rf, 0)
  const ra = sample.reduce((sum, game) => sum + game.ra, 0)
  return {
    win: sample.filter((game) => game.won).length / sample.length,
    rf: rf / sample.length, ra: ra / sample.length,
    rd: (rf - ra) / sample.length, pyth: pythag(rf, ra),
  }
}

const priorFor = (state, team) => state.prior[team] || { win: 0.5, pyth: 0.5, rf: 4.5, ra: 4.5, n: 0 }
const listFor = (map, key) => map.get(key) || []
const setList = (map, key, value) => { map.set(key, value); return value }
const h2hKey = (home, away) => [home, away].sort().join('|')

function copyInitialState(model) {
  const initial = model.initial_2026_state
  return {
    prior: structuredClone(initial.prior),
    elo: structuredClone(initial.elo),
    parkHistory: new Map(Object.entries(initial.park_history).map(([team, values]) => [team, [...values]])),
    leagueTotals: [...initial.league_totals],
    teamGames: new Map(), h2h: new Map(),
  }
}

function normalizeFinalRow(row) {
  if (!row || !String(row.date || '').startsWith('2026-') || row.home_win == null || !/^\d+-\d+$/.test(String(row.final || ''))) return null
  const [awayRuns, homeRuns] = String(row.final).split('-').map(Number)
  if (![awayRuns, homeRuns].every(Number.isFinite) || !row.home || !row.away) return null
  return {
    game_pk: String(row.game_pk), date: row.date,
    start: row.first_pitch || row.game_datetime || row.start || null,
    home: row.home, away: row.away, home_runs: homeRuns, away_runs: awayRuns,
    home_win: Number(row.home_win) === 1 ? 1 : 0,
  }
}

function applyDate(state, games) {
  const eloBefore = { ...state.elo }
  const eloChanges = new Map()
  const addElo = (team, change) => eloChanges.set(team, (eloChanges.get(team) || 0) + change)
  for (const game of [...games].sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.game_pk.localeCompare(b.game_pk))) {
    const homeElo = eloBefore[game.home] ?? 1500, awayElo = eloBefore[game.away] ?? 1500
    const expected = 1 / (1 + 10 ** (-((homeElo + 30) - awayElo) / 400))
    const change = 20 * (game.home_win - expected)
    addElo(game.home, change); addElo(game.away, -change)

    const homeGames = listFor(state.teamGames, game.home)
    const awayGames = listFor(state.teamGames, game.away)
    homeGames.push({ date: game.date, won: game.home_win === 1, rf: game.home_runs, ra: game.away_runs, at_home: true })
    awayGames.push({ date: game.date, won: game.home_win === 0, rf: game.away_runs, ra: game.home_runs, at_home: false })
    setList(state.teamGames, game.home, homeGames); setList(state.teamGames, game.away, awayGames)
    const seriesKey = h2hKey(game.home, game.away)
    const series = listFor(state.h2h, seriesKey)
    series.push({ winner: game.home_win ? game.home : game.away })
    setList(state.h2h, seriesKey, series)
    const total = game.home_runs + game.away_runs
    const park = listFor(state.parkHistory, game.home)
    park.push(total)
    if (park.length > 100) park.splice(0, park.length - 100)
    setList(state.parkHistory, game.home, park)
    state.leagueTotals.push(total)
    if (state.leagueTotals.length > 500) state.leagueTotals.splice(0, state.leagueTotals.length - 500)
  }
  for (const [team, change] of eloChanges) state.elo[team] = (state.elo[team] ?? 1500) + change
}

export function replayAaLabState(historyRows, targetDate, model = DEFAULT_MODEL) {
  if (!/^2026-\d{2}-\d{2}$/.test(String(targetDate || ''))) throw new Error('aa_lab_v1 supports 2026 target dates only')
  const state = copyInitialState(model)
  const byDate = new Map()
  const seen = new Set()
  for (const raw of historyRows || []) {
    const game = normalizeFinalRow(raw)
    if (!game || game.date >= targetDate || seen.has(game.game_pk)) continue
    seen.add(game.game_pk)
    const group = byDate.get(game.date) || []
    group.push(game); byDate.set(game.date, group)
  }
  for (const day of [...byDate.keys()].sort()) applyDate(state, byDate.get(day))
  return state
}

function streak(games) {
  if (!games.length) return 0
  const direction = games.at(-1).won ? 1 : -1
  let length = 0
  for (let i = games.length - 1; i >= 0; i--) {
    if ((games[i].won ? 1 : -1) !== direction) break
    length++
  }
  return direction * Math.min(length, 6)
}

export function aaLabFeatures(state, { date, home, away }) {
  const homeGames = listFor(state.teamGames, home), awayGames = listFor(state.teamGames, away)
  const h20 = rolling(homeGames, 20), a20 = rolling(awayGames, 20)
  const hp = priorFor(state, home), ap = priorFor(state, away)
  const blended = (games, previous, key, equivalent = 20) => {
    const current = summary(games), n = games.length
    return (previous[key] * equivalent + current[key] * n) / (equivalent + n)
  }
  const homeSplit = homeGames.filter((game) => game.at_home).slice(-10).map((game) => game.won ? 1 : 0)
  const awaySplit = awayGames.filter((game) => !game.at_home).slice(-10).map((game) => game.won ? 1 : 0)
  const split = homeSplit.length && awaySplit.length ? mean(homeSplit) - mean(awaySplit) : null
  const homeRest = homeGames.length ? dateGap(date, homeGames.at(-1).date) : null
  const awayRest = awayGames.length ? dateGap(date, awayGames.at(-1).date) : null
  const rest = homeRest != null && awayRest != null
    ? Math.min(7, Math.max(0, homeRest)) - Math.min(7, Math.max(0, awayRest)) : null
  const homeDensity = homeGames.filter((game) => dateGap(date, game.date) <= 7).length
  const awayDensity = awayGames.filter((game) => dateGap(date, game.date) <= 7).length
  const series = listFor(state.h2h, h2hKey(home, away))
  const h2h = Math.max(-4, Math.min(4, series.reduce((sum, game) => sum + (game.winner === home ? 1 : -1), 0)))
  const leagueMean = mean(state.leagueTotals.slice(-500))
  const parkMean = mean(listFor(state.parkHistory, home).slice(-100))
  const parkFactor = parkMean != null && leagueMean ? parkMean / leagueMean : null
  return {
    pyth20_diff: h20.pyth != null && a20.pyth != null ? h20.pyth - a20.pyth : null,
    blended_pyth_diff: blended(homeGames, hp, 'pyth') - blended(awayGames, ap, 'pyth'),
    split_form_diff: split,
    prior_pyth_diff: hp.pyth - ap.pyth,
    elo_diff: ((state.elo[home] ?? 1500) - (state.elo[away] ?? 1500)) / 100,
    rest_diff: rest,
    density7_diff: awayDensity - homeDensity,
    streak_diff: streak(homeGames) - streak(awayGames),
    h2h_diff: h2h,
    park_runs_factor: parkFactor,
    league_runs_environment: leagueMean != null ? leagueMean / 2 : null,
    season_progress: dayNumber(date) / 220,
  }
}

export function aaLabProbability(features, model = DEFAULT_MODEL) {
  let linear = Number(model.intercept)
  const normalized = {}
  model.features.forEach((name, index) => {
    const raw = finite(features?.[name]) ?? Number(model.imputer_medians[index])
    const scale = Number(model.scaler_scale[index]) || 1
    const value = (raw - Number(model.scaler_mean[index])) / scale
    normalized[name] = value
    linear += Number(model.coefficients[index]) * value
  })
  const rawProbability = sigmoid(linear)
  const calibrated = sigmoid(Number(model.platt.slope) * linear + Number(model.platt.intercept))
  return { raw: rawProbability, calibrated, normalized }
}

export function buildAaLabSlate({ date, games, historyRows, generatedAt, model = DEFAULT_MODEL }) {
  const state = replayAaLabState(historyRows, date, model)
  const predictions = (games || []).filter((game) => game?.game_pk != null && game.home && game.away).map((game) => {
    const features = aaLabFeatures(state, { date, home: game.home, away: game.away })
    const probability = aaLabProbability(features, model)
    const homeProb = round6(probability.calibrated)
    const start = game.first_pitch || game.game_datetime || null
    // Compare against the exact HOME probability authorized by AA's public
    // chain. p_learn can diverge when a future market-anchor gate is enabled;
    // using p_final keeps the paired forward audit apples-to-apples.
    const aaHomeProb = finite(game.p_final)
    const pick = homeProb >= 0.5 ? game.home : game.away
    return {
      game_pk: game.game_pk, matchup: `${game.away} @ ${game.home}`, market: 'ml',
      home: game.home, away: game.away, pick, home_prob: homeProb,
      raw_home_prob: round6(probability.raw), margin: round6(Math.abs(homeProb - 0.5)),
      aa_pick: game.ml_pick || null, aa_home_prob: aaHomeProb == null ? null : round6(aaHomeProb),
      agrees_with_aa: game.ml_pick ? pick === game.ml_pick : null,
      scheduled_start_utc: start, feature_as_of: generatedAt,
      features: Object.fromEntries(Object.entries(features).map(([key, value]) => [key, round6(value)])),
      feature_hash: hash({ version: model.version, date, game_pk: game.game_pk, features }),
      selected: false,
    }
  })
  const eligible = predictions.filter((prediction) => prediction.scheduled_start_utc
    && Date.parse(generatedAt) < Date.parse(prediction.scheduled_start_utc))
    .sort((a, b) => b.margin - a.margin || String(a.game_pk).localeCompare(String(b.game_pk)))
    .slice(0, model.selection_policy.max_per_day)
  const selected = new Set(eligible.map((prediction) => String(prediction.game_pk)))
  for (const prediction of predictions) prediction.selected = selected.has(String(prediction.game_pk))
  return {
    schema: model.schema, version: model.version, model: model.model,
    status: 'forward_shadow', published: false, changes_public_model: false,
    trained_through: model.trained_through, generated_at: generatedAt,
    feature_date_cutoff: date, selection_policy: model.selection_policy,
    predictions,
  }
}

function metricBlock(predictions, probabilityKey = 'home_prob') {
  const rows = predictions.filter((prediction) => ['win', 'loss'].includes(prediction.result)
    && finite(prediction[probabilityKey]) != null)
  if (!rows.length) return { n: 0, dates: 0, wins: 0, losses: 0, accuracy: null, logloss: null, brier: null, ece: null }
  const values = rows.map((prediction) => {
    const y = prediction.pick === prediction.home
      ? (prediction.result === 'win' ? 1 : 0)
      : (prediction.result === 'win' ? 0 : 1)
    const p = Math.max(1e-6, Math.min(1 - 1e-6, Number(prediction[probabilityKey])))
    return { y, p, correct: (p >= 0.5) === (y === 1), date: prediction.ledger_date }
  })
  const bins = Array.from({ length: 10 }, () => [])
  for (const row of values) bins[Math.min(9, Math.floor(row.p * 10))].push(row)
  const ece = bins.reduce((total, bin) => !bin.length ? total : total
    + bin.length / values.length * Math.abs(mean(bin.map((row) => row.p)) - mean(bin.map((row) => row.y))), 0)
  const wins = values.filter((row) => row.correct).length
  return {
    n: values.length, dates: new Set(values.map((row) => row.date)).size,
    wins, losses: values.length - wins, accuracy: wins / values.length,
    logloss: -mean(values.map((row) => row.y * Math.log(row.p) + (1 - row.y) * Math.log(1 - row.p))),
    brier: mean(values.map((row) => (row.p - row.y) ** 2)), ece,
  }
}

function pairedBootstrap(predictions, repetitions = 1000, seed = 20260722) {
  const rows = predictions.filter((prediction) => ['win', 'loss'].includes(prediction.result)
    && finite(prediction.home_prob) != null && finite(prediction.aa_home_prob) != null)
  const grouped = new Map()
  for (const row of rows) { const list = grouped.get(row.ledger_date) || []; list.push(row); grouped.set(row.ledger_date, list) }
  const blocks = [...grouped.values()]
  if (!blocks.length) return null
  let state = seed >>> 0
  const random = () => (state = (1664525 * state + 1013904223) >>> 0) / 4294967296
  const deltas = { accuracy: [], logloss: [], brier: [] }
  for (let repeat = 0; repeat < repetitions; repeat++) {
    const sample = []
    for (let i = 0; i < blocks.length; i++) sample.push(...blocks[Math.floor(random() * blocks.length)])
    const lab = metricBlock(sample, 'home_prob'), aa = metricBlock(sample, 'aa_home_prob')
    deltas.accuracy.push(lab.accuracy - aa.accuracy)
    deltas.logloss.push(lab.logloss - aa.logloss)
    deltas.brier.push(lab.brier - aa.brier)
  }
  return Object.fromEntries(Object.entries(deltas).map(([key, values]) => {
    values.sort((a, b) => a - b)
    return [key, { mean: mean(values), ci95: [values[Math.floor(0.025 * values.length)], values[Math.floor(0.975 * values.length)]] }]
  }))
}

export function buildAaLabForwardReport(dailyDocs, { updatedAt = new Date().toISOString() } = {}) {
  const predictions = []
  for (const doc of dailyDocs || []) for (const prediction of doc?.shadow?.aa_lab?.predictions || []) {
    predictions.push({ ...prediction, ledger_date: doc.date })
  }
  // Shadow candidates are never public-eligible by definition, so their
  // temporal_scope is the authoritative pregame guard. A delayed first run can
  // observe games already underway; those rows stay auditable but never enter
  // forward metrics or the promotion gate.
  const causal = predictions.filter((prediction) => prediction.temporal_scope === 'public_live')
  const graded = causal.filter((prediction) => ['win', 'loss'].includes(prediction.result))
  const selected = graded.filter((prediction) => prediction.selected === true)
  const agreementSelected = selected.filter((prediction) => prediction.agrees_with_aa === true)
  const all = metricBlock(graded), aa = metricBlock(graded, 'aa_home_prob')
  const topTwo = metricBlock(selected), agreement = metricBlock(agreementSelected)
  const paired = pairedBootstrap(graded)
  const enough = all.n >= 300 && all.dates >= 30
  const promotionEligible = !!(enough && paired && paired.logloss.ci95[1] < 0
    && paired.brier.ci95[1] <= 0 && all.ece <= 0.05)
  return {
    schema: 'aa_lab_forward_report_v1', version: DEFAULT_MODEL.version,
    updated_at: updatedAt, status: enough ? 'evaluating' : 'collecting',
    published: false, changes_public_model: false,
    observed_predictions: predictions.length,
    excluded_nonpregame: predictions.length - causal.length,
    all, aa_comparator: aa, selected_top_two: topTwo, selected_agreement: agreement,
    paired_delta_lab_minus_aa: paired,
    gate: {
      min_games: 300, min_dates: 30, ece_max: 0.05,
      enough_forward_data: enough, promotion_eligible: promotionEligible,
      human_approval_required: true, passes: false,
      note: promotionEligible
        ? 'Evidencia estadística lista para revisión humana; sigue cerrado.'
        : 'AA Lab permanece en sombra hasta cumplir muestra, proper scores y calibración.',
    },
  }
}

export { DEFAULT_MODEL as AA_LAB_MODEL }
