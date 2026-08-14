// Publishes aggregate WNBA validation evidence only. No coefficients,
// features, per-game projections or private selections leave Actions.

import { backtestWnbaMarkets } from './wnba_market_model.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { buildSportBrain, forwardMetrics } from './sport_brain.mjs'

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342'
const KV_NAMESPACE_ID = '683aa2f8846643bf8a6a8b606e5bf0b7'
const D1_DATABASE_ID = 'ed0969d8-050a-4987-ab98-b047c30f76c9'
const TOKEN = process.env.CLOUDFLARE_API_TOKEN
const DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data')

if (!TOKEN) {
  console.log('Sin CLOUDFLARE_API_TOKEN; publicación wnba:simulation omitida.')
  process.exit(0)
}

let report = null
try { report = JSON.parse(fs.readFileSync(path.join(DATA, 'fase2', 'wnba', 'wnba_markets_backtest.json'), 'utf8')) }
catch { report = backtestWnbaMarkets({ write: false }) }
const publicPlayers = Object.fromEntries(Object.entries(report.players || {}).map(([family, block]) => [family, {
  historical: block.historical || null,
  market_line_coverage: block.market_line_coverage || 0,
  forward: block.forward || { n: 0, dates: 0 },
  gate: block.gate,
}]))
async function d1Rows(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })
  const body = await response.json()
  if (!response.ok || body?.success === false) throw new Error(`D1 query ${response.status}: ${JSON.stringify(body?.errors || body).slice(0, 200)}`)
  return body?.result?.[0]?.results || []
}

let winnerRows = [], totalRows = []
try {
  ;[winnerRows, totalRows] = await Promise.all([
    d1Rows("SELECT date,result,prob,market_prob FROM predictions WHERE sport='wnba' AND result IN ('win','loss') ORDER BY date,event_id"),
    d1Rows("SELECT date,result,prob,market_prob FROM sport_market_predictions WHERE sport='wnba' AND market_key='total' AND result IS NOT NULL ORDER BY date,event_id"),
  ])
} catch { /* fail closed with a zero sample; never invent evidence */ }
let backtest = null
try { backtest = JSON.parse(fs.readFileSync(path.join(DATA, 'fase2', 'wnba', 'wnba_backtest.json'), 'utf8')) } catch { /* historical gate stays closed */ }
const brain = buildSportBrain({ sport: 'wnba', backtest, rows: winnerRows, now: report.generated_at })
const winnerForward = brain.forward
const totalForward = forwardMetrics(totalRows)
const totalFinalN = totalRows.filter((row) => ['win', 'loss', 'push', 'void'].includes(row.result)).length
const totalMarketN = totalRows.filter((row) => ['win', 'loss', 'push'].includes(row.result)
  && row.market_prob != null && Number.isFinite(Number(row.market_prob))).length
const totalLineCoverage = totalFinalN ? totalMarketN / totalFinalN : 0
const totalChecks = {
  forward_sample: totalForward.n >= 200, dates: totalForward.dates >= 30,
  real_lines: totalLineCoverage >= 0.95,
  calibration: totalForward.ece != null && totalForward.ece <= 0.075,
  market_noninferiority: totalForward.logloss != null && totalForward.market_logloss != null
    && totalForward.logloss <= totalForward.market_logloss,
}
const totalPassed = Object.values(totalChecks).every(Boolean)
const totalReason = totalPassed ? 'human_approval_pending'
  : !totalChecks.real_lines ? 'market_lines_unavailable'
    : !totalChecks.forward_sample || !totalChecks.dates ? 'total_forward_validation_pending'
      : !totalChecks.calibration ? 'forward_calibration_pending' : 'market_benchmark_pending'
const totalGate = { passed: totalPassed, approved: false, public: false, state: 'closed', reason: totalReason, min_forward: 200, min_dates: 30, checks: totalChecks }
const publicDoc = {
  schema: 'aa_multisport_simulation_public_v1', sport: 'wnba', generated_at: report.generated_at,
  seasons: report.seasons, burn_in: report.burn_in,
  winner: { historical: brain.historical, forward: winnerForward, gate: brain.gate },
  total: {
    historical: report.total.historical, per_season: report.total.per_season,
    market_line_coverage: totalLineCoverage, forward: totalForward, gate: totalGate,
  },
  players: publicPlayers,
  combos: report.combos,
  state: 'training',
}

const closedBlock = (gate, sample) => ({ state: 'closed', gate, sample })
const samples = {
  winner: { ...winnerForward, min_forward: 200, min_dates: 30 },
  total: { n: totalForward.n, dates: totalForward.dates, market_n: totalMarketN, min_forward: 200, min_dates: 30 },
  players: { n: 0, dates: 0, market_n: 0, min_forward: 200, min_dates: 30 },
  combos: { n: 0, dates: 0, min_forward: 100, min_dates: 30 },
}
const gates = {
  winner: brain.gate, total: totalGate,
  players: report.players.pts?.gate || { passed: false, approved: false, public: false, reason: 'market_lines_unavailable' },
  combos: report.combos.gate,
}
const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const todayDoc = {
  schema: 'aa_multisport_markets_v1', sport: 'wnba', date: etDate, updated_at: report.generated_at,
  gate: gates.winner, sample: samples.winner, gates, samples,
  markets: Object.fromEntries(Object.keys(gates).map((kind) => [kind, closedBlock(gates[kind], samples[kind])])),
  events: [], top2: [], record: null,
}

for (const [key, value] of [['wnba:simulation', publicDoc], ['wnba:today', todayDoc]]) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`KV ${key} ${response.status}: ${body.slice(0, 240)}`)
}
console.log(`WNBA evidencia publicada · winner forward n=${winnerForward.n} · total forward n=${totalForward.n} · total gate=${totalGate.reason}`)
