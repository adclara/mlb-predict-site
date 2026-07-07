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
  if (!fit || !Array.isArray(x) || x.length !== fit.features) return null // guard: stale fit vs newer feature extraction
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
  const raw = rawCoefs(fit) // raw[0] = beta1/sd already; de-standardized intercept = beta0 - raw[0]·mu
  return { a: round4(raw[0]), b: round4(fit.beta[0] - raw[0] * fit.mu[0]), n: fit.n }
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

// --- combined model (Adrian classic + learned), walk-forward ensemble --------
// p_comb = clamp(α·p_adrian + (1−α)·p_learned) with α learned per date D by
// log-loss sweep over the OOS pairs accumulated from days STRICTLY before D
// (mirrors backend sweep_ensemble_weights), then Platt-recalibrated on those
// same past pairs. The scored day never informs its own α, fit or calibration.
const EPS_P = 1e-4
const clampP = (p) => clamp(p, EPS_P, 1 - EPS_P)
const llOf = (p, y) => { const q = clamp(p, 1e-6, 1 - 1e-6); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)) }

export function applyPlatt(platt, p) {
  if (!platt) return p
  return sigmoid(platt.a * logit(p) + platt.b)
}

// Grid-sweep the blend weight α (0..1, step 1/steps) minimizing mean log-loss
// over (y, pC, pL) pairs. Pairs must all predate the day being scored.
export function sweepAlpha(pairs, { steps = 20 } = {}) {
  if (!pairs.length) return null
  let best = null, bestLL = Infinity
  for (let i = 0; i <= steps; i++) {
    const a = i / steps
    let ll = 0
    for (const h of pairs) ll += llOf(clampP(a * h.pC + (1 - a) * h.pL), h.y)
    ll /= pairs.length
    if (ll < bestLL - 1e-12) { bestLL = ll; best = a }
  }
  return { alpha: round4(best), logloss: round4(bestLL) }
}

// Walk-forward replay of classic vs learned vs combined. For each date D:
// fit on rows < D, learn α + Platt on the OOS pairs of days < D, score D.
// Until there is α history, the blend stays at alphaDefault (no peeking).
// The Platt map is shrunk toward the identity (k = n/(n+plattShrink)): a blend
// of two calibrated probs is near-calibrated, so with small n raw Platt is
// mostly variance — it only bites when miscalibration persists at scale.
export function walkForwardEnsemble(rows, { market = 'ml', minTrain = 100, lambda = 1.0, alphaMin = 20, alphaDefault = 0.5, plattMin = 100, plattShrink = 1500 } = {}) {
  const graded = rows.filter((r) => r.graded && r.formula_version === FORMULA_VERSION)
  const byDate = {}
  for (const r of graded) (byDate[r.date] = byDate[r.date] || []).push(r)
  const dates = Object.keys(byDate).sort()
  const sample = market === 'ml' ? mlSample : totalSample
  const classicP = (r) => (market === 'ml' ? r.adrian_p : r.p_over)
  const history = [] // OOS (y, pC, pL) pairs of already-scored days — sole training data for α/Platt
  const yTrue = [], pC = [], pL = [], pB = []
  const alphaCurve = []
  let lastPlatt = null
  const train = []
  for (const D of dates) {
    if (train.length >= minTrain) {
      const fit = fitLogit(train.map(sample), { lambda, intercept: market !== 'ml' })
      const swept = history.length >= alphaMin ? sweepAlpha(history) : null
      const alpha = swept ? swept.alpha : alphaDefault
      let platt = null
      if (history.length >= plattMin) {
        const raw = fitPlatt(history, (h) => clampP(alpha * h.pC + (1 - alpha) * h.pL), (h) => h.y)
        if (raw) {
          const k = history.length / (history.length + plattShrink)
          platt = { a: round4(1 + (raw.a - 1) * k), b: round4(raw.b * k), n: raw.n, shrink_k: round4(k) }
        }
      }
      if (platt) lastPlatt = platt
      const dayPairs = []
      for (const g of byDate[D]) {
        const s = sample(g), cp = classicP(g)
        if (!s.ok || cp == null || fit == null) continue
        const lp = predictLogit(fit, s.x, s.offset)
        if (lp == null) continue
        const raw = clampP(alpha * cp + (1 - alpha) * lp)
        const comb = platt ? clampP(applyPlatt(platt, raw)) : raw
        yTrue.push(s.y); pC.push(cp); pL.push(lp); pB.push(comb)
        dayPairs.push({ y: s.y, pC: cp, pL: lp })
      }
      if (dayPairs.length) alphaCurve.push({ date: D, alpha: round4(alpha), n_pairs: history.length, platt: !!platt })
      history.push(...dayPairs) // D's own results only become visible to LATER dates
    }
    for (const g of byDate[D]) train.push(g)
  }
  const n = yTrue.length
  const cM = probMetrics(yTrue, pC), lM = probMetrics(yTrue, pL), bM = probMetrics(yTrue, pB)
  return {
    n, first_date: dates[0] || null, last_date: dates[dates.length - 1] || null,
    classic: cM, learned: lM, combined: bM,
    delta: n ? { acc: round4(bM.acc - cM.acc), logloss: round4(bM.logloss - cM.logloss), brier: round4(bM.brier - cM.brier) } : null,
    alpha: { final: alphaCurve.length ? alphaCurve[alphaCurve.length - 1].alpha : null, curve: alphaCurve },
    platt_last: lastPlatt,
    _pairs: { y: yTrue, classic: pC, learned: pL, combined: pB },
  }
}

// Paired bootstrap (B resamples, deterministic LCG — learn.js never uses
// Math.random) over the OOS pairs: SE + 95% CI for each model's accuracy /
// log-loss / Brier and for Δ(combined − classic).
export function bootstrapStability(y, ps, { B = 1000, seed = 20260705 } = {}) {
  const n = y.length
  if (!n) return null
  let s = seed >>> 0
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const names = Object.keys(ps) // e.g. classic, learned, combined
  const acc = {}, ll = {}, br = {}
  for (const m of names) { acc[m] = []; ll[m] = []; br[m] = [] }
  const dAcc = [], dLL = [], dBr = []
  for (let b = 0; b < B; b++) {
    const hit = {}, sll = {}, sbr = {}
    for (const m of names) { hit[m] = 0; sll[m] = 0; sbr[m] = 0 }
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rnd() * n) % n
      const yy = y[k]
      for (const m of names) {
        const p = ps[m][k]
        if ((p >= 0.5 ? 1 : 0) === yy) hit[m]++
        sll[m] += llOf(p, yy)
        sbr[m] += (p - yy) ** 2
      }
    }
    for (const m of names) { acc[m].push(hit[m] / n); ll[m].push(sll[m] / n); br[m].push(sbr[m] / n) }
    if (ps.combined && ps.classic) {
      dAcc.push((hit.combined - hit.classic) / n)
      dLL.push((sll.combined - sll.classic) / n)
      dBr.push((sbr.combined - sbr.classic) / n)
    }
  }
  const stat = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b)
    const m = mean(arr)
    const sd = Math.sqrt(mean(arr.map((v) => (v - m) ** 2)))
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
    return { mean: round4(m), se: round4(sd), ci: [round4(q(0.025)), round4(q(0.975))] }
  }
  const models = {}
  for (const m of names) models[m] = { acc: stat(acc[m]), logloss: stat(ll[m]), brier: stat(br[m]) }
  return { B, n, models, delta: dLL.length ? { acc: stat(dAcc), logloss: stat(dLL), brier: stat(dBr) } : null }
}

// Full ensemble report: λ sweep (best by combined OOS log-loss), bootstrap
// stability on the winner, and the honest gate — if the 95% CI of
// Δlog-loss(combined − classic) crosses 0, it's a statistical tie.
export function ensembleReport(rows, { market = 'ml', lambdas = [0.3, 1, 3], minTrain = 100, B = 1000 } = {}) {
  const runs = lambdas.map((lambda) => ({ lambda, run: walkForwardEnsemble(rows, { market, lambda, minTrain }) }))
  const sweep = runs.map((r) => ({ lambda: r.lambda, n: r.run.n, acc: r.run.combined?.acc ?? null, logloss: r.run.combined?.logloss ?? null, brier: r.run.combined?.brier ?? null }))
  let best = runs[0]
  for (const r of runs) if (r.run.n > 0 && (r.run.combined.logloss ?? Infinity) < (best.run.n > 0 ? best.run.combined.logloss ?? Infinity : Infinity)) best = r
  const { _pairs, ...pub } = best.run
  if (!pub.n) return { ...pub, lambda_best: null, sweep, stability: null, tie: true, verdict: 'sin dato' }
  const stability = bootstrapStability(_pairs.y, { classic: _pairs.classic, learned: _pairs.learned, combined: _pairs.combined }, { B })
  const dll = stability?.delta?.logloss
  const tie = pub.n < 30 || !dll || (dll.ci[0] <= 0 && dll.ci[1] >= 0)
  // Walk-forward "does the classic pick hit more when the combined agrees?"
  // (y is home_win/over; the classic pick side is pC vs 0.5, its hit = side match)
  let agA = 0, agN = 0, dgA = 0, dgN = 0
  for (let i = 0; i < _pairs.y.length; i++) {
    const sideC = _pairs.classic[i] >= 0.5, hit = (sideC === (_pairs.y[i] === 1)) ? 1 : 0
    if ((_pairs.combined[i] >= 0.5) === sideC) { agN++; agA += hit } else { dgN++; dgA += hit }
  }
  const agree_split = {
    agree: { n: agN, ...wilson(agA, agN) },
    disagree: { n: dgN, ...wilson(dgA, dgN) },
  }
  return {
    ...pub, lambda_best: best.lambda, sweep, stability, tie, agree_split,
    verdict: tie ? 'empate' : dll.ci[1] < 0 ? 'combinado mejor' : 'clásico mejor',
  }
}

// --- pick indicators ("cuándo jugarlo") --------------------------------------
// A FIXED, pre-registered list of simple pre-game conditions (no rule mining:
// the candidate set is small and declared in code, each reported with its
// Wilson CI and sample size). active = 95% CI above 50%; strong = above the
// −110 break-even (52.38%). Descriptive, never a guarantee.
// --- market anchor: blend Adrian's prob toward the de-vig line ---------------
// Walk-forward α sweep (blend = α·adrian + (1−α)·market), α learned ONLY from days
// < D (reuses sweepAlpha with pC=adrian_p, pL=market_p). The 2026-07-06 study
// confirmed this is a strict calibration win over Adrian-alone (log-loss ~0.72 →
// ~0.69). HONEST FRAMING: the blended number is partly the market's opinion — it is
// a market-CALIBRATED probability, NOT an edge over the vig. Descriptive overlay.
export function marketAnchorReport(rows, { minTrain = 100, steps = 20 } = {}) {
  const graded = rows.filter((r) => r.graded && r.formula_version === FORMULA_VERSION && r.odds?.p_home_mkt != null && (r.home_win === 0 || r.home_win === 1) && r.adrian_p != null)
  const byDate = {}
  for (const r of graded) (byDate[r.date] = byDate[r.date] || []).push(r)
  const dates = Object.keys(byDate).sort()
  const yTrue = [], pModel = [], pMarket = [], pBlend = []
  const past = []
  for (const D of dates) {
    const sw = past.length >= minTrain ? sweepAlpha(past, { steps }) : null
    for (const g of byDate[D]) {
      if (sw == null) continue
      yTrue.push(g.home_win); pModel.push(g.adrian_p); pMarket.push(g.odds.p_home_mkt)
      pBlend.push(clampP(sw.alpha * g.adrian_p + (1 - sw.alpha) * g.odds.p_home_mkt))
    }
    for (const g of byDate[D]) past.push({ y: g.home_win, pC: g.adrian_p, pL: g.odds.p_home_mkt })
  }
  const final = past.length ? sweepAlpha(past, { steps }) : null // α to apply to today's games
  const mModel = probMetrics(yTrue, pModel), mMarket = probMetrics(yTrue, pMarket), mBlend = probMetrics(yTrue, pBlend)
  return {
    n: yTrue.length, alpha: final?.alpha ?? null,
    logloss: { model: mModel.logloss, market: mMarket.logloss, blend: mBlend.logloss },
    brier: { model: mModel.brier, market: mMarket.brier, blend: mBlend.brier },
    improves: mModel.logloss != null && mBlend.logloss != null && mBlend.logloss < mModel.logloss,
  }
}

// Blend a HOME win-prob toward the market's HOME de-vig prob (both home-oriented).
export function marketBlend(homeProb, marketHomeProb, alpha) {
  if (homeProb == null || marketHomeProb == null || alpha == null) return null
  return round4(clampP(alpha * homeProb + (1 - alpha) * marketHomeProb))
}

export const BREAK_EVEN_110 = 0.5238

export function wilson(k, n, z = 1.96) {
  if (!n) return { p: null, lo: null, hi: null }
  const p = k / n, z2 = z * z
  const den = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den
  return { p: round4(p), lo: round4(Math.max(0, center - half)), hi: round4(Math.min(1, center + half)) }
}

// Direction of the logged ML pick: +1 home, −1 away (from adrian_p).
const mlPickDir = (r) => (r.adrian_p >= 0.5 ? 1 : -1)
const pickStreak = (r) => (mlPickDir(r) > 0 ? r.streak_home : r.streak_away)

export const ML_INDICATORS = [
  { id: 'prob60', label: 'Prob. del pick ≥ 60%', test: (r) => mlPickProb(r) >= 0.60 },
  { id: 'prob55', label: 'Prob. del pick ≥ 55%', test: (r) => mlPickProb(r) >= 0.55 },
  { id: 'agree4', label: '4+ factores de acuerdo con el pick', test: (r) => (r.agree ?? 0) >= 4 },
  { id: 'agree5', label: '5+ factores de acuerdo con el pick', test: (r) => (r.agree ?? 0) >= 5 },
  { id: 'signal4', label: 'Señal de factores ≥ 4 pts hacia el pick', test: (r) => r.signal != null && Math.sign(r.signal) === mlPickDir(r) && Math.abs(r.signal) >= 0.04 },
  { id: 'news', label: 'Noticias/lesiones a favor del pick', test: (r) => (r.news_delta ?? 0) !== 0 && Math.sign(r.news_delta) === mlPickDir(r) },
  { id: 'streak3', label: 'El equipo del pick trae racha ≥ 3', test: (r) => (pickStreak(r) ?? 0) >= 3 },
  // Pre-registered 2026-07-05 (prior: home advantage; the away legs of the
  // formula run near coin-flip). The CI gate judges it forward like the rest.
  { id: 'home', label: 'El pick es el equipo local', test: (r) => r.adrian_p != null && r.adrian_p >= 0.5 },
]
export const TOTAL_INDICATORS = [
  { id: 'tprob57', label: 'Prob. del lado ≥ 57%', test: (r) => totalPickProb(r) >= 0.57 },
  { id: 'tedge05', label: 'Modelo vs línea ≥ 0.5 carreras', test: (r) => r.adj_total != null && r.line != null && Math.abs(r.adj_total - r.line) >= 0.5 },
  { id: 'tedge10', label: 'Modelo vs línea ≥ 1.0 carrera', test: (r) => r.adj_total != null && r.line != null && Math.abs(r.adj_total - r.line) >= 1.0 },
]

export function evalIndicators(rows, { market = 'ml', minN = 40 } = {}) {
  const graded = rows.filter((r) => r.graded && r.formula_version === FORMULA_VERSION)
  const defs = market === 'ml' ? ML_INDICATORS : TOTAL_INDICATORS
  const won = market === 'ml' ? mlPickWon : totalPickWon
  const scored = graded.map((r) => ({ r, y: won(r) })).filter((x) => x.y === 0 || x.y === 1)
  const base = wilson(scored.filter((x) => x.y === 1).length, scored.length)
  const list = defs.map((d) => {
    const sub = scored.filter((x) => { try { return d.test(x.r) } catch { return false } })
    const w = wilson(sub.filter((x) => x.y === 1).length, sub.length)
    return {
      id: d.id, label: d.label, n: sub.length, rate: w.p, lo: w.lo, hi: w.hi,
      lift: w.p != null && base.p != null ? round4(w.p - base.p) : null,
      active: sub.length >= minN && w.lo != null && w.lo > 0.5,
      strong: sub.length >= minN && w.lo != null && w.lo > BREAK_EVEN_110,
    }
  })
  return { baseline: { n: scored.length, rate: base.p, lo: base.lo, hi: base.hi }, min_n: minN, list }
}

// Which indicator ids does a single (ungraded) row satisfy today?
export function matchIndicators(row, market = 'ml') {
  const defs = market === 'ml' ? ML_INDICATORS : TOTAL_INDICATORS
  return defs.filter((d) => { try { return d.test(row) } catch { return false } }).map((d) => d.id)
}

// --- segment report: the anatomy of the classic's (mis)calibration ------------
// For fixed, pre-declared segments of ML picks: what the formula SAYS (mean
// stated prob of the pick) vs what HAPPENS (hit rate, with Wilson CI). This is
// the living version of the season-study insight that overconfidence is not
// uniform: mid-prob picks are honest, the tails inflate. Descriptive only.
const ML_SEGMENTS = [
  { id: 'all', label: 'Todos los picks', test: () => true },
  { id: 'home', label: 'Pick local', test: (r) => r.adrian_p >= 0.5 },
  { id: 'away', label: 'Pick visitante', test: (r) => r.adrian_p < 0.5 },
  { id: 'p50', label: 'Prob 50–55%', test: (r) => mlPickProb(r) < 0.55 },
  { id: 'p55', label: 'Prob 55–60%', test: (r) => mlPickProb(r) >= 0.55 && mlPickProb(r) < 0.60 },
  { id: 'p60', label: 'Prob 60–65%', test: (r) => mlPickProb(r) >= 0.60 && mlPickProb(r) < 0.65 },
  { id: 'p65', label: 'Prob ≥ 65%', test: (r) => mlPickProb(r) >= 0.65 },
]
export function segmentReport(rows) {
  const graded = rows.filter((r) => r.graded && r.formula_version === FORMULA_VERSION)
  const scored = graded.map((r) => ({ r, y: mlPickWon(r) })).filter((x) => (x.y === 0 || x.y === 1) && x.r.adrian_p != null)
  return ML_SEGMENTS.map((s) => {
    const sub = scored.filter((x) => { try { return s.test(x.r) } catch { return false } })
    const n = sub.length
    if (!n) return { id: s.id, label: s.label, n: 0, says: null, hits: null, lo: null, hi: null, gap: null }
    const says = sub.reduce((acc, x) => acc + mlPickProb(x.r), 0) / n
    const w = wilson(sub.filter((x) => x.y === 1).length, n)
    return { id: s.id, label: s.label, n, says: round4(says), hits: w.p, lo: w.lo, hi: w.hi, gap: round4(says - w.p) }
  })
}

// --- today's Aprende opinion for a live analysis ------------------------------
// Projects the walk-forward-validated combined model onto TODAY's game (all
// inputs are pre-game; the fit/α/Platt come from the robot's snapshot, trained
// only on past graded games). Returns null when there's no usable snapshot.
export function aprendeOpinion(analysis, snapshot, { minGraded = 150 } = {}) {
  if (!snapshot || snapshot.formula_version !== FORMULA_VERSION || (snapshot.n_graded ?? 0) < minGraded) return null
  const row = analysisToRow(analysis)
  const out = { ml: null, total: null }
  const mlC = snapshot.ml?.combined
  if (snapshot.ml?.fit && mlC?.n) {
    const s = mlSample(row)
    const pL = predictLogit(snapshot.ml.fit, s.x, s.offset)
    if (pL != null && row.adrian_p != null) {
      const alpha = mlC.alpha?.final ?? 1
      let p = clampP(alpha * row.adrian_p + (1 - alpha) * pL)
      if (mlC.platt_last) p = clampP(applyPlatt(mlC.platt_last, p))
      out.ml = {
        p_comb: round4(p), p_classic: row.adrian_p,
        favors: (p >= 0.5) === (row.adrian_p >= 0.5),
        indicators: matchIndicators(row, 'ml'),
      }
    }
  }
  const tC = snapshot.total?.combined
  if (snapshot.total?.fit && tC?.n) {
    const s = totalSample(row)
    const pL = predictLogit(snapshot.total.fit, s.x, s.offset)
    if (pL != null && row.p_over != null) {
      const alpha = tC.alpha?.final ?? 1
      let p = clampP(alpha * row.p_over + (1 - alpha) * pL)
      if (tC.platt_last) p = clampP(applyPlatt(tC.platt_last, p))
      out.total = {
        p_comb: round4(p), p_classic: row.p_over,
        favors: (p >= 0.5) === (row.p_over >= 0.5),
        indicators: matchIndicators(row, 'total'),
      }
    }
  }
  return out.ml || out.total ? out : null
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

// --- market ("logros") studies ----------------------------------------------
// HONEST FRAMING: we never claim a book cheats. We measure whether the market's
// de-vigged pregame price (from ESPN's free pickcenter) forecasts the winner
// better than adrian_p, and test the thesis that a slight ("-110") favorite wins
// MORE than a big favorite. The pregame line is known before first pitch → safe
// as a predictor; the win-prob curve is never used here (past-game studies only,
// Phase 3). Every claim is Wilson/bootstrap CI-gated → "empate" when it crosses.
const sideWon = (side, homeWin) => ((homeWin === 0 || homeWin === 1) ? (side === 'home' ? homeWin : 1 - homeWin) : null)
const favML = (o) => (o?.ml_home != null && o?.ml_away != null ? Math.min(o.ml_home, o.ml_away) : null)

export const ODDS_INDICATORS = [
  { id: 'pickem_fav', label: 'Favorito en juego parejo (línea ≥ −145)', test: (r) => { const f = favML(r.odds); return f != null && f >= -145 }, pick: (r) => r.odds.fav_side },
  { id: 'heavy_fav', label: 'Favorito grande (línea ≤ −190)', test: (r) => { const f = favML(r.odds); return f != null && f <= -190 }, pick: (r) => r.odds.fav_side },
  { id: 'market_agrees', label: 'Mercado y Adrian coinciden en el favorito', test: (r) => r.adrian_p != null && r.odds?.p_home_mkt != null && (r.adrian_p >= 0.5) === (r.odds.p_home_mkt >= 0.5), pick: (r) => r.odds.fav_side },
]

// Win rate (Wilson CI) of the market-favorite side for each pre-registered
// condition, vs the baseline market-favorite win rate. Tests the dad's "-110
// wins more than a big favorite" thesis honestly (likely "empate" at first).
export function evalOddsIndicators(rows, { minN = 40 } = {}) {
  const graded = rows.filter((r) => r.graded && r.formula_version === FORMULA_VERSION && r.odds?.p_home_mkt != null && (r.home_win === 0 || r.home_win === 1))
  const baseWon = graded.map((r) => sideWon(r.odds.fav_side, r.home_win)).filter((v) => v === 0 || v === 1)
  const base = wilson(baseWon.filter((v) => v === 1).length, baseWon.length)
  const list = ODDS_INDICATORS.map((d) => {
    const won = graded.filter((r) => { try { return d.test(r) } catch { return false } })
      .map((r) => sideWon(d.pick(r), r.home_win)).filter((v) => v === 0 || v === 1)
    const w = wilson(won.filter((v) => v === 1).length, won.length)
    return {
      id: d.id, label: d.label, n: won.length, rate: w.p, lo: w.lo, hi: w.hi,
      lift: w.p != null && base.p != null ? round4(w.p - base.p) : null,
      active: won.length >= minN && w.lo != null && w.lo > 0.5,
      strong: won.length >= minN && w.lo != null && w.lo > BREAK_EVEN_110,
    }
  })
  return { baseline: { n: baseWon.length, rate: base.p, lo: base.lo, hi: base.hi }, min_n: minN, list }
}

// Is the de-vigged pregame market prob a better winner-forecaster than adrian_p?
// Paired bootstrap on Δlog-loss(model − market) with the same "empate" gate.
export function oddsReport(rows, { B = 1000, minN = 40 } = {}) {
  const graded = rows.filter((r) => r.graded && r.formula_version === FORMULA_VERSION && r.odds?.p_home_mkt != null && r.adrian_p != null && (r.home_win === 0 || r.home_win === 1))
  const n = graded.length
  if (n < minN) return { n, market: null, model: null, delta: null, tie: true, verdict: 'sin dato', disagree: null }
  const y = graded.map((r) => r.home_win)
  const pMarket = graded.map((r) => clamp(r.odds.p_home_mkt, 1e-4, 1 - 1e-4))
  const pModel = graded.map((r) => clamp(r.adrian_p, 1e-4, 1 - 1e-4))
  const market = probMetrics(y, pMarket), model = probMetrics(y, pModel)
  const boot = bootstrapStability(y, { classic: pMarket, combined: pModel }, { B }) // delta = model − market
  const dll = boot?.delta?.logloss
  const tie = !dll || (dll.ci[0] <= 0 && dll.ci[1] >= 0)
  const dis = graded.filter((r) => (r.adrian_p >= 0.5) !== (r.odds.p_home_mkt >= 0.5))
  const mktWon = dis.map((r) => sideWon(r.odds.fav_side, r.home_win)).filter((v) => v === 0 || v === 1)
  const disW = wilson(mktWon.filter((v) => v === 1).length, mktWon.length)
  return {
    n, market, model, delta: dll,
    tie, verdict: tie ? 'empate' : dll.ci[1] < 0 ? 'modelo mejor' : 'mercado mejor',
    disagree: { n: mktWon.length, market_win_rate: disW.p, lo: disW.lo, hi: disW.hi },
  }
}

// The dad's "stubborn favorite" thesis, honestly: when the pregame favorite is
// LOSING early, does it come back and win MORE than a generic team trailing at
// the same point? Uses only the post-game win-prob curve of PAST graded games
// (a completed-game fact) → never an input to today's pick. Non-overlapping
// Wilson CIs → "el favorito remonta más"; overlap → empate.
export function trailedEarlyReport(rows, { throughInn = 3, minN = 30 } = {}) {
  const graded = rows.filter((r) => r.graded && r.formula_version === FORMULA_VERSION && r.odds?.wp_curve && r.odds?.fav_side && (r.home_win === 0 || r.home_win === 1))
  let trailerN = 0, trailerWins = 0, favN = 0, favWins = 0
  const bucket = { pickem: [0, 0], heavy: [0, 0] } // [wins, n] for fav-trailed
  for (const r of graded) {
    let sh = null, sa = null // score at the end of `throughInn`
    for (const p of r.odds.wp_curve) { if (p.inn > throughInn) break; if (p.home_score != null) { sh = p.home_score; sa = p.away_score } }
    if (sh == null || sh === sa) continue // no score / tied → no clear early trailer
    const trailingSide = sh < sa ? 'home' : 'away'
    const trailingWon = (trailingSide === 'home' ? r.home_win === 1 : r.home_win === 0) ? 1 : 0
    trailerN++; trailerWins += trailingWon
    if (r.odds.fav_side === trailingSide) {
      favN++; favWins += trailingWon
      const f = favML(r.odds)
      if (f != null && f >= -145) { bucket.pickem[1]++; bucket.pickem[0] += trailingWon }
      else if (f != null && f <= -190) { bucket.heavy[1]++; bucket.heavy[0] += trailingWon }
    }
  }
  const any = wilson(trailerWins, trailerN), fav = wilson(favWins, favN)
  const tie = favN < minN || trailerN < minN || fav.lo == null || any.hi == null || fav.lo <= any.hi
  return {
    through_inn: throughInn,
    any_trailer: { n: trailerN, rate: any.p, lo: any.lo, hi: any.hi },
    fav_trailer: { n: favN, rate: fav.p, lo: fav.lo, hi: fav.hi },
    pickem: { n: bucket.pickem[1], ...wilson(bucket.pickem[0], bucket.pickem[1]) },
    heavy: { n: bucket.heavy[1], ...wilson(bucket.heavy[0], bucket.heavy[1]) },
    tie, verdict: tie ? 'empate' : 'el favorito remonta más',
  }
}

// --- market microstructure: multi-book consensus, disagreement, line movement -
// Three PRE-REGISTERED, CI-gated questions on the enriched market block (books[],
// consensus, book_disagreement, line_move) captured by odds.js. Every field is
// additive metadata (no FORMULA_VERSION bump) and only appears on rows captured
// after this feature shipped, so verdicts read "sin dato" until data accrues —
// exactly the honest posture the rest of the file keeps.
//   1) value  — when the model's price beats the consensus by >=3 pts, does that
//               side clear the -110 break-even? (the honest Yankees/Tampa test)
//   2) disagreement — is the market favorite weaker when the books disagree?
//   3) line_move — does the side the line moved TOWARD win more than a coin flip?
export function marketMicrostructureReport(rows, { minN = 30 } = {}) {
  const g = rows.filter((r) => r.graded && r.formula_version === FORMULA_VERSION && (r.home_win === 0 || r.home_win === 1))
  // 1) value edge
  const val = g.filter((r) => r.value?.best_side && (r.value.best_edge ?? 0) >= 0.03)
  const valWon = val.map((r) => (r.value.best_side === 'home' ? r.home_win : 1 - r.home_win)).filter((v) => v === 0 || v === 1)
  const vW = wilson(valWon.filter((v) => v === 1).length, valWon.length)
  const value = {
    n: valWon.length, rate: vW.p, lo: vW.lo, hi: vW.hi,
    verdict: valWon.length < minN ? 'sin dato' : (vW.lo != null && vW.lo > BREAK_EVEN_110) ? 'valor real' : (vW.hi != null && vW.hi < 0.5) ? 'trampa' : 'empate',
  }
  // 2) between-book disagreement
  const withDis = g.filter((r) => r.odds?.book_disagreement != null && r.odds?.fav_side)
  const favWin = (arr) => { const won = arr.map((r) => sideWon(r.odds.fav_side, r.home_win)).filter((v) => v === 0 || v === 1); return { n: won.length, ...wilson(won.filter((v) => v === 1).length, won.length) } }
  const disHi = favWin(withDis.filter((r) => r.odds.book_disagreement >= 0.04))
  const disLo = favWin(withDis.filter((r) => r.odds.book_disagreement < 0.04))
  const disagreement = {
    high: disHi, low: disLo,
    verdict: (disHi.n < minN || disLo.n < minN || disHi.hi == null || disLo.lo == null) ? 'sin dato' : disHi.hi < disLo.lo ? 'discrepancia = más riesgo' : 'empate',
  }
  // 3) line movement (open -> close)
  const moved = g.filter((r) => r.odds?.line_move != null && Math.abs(r.odds.line_move) >= 0.03)
  const towardWon = moved.map((r) => sideWon(r.odds.line_move > 0 ? 'home' : 'away', r.home_win)).filter((v) => v === 0 || v === 1)
  const mW = wilson(towardWon.filter((v) => v === 1).length, towardWon.length)
  const line_move = {
    n: towardWon.length, rate: mW.p, lo: mW.lo, hi: mW.hi,
    verdict: towardWon.length < minN ? 'sin dato' : (mW.lo != null && mW.lo > 0.5) ? 'seguir el movimiento' : 'empate',
  }
  return { min_n: minN, n_with_books: g.filter((r) => r.odds?.consensus?.n_books > 1).length, value, disagreement, line_move }
}

// --- signal audit: which factors actually detect winners, honestly -----------
// Each signal is a PRE-DECLARED oriented hypothesis (the direction is a prior, not
// fit from outcomes → no leakage). We compare favorable-vs-unfavorable ML picks
// with a bootstrap CI on the gap AND a both-halves robustness gate. A signal is
// only 'robusto' if the gap CI excludes 0 AND it stays positive in BOTH halves of
// the season — a signal that only works in one half is the classic false positive
// (this is exactly what killed the pitcher-ERA signal in the 2026-07-06 blind sim).
// Verdicts self-expire as forward data accrues. Descriptive only — never an input.
const pickEraAdv = (r) => {
  const pr = r.pitcher_recent; if (!pr) return null
  const home = mlPickDir(r) > 0, pk = home ? pr.home : pr.away, op = home ? pr.away : pr.home
  if (pk?.era == null || op?.era == null) return null
  return op.era - pk.era // > 0 → the pick's starter has better recent ERA
}
const pickIsMktFav = (r) => { const o = r.odds; if (!o || !o.fav_side) return null; return o.fav_side === (mlPickDir(r) > 0 ? 'home' : 'away') }
const newsFavorsPick = (r) => (r.news_delta ?? 0) !== 0 && Math.sign(r.news_delta) === mlPickDir(r)
const AUDIT_SIGNALS = [
  { id: 'market', label: 'Coincide con el favorito del mercado', req: (r) => r.odds?.fav_side != null, fav: (r) => pickIsMktFav(r) },
  { id: 'agree5', label: '5+ factores de acuerdo con el pick', req: () => true, fav: (r) => (r.agree ?? 0) >= 5 },
  { id: 'prob60', label: 'Prob. del pick ≥ 60%', req: () => true, fav: (r) => mlPickProb(r) >= 0.60 },
  { id: 'pitcher', label: 'Mejor ERA reciente del abridor', req: (r) => pickEraAdv(r) != null, fav: (r) => pickEraAdv(r) > 0 },
  { id: 'streak3', label: 'Racha del equipo del pick ≥ 3', req: () => true, fav: (r) => (pickStreak(r) ?? 0) >= 3 },
  { id: 'news', label: 'Noticias/lesiones a favor del pick', req: () => true, fav: (r) => newsFavorsPick(r) },
]
// deterministic seeded bootstrap CI of mean(a) − mean(b) over 0/1 arrays.
function bootGap(a, b, B = 1000, seed = 20260706) {
  if (!a.length || !b.length) return null
  let s = seed >>> 0; const rnd = () => (s = (1664525 * s + 1013904223) >>> 0) / 4294967296
  const ds = []
  for (let t = 0; t < B; t++) { let sa = 0; for (let i = 0; i < a.length; i++) sa += a[(rnd() * a.length) | 0]; let sb = 0; for (let i = 0; i < b.length; i++) sb += b[(rnd() * b.length) | 0]; ds.push(sa / a.length - sb / b.length) }
  ds.sort((x, y) => x - y)
  return { lo: round4(ds[Math.floor(0.025 * B)]), hi: round4(ds[Math.floor(0.975 * B)]) }
}
export function signalAudit(rows, { minN = 60 } = {}) {
  const graded = rows.filter((r) => r.graded && r.formula_version === FORMULA_VERSION)
  const scored = graded.map((r) => ({ r, y: mlPickWon(r), date: r.date })).filter((x) => x.y === 0 || x.y === 1)
  scored.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const mid = scored.length ? scored[Math.floor(scored.length / 2)].date : null
  const base = wilson(scored.filter((x) => x.y === 1).length, scored.length)
  const rateOf = (arr) => (arr.length ? arr.filter((x) => x.y === 1).length / arr.length : null)
  const list = AUDIT_SIGNALS.map((s) => {
    const usable = scored.filter((x) => { try { return s.req(x.r) } catch { return false } })
    const favG = [], unfG = []
    for (const x of usable) { let f; try { f = s.fav(x.r) } catch { f = null }; if (f === true) favG.push(x); else if (f === false) unfG.push(x) }
    const wf = wilson(favG.filter((x) => x.y === 1).length, favG.length), wu = wilson(unfG.filter((x) => x.y === 1).length, unfG.length)
    const gap = (wf.p != null && wu.p != null) ? round4(wf.p - wu.p) : null
    const ci = bootGap(favG.map((x) => x.y), unfG.map((x) => x.y))
    const hg = (which) => { const f = favG.filter((x) => which === 1 ? x.date < mid : x.date >= mid), u = unfG.filter((x) => which === 1 ? x.date < mid : x.date >= mid); const a = rateOf(f), b = rateOf(u); return (a == null || b == null) ? null : round4(a - b) }
    const g1 = hg(1), g2 = hg(2)
    let verdict = 'sin dato'
    if (favG.length >= minN && unfG.length >= minN && ci) {
      const sig = ci.lo > 0
      // Both halves must show a MEANINGFULLY positive gap (>= +2 pts each), not just
      // >0 — a half that is ~flat (e.g. +0.2) means the effect lives in one half only,
      // the classic false-positive signature. Such a signal is 'frágil', not robust.
      const bothHalves = g1 != null && g2 != null && g1 >= 0.02 && g2 >= 0.02
      verdict = !sig ? 'ruido' : bothHalves ? 'robusto' : 'frágil'
    }
    return { id: s.id, label: s.label, n_fav: favG.length, n_unf: unfG.length, fav_rate: wf.p, fav_lo: wf.lo, fav_hi: wf.hi, unf_rate: wu.p, gap, gap_lo: ci?.lo ?? null, gap_hi: ci?.hi ?? null, half1: g1, half2: g2, verdict }
  })
  const rank = { robusto: 0, 'frágil': 1, ruido: 2, 'sin dato': 3 }
  list.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || ((b.gap ?? -9) - (a.gap ?? -9)))
  return { baseline: { n: scored.length, rate: base.p, lo: base.lo, hi: base.hi }, min_n: minN, list }
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
      combined: ensembleReport(graded, { market: 'ml' }),
      market_anchor: marketAnchorReport(graded),
    },
    total: {
      fit: totalFit, weights: totalWeights(totalFit),
      calibration: reliability(graded, totalPickProb, totalPickWon),
      oos: walkForwardReplay(graded, { market: 'total' }),
      combined: ensembleReport(graded, { market: 'total' }),
    },
    indicators: {
      ml: evalIndicators(graded, { market: 'ml' }),
      total: evalIndicators(graded, { market: 'total' }),
    },
    segments: segmentReport(graded),
    signal_audit: signalAudit(graded),
    n_backfilled: graded.filter((r) => r.backfilled).length,
    odds: {
      n_with_line: graded.filter((r) => r.odds?.p_home_mkt != null).length,
      n_with_curve: graded.filter((r) => r.odds?.wp_curve).length,
      indicators: evalOddsIndicators(graded),
      market_vs_model: oddsReport(graded),
      trailed_early: trailedEarlyReport(graded),
      microstructure: marketMicrostructureReport(graded),
    },
    misses: graded.filter((r) => r.ml_result === 'loss').slice(-15).reverse().map(missReport(trust)),
  }
}
