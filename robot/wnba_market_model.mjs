// WNBA market lab — causal totals baseline + explicit closed prop/combo gates.
//
// This challenger never changes the public winner model. It uses only game
// information available before tip-off, refits chronologically, and evaluates
// seasons after a two-season burn-in. Historical ESPN files contain final team
// scores but no auditable prop lines/prices, so this file reports point-forecast
// quality for totals and keeps every betting gate closed.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSeasons } from './nba_model.mjs'
import { backtestWnbaPlayers } from './wnba_player_model.mjs'
import { backtestWnbaPlayerWinner } from './wnba_player_winner.mjs'

const DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const DIR = path.join(DATA, 'fase2', 'wnba')
const OUTPUT = path.join(DIR, 'wnba_markets_backtest.json')
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const average = (values, fallback = 0) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback
const dayDiff = (a, b) => b ? Math.max(0, Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000)) : 4

function solve(matrix, vector) {
  const n = vector.length
  const a = matrix.map((row, index) => [...row, vector[index]])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    if (Math.abs(a[pivot][col]) < 1e-10) continue
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    const scale = a[col][col]
    for (let j = col; j <= n; j++) a[col][j] /= scale
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = a[row][col]
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j]
    }
  }
  return a.map((row, index) => Number.isFinite(row[n]) ? row[n] : (index === 0 ? average(vector) : 0))
}

function fitRidge(rows, lambda) {
  const width = rows[0].x.length
  const means = Array(width).fill(0), scales = Array(width).fill(1)
  for (let col = 1; col < width; col++) {
    means[col] = average(rows.map((row) => row.x[col]))
    const variance = average(rows.map((row) => (row.x[col] - means[col]) ** 2))
    scales[col] = Math.sqrt(variance) || 1
  }
  const normalized = rows.map((row) => ({ x: row.x.map((value, col) => col ? (value - means[col]) / scales[col] : 1), y: row.y }))
  const xtx = Array.from({ length: width }, () => Array(width).fill(0)), xty = Array(width).fill(0)
  for (const row of normalized) for (let i = 0; i < width; i++) {
    xty[i] += row.x[i] * row.y
    for (let j = 0; j < width; j++) xtx[i][j] += row.x[i] * row.x[j]
  }
  for (let i = 1; i < width; i++) xtx[i][i] += lambda
  const beta = solve(xtx, xty)
  return {
    predict(x) { return beta.reduce((sum, value, col) => sum + value * (col ? (x[col] - means[col]) / scales[col] : 1), 0) },
  }
}

function causalRows(seasons) {
  const rows = [], leagueTotals = []
  for (let seasonIndex = 0; seasonIndex < seasons.length; seasonIndex++) {
    const teams = new Map()
    const state = (team) => {
      if (!teams.has(team)) teams.set(team, { scored: [], allowed: [], last: null })
      return teams.get(team)
    }
    const games = [...(seasons[seasonIndex].games || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))
    for (const game of games) {
      if (!game.home || !game.away || !Number.isFinite(Number(game.hs)) || !Number.isFinite(Number(game.as))) continue
      const home = state(game.home), away = state(game.away)
      const leagueTotal = average(leagueTotals.slice(-160), 161)
      const teamMean = leagueTotal / 2
      const hFor10 = average(home.scored.slice(-10), teamMean), hAllow10 = average(home.allowed.slice(-10), teamMean)
      const aFor10 = average(away.scored.slice(-10), teamMean), aAllow10 = average(away.allowed.slice(-10), teamMean)
      const month = Math.max(1, Math.min(12, Number(String(game.date).slice(5, 7)) || 6))
      const x = [
        1, leagueTotal, hFor10, hAllow10, aFor10, aAllow10,
        average(home.scored.slice(-5), hFor10), average(away.scored.slice(-5), aFor10),
        Math.min(7, dayDiff(game.date, home.last)), Math.min(7, dayDiff(game.date, away.last)),
        game.neutral ? 1 : 0, Math.sin(2 * Math.PI * month / 12), Math.cos(2 * Math.PI * month / 12),
      ]
      const y = Number(game.hs) + Number(game.as)
      rows.push({ x, y, baseline: leagueTotal, date: game.date, season: String(seasons[seasonIndex].season), seasonIndex })
      home.scored.push(Number(game.hs)); home.allowed.push(Number(game.as)); home.last = game.date
      away.scored.push(Number(game.as)); away.allowed.push(Number(game.hs)); away.last = game.date
      leagueTotals.push(y)
    }
  }
  return rows
}

function evaluate(rows, lambda, { trainBeforeSeason = 2, minTrain = 200, refitEvery = 20 } = {}) {
  const train = [], predictions = []
  let model = null, lastFit = -Infinity
  for (const row of rows) {
    if (row.seasonIndex >= trainBeforeSeason && train.length >= minTrain) {
      if (!model || train.length - lastFit >= refitEvery) { model = fitRidge(train, lambda); lastFit = train.length }
      const prediction = Math.max(100, Math.min(230, model.predict(row.x)))
      predictions.push({ ...row, prediction, error: prediction - row.y })
    }
    train.push(row)
  }
  return predictions
}

function metrics(rows) {
  if (!rows.length) return { n: 0, mae: null, rmse: null, bias: null, baseline_mae: null, interval80_coverage: null }
  const errors = rows.map((row) => row.error)
  const residualSd = Math.sqrt(average(errors.map((error) => error ** 2)))
  return {
    n: rows.length,
    mae: round(average(errors.map(Math.abs)), 3),
    rmse: round(residualSd, 3),
    bias: round(average(errors), 3),
    baseline_mae: round(average(rows.map((row) => Math.abs(row.baseline - row.y))), 3),
    interval80_coverage: round(rows.filter((row) => Math.abs(row.error) <= 1.2816 * residualSd).length / rows.length, 4),
  }
}

function selectLambda(rows, burnInSeasons) {
  let best = null
  for (const lambda of [0.3, 1, 3, 10, 30]) {
    const tune = evaluate(rows.filter((row) => row.seasonIndex < burnInSeasons), lambda, { trainBeforeSeason: 1, minTrain: 120, refitEvery: 15 })
    const score = metrics(tune).mae
    if (score != null && (!best || score < best.mae)) best = { lambda, mae: score }
  }
  return best || { lambda: 10, mae: null }
}

function latestTotalState(seasons) {
  const leagueTotals = []
  let teams = new Map(), latestDate = null, activeSeason = null
  const stateFor = (team) => {
    if (!teams.has(team)) teams.set(team, { scored: [], allowed: [], last: null })
    return teams.get(team)
  }
  for (const season of seasons) {
    teams = new Map(); activeSeason = Number(season.season)
    for (const game of [...(season.games || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
      if (!game.home || !game.away || !Number.isFinite(Number(game.hs)) || !Number.isFinite(Number(game.as))) continue
      const home = stateFor(game.home), away = stateFor(game.away)
      home.scored.push(Number(game.hs)); home.allowed.push(Number(game.as)); home.last = game.date
      away.scored.push(Number(game.as)); away.allowed.push(Number(game.hs)); away.last = game.date
      leagueTotals.push(Number(game.hs) + Number(game.as)); latestDate = game.date
    }
  }
  return { teams, leagueTotals, latestDate, activeSeason, stateFor }
}

function forwardTotalFeatures(state, game) {
  const home = state.stateFor(game.home), away = state.stateFor(game.away)
  const leagueTotal = average(state.leagueTotals.slice(-160), 161), teamMean = leagueTotal / 2
  const hFor10 = average(home.scored.slice(-10), teamMean), hAllow10 = average(home.allowed.slice(-10), teamMean)
  const aFor10 = average(away.scored.slice(-10), teamMean), aAllow10 = average(away.allowed.slice(-10), teamMean)
  const month = Math.max(1, Math.min(12, Number(String(game.date).slice(5, 7)) || 6))
  return [
    1, leagueTotal, hFor10, hAllow10, aFor10, aAllow10,
    average(home.scored.slice(-5), hFor10), average(away.scored.slice(-5), aFor10),
    Math.min(7, dayDiff(game.date, home.last)), Math.min(7, dayDiff(game.date, away.last)),
    game.neutral ? 1 : 0, Math.sin(2 * Math.PI * month / 12), Math.cos(2 * Math.PI * month / 12),
  ]
}

// Operational forecaster for the hourly shadow ledger. It exposes only a
// callable server-side object; coefficients never enter a report or KV blob.
export function createWnbaTotalForecaster({ burnInSeasons = 2 } = {}) {
  const seasons = loadSeasons(DIR)
  if (seasons.length <= burnInSeasons) throw new Error('WNBA total forecaster needs evaluation seasons after burn-in')
  const rows = causalRows(seasons), best = selectLambda(rows, burnInSeasons)
  const evaluated = evaluate(rows, best.lambda, { trainBeforeSeason: burnInSeasons })
  const oos = metrics(evaluated), model = fitRidge(rows, best.lambda)
  const state = latestTotalState(seasons)
  const resetSeason = (season) => {
    state.teams = new Map(); state.activeSeason = season
    state.stateFor = (team) => {
      if (!state.teams.has(team)) state.teams.set(team, { scored: [], allowed: [], last: null })
      return state.teams.get(team)
    }
  }
  return {
    model: 'causal_ridge_team_form_v1', selected_lambda: best.lambda,
    residual_sd: oos.rmse, latest_date: state.latestDate,
    predict(game) {
      if (!game?.home || !game?.away || !game?.date) return null
      return Math.max(100, Math.min(230, model.predict(forwardTotalFeatures(state, game))))
    },
    update(game) {
      if (!game?.home || !game?.away || !game?.date || !Number.isFinite(Number(game.hs)) || !Number.isFinite(Number(game.as))) return false
      const season = Number(String(game.date).slice(0, 4))
      if (state.activeSeason !== season) resetSeason(season)
      const home = state.stateFor(game.home), away = state.stateFor(game.away)
      home.scored.push(Number(game.hs)); home.allowed.push(Number(game.as)); home.last = game.date
      away.scored.push(Number(game.as)); away.allowed.push(Number(game.hs)); away.last = game.date
      state.leagueTotals.push(Number(game.hs) + Number(game.as)); state.latestDate = game.date
      return true
    },
  }
}

export function backtestWnbaMarkets({ burnInSeasons = 2, write = true } = {}) {
  const seasons = loadSeasons(DIR)
  if (seasons.length <= burnInSeasons) throw new Error('WNBA market lab needs evaluation seasons after burn-in')
  const rows = causalRows(seasons)
  const best = selectLambda(rows, burnInSeasons)
  const out = evaluate(rows, best.lambda, { trainBeforeSeason: burnInSeasons })
  const overall = metrics(out)
  const perSeason = Object.fromEntries(seasons.slice(burnInSeasons).map((season) => {
    const subset = out.filter((row) => row.season === String(season.season))
    return [String(season.season), metrics(subset)]
  }))
  let winner = null
  try { winner = JSON.parse(fs.readFileSync(path.join(DIR, 'wnba_backtest.json'), 'utf8')) } catch { /* report remains independently usable */ }
  const playerReport = backtestWnbaPlayers({ write })
  const playerWinner = backtestWnbaPlayerWinner({ write })
  const closed = (reason, minForward) => ({ passed: false, approved: false, public: false, reason, min_forward: minForward, min_dates: 30 })
  const report = {
    schema: 'aa_multisport_simulation_v1', sport: 'wnba', generated_at: new Date().toISOString(),
    seasons: seasons.map((season) => String(season.season)), burn_in: seasons.slice(0, burnInSeasons).map((season) => String(season.season)),
    winner: {
      historical: winner ? { n: winner.n_eval, ...winner.metrics } : null,
      player_aware_shadow: playerWinner ? {
        validation: playerWinner.selected,
        elo_validation: playerWinner.elo_rolling_2023_2025,
        heldout_2026: playerWinner.heldout_2026,
        elo_heldout_2026: playerWinner.elo_heldout_2026,
        delta_vs_elo: playerWinner.delta_vs_elo,
        selection: playerWinner.player_aware_selection,
        data_audit: playerWinner.data_audit,
        gate: playerWinner.gate,
      } : null,
      gate: closed('forward_sample_pending', 200),
    },
    total: {
      model: 'causal_ridge_team_form_v1', selected_lambda: best.lambda, tune_mae: best.mae,
      historical: overall, per_season: perSeason, market_line_coverage: 0, forward: { n: 0, dates: 0 },
      gate: closed('market_lines_unavailable', 200),
      note: 'Point forecast only. Historical files do not contain auditable pregame total lines/prices, so no Over/Under signal is authorized.',
    },
    players: playerReport?.families || Object.fromEntries(['pts', 'reb', 'ast'].map((family) => [family, {
      historical: null, market_line_coverage: 0, forward: { n: 0, dates: 0 }, gate: closed('player_boxscore_backfill_pending', 200),
    }])),
    combos: { forward: { n: 0, dates: 0 }, gate: closed('individual_markets_not_public', 100) },
  }
  if (write) fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2))
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = backtestWnbaMarkets({ write: process.argv[2] !== '--no-write' })
  console.log(JSON.stringify({ sport: report.sport, total: report.total.historical, gate: report.total.gate, players: report.players }, null, 2))
}
