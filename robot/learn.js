// Adrian Clara Learning (beta) — pure, dependency-free learners.
//
// WALK-FORWARD ONLY: every fit is trained on rows STRICTLY BEFORE the day being
// scored; a game's own result never influences its own weighting/calibration.
// Shared by the Node robot (canonical snapshot -> data/history/learning.json)
// and the browser (today's projection). No Date/Math.random used.
//
// The classic "Estadística Adrian" (adrian.js) is 100% untouched: this file only
// reads its (additive) intermediate outputs and re-weights them on the side.

import { WEIGHTS } from './adrian.js'

// Bump when adrian.js's factor math changes so stale rows are dropped from fits.
export const FORMULA_VERSION = 'v2'
export const ML_FACTORS = ['momentum', 'pitching', 'f5', 'bats', 'schedule', 'manager']
export const TOTAL_COMPONENTS = ['aStart', 'hStart', 'homeContact', 'awayContact', 'aFat', 'hFat']

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const sigmoid = (z) => 1 / (1 + Math.exp(-z))
const logit = (p) => { const q = clamp(p, 1e-6, 1 - 1e-6); return Math.log(q / (1 - q)) }
const round4 = (x) => Math.round(x * 1e4) / 1e4
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)

// --- games_v1 row assembly (schema shared with the robot) -------------------
// Turn an analyzeGame() result into a learnable row (Y is filled later on grading).
export function analysisToRow(a) {
  const lean = {}
  for (const k of ML_FACTORS) lean[k] = round4(a.factors[k].home - a.factors[k].away)
  const c = a.total.components || {}
  const comp = {}
  for (const k of TOTAL_COMPONENTS) comp[k] = round4(c[k] ?? 0)
  return {
    game_pk: a.game_pk, matchup: a.matchup, home: a.home, away: a.away, status: a.status,
    // ML chain
    model_p: a.ml.model_p, signal: a.ml.signal, adrian_p: a.ml.adrian_p, agree: a.ml.agree, ml_pick: a.ml.pick,
    factor_leans: lean, news_delta: round4((a.news?.home ?? 0) - (a.news?.away ?? 0)),
    // Total chain
    base: round4(a.total.base_raw), adj_total: round4(a.total.adj_total), line: a.total.line, side: a.total.side, p_over: a.total.p_over,
    components: comp,
    // Context (for post-mortems)
    streak_home: a.streak_home, streak_away: a.streak_away,
    pitcher_recent: {
      home: a.pitcher_recent?.home?.recent ? { era: a.pitcher_recent.home.recent.era, n: a.pitcher_recent.home.recent.n, fatigue: a.pitcher_recent.home.fatigue?.level ?? null } : null,
      away: a.pitcher_recent?.away?.recent ? { era: a.pitcher_recent.away.recent.era, n: a.pitcher_recent.away.recent.n, fatigue: a.pitcher_recent.away.fatigue?.level ?? null } : null,
    },
    formula_version: FORMULA_VERSION,
    // Y (filled on grading): home_win, total_runs, ml_result, total_result, final, graded
    graded: false,
  }
}

// --- feature extraction -----------------------------------------------------
export function mlSample(row) {
  const d = row.factor_leans || {}
  const x = ML_FACTORS.map((k) => d[k] ?? 0)
  x.push(row.news_delta ?? 0)
  const y = row.home_win === 0 || row.home_win === 1 ? row.home_win : null
  return { x, offset: logit(row.model_p ?? 0.5), y, ok: y != null && row.model_p != null }
}
export function totalSample(row) {
  const c = row.components || {}
  const x = TOTAL_COMPONENTS.map((k) => c[k] ?? 0)
  x.push((row.base ?? 0) - (row.line ?? 0)) // base - line, learns the effective scale
  // Target = actual OVER indicator; pushes (total_runs == line) excluded.
  let y = null
  if (row.total_runs != null && row.line != null && row.total_runs !== row.line) y = row.total_runs > row.line ? 1 : 0
  return { x, offset: 0, y, ok: y != null }
}

// --- linear solve (Gauss-Jordan with partial pivoting) ----------------------
function solve(A, b) {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-12) return null
    ;[M[col], M[piv]] = [M[piv], M[col]]
    const d = M[col][col]
    for (let c = col; c <= n; c++) M[col][c] /= d
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col]
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row) => row[n])
}

// --- logistic regression with fixed offset + ridge (L2, intercept unpenalized)
// Standardizes feature columns on the TRAIN rows only (μ,σ stored for scoring).
export function fitLogit(samples, { lambda = 1.0, intercept = false, iters = 25 } = {}) {
  const rows = samples.filter((s) => s.ok)
  const n = rows.length
  const nf = rows[0]?.x.length || 0
  if (n < 2 || nf === 0) return null
  const mu = new Array(nf).fill(0), sd = new Array(nf).fill(0)
  for (const r of rows) for (let j = 0; j < nf; j++) mu[j] += r.x[j]
  for (let j = 0; j < nf; j++) mu[j] /= n
  for (const r of rows) for (let j = 0; j < nf; j++) sd[j] += (r.x[j] - mu[j]) ** 2
  for (let j = 0; j < nf; j++) sd[j] = Math.sqrt(sd[j] / n) || 1
  const p = nf + (intercept ? 1 : 0)
  const design = rows.map((r) => { const z = []; if (intercept) z.push(1); for (let j = 0; j < nf; j++) z.push((r.x[j] - mu[j]) / sd[j]); return z })
  const offs = rows.map((r) => r.offset), ys = rows.map((r) => r.y)
  let beta = new Array(p).fill(0)
  for (let it = 0; it < iters; it++) {
    const A = Array.from({ length: p }, () => new Array(p).fill(0))
    const b = new Array(p).fill(0)
    for (let i = 0; i < n; i++) {
      let eta = offs[i]
      for (let j = 0; j < p; j++) eta += design[i][j] * beta[j]
      const pi = sigmoid(eta), w = Math.max(pi * (1 - pi), 1e-6)
      const z = (ys[i] - pi) / w // working residual (offset & Xβ cancel in the normal eqn)
      for (let j = 0; j < p; j++) {
        b[j] += design[i][j] * w * (design[i].reduce((s, v, k) => s + v * beta[k], 0) + z)
        for (let k = 0; k < p; k++) A[j][k] += design[i][j] * w * design[i][k]
      }
    }
    for (let j = intercept ? 1 : 0; j < p; j++) A[j][j] += lambda
    const nb = solve(A, b)
    if (!nb) break
    let diff = 0
    for (let j = 0; j < p; j++) diff += Math.abs(nb[j] - beta[j])
    beta = nb
    if (diff < 1e-9) break
  }
  return { beta, mu, sd, intercept, n, features: nf }
}

export function predictLogit(fit, x, offset = 0) {
  if (!fit) return null
  let eta = offset, idx = 0
  if (fit.intercept) { eta += fit.beta[0]; idx = 1 }
  for (let j = 0; j < fit.features; j++) eta += fit.beta[idx + j] * ((x[j] - fit.mu[j]) / (fit.sd[j] || 1))
  return sigmoid(eta)
}

// De-standardized coefficients in raw feature space (for display).
export function rawCoefs(fit) {
  if (!fit) return null
  const idx = fit.intercept ? 1 : 0
  return fit.beta.slice(idx).map((b, j) => b / (fit.sd[j] || 1))
}

// Learned ML weights normalized to the classic scale (Σ|WEIGHTS| = 1) for a
// like-for-like emphasis comparison. Returns { learned:{6}, original:{6}, news_coef }.
export function mlWeights(fit) {
  if (!fit) return null
  const raw = rawCoefs(fit) // 6 factors + news
  const factorRaw = raw.slice(0, 6)
  const norm = factorRaw.reduce((s, v) => s + Math.abs(v), 0) || 1
  const scale = Object.values(WEIGHTS).reduce((s, v) => s + Math.abs(v), 0) / norm
  const learned = {}
  ML_FACTORS.forEach((k, j) => { learned[k] = round4(factorRaw[j] * scale) })
  return { learned, original: { ...WEIGHTS }, news_coef: round4(raw[6]) }
}

// --- per-factor Bayesian trust ----------------------------------------------
export function betaTrust(rows, { tau = 0.03, prior = 8 } = {}) {
  return ML_FACTORS.map((k) => {
    let a = prior, b = prior, n = 0
    for (const r of rows) {
      if (r.home_win !== 0 && r.home_win !== 1) continue
      const d = (r.factor_leans || {})[k] ?? 0
      if (Math.abs(d) < tau) continue
      n++
      const correct = (d > 0) === (r.home_win === 1)
      if (correct) a++; else b++
    }
    const trust = a / (a + b)
    const v = (a * b) / ((a + b) ** 2 * (a + b + 1))
    const s = 1.645 * Math.sqrt(v)
    return { factor: k, trust: round4(trust), lift: round4(trust - 0.5), n, band: [round4(clamp(trust - s, 0, 1)), round4(clamp(trust + s, 0, 1))] }
  })
}

// --- calibration (reliability curve + ECE + Platt) --------------------------
// getP(row) = prob of the PICKED side (>=0.5); getY(row) = 1 if the picked side won.
export function reliability(rows, getP, getY, { bins = 10 } = {}) {
  const arr = []
  for (const r of rows) { const p = getP(r), y = getY(r); if (p != null && (y === 0 || y === 1)) arr.push({ p, y }) }
  const N = arr.length
  const curve = []
  let ece = 0, wsum = 0
  for (let i = 0; i < bins; i++) {
    const lo = 0.5 + (i / bins) * 0.5, hi = 0.5 + ((i + 1) / bins) * 0.5
    const inb = arr.filter((r) => r.p >= lo && (i === bins - 1 ? r.p <= hi : r.p < hi))
    if (!inb.length) { curve.push({ lo: round4(lo), hi: round4(hi), n: 0, conf: null, emp: null }); continue }
    const conf = mean(inb.map((r) => r.p)), emp = mean(inb.map((r) => r.y))
    ece += (inb.length / N) * Math.abs(conf - emp)
    wsum += inb.length * (conf - emp)
    curve.push({ lo: round4(lo), hi: round4(hi), n: inb.length, conf: round4(conf), emp: round4(emp) })
  }
  const bias = N ? wsum / N : 0
  const verdict = N < 30 ? 'sin dato' : bias > 0.03 ? 'sobre-confiado' : bias < -0.03 ? 'infra-confiado' : 'bien calibrado'
  return { curve, ece: round4(ece), n: N, verdict, bias: round4(bias) }
}

// Platt scaling fit on raw (prob, y) pairs: logit(cal) = a·logit(prob) + b.
export function fitPlatt(rows, getP, getY) {
  const samples = []
  for (const r of rows) { const p = getP(r), y = getY(r); if (p != null && (y === 0 || y === 1)) samples.push({ x: [logit(p)], offset: 0, y, ok: true }) }
  const fit = fitLogit(samples, { lambda: 1e-4, intercept: true, iters: 30 })
  if (!fit) return null
  const raw = rawCoefs(fit)
  return { a: round4(raw[0]), b: round4(fit.beta[0] - raw[0] * fit.mu[0] / (fit.sd[0] || 1)), n: fit.n }
}

// --- metrics ----------------------------------------------------------------
export function probMetrics(yTrue, yProb) {
  const n = yTrue.length
  if (!n) return { acc: null, logloss: null, brier: null, n: 0 }
  let hit = 0, ll = 0, br = 0
  for (let i = 0; i < n; i++) {
    const p = clamp(yProb[i], 1e-6, 1 - 1e-6), y = yTrue[i]
    if ((p >= 0.5 ? 1 : 0) === y) hit++
    ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p))
    br += (p - y) ** 2
  }
  return { acc: round4(hit / n), logloss: round4(ll / n), brier: round4(br / n), n }
}

// --- walk-forward replay (the honest OOS scoreboard) ------------------------
// rows: ALL graded rows (any order). For each date D, fit on rows with date < D
// (>= minTrain), score D's games, compare learned vs the logged classic prob.
export function walkForwardReplay(rows, { market = 'ml', minTrain = 100, lambda = 1.0 } = {}) {
  const graded = rows.filter((r) => r.graded && r.formula_version === FORMULA_VERSION)
  const byDate = {}
  for (const r of graded) (byDate[r.date] = byDate[r.date] || []).push(r)
  const dates = Object.keys(byDate).sort()
  const sample = market === 'ml' ? mlSample : totalSample
  const classicP = (r) => (market === 'ml' ? r.adrian_p : r.p_over)
  const yTrue = [], pC = [], pL = []
  const train = []
  for (const D of dates) {
    if (train.length >= minTrain) {
      const fit = fitLogit(train.map(sample), { lambda, intercept: market !== 'ml' })
      for (const g of byDate[D]) {
        const s = sample(g)
        const cp = classicP(g)
        if (!s.ok || cp == null || fit == null) continue
        const lp = predictLogit(fit, s.x, s.offset)
        if (lp == null) continue
        yTrue.push(s.y); pC.push(cp); pL.push(lp)
      }
    }
    for (const g of byDate[D]) train.push(g)
  }
  const cM = probMetrics(yTrue, pC), lM = probMetrics(yTrue, pL)
  const n = yTrue.length
  const se = n ? round4(Math.sqrt(0.25 / n)) : null // conservative SE for accuracy
  return {
    n, first_date: dates[0] || null, last_date: dates[dates.length - 1] || null,
    classic: cM, learned: lM,
    delta: n ? { acc: round4((lM.acc ?? 0) - (cM.acc ?? 0)), logloss: round4((lM.logloss ?? 0) - (cM.logloss ?? 0)), brier: round4((lM.brier ?? 0) - (cM.brier ?? 0)) } : null,
    se, tie: n ? Math.abs((lM.acc ?? 0) - (cM.acc ?? 0)) < (se ?? 1) : true,
  }
}

// Learned TOTAL component weights (relative emphasis, Σ|·|=1) for display.
export function totalWeights(fit) {
  if (!fit) return null
  const raw = rawCoefs(fit) // 6 components + (base - line)
  const comp = raw.slice(0, 6)
  const norm = comp.reduce((s, v) => s + Math.abs(v), 0) || 1
  const learned = {}
  TOTAL_COMPONENTS.forEach((k, j) => { learned[k] = round4(comp[j] / norm) })
  return { learned, base_line_coef: round4(raw[6]) }
}

// --- pick-side accessors (the side Adrian actually shows) --------------------
const mlPickProb = (r) => (r.adrian_p == null ? null : Math.max(r.adrian_p, 1 - r.adrian_p))
const mlPickWon = (r) => ((r.home_win === 0 || r.home_win === 1) ? (((r.adrian_p >= 0.5) === (r.home_win === 1)) ? 1 : 0) : null)
const totalPickProb = (r) => (r.p_over == null ? null : Math.max(r.p_over, 1 - r.p_over))
const totalPickWon = (r) => (r.total_result === 'win' ? 1 : r.total_result === 'loss' ? 0 : null)

function missReport(trust) {
  const tmap = Object.fromEntries(trust.map((t) => [t.factor, t.trust]))
  return (r) => {
    const pickHome = r.ml_pick === r.home
    const misled = ML_FACTORS.map((k) => ({ k, d: (r.factor_leans || {})[k] ?? 0 }))
      .filter((x) => (x.d > 0) === pickHome && Math.abs(x.d) >= 0.03)
      .map((x) => ({ factor: x.k, lean: round4(x.d), trust: tmap[x.k] ?? 0.5 }))
      .sort((a, b) => Math.abs(b.lean) - Math.abs(a.lean)).slice(0, 4)
    return { date: r.date, matchup: r.matchup, final: r.final, market: 'ml', prob: r.adrian_p, misled_factors: misled }
  }
}

// --- the canonical snapshot the robot writes and the app reads ---------------
// `rows` = every logged games_v1 row (graded + ungraded). Everything is fit on
// the graded subset of the CURRENT formula version. `now` is passed in (learn.js
// never touches the clock).
export function buildSnapshot(rows, { now = null } = {}) {
  const graded = rows.filter((r) => r.graded && r.formula_version === FORMULA_VERSION)
  const dates = [...new Set(graded.map((r) => r.date))].sort()
  const mlFit = fitLogit(graded.map(mlSample), { lambda: 1 })
  const totalFit = fitLogit(graded.map(totalSample), { lambda: 1, intercept: true })
  const trust = betaTrust(graded)
  return {
    updated_at: now, n_graded: graded.length, n_total: rows.length,
    first_date: dates[0] || null, last_date: dates[dates.length - 1] || null,
    formula_version: FORMULA_VERSION,
    ml: {
      fit: mlFit, weights: mlWeights(mlFit),
      calibration: { ...reliability(graded, mlPickProb, mlPickWon), platt: fitPlatt(graded, mlPickProb, mlPickWon) },
      trust,
      oos: walkForwardReplay(graded, { market: 'ml' }),
    },
    total: {
      fit: totalFit, weights: totalWeights(totalFit),
      calibration: reliability(graded, totalPickProb, totalPickWon),
      oos: walkForwardReplay(graded, { market: 'total' }),
    },
    misses: graded.filter((r) => r.ml_result === 'loss').slice(-15).reverse().map(missReport(trust)),
  }
}
