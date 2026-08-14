// AA Sports — Cerebro medido multideporte.
//
// Publica únicamente métricas y estado del gate. La lógica/pesos permanecen
// server-side y ninguna predicción nueva se abre desde este archivo. Los
// deportes en sombra siguen en sombra aunque el backtest histórico sea bueno:
// necesitan muestra forward, calibración, comparación de mercado y aprobación.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342'
const D1_DATABASE_ID = 'ed0969d8-050a-4987-ab98-b047c30f76c9'
const KV_NAMESPACE_ID = '683aa2f8846643bf8a6a8b606e5bf0b7'
const TOKEN = process.env.CLOUDFLARE_API_TOKEN
const DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const SUPPORTED = Object.freeze(['soccer', 'nba', 'wnba', 'tennis'])

const finite = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null }
const round = (x, d = 4) => x == null ? null : Number(Number(x).toFixed(d))

export function calibrationEce(curve = []) {
  let n = 0, err = 0
  for (const row of curve || []) {
    const k = finite(row?.n), p = finite(row?.p_media ?? row?.pred), y = finite(row?.freq_real ?? row?.real)
    if (!(k > 0) || p == null || y == null) continue
    // Algunos backtests expresan p/real como porcentaje (0–100).
    const pp = p > 1 ? p / 100 : p
    const yy = y > 1 ? y / 100 : y
    n += k; err += k * Math.abs(pp - yy)
  }
  return n ? err / n : null
}

function weighted(values, field) {
  let n = 0, total = 0
  for (const value of values) {
    const k = finite(value?.n), x = finite(value?.[field])
    if (!(k > 0) || x == null) continue
    n += k; total += k * x
  }
  return n ? total / n : null
}

function historicalMetrics(sport, backtest) {
  if (!backtest) return { n: 0, accuracy: null, brier: null, logloss: null, ece: null, baseline_brier: null, market_brier: null }
  if (sport === 'soccer') {
    const o = backtest.overall || {}
    const curve = (backtest.leagues || []).flatMap((league) => league.calibration || [])
    return {
      n: finite(o.n_test) || 0, accuracy: finite(o.tiers?.t55?.hit_pct) != null ? finite(o.tiers.t55.hit_pct) / 100 : null,
      brier: finite(o.brier_blend), logloss: weighted((backtest.leagues || []).map((x) => ({ n: x.evaluated_test, logloss: x.logloss_blend })), 'logloss'),
      ece: calibrationEce(curve), baseline_brier: null, market_brier: finite(o.brier_market),
    }
  }
  if (sport === 'tennis') {
    const tours = Object.values(backtest.tours || {})
    return {
      n: tours.reduce((n, t) => n + (finite(t.n_eval) || 0), 0),
      accuracy: weighted(tours.map((t) => ({ n: t.n_eval, accuracy: t.metrics?.acc })), 'accuracy'),
      brier: weighted(tours.map((t) => ({ n: t.n_eval, brier: t.metrics?.brier })), 'brier'),
      logloss: weighted(tours.map((t) => ({ n: t.n_eval, logloss: t.metrics?.logloss })), 'logloss'),
      ece: weighted(tours.map((t) => ({ n: t.n_eval, ece: calibrationEce(t.calibration) })), 'ece'),
      baseline_brier: 0.25, market_brier: null,
    }
  }
  return {
    n: finite(backtest.n_eval) || 0, accuracy: finite(backtest.metrics?.acc), brier: finite(backtest.metrics?.brier),
    logloss: finite(backtest.metrics?.logloss), ece: calibrationEce(backtest.calibration),
    baseline_brier: finite(backtest.metrics?.brier_baseline_local), market_brier: null,
  }
}

function wilson(wins, n, z = 1.96) {
  if (!(n > 0)) return { lo: null, hi: null }
  const p = wins / n, den = 1 + z * z / n
  const center = (p + z * z / (2 * n)) / den
  const half = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / den
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) }
}

export function forwardMetrics(rows = []) {
  const graded = rows.filter((r) => ['win', 'loss'].includes(r?.result) && finite(r?.prob) != null)
  if (!graded.length) return { n: 0, dates: 0, wins: 0, losses: 0, accuracy: null, ci: { lo: null, hi: null }, brier: null, logloss: null, ece: null, market_n: 0, market_accuracy: null, market_brier: null, market_logloss: null }
  let wins = 0, brier = 0, logloss = 0, marketN = 0, marketWins = 0, marketBrier = 0, marketLogloss = 0
  const curve = Array.from({ length: 10 }, () => ({ n: 0, p_media: 0, freq_real: 0 }))
  for (const row of graded) {
    const y = row.result === 'win' ? 1 : 0
    const p = Math.max(1e-6, Math.min(1 - 1e-6, Number(row.prob)))
    wins += y; brier += (p - y) ** 2; logloss -= Math.log(y ? p : 1 - p)
    const bin = Math.min(9, Math.floor(p * 10)); curve[bin].n++; curve[bin].p_media += p; curve[bin].freq_real += y
    const mp = finite(row.market_prob)
    if (mp != null) {
      const m = Math.max(1e-6, Math.min(1 - 1e-6, mp)); marketN++
      marketWins += (m >= 0.5) === (y === 1) ? 1 : 0
      marketBrier += (m - y) ** 2; marketLogloss -= Math.log(y ? m : 1 - m)
    }
  }
  for (const b of curve) if (b.n) { b.p_media /= b.n; b.freq_real /= b.n }
  return {
    n: graded.length, dates: new Set(graded.map((r) => r.date).filter(Boolean)).size,
    wins, losses: graded.length - wins, accuracy: wins / graded.length, ci: wilson(wins, graded.length),
    brier: brier / graded.length, logloss: logloss / graded.length, ece: calibrationEce(curve),
    market_n: marketN, market_accuracy: marketN ? marketWins / marketN : null,
    market_brier: marketN ? marketBrier / marketN : null, market_logloss: marketN ? marketLogloss / marketN : null,
  }
}

function loadBacktest(sport) {
  const p = path.join(DATA, 'fase2', sport, `${sport}_backtest.json`)
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function historicalGate(sport, h) {
  if (!(h.n > 0) || h.brier == null) return false
  if (sport === 'soccer') return h.market_brier != null && h.brier <= h.market_brier + 0.002
  return h.baseline_brier != null && h.brier < h.baseline_brier && (h.ece == null || h.ece <= 0.05)
}

const LABEL = { soccer: 'Fútbol', nba: 'NBA', wnba: 'WNBA', tennis: 'Tenis' }
const MIN_FORWARD = { soccer: 0, nba: 300, wnba: 200, tennis: 300 }
const MIN_DATES = { soccer: 0, nba: 30, wnba: 30, tennis: 30 }

export function buildSportBrain({ sport, backtest = null, rows = [], now = new Date().toISOString() }) {
  if (!SUPPORTED.includes(sport)) throw new Error(`deporte no soportado: ${sport}`)
  const historical = historicalMetrics(sport, backtest)
  const forward = forwardMetrics(rows)
  const historyPass = historicalGate(sport, historical)
  const enoughForward = forward.n >= MIN_FORWARD[sport] && forward.dates >= MIN_DATES[sport]
  const calibratedForward = forward.ece != null && forward.ece <= 0.05
  const beatsMarket = forward.market_n >= Math.min(100, MIN_FORWARD[sport])
    && forward.logloss != null && forward.market_logloss != null && forward.logloss <= forward.market_logloss
  const approved = sport === 'soccer'
  const passed = sport === 'soccer' ? historyPass : (historyPass && enoughForward && calibratedForward && beatsMarket)
  const publicModel = approved && passed
  const reason = passed ? 'passed' : !historyPass ? 'historical_gate_failed'
    : !enoughForward ? 'forward_sample_pending'
      : !calibratedForward ? 'forward_calibration_pending'
        : !beatsMarket ? 'market_benchmark_pending' : 'human_approval_pending'
  const label = LABEL[sport]
  const histAcc = historical.accuracy == null ? null : Math.round(historical.accuracy * 1000) / 10
  const liveAcc = forward.accuracy == null ? null : Math.round(forward.accuracy * 1000) / 10
  const learningEs = [
    historical.n ? `${label}: ${historical.n.toLocaleString('en-US')} predicciones históricas OOS; acierto ${histAcc ?? '—'}% y Brier ${round(historical.brier, 4)}.` : `${label}: el histórico validado todavía no está disponible.`,
    forward.n ? `Validación forward: ${forward.wins}-${forward.losses} (${liveAcc}%) en ${forward.dates} fechas; la muestra se muestra completa aunque sea pequeña.` : 'La validación forward todavía no tiene decisiones calificadas.',
    publicModel ? 'El gate público está abierto y el récord vivo permanece visible.' : `El modelo sigue en sombra: ${reason}. No se publican picks ni porcentajes.`,
  ]
  const learningEn = [
    historical.n ? `${label}: ${historical.n.toLocaleString('en-US')} historical OOS predictions; ${histAcc ?? '—'}% accuracy and ${round(historical.brier, 4)} Brier.` : `${label}: validated history is not available yet.`,
    forward.n ? `Forward validation: ${forward.wins}-${forward.losses} (${liveAcc}%) across ${forward.dates} dates; the full sample is shown even while small.` : 'Forward validation has no graded decisions yet.',
    publicModel ? 'The public gate is open and the live record remains visible.' : `The model remains in shadow: ${reason}. No picks or probabilities are published.`,
  ]
  return {
    schema: 'aa_sport_learning_v1', sport, label, updated_at: now,
    state: publicModel ? 'public' : 'training', model_scope: publicModel ? 'public' : 'shadow',
    gate: {
      passed, approved, public: publicModel, reason,
      historical_passed: historyPass, min_forward: MIN_FORWARD[sport], min_dates: MIN_DATES[sport],
      requires_ece_lte: 0.05, requires_market_benchmark: sport !== 'soccer',
    },
    historical: Object.fromEntries(Object.entries(historical).map(([k, v]) => [k, typeof v === 'number' ? round(v, 4) : v])),
    forward: {
      ...forward,
      accuracy: round(forward.accuracy), brier: round(forward.brier), logloss: round(forward.logloss), ece: round(forward.ece),
      market_accuracy: round(forward.market_accuracy), market_brier: round(forward.market_brier), market_logloss: round(forward.market_logloss),
      ci: { lo: round(forward.ci.lo), hi: round(forward.ci.hi) },
    },
    learning_es: learningEs, learning_en: learningEn,
    attribution_es: 'Métricas medidas con validación cronológica. Entrenamiento privado; un backtest no garantiza resultados futuros.',
    attribution_en: 'Metrics measured with chronological validation. Private training; a backtest does not guarantee future results.',
  }
}

async function d1Rows(sport) {
  if (!TOKEN) return []
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sql: "SELECT date, result, prob, market_prob, confidence FROM predictions WHERE sport = ? AND result IN ('win','loss') ORDER BY date, event_id",
      params: [sport],
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) throw new Error(`D1 ${sport}: ${JSON.stringify(body.errors || body).slice(0, 300)}`)
  return body.result?.[0]?.results || []
}

async function publish(sport, doc) {
  if (!TOKEN) return false
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(`${sport}:learning`)}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
  })
  if (!res.ok) throw new Error(`KV ${sport}:learning: ${res.status} ${(await res.text()).slice(0, 180)}`)
  return true
}

async function main() {
  const requested = (process.argv[2] || 'all').toLowerCase()
  const sports = requested === 'all' ? [...SUPPORTED] : [requested]
  for (const sport of sports) {
    if (!SUPPORTED.includes(sport)) throw new Error(`Uso: node robot/sport_brain.mjs [${SUPPORTED.join('|')}|all]`)
    const doc = buildSportBrain({ sport, backtest: loadBacktest(sport), rows: await d1Rows(sport) })
    const didPublish = await publish(sport, doc)
    console.log(JSON.stringify({ sport, published: didPublish, state: doc.state, gate: doc.gate, historical_n: doc.historical.n, forward_n: doc.forward.n }))
  }
  if (!TOKEN) console.log('Sin CLOUDFLARE_API_TOKEN: Cerebros calculados localmente, publicación omitida.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exit(1) })
}
