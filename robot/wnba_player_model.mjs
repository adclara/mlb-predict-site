// WNBA player-market lab: keyless box-score backfill + causal PTS/REB/AST.
//
// The output is descriptive shadow evidence. ESPN's historical summaries do
// not provide auditable pregame prop lines/prices, so every prop gate remains
// closed regardless of point-forecast quality.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const DIR = path.join(DATA, 'fase2', 'wnba')
const BOX = path.join(DIR, 'player_box.json.gz')
const REPORT = path.join(DIR, 'wnba_player_backtest.json')
const FAMILIES = ['pts', 'reb', 'ast']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const average = (values, fallback = null) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const num = (value) => { const parsed = Number(String(value ?? '').replaceAll(',', '')); return Number.isFinite(parsed) ? parsed : null }

async function json(url, tries = 4) {
  const candidates = [url, url.replace('site.web.api.espn.com', 'site.api.espn.com')]
  let last = null
  for (let attempt = 0; attempt < tries; attempt++) {
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate, { headers: { accept: 'application/json', 'user-agent': 'aa-sports/1.0' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      } catch (error) { last = error }
    }
    if (attempt + 1 < tries) await sleep(300 * (2 ** attempt))
  }
  throw new Error(`WNBA ESPN request failed: ${last?.message || 'unknown'}`)
}

function readBox() {
  if (!fs.existsSync(BOX)) return []
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(BOX)).toString('utf8'))
}

function writeBox(rows) {
  const encoded = Buffer.from(JSON.stringify(rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.event_id).localeCompare(String(b.event_id)) || String(a.player_id).localeCompare(String(b.player_id)))))
  fs.writeFileSync(BOX, zlib.gzipSync(encoded, { level: 9 }))
}

function seasonDates({ recent = false } = {}) {
  const dates = new Set()
  if (!recent) {
    for (const file of fs.readdirSync(DIR).filter((name) => /^\d{4}\.json$/.test(name))) {
      const doc = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'))
      for (const game of doc.games || []) if (game.date) dates.add(game.date)
    }
  }
  if (recent) {
    const now = new Date()
    for (let offset = 21; offset >= 0; offset--) {
      const date = new Date(now); date.setUTCDate(date.getUTCDate() - offset)
      dates.add(date.toISOString().slice(0, 10))
    }
  }
  return [...dates].sort()
}

function scoreboardEvents(doc, date) {
  const events = []
  for (const event of doc.events || []) {
    const competition = event.competitions?.[0] || {}
    const status = competition.status?.type || event.status?.type || {}
    if (!(status.completed || String(status.name || '').toUpperCase().includes('FINAL'))) continue
    if (![2, 3].includes(Number(event.season?.type))) continue
    const competitors = competition.competitors || []
    const home = competitors.find((item) => item.homeAway === 'home') || {}
    const away = competitors.find((item) => item.homeAway === 'away') || {}
    if (!event.id || !home.team?.id || !away.team?.id) continue
    events.push({
      event_id: String(event.id), date, season: Number(String(date).slice(0, 4)),
      home_id: String(home.team.id), away_id: String(away.team.id),
      home_points: num(home.score), away_points: num(away.score),
    })
  }
  return events
}

function normalizeSummary(game, doc) {
  const rows = []
  const opponent = { [game.home_id]: game.away_id, [game.away_id]: game.home_id }
  const score = { [game.home_id]: game.home_points, [game.away_id]: game.away_points }
  for (const block of doc.boxscore?.players || []) {
    const teamId = String(block.team?.id || '')
    if (!teamId) continue
    for (const group of block.statistics || []) {
      const labels = (group.labels || group.names || []).map(String)
      const index = Object.fromEntries(labels.map((label, position) => [label, position]))
      if (!FAMILIES.every((family) => index[family.toUpperCase()] != null)) continue
      for (const entry of group.athletes || []) {
        const athlete = entry.athlete || {}
        const stats = entry.stats || []
        const minutes = num(stats[index.MIN])
        if (!athlete.id || entry.didNotPlay || !(minutes > 0)) continue
        rows.push({
          event_id: game.event_id, date: game.date, season: game.season,
          team_id: teamId, opponent_id: opponent[teamId] || null,
          team_points: score[teamId], opponent_points: score[opponent[teamId]],
          player_id: String(athlete.id), player_name: athlete.displayName || athlete.shortName || null,
          position: athlete.position?.abbreviation || null, minutes,
          pts: num(stats[index.PTS]), reb: num(stats[index.REB]), ast: num(stats[index.AST]),
        })
      }
      break
    }
  }
  return rows.filter((row) => FAMILIES.every((family) => row[family] != null))
}

async function inBatches(items, size, task) {
  const out = []
  for (let index = 0; index < items.length; index += size) {
    out.push(...await Promise.all(items.slice(index, index + size).map(task)))
    if (index && index % (size * 10) === 0) console.log(`  WNBA player backfill ${Math.min(items.length, index + size)}/${items.length}`)
    await sleep(40)
  }
  return out.flat()
}

export async function backfillWnbaPlayers({ recent = false } = {}) {
  fs.mkdirSync(DIR, { recursive: true })
  const existing = readBox()
  const covered = new Set(existing.map((row) => row.event_id))
  const dates = seasonDates({ recent })
  const games = await inBatches(dates, 12, async (date) => {
    const day = date.replaceAll('-', '')
    const doc = await json(`https://site.web.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${day}&limit=100`)
    return scoreboardEvents(doc, date)
  })
  const discovered = new Set(games.map((game) => game.event_id))
  const missing = [...new Map(games.filter((game) => !covered.has(game.event_id)).map((game) => [game.event_id, game])).values()]
  const additions = await inBatches(missing, 14, async (game) => {
    const doc = await json(`https://site.web.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event=${game.event_id}`)
    const rows = normalizeSummary(game, doc)
    if (!rows.length) throw new Error(`WNBA ${game.event_id}: player box score empty`)
    return rows
  })
  const merged = [...(recent ? existing : existing.filter((row) => discovered.has(row.event_id))), ...additions]
  writeBox(merged)
  return {
    source: 'ESPN public scoreboard + summary', dates_checked: dates.length,
    games_discovered: discovered.size,
    games_added: missing.length, games_covered: new Set(merged.map((row) => row.event_id)).size,
    player_rows: merged.length, seasons: [...new Set(merged.map((row) => row.season))].sort(),
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

function fitRidge(rows, lambda) {
  const width = rows[0].x.length, means = Array(width).fill(0), scales = Array(width).fill(1)
  for (let col = 1; col < width; col++) {
    means[col] = average(rows.map((row) => row.x[col]), 0)
    scales[col] = Math.sqrt(average(rows.map((row) => (row.x[col] - means[col]) ** 2), 0)) || 1
  }
  const xtx = Array.from({ length: width }, () => Array(width).fill(0)), xty = Array(width).fill(0)
  for (const row of rows) {
    const x = row.x.map((value, col) => col ? (value - means[col]) / scales[col] : 1)
    for (let i = 0; i < width; i++) { xty[i] += x[i] * row.y; for (let j = 0; j < width; j++) xtx[i][j] += x[i] * x[j] }
  }
  for (let i = 1; i < width; i++) xtx[i][i] += lambda
  const beta = solve(xtx, xty)
  return (x) => beta.reduce((sum, value, col) => sum + value * (col ? (x[col] - means[col]) / scales[col] : 1), 0)
}

function causalRows(rows, family) {
  const players = new Map(), teams = new Map(), opponents = new Map(), out = []
  const state = (map, key) => { if (!map.has(key)) map.set(key, []); return map.get(key) }
  const games = new Map()
  for (const row of rows) { if (!games.has(row.event_id)) games.set(row.event_id, []); games.get(row.event_id).push(row) }
  const ordered = [...games.values()].sort((a, b) => String(a[0].date).localeCompare(String(b[0].date)) || String(a[0].event_id).localeCompare(String(b[0].event_id)))
  for (const gameRows of ordered) {
    for (const row of gameRows) {
      const history = state(players, row.player_id)
      const teamHistory = state(teams, row.team_id)
      const defenseHistory = state(opponents, row.opponent_id)
      if (history.length >= 3) {
        const recent = history.slice(-5), season = history.filter((item) => item.season === row.season).slice(-20)
        const lastDate = recent.at(-1).date
        const rest = Math.max(0, Math.min(10, Math.round((Date.parse(`${row.date}T12:00:00Z`) - Date.parse(`${lastDate}T12:00:00Z`)) / 86400000)))
        out.push({
          x: [1, average(recent.map((item) => item[family]), 0), average(season.map((item) => item[family]), average(recent.map((item) => item[family]), 0)),
            average(recent.map((item) => item.minutes), 0), average(teamHistory.slice(-10).map((item) => item.gameTotal), 160),
            average(defenseHistory.slice(-10).map((item) => item[family]), average(recent.map((item) => item[family]), 0)), rest],
          y: row[family], baseline: recent.at(-1)[family], date: row.date, feature_as_of: lastDate,
          season: row.season, seasonIndex: Math.max(0, row.season - 2021),
        })
      }
    }
    const totals = new Map()
    for (const row of gameRows) {
      const key = `${row.team_id}`
      if (!totals.has(key)) totals.set(key, 0)
      totals.set(key, totals.get(key) + row[family])
      state(players, row.player_id).push(row)
    }
    for (const teamId of new Set(gameRows.map((row) => row.team_id))) {
      const representative = gameRows.find((row) => row.team_id === teamId)
      state(teams, teamId).push({ gameTotal: representative.team_points + representative.opponent_points })
      state(opponents, teamId).push({ [family]: totals.get(String(representative.opponent_id)) || 0 })
    }
  }
  return out
}

function evaluate(rows, lambda, evalFrom = 2) {
  const train = [], out = [], residuals = []
  let model = null, lastFit = -Infinity
  for (const row of rows) {
    if (row.seasonIndex >= evalFrom && train.length >= 250) {
      if (!model || train.length - lastFit >= 100) { model = fitRidge(train, lambda); lastFit = train.length }
      const prediction = Math.max(0, model(row.x)), error = prediction - row.y
      const radius = residuals.length ? [...residuals].sort((a, b) => a - b)[Math.floor(.8 * (residuals.length - 1))] : null
      out.push({ ...row, prediction, error, low: radius == null ? null : Math.max(0, prediction - radius), high: radius == null ? null : prediction + radius })
      residuals.push(Math.abs(error)); if (residuals.length > 1500) residuals.shift()
    }
    train.push(row)
  }
  return out
}

function metrics(rows) {
  const errors = rows.map((row) => row.error)
  return {
    n: rows.length, mae: round(average(errors.map(Math.abs))),
    rmse: round(errors.length ? Math.sqrt(average(errors.map((error) => error ** 2), 0)) : null),
    bias: round(average(errors)), baseline_mae: round(average(rows.map((row) => Math.abs(row.baseline - row.y)))),
    interval80_coverage: round(average(rows.filter((row) => row.low != null).map((row) => Number(row.low <= row.y && row.y <= row.high)))),
    timestamp_violations: rows.filter((row) => row.feature_as_of >= row.date).length,
  }
}

export function backtestWnbaPlayers({ write = true } = {}) {
  if (!fs.existsSync(BOX)) return null
  const rows = readBox(), families = {}
  const closed = { passed: false, approved: false, public: false, state: 'closed', reason: 'market_lines_unavailable', min_forward: 200, min_dates: 30 }
  for (const family of FAMILIES) {
    const causal = causalRows(rows, family)
    let best = null
    for (const lambda of [.3, 1, 3, 10, 30]) {
      const tune = evaluate(causal.filter((row) => row.seasonIndex < 2), lambda, 1)
      const score = metrics(tune).mae
      if (score != null && (!best || score < best.mae)) best = { lambda, mae: score }
    }
    best ||= { lambda: 10, mae: null }
    const evaluated = evaluate(causal, best.lambda, 2)
    families[family] = {
      model: 'causal_player_form_ridge_v1', selected_lambda: best.lambda,
      historical: metrics(evaluated),
      per_season: Object.fromEntries([...new Set(evaluated.map((row) => row.season))].sort().map((season) => [String(season), metrics(evaluated.filter((row) => row.season === season))])),
      market_line_coverage: 0, forward: { n: 0, dates: 0 }, gate: { ...closed },
    }
  }
  const report = {
    schema: 'aa_wnba_player_backtest_v1', generated_at: new Date().toISOString(),
    seasons: [...new Set(rows.map((row) => String(row.season)))].sort(), burn_in: ['2021', '2022'],
    method: 'causal rolling ridge; prior games only; no prop recommendation without auditable pregame line',
    participant_note: 'Historical evaluation includes players who logged minutes; forward roster availability must be frozen pregame.',
    families,
  }
  if (write) fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
  return report
}

async function main() {
  const command = process.argv[2] || 'backtest'
  if (command === 'backfill') console.log(JSON.stringify(await backfillWnbaPlayers({ recent: process.argv.includes('--recent') }), null, 2))
  const report = backtestWnbaPlayers({ write: !process.argv.includes('--no-write') })
  if (!report) { console.log(JSON.stringify({ ran: false, reason: 'wnba_player_box_missing' })); return }
  console.log(JSON.stringify({ ran: true, families: Object.fromEntries(FAMILIES.map((family) => [family, report.families[family].historical])) }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
