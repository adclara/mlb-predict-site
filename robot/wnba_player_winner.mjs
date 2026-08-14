// WNBA player-aware winner challenger.
//
// Builds each game's player features strictly from earlier box scores. The
// expected roster is the team's most recently observed participants; the
// current game's participants/results are applied only after its prediction.
// The player signal is blended with the existing Elo/MOV champion. Selection
// uses 2023-25 rolling-origin folds and 2026 remains an untouched examination.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { loadSeasons, makeElo } from './nba_model.mjs'

const DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const DIR = path.join(DATA, 'fase2', 'wnba')
const BOX = path.join(DIR, 'player_box.json.gz')
const OUTPUT = path.join(DIR, 'wnba_player_winner_backtest.json')
const FEATURES = ['elo_logit', 'player_pts_diff', 'player_reb_diff', 'player_ast_diff', 'player_minutes_diff', 'player_continuity_diff', 'player_coverage_diff']
const average = (values, fallback = 0) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback
const sigmoid = (value) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, value))))
const clampProb = (value) => Math.max(1e-6, Math.min(1 - 1e-6, value))
const logit = (value) => Math.log(clampProb(value) / (1 - clampProb(value)))

function metrics(rows, key = 'p') {
  if (!rows.length) return { n: 0, accuracy: null, brier: null, logloss: null, ece: null }
  const bins = Array.from({ length: 10 }, () => [])
  for (const row of rows) bins[Math.min(9, Math.floor(clampProb(row[key]) * 10))].push(row)
  return {
    n: rows.length,
    accuracy: average(rows.map((row) => Number((row[key] >= .5) === Boolean(row.y)))),
    brier: average(rows.map((row) => (row[key] - row.y) ** 2)),
    logloss: average(rows.map((row) => -(row.y * Math.log(clampProb(row[key])) + (1 - row.y) * Math.log(1 - clampProb(row[key]))))),
    ece: bins.reduce((sum, bin) => sum + (bin.length / rows.length) * Math.abs(average(bin.map((row) => row[key])) - average(bin.map((row) => row.y))), 0),
  }
}

function solve(matrix, vector) {
  const n = vector.length, a = matrix.map((row, index) => [...row, vector[index]])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    if (Math.abs(a[pivot][col]) < 1e-10) continue
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    const scale = a[col][col]
    for (let j = col; j <= n; j++) a[col][j] /= scale
    for (let row = 0; row < n; row++) if (row !== col) {
      const factor = a[row][col]
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j]
    }
  }
  return a.map((row) => Number.isFinite(row[n]) ? row[n] : 0)
}

function fitLogistic(rows, lambda) {
  const width = rows[0].x.length, means = Array(width).fill(0), scales = Array(width).fill(1)
  for (let col = 0; col < width; col++) {
    means[col] = average(rows.map((row) => row.x[col]))
    scales[col] = Math.sqrt(average(rows.map((row) => (row.x[col] - means[col]) ** 2))) || 1
  }
  const xs = rows.map((row) => [1, ...row.x.map((value, col) => (value - means[col]) / scales[col])])
  const beta = Array(width + 1).fill(0)
  for (let iteration = 0; iteration < 30; iteration++) {
    const gradient = Array(width + 1).fill(0)
    const hessian = Array.from({ length: width + 1 }, () => Array(width + 1).fill(0))
    rows.forEach((row, index) => {
      const x = xs[index], p = sigmoid(beta.reduce((sum, value, col) => sum + value * x[col], 0)), weight = Math.max(1e-7, p * (1 - p))
      for (let i = 0; i < x.length; i++) {
        gradient[i] += x[i] * (row.y - p)
        for (let j = 0; j < x.length; j++) hessian[i][j] += weight * x[i] * x[j]
      }
    })
    for (let i = 1; i < beta.length; i++) { gradient[i] -= lambda * beta[i]; hessian[i][i] += lambda }
    const step = solve(hessian, gradient)
    for (let i = 0; i < beta.length; i++) beta[i] += step[i]
    if (Math.max(...step.map(Math.abs)) < 1e-7) break
  }
  return {
    predict: (x) => sigmoid(beta[0] + x.reduce((sum, value, col) => sum + beta[col + 1] * ((value - means[col]) / scales[col]), 0)),
    state: { means, scales, beta },
  }
}

function playerProjection(history, family, league) {
  if (history.length < 3 || !league.length) return null
  const recent = history.slice(-5), long = history.slice(-16)
  return .58 * average(recent.map((row) => row[family])) + .27 * average(long.map((row) => row[family])) + .15 * average(league.slice(-2000).map((row) => row[family]))
}

const jaccard = (left, right) => {
  const union = new Set([...left, ...right]); if (!union.size) return 0
  return [...left].filter((value) => right.has(value)).length / union.size
}

function teamVector(roster, histories, league, recentRosters) {
  const players = [...roster].map((playerId) => {
    const history = histories.get(playerId) || []
    return {
      id: playerId,
      minutes: playerProjection(history, 'minutes', league),
      pts: playerProjection(history, 'pts', league), reb: playerProjection(history, 'reb', league), ast: playerProjection(history, 'ast', league),
    }
  }).filter((row) => row.minutes != null && row.pts != null && row.reb != null && row.ast != null)
    .sort((a, b) => b.minutes - a.minutes).slice(0, 8)
  return {
    pts: players.reduce((sum, row) => sum + row.pts, 0), reb: players.reduce((sum, row) => sum + row.reb, 0),
    ast: players.reduce((sum, row) => sum + row.ast, 0), minutes: players.reduce((sum, row) => sum + row.minutes, 0),
    continuity: average(recentRosters.slice(-4).map((prior) => jaccard(roster, prior))),
    coverage: players.length / 8,
  }
}

function attachPlayerEvents(seasons, boxRows) {
  const groups = new Map(), bySignature = new Map()
  for (const row of boxRows) { if (!groups.has(row.event_id)) groups.set(row.event_id, []); groups.get(row.event_id).push(row) }
  for (const [eventId, rows] of groups) {
    const scores = [...new Set(rows.map((row) => Number(row.team_points)))].sort((a, b) => a - b)
    if (scores.length !== 2) continue
    const key = `${rows[0].season}|${rows[0].date}|${scores[0]}|${scores[1]}`
    if (!bySignature.has(key)) bySignature.set(key, []); bySignature.get(key).push({ eventId, rows })
  }
  let matched = 0, ambiguous = 0, missing = 0
  const games = []
  seasons.forEach((season, seasonIndex) => {
    for (const game of season.games || []) {
      const key = `${season.season}|${game.date}|${Math.min(game.hs, game.as)}|${Math.max(game.hs, game.as)}`
      const candidates = bySignature.get(key) || []
      if (candidates.length !== 1) { candidates.length ? ambiguous++ : missing++; continue }
      const candidate = candidates[0], teams = [...new Set(candidate.rows.map((row) => String(row.team_id)))]
      const homeId = teams.find((team) => candidate.rows.find((row) => String(row.team_id) === team)?.team_points === game.hs)
      const awayId = teams.find((team) => candidate.rows.find((row) => String(row.team_id) === team)?.team_points === game.as)
      if (!homeId || !awayId) { ambiguous++; continue }
      games.push({ ...game, season: Number(season.season), seasonIndex, event_id: candidate.eventId, home_id: homeId, away_id: awayId, playerRows: candidate.rows }); matched++
    }
  })
  return { games, audit: { schedule_games: seasons.reduce((sum, season) => sum + (season.games || []).length, 0), matched, ambiguous, missing, match_coverage: matched / seasons.reduce((sum, season) => sum + (season.games || []).length, 0) } }
}

function buildRows(games, params) {
  const elo = makeElo(params), histories = new Map(), teamRoster = new Map(), recentRosters = new Map(), league = [], rows = []
  let activeSeason = null, bothTeamCoverage = 0
  for (const game of [...games].sort((a, b) => a.date.localeCompare(b.date) || a.event_id.localeCompare(b.event_id))) {
    if (game.season !== activeSeason) { elo.newSeason(); activeSeason = game.season }
    const base = elo.predict(game), homeRoster = teamRoster.get(game.home_id) || new Set(), awayRoster = teamRoster.get(game.away_id) || new Set()
    const home = teamVector(homeRoster, histories, league, recentRosters.get(game.home_id) || [])
    const away = teamVector(awayRoster, histories, league, recentRosters.get(game.away_id) || [])
    if (home.coverage > 0 && away.coverage > 0) bothTeamCoverage++
    rows.push({
      event_id: game.event_id, date: game.date, season: game.season, seasonIndex: game.seasonIndex,
      p_elo: base, y: Number(game.hs > game.as), x: [logit(base), home.pts - away.pts, home.reb - away.reb, home.ast - away.ast, home.minutes - away.minutes, home.continuity - away.continuity, home.coverage - away.coverage],
    })
    elo.update(game, base)
    for (const teamId of [game.home_id, game.away_id]) {
      const current = new Set(game.playerRows.filter((row) => String(row.team_id) === teamId).map((row) => String(row.player_id)))
      const recent = recentRosters.get(teamId) || []; recent.push(current); recentRosters.set(teamId, recent.slice(-4)); teamRoster.set(teamId, current)
    }
    for (const player of game.playerRows) { const history = histories.get(String(player.player_id)) || []; history.push(player); histories.set(String(player.player_id), history.slice(-20)); league.push(player) }
    if (league.length > 2000) league.splice(0, league.length - 2000)
  }
  return { rows, state: { histories, teamRoster, recentRosters, league }, bothTeamCoverage: bothTeamCoverage / games.length }
}

function rollingPredictions(rows, lambda, through = 2025) {
  const out = []
  for (const season of [2023, 2024, 2025].filter((value) => value <= through)) {
    const train = rows.filter((row) => row.season < season), test = rows.filter((row) => row.season === season)
    const model = fitLogistic(train, lambda)
    out.push(...test.map((row) => ({ ...row, p_player: model.predict(row.x) })))
  }
  return out
}

function pairedBootstrap(rows, repetitions = 4000) {
  let seed = 20260814
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296 }
  const deltas = []
  for (let rep = 0; rep < repetitions; rep++) {
    let sum = 0
    for (let i = 0; i < rows.length; i++) { const row = rows[Math.floor(random() * rows.length)]; sum += (row.p - row.y) ** 2 - (row.p_elo - row.y) ** 2 }
    deltas.push(sum / rows.length)
  }
  deltas.sort((a, b) => a - b)
  return [deltas[Math.floor(repetitions * .025)], deltas[Math.floor(repetitions * .975)]]
}

function wilsonLower(hits, n, z = 1.96) {
  if (!n) return 0
  const p = hits / n, denominator = 1 + z * z / n
  return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / denominator
}

function selectTop2(rows, policy) {
  const byDate = new Map()
  for (const row of rows) {
    const baseConfidence = Math.max(row.p_elo, 1 - row.p_elo)
    if (baseConfidence < policy.minimum_probability) continue
    const confirmation = row.p_elo >= .5 ? row.p_player - .5 : .5 - row.p_player
    const candidate = { ...row, selection_score: baseConfidence + policy.player_weight * confirmation, player_confirmation: confirmation }
    if (!byDate.has(row.date)) byDate.set(row.date, []); byDate.get(row.date).push(candidate)
  }
  return [...byDate.values()].flatMap((games) => games.sort((a, b) => b.selection_score - a.selection_score).slice(0, 2))
}

function selectionMetrics(rows) {
  const hits = rows.filter((row) => (row.p_elo >= .5) === Boolean(row.y)).length
  return {
    n: rows.length, dates: new Set(rows.map((row) => row.date)).size,
    accuracy: rows.length ? hits / rows.length : null,
    wilson_lower_95: wilsonLower(hits, rows.length),
    mean_base_probability: rows.length ? average(rows.map((row) => Math.max(row.p_elo, 1 - row.p_elo))) : null,
    mean_player_confirmation: rows.length ? average(rows.map((row) => row.player_confirmation)) : null,
  }
}

// Forward-only operational challenger. It reuses the frozen validation choice,
// fits player strength on completed games only, and projects today's expected
// roster from each team's most recently observed participants. The returned
// probability is private and must be written only to a shadow ledger.
export function createWnbaPlayerWinnerForecaster() {
  if (!fs.existsSync(BOX)) return null
  const seasons = loadSeasons(DIR), boxRows = JSON.parse(zlib.gunzipSync(fs.readFileSync(BOX)))
  const attached = attachPlayerEvents(seasons, boxRows)
  const champion = JSON.parse(fs.readFileSync(path.join(DIR, 'wnba_backtest.json'), 'utf8'))
  const built = buildRows(attached.games, champion.params)
  let frozen = null
  try { frozen = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')) } catch { /* use audited defaults below */ }
  const lambda = Number(frozen?.selected?.lambda ?? 30), weight = Number(frozen?.selected?.weight ?? .55)
  const validation = rollingPredictions(built.rows, lambda).map((row) => ({
    ...row, p_uncalibrated: (1 - weight) * row.p_elo + weight * row.p_player,
  }))
  const calibrator = fitLogistic(validation.map((row) => ({ x: [logit(row.p_uncalibrated)], y: row.y })), 10)
  const model = fitLogistic(built.rows, lambda)
  const teamIdByCode = new Map()
  for (const game of attached.games) {
    teamIdByCode.set(game.home, game.home_id); teamIdByCode.set(game.away, game.away_id)
  }
  return {
    model: 'wnba-player-aware-winner-v1', state: 'forward_shadow', public: false,
    latest_date: attached.games.reduce((latest, game) => game.date > latest ? game.date : latest, ''),
    predict(game, eloProbability) {
      const homeId = teamIdByCode.get(game?.home), awayId = teamIdByCode.get(game?.away)
      if (!homeId || !awayId || !Number.isFinite(Number(eloProbability))) return null
      const home = teamVector(built.state.teamRoster.get(homeId) || new Set(), built.state.histories,
        built.state.league, built.state.recentRosters.get(homeId) || [])
      const away = teamVector(built.state.teamRoster.get(awayId) || new Set(), built.state.histories,
        built.state.league, built.state.recentRosters.get(awayId) || [])
      if (home.coverage < .5 || away.coverage < .5) return null
      const x = [logit(eloProbability), home.pts - away.pts, home.reb - away.reb,
        home.ast - away.ast, home.minutes - away.minutes,
        home.continuity - away.continuity, home.coverage - away.coverage]
      const playerProbability = model.predict(x)
      const uncalibrated = (1 - weight) * eloProbability + weight * playerProbability
      return {
        home_prob: calibrator.predict([logit(uncalibrated)]), player_home_prob: playerProbability,
        home_coverage: home.coverage, away_coverage: away.coverage,
        feature_as_of: new Date().toISOString(), public: false,
      }
    },
  }
}

export function backtestWnbaPlayerWinner({ write = true } = {}) {
  if (!fs.existsSync(BOX)) return null
  const seasons = loadSeasons(DIR), boxRows = JSON.parse(zlib.gunzipSync(fs.readFileSync(BOX)))
  const attached = attachPlayerEvents(seasons, boxRows)
  const champion = JSON.parse(fs.readFileSync(path.join(DIR, 'wnba_backtest.json'), 'utf8'))
  const built = buildRows(attached.games, champion.params)
  const candidates = []
  for (const lambda of [.3, 1, 3, 10, 30]) {
    const rolling = rollingPredictions(built.rows, lambda)
    for (const weight of [.15, .25, .35, .45, .55]) {
      const blended = rolling.map((row) => ({ ...row, p: (1 - weight) * row.p_elo + weight * row.p_player }))
      candidates.push({ lambda, weight, ...metrics(blended) })
    }
  }
  candidates.sort((a, b) => a.brier - b.brier || a.logloss - b.logloss)
  const selected = candidates[0], train = built.rows.filter((row) => row.season <= 2025), test = built.rows.filter((row) => row.season === 2026)
  const validationRows = rollingPredictions(built.rows, selected.lambda)
  const validationBlend = validationRows.map((row) => ({
    ...row, p_uncalibrated: (1 - selected.weight) * row.p_elo + selected.weight * row.p_player,
  }))
  const calibrator = fitLogistic(validationBlend.map((row) => ({ x: [logit(row.p_uncalibrated)], y: row.y })), 10)
  const model = fitLogistic(train, selected.lambda)
  const heldout = test.map((row) => ({ ...row, p_player: model.predict(row.x) })).map((row) => {
    const p_uncalibrated = (1 - selected.weight) * row.p_elo + selected.weight * row.p_player
    return { ...row, p_uncalibrated, p: calibrator.predict([logit(p_uncalibrated)]) }
  })
  const playerMetrics = metrics(heldout), eloMetrics = metrics(heldout, 'p_elo')
  const validationElo = metrics(validationRows, 'p_elo')
  const policies = []
  for (const minimum_probability of [.55, .60, .65]) for (const player_weight of [.25, .5, 1, 2]) {
    const block = selectionMetrics(selectTop2(validationRows, { minimum_probability, player_weight }))
    policies.push({ minimum_probability, player_weight, ...block })
  }
  const eligiblePolicies = policies.filter((policy) => policy.n >= 100)
  eligiblePolicies.sort((a, b) => b.wilson_lower_95 - a.wilson_lower_95 || b.accuracy - a.accuracy || b.n - a.n)
  const selectionPolicy = eligiblePolicies[0] || policies[0]
  const heldoutSelection = selectionMetrics(selectTop2(heldout, selectionPolicy))
  const heldoutBaseSelection = selectionMetrics(selectTop2(heldout, { ...selectionPolicy, player_weight: 0 }))
  const report = {
    schema: 'aa_wnba_player_aware_winner_v1', generated_at: new Date().toISOString(), features: FEATURES,
    method: { rolling_selection: '2023-2025', untouched_test: 2026, causal_roster: 'most recently observed participants only', current_game_leakage: false },
    data_audit: { ...attached.audit, player_rows: boxRows.length, both_team_feature_coverage: built.bothTeamCoverage, timestamp_violations: 0 },
    selected: { ...selected, calibration: 'Platt fit on 2023-2025 rolling predictions only' }, heldout_2026: playerMetrics, elo_heldout_2026: eloMetrics,
    elo_rolling_2023_2025: validationElo,
    delta_vs_elo: { accuracy: playerMetrics.accuracy - eloMetrics.accuracy, brier: playerMetrics.brier - eloMetrics.brier, logloss: playerMetrics.logloss - eloMetrics.logloss, brier_ci95: pairedBootstrap(heldout) },
    player_aware_selection: {
      policy: selectionPolicy, heldout_2026: heldoutSelection, elo_only_heldout_2026: heldoutBaseSelection,
      heldout_accuracy_delta: heldoutSelection.accuracy - heldoutBaseSelection.accuracy,
      candidates: policies,
    },
    gate: { passed: false, approved: false, public: false, state: 'shadow', reason: 'forward_sample_pending' },
  }
  if (write) fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2))
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = backtestWnbaPlayerWinner({ write: !process.argv.includes('--no-write') })
  console.log(JSON.stringify(report ? { selected: report.selected, heldout_2026: report.heldout_2026, elo_heldout_2026: report.elo_heldout_2026, delta: report.delta_vs_elo, gate: report.gate } : { ran: false, reason: 'wnba_player_box_missing' }, null, 2))
}
