// AA Sports — mercados MLB en SOMBRA (Over real, F5 líder y abridor/F5).
//
// Este módulo NO publica apuestas. Registra hasta dos candidatos por categoría,
// los gradúa y produce un replay cronológico. Solo una categoría cuyo gate pase
// podrá ser expuesta después con aprobación humana. Cero candidatos es válido.

import { starterRecentGate } from './adrian.js'
import { prepareTrainingRows } from './learn.js'
import { hasAuditableOpening } from './odds.js'

export const TOTAL_SIGMA = 2.9
export const BREAK_EVEN_110 = 0.5238
export const FORWARD_START = '2026-07-21'
export const isVoidStatus = (status) => /Postponed|Cancelled|Canceled/i.test(String(status || ''))

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const round3 = (x) => x == null ? null : Math.round(x * 1000) / 1000

// Normal CDF (misma aproximación que adrian.js, exportada aquí para mantener el
// mercado secundario puro y testeable sin mover la fórmula de producción).
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp(-z * z / 2)
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}

// La línea para un boleto debe ser la línea REAL capturada, nunca la referencia
// redondeada del propio modelo. Desde rare_v1 se conserva over_under_open.
export function totalAtMarket(row) {
  const odds = row?.odds
  const audited = hasAuditableOpening(odds, 'total')
  const lineRaw = audited ? odds.over_under_open : (odds?.over_under_open ?? odds?.over_under)
  const expectedRaw = row?.adj_total
  if (lineRaw == null || expectedRaw == null) return null
  const line = Number(lineRaw), expected = Number(expectedRaw)
  if (!Number.isFinite(line) || !Number.isFinite(expected)) return null
  const pOver = clamp(1 - normCdf((line - expected) / TOTAL_SIGMA), 0.05, 0.95)
  const side = pOver >= 0.5 ? 'over' : 'under'
  const price = audited ? Number(side === 'over' ? odds.over_price_open : odds.under_price_open) : null
  const priced = Number.isFinite(price) && price !== 0
  return {
    line, expected: Math.round(expected * 10) / 10,
    edge_runs: Math.round((expected - line) * 10) / 10,
    p_over: round3(pOver), side,
    price: priced ? price : null,
    publicable: audited && priced,
    provider: audited ? odds.provider_open ?? odds.provider ?? null : odds?.provider ?? null,
    captured_at: audited ? odds.captured_at_open : null,
    line_stage: audited ? 'audited_pregame_open' : odds?.over_under_open != null ? 'legacy_open_unverified' : 'late_or_unknown',
  }
}

// Resultado F5 desde el score explícito nuevo; fallback a la curva ESPN de
// juegos históricos. Empate = push para la moneyline F5 de dos vías.
export function f5Outcome(row) {
  const hasExplicit = row?.f5_home_score != null && row?.f5_away_score != null
  let home = hasExplicit ? Number(row.f5_home_score) : NaN
  let away = hasExplicit ? Number(row.f5_away_score) : NaN
  if (!Number.isFinite(home) || !Number.isFinite(away)) {
    const curve = row?.odds?.wp_curve
    const p = Array.isArray(curve)
      ? curve.filter((x) => Number(x.inn) <= 5 && x.home_score != null && x.away_score != null).at(-1) : null
    home = p?.home_score != null ? Number(p.home_score) : NaN
    away = p?.away_score != null ? Number(p.away_score) : NaN
  }
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null
  return { home, away, result: home === away ? 'push' : home > away ? 'home' : 'away' }
}

function f5Projection(row) {
  const f = row?.brief?.f5
  if (f?.home_lead != null && f?.away_lead != null && Number.isFinite(Number(f.home_lead)) && Number.isFinite(Number(f.away_lead))) {
    const home = Number(f.home_lead), away = Number(f.away_lead)
    return { side: home >= away ? 'home' : 'away', prob: Math.max(home, away), score: Math.abs(home - away) }
  }
  // factor_leans.f5 = F_home − F_away; conserva dirección/magnitud en todo el
  // histórico, aunque no permite recuperar la prob absoluta ni el empate.
  const d = Number(row?.factor_leans?.f5)
  if (!Number.isFinite(d) || d === 0) return null
  return { side: d > 0 ? 'home' : 'away', prob: null, score: Math.abs(d) }
}

function baseCandidate(row, side) {
  const out = { game_pk: row.game_pk, matchup: row.matchup }
  if (side === 'home' || side === 'away') {
    out.pick = side === 'home' ? row.home : row.away
    out.side = side
  }
  return out
}

const f5Price = (row, side) => {
  const o = row?.odds || {}
  const raw = side === 'home' ? (o.f5_home_price_open ?? o.f5_home_price) : (o.f5_away_price_open ?? o.f5_away_price)
  const n = Number(raw)
  const audited = Number.isFinite(n) && n !== 0 && o.captured_at_open != null && o.open_provenance === 'explicit_pregame'
  return { price: audited ? n : null, audited }
}

const americanProfit = (price, won) => won ? (price > 0 ? price / 100 : 100 / Math.abs(price)) : -1

function roiBlockBootstrap(picks, B = 1000, seed = 20260721) {
  const priced = picks.filter((p) => Number.isFinite(p.price) && (p.result === 'win' || p.result === 'loss'))
  if (!priced.length) return { lo: null, hi: null, method: 'date_block', n: 0, dates: 0 }
  const by = new Map()
  for (const p of priced) { if (!by.has(p.date)) by.set(p.date, []); by.get(p.date).push(p) }
  const days = [...by.values()]
  let x = seed >>> 0 || 0x9e3779b9
  const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296 }
  const vals = []
  for (let b = 0; b < B; b++) {
    let units = 0, n = 0
    for (let d = 0; d < days.length; d++) for (const p of days[(rnd() * days.length) | 0]) {
      units += americanProfit(p.price, p.result === 'win'); n++
    }
    vals.push(n ? units / n : 0)
  }
  vals.sort((a, b) => a - b)
  return { lo: round3(vals[Math.floor(B * 0.025)]), hi: round3(vals[Math.floor(B * 0.975)]), method: 'date_block', n: priced.length, dates: days.length }
}

// Candidatos de HOY, guardados únicamente en data/history/{date}.json.
export function buildMarketLab(rows, { max = 2 } = {}) {
  const overs = [], f5 = [], pitchers = []
  for (const row of rows || []) {
    const tot = totalAtMarket(row)
    if (tot && tot.side === 'over') {
      overs.push({ ...baseCandidate(row, null), market: 'total', side: 'over', line: tot.line,
        prob_raw: tot.p_over, expected: tot.expected, edge_runs: tot.edge_runs,
        price: tot.price, publicable: tot.publicable, provider: tot.provider,
        captured_at: tot.captured_at, line_stage: tot.line_stage, score: tot.p_over })
    }
    const fp = f5Projection(row)
    if (!fp) continue
    const fpPrice = f5Price(row, fp.side)
    const cand = { ...baseCandidate(row, fp.side), market: 'f5_ml', prob_raw: round3(fp.prob),
      price: fpPrice.price, publicable: false, score: fp.score }
    f5.push(cand)
    const starter = starterRecentGate(row, cand.pick)
    if (starter.passes) {
      const bp = row?.brief?.pitchers?.[fp.side]
      pitchers.push({ ...cand, market: 'pitcher_f5', pitcher: bp?.name || null, starter_gate: starter })
    }
  }
  const take = (a) => a.sort((x, y) => (y.score || 0) - (x.score || 0)).slice(0, max)
    .map(({ score: _score, ...x }) => x)
  return {
    version: 'shadow_v1', published: false, generated_at: new Date().toISOString(),
    gates: {
      over: { passes: false, reason: 'línea de apertura + muestra forward pendientes' },
      f5: { passes: false, reason: 'sin precio F5 y gate OOS pendiente' },
      pitcher_f5: { passes: false, reason: 'sin precio F5 y gate OOS pendiente' },
    },
    over: take(overs), f5: take(f5), pitcher_f5: take(pitchers), graded: false,
  }
}

export function gradeMarketLab(lab, byPk) {
  if (!lab) return true
  let done = true
  for (const key of ['over', 'f5', 'pitcher_f5']) {
    for (const p of lab[key] || []) {
      if (p.result) continue
      if (p.scratch_warning === true) {
        p.result = 'void'; p.void_reason = 'probable_starter_changed_pregame'; continue
      }
      const g = byPk?.get ? byPk.get(p.game_pk) : byPk?.[p.game_pk]
      if (g && isVoidStatus(g.status)) {
        p.result = 'void'; p.void_reason = g.status || 'void'; continue
      }
      if (!g || g.home_score == null || g.away_score == null) { done = false; continue }
      if (p.market === 'total') {
        const total = Number(g.home_score) + Number(g.away_score)
        p.result = total === p.line ? 'push' : total > p.line ? 'win' : 'loss'
        p.final = `${g.away_score}-${g.home_score}`
      } else {
        const f = f5Outcome(g)
        if (!f) { done = false; continue }
        p.result = f.result === 'push' ? 'push' : ((p.side === f.result) ? 'win' : 'loss')
        p.final_f5 = `${f.away}-${f.home}`
      }
    }
  }
  lab.graded = done
  return done
}

function wilson(w, n) {
  if (!n) return { rate: null, lo: null, hi: null }
  const z = 1.96, p = w / n, z2 = z * z, den = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / den
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den
  return { rate: round3(p), lo: round3(Math.max(0, center - half)), hi: round3(Math.min(1, center + half)) }
}

function evaluate(rows, kind, period, cut, max = 2, { requireTradable = false } = {}) {
  const src = rows.filter((r) => period === 'train' ? r.date < cut : period === 'test' ? r.date >= cut : true)
  const byDate = new Map()
  for (const row of src) {
    let cand = null
    if (kind === 'over') {
      const t = totalAtMarket(row)
      if (t && t.side === 'over' && row.total_runs != null && (!requireTradable || t.publicable)) {
        cand = { row, side: 'over', score: t.p_over, line: t.line, price: t.price, tradable: t.publicable }
      }
    } else {
      const f = f5Projection(row), out = f5Outcome(row)
      if (f && out) {
        const pick = f.side === 'home' ? row.home : row.away
        const px = f5Price(row, f.side)
        const explicitScore = row.f5_home_score != null && row.f5_away_score != null
        const tradable = px.audited && explicitScore
        if ((!requireTradable || tradable) && (kind !== 'pitcher_f5' || starterRecentGate(row, pick).passes)) {
          cand = { row, side: f.side, score: f.score, outcome: out, price: px.price, tradable, explicitScore }
        }
      }
    }
    if (!cand) continue
    if (!byDate.has(row.date)) byDate.set(row.date, [])
    byDate.get(row.date).push(cand)
  }
  const picks = []
  for (const day of byDate.values()) picks.push(...day.sort((a, b) => b.score - a.score).slice(0, max))
  let wins = 0, losses = 0, pushes = 0, units = 0, priced = 0, explicitScores = 0
  const settled = []
  for (const p of picks) {
    let result
    if (kind === 'over') {
      if (Number(p.row.total_runs) === p.line) { pushes++; result = 'push' }
      else if (Number(p.row.total_runs) > p.line) { wins++; result = 'win' }
      else { losses++; result = 'loss' }
    } else if (p.outcome.result === 'push') { pushes++; result = 'push' }
    else if (p.outcome.result === p.side) { wins++; result = 'win' }
    else { losses++; result = 'loss' }
    if (p.explicitScore) explicitScores++
    if (Number.isFinite(p.price) && (result === 'win' || result === 'loss')) {
      priced++; units += americanProfit(p.price, result === 'win')
      settled.push({ date: p.row.date, price: p.price, result })
    }
  }
  return { period, n: wins + losses, picks: picks.length, days: byDate.size, wins, losses, pushes,
    priced, explicit_scores: explicitScores, units: round3(units), roi: priced ? round3(units / priced) : null,
    roi_ci: roiBlockBootstrap(settled), ...wilson(wins, wins + losses) }
}

// Reporte exploratorio determinista. El corte 70/30 es cronológico. Los gates
// exigen muestra de test suficiente + cota inferior; F5 además exige precios
// reales antes de que pueda llamarse boleto.
export function marketLabReport(rows, { split = 0.70, minTest = 100, forwardStart = FORWARD_START, invalidatedGamePks = new Set() } = {}) {
  const excluded = invalidatedGamePks instanceof Set ? invalidatedGamePks : new Set(invalidatedGamePks || [])
  const graded = prepareTrainingRows(rows).filter((row) => !excluded.has(String(row.game_pk)))
  const dates = [...new Set(graded.map((r) => r.date))].sort()
  const cut = dates[Math.floor(dates.length * split)] || null
  const report = { version: 'shadow_v1', generated_at: new Date().toISOString(), cut, rows: graded.length, markets: {} }
  for (const kind of ['over', 'f5', 'pitcher_f5']) {
    const train = evaluate(graded, kind, 'train', cut)
    const test = evaluate(graded, kind, 'test', cut)
    const all = evaluate(graded, kind, 'all', cut)
    const forwardRows = graded.filter((r) => r.date >= forwardStart)
    const forward = evaluate(forwardRows, kind, 'all', cut, 2, { requireTradable: true })
    const hasPrice = forward.n > 0 && forward.priced === forward.n
    const hasScore = kind === 'over' || (forward.picks > 0 && forward.explicit_scores === forward.picks)
    const threshold = forward.priced ? null : (kind === 'over' ? BREAK_EVEN_110 : 0.5)
    const passes = hasPrice && hasScore && forward.n >= minTest && forward.roi_ci?.lo != null && forward.roi_ci.lo > 0
    report.markets[kind] = {
      train, test, all, forward,
      gate: { passes, min_test: minTest, threshold, has_market_price: hasPrice, has_explicit_score: hasScore,
        forward_start: forwardStart,
        reason: !hasPrice ? 'sin línea y juice pregame auditables' : !hasScore ? 'sin score F5 explícito' : forward.n < minTest ? `muestra forward insuficiente (n=${forward.n})` : forward.roi_ci.lo <= 0 ? 'IC95% forward de ROI cruza 0' : 'pasa' },
    }
  }
  return report
}
