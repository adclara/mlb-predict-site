// Adrian Clara Learning (beta) — pure, dependency-free learners.
//
// WALK-FORWARD ONLY: every fit is trained on rows STRICTLY BEFORE the day being
// scored; a game's own result never influences its own weighting/calibration.
// Shared by the Node robot (canonical snapshot -> data/history/learning.json)
// and the browser (today's projection). No wall clock/Math.random used.
//
// The classic "Estadística Adrian" (adrian.js) is 100% untouched: this file only
// reads its (additive) intermediate outputs and re-weights them on the side.

import { WEIGHTS } from './adrian.js'

// Bump when adrian.js's factor math changes so stale rows are dropped from fits.
export const FORMULA_VERSION = 'v2'
export const ML_FACTORS = ['momentum', 'pitching', 'f5', 'bats', 'schedule', 'manager']
export const TOTAL_COMPONENTS = ['aStart', 'hStart', 'homeContact', 'awayContact', 'aFat', 'hFat']

const BAD_GAME_STATUS = /postponed|cancel(?:led|ed)|suspended/i
const LATE_CAPTURE_STATUS = /in progress|final|game over|completed/i
const VERIFIED_TEMPORAL_COHORTS = new Set(['backfill_asof', 'native_pregame_immutable'])

const hasFinalOutcome = (r) => (r?.home_win === 0 || r?.home_win === 1)
  && typeof r?.final === 'string' && /^\d+-\d+$/.test(r.final)

function rowQuality(r) {
  let q = 0
  if (r?.integrity?.training_eligible === true) q += 40
  if (r?.integrity?.training_eligible === false) q -= 40
  if (r?.graded === true && hasFinalOutcome(r)) q += 20
  if (r?.date && r?.game_date && r.date === r.game_date) q += 8
  if (r?.capture_phase === 'pregame' || r?.decision_captured_at) q += 6
  if (r?.backfilled) q += 4 // explicitly reconstructed as-of rows
  if (!LATE_CAPTURE_STATUS.test(String(r?.status || ''))) q += 2
  if (r?.odds?.captured_at_open) q += 1
  return q
}

const validIso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v))

// Fail closed: a row is learnable only after the ledger has explicitly vouched
// for it and assigned it to one of the two causal cohorts. Reconstructed
// `backfill_asof` rows were generated from an as-of source and sealed by the
// ledger migration. Native rows additionally prove that their immutable feature
// snapshot predates first pitch. A plausible status/capture_phase alone is not
// evidence: legacy rows used to be overwritten later in the same day.
export function hasVerifiedTemporalCohort(row) {
  const integrity = row?.integrity
  if (integrity?.training_eligible !== true || !VERIFIED_TEMPORAL_COHORTS.has(integrity?.cohort)) return false
  if (integrity.cohort === 'backfill_asof') {
    return row?.backfilled === true && integrity.reason === 'asof_backfill'
  }
  const asOf = row?.feature_as_of ?? row?.decision_captured_at
  const firstPitch = row?.first_pitch ?? integrity?.first_pitch ?? row?.start ?? row?.game_datetime
  return row?.capture_phase === 'pregame' && typeof row?.feature_hash === 'string'
    && row.feature_hash.length === 64 && validIso(asOf) && validIso(firstPitch)
    && Date.parse(asOf) < Date.parse(firstPitch)
}

// Canonical game de-duplication. A postponed placeholder and its later played
// game can share game_pk; prefer the row with a real outcome and matching
// official date. Stable ties keep the first row so results are reproducible.
export function dedupeGameRows(rows) {
  const out = new Map(), noPk = []
  for (const r of rows || []) {
    if (!r || typeof r !== 'object') continue
    if (r.game_pk == null) { noPk.push(r); continue }
    const k = String(r.game_pk), prev = out.get(k)
    if (!prev || rowQuality(r) > rowQuality(prev)) out.set(k, r)
  }
  return [...out.values(), ...noPk]
}

// Single source of truth for every learner/replay. In strict mode the default is
// fail-closed: only ledger-approved, explicitly verifiable causal cohorts enter
// a fit. This function is exported for the standalone daily learner so ingestion
// code never has to duplicate these rules.
export function prepareTrainingRows(rows, { formulaVersion = FORMULA_VERSION, strictTemporal = true } = {}) {
  return dedupeGameRows(rows).filter((r) => {
    if (r.graded !== true || !hasFinalOutcome(r) || !r.date) return false
    if (formulaVersion != null && r.formula_version !== formulaVersion) return false
    if (BAD_GAME_STATUS.test(String(r.status || ''))) return false
    if (strictTemporal) return hasVerifiedTemporalCohort(r)
    if (r.integrity?.training_eligible === false) return false
    return true
  })
}

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
  const graded = prepareTrainingRows(rows)
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
  const graded = prepareTrainingRows(rows)
  const byDate = {}
  for (const r of graded) (byDate[r.date] = byDate[r.date] || []).push(r)
  const dates = Object.keys(byDate).sort()
  const sample = market === 'ml' ? mlSample : totalSample
  const classicP = (r) => (market === 'ml' ? r.adrian_p : r.p_over)
  const history = [] // OOS (y, pC, pL) pairs of already-scored days — sole training data for α/Platt
  const yTrue = [], pC = [], pL = [], pB = [], pairDates = [], pairRows = []
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
        yTrue.push(s.y); pC.push(cp); pL.push(lp); pB.push(comb); pairDates.push(D); pairRows.push(g)
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
    _pairs: { y: yTrue, classic: pC, learned: pL, combined: pB, dates: pairDates, rows: pairRows },
  }
}

// Paired bootstrap (B resamples, deterministic xorshift32 — learn.js never uses
// Math.random) over the OOS pairs: SE + 95% CI for each model's accuracy /
// log-loss / Brier and for Δ(combined − classic).
function bootstrapRng(seed) {
  let x = (Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : 0x9e3779b9) || 0x9e3779b9
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296 }
}

export function bootstrapStability(y, ps, { B = 1000, seed = 20260705, blocks = null } = {}) {
  const n = y.length
  if (!n) return null
  const rnd = bootstrapRng(seed)
  const names = Object.keys(ps).filter((k) => Array.isArray(ps[k]) && ps[k].length === n) // e.g. classic, learned, combined
  if (!names.length) return null
  const useBlocks = Array.isArray(blocks) && blocks.length === n
  const blockList = []
  if (useBlocks) {
    const by = new Map()
    for (let i = 0; i < n; i++) { const k = String(blocks[i]); if (!by.has(k)) by.set(k, []); by.get(k).push(i) }
    blockList.push(...by.values())
  }
  const acc = {}, ll = {}, br = {}
  for (const m of names) { acc[m] = []; ll[m] = []; br[m] = [] }
  const dAcc = [], dLL = [], dBr = []
  for (let b = 0; b < B; b++) {
    const hit = {}, sll = {}, sbr = {}
    for (const m of names) { hit[m] = 0; sll[m] = 0; sbr[m] = 0 }
    const sample = []
    if (blockList.length) {
      // Date/block bootstrap keeps the same-slate correlation intact.
      for (let j = 0; j < blockList.length; j++) sample.push(...blockList[Math.floor(rnd() * blockList.length)])
    } else for (let i = 0; i < n; i++) sample.push(Math.floor(rnd() * n))
    const denom = sample.length || 1
    for (const k of sample) {
      const yy = y[k]
      for (const m of names) {
        const p = ps[m][k]
        if ((p >= 0.5 ? 1 : 0) === yy) hit[m]++
        sll[m] += llOf(p, yy)
        sbr[m] += (p - yy) ** 2
      }
    }
    for (const m of names) { acc[m].push(hit[m] / denom); ll[m].push(sll[m] / denom); br[m].push(sbr[m] / denom) }
    if (ps.combined && ps.classic) {
      dAcc.push((hit.combined - hit.classic) / denom)
      dLL.push((sll.combined - sll.classic) / denom)
      dBr.push((sbr.combined - sbr.classic) / denom)
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
  return { B, n, method: blockList.length ? 'date_block' : 'iid', n_blocks: blockList.length || null,
    models, delta: dLL.length ? { acc: stat(dAcc), logloss: stat(dLL), brier: stat(dBr) } : null }
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
  const stability = bootstrapStability(_pairs.y, { classic: _pairs.classic, learned: _pairs.learned, combined: _pairs.combined }, { B, blocks: _pairs.dates })
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
// Walk-forward α sweep (blend = α·adrian + (1−α)·market), learned only
// from prior dates. Historical latest-price rows have unknown timing, so that
// cohort is diagnostic only. The public chain stays disabled until auditable
// opening captures pass a forward, date-block-bootstrap gate.
const validProb = (v) => Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 1

// A market price is eligible as a model input only when its provenance says it
// was captured pre-game, it carries an actual capture time, and (when a first
// pitch is available) that time is not after first pitch. Historical
// `p_home_open` fields without this metadata stay readable for legacy reports,
// but never enter a new challenger or a publication gate.
export function auditableOpeningMarketHome(row) {
  const o = row?.odds
  if (!o || o.open_provenance !== 'explicit_pregame' || !o.captured_at_open || !validProb(o.p_home_open)) return null
  const captured = Date.parse(o.captured_at_open)
  if (!Number.isFinite(captured)) return null
  const firstPitchRaw = row?.start ?? row?.game_datetime ?? row?.scheduled_at ?? null
  if (firstPitchRaw != null) {
    const firstPitch = Date.parse(firstPitchRaw)
    if (Number.isFinite(firstPitch) && captured > firstPitch) return null
  }
  return Number(o.p_home_open)
}

export function auditableClosingMarketHome(row) {
  const o = row?.odds
  if (!o || o.close_provenance !== 'explicit_close_capture' || !o.captured_at_close
    || !o.provider_close || !validProb(o.p_home_close)) return null
  const captured = Date.parse(o.captured_at_close)
  return Number.isFinite(captured) ? Number(o.p_home_close) : null
}

function marketCohort(row) {
  if (auditableOpeningMarketHome(row) != null) return 'auditable_open'
  if (validProb(row?.odds?.p_home_open)) return 'legacy_open_unverified'
  if (validProb(row?.odds?.p_home_close)) return 'closing_only'
  if (validProb(row?.odds?.p_home_mkt)) return 'latest_time_unknown'
  return 'no_market'
}

function marketCohorts(rows) {
  const out = { auditable_open: 0, legacy_open_unverified: 0, closing_only: 0, latest_time_unknown: 0, no_market: 0 }
  for (const r of rows) out[marketCohort(r)]++
  return out
}

function anchorWalkForward(rows, getModel, getMarket, { minTrain = 100, steps = 20 } = {}) {
  const usable = rows.filter((r) => validProb(getModel(r)) && validProb(getMarket(r)))
  const byDate = {}
  for (const r of usable) (byDate[r.date] = byDate[r.date] || []).push(r)
  const dates = Object.keys(byDate).sort(), past = []
  const y = [], model = [], market = [], blend = [], pairDates = []
  for (const D of dates) {
    const sw = past.length >= minTrain ? sweepAlpha(past, { steps }) : null
    if (sw) for (const g of byDate[D]) {
      const pm = Number(getModel(g)), pk = Number(getMarket(g))
      y.push(g.home_win); model.push(pm); market.push(pk)
      blend.push(clampP(sw.alpha * pm + (1 - sw.alpha) * pk)); pairDates.push(D)
    }
    for (const g of byDate[D]) past.push({ y: g.home_win, pC: Number(getModel(g)), pL: Number(getMarket(g)) })
  }
  return {
    n: y.length, n_available: usable.length, dates: pairDates,
    alpha: past.length ? sweepAlpha(past, { steps })?.alpha ?? null : null,
    model: probMetrics(y, model), market: probMetrics(y, market), blend: probMetrics(y, blend),
    pairs: { y, model, market, blend, dates: pairDates },
  }
}

export function marketAnchorReport(rows, {
  minTrain = 100, steps = 20, minForward = 300, minDates = 30, maxEce = 0.05, B = 1000,
} = {}) {
  const all = prepareTrainingRows(rows)
  // Compatibility diagnostic only: historical p_home_mkt was not guaranteed
  // to be captured before first pitch and can never authorize publication.
  const legacy = anchorWalkForward(all, (r) => r.adrian_p, (r) => r.odds?.p_home_mkt, { minTrain, steps })
  // Exact production-chain audit when the row logged p_learn and an auditable
  // pre-game opening. Until this forward gate passes it cannot alter p_final.
  const production = anchorWalkForward(all, (r) => r.p_learn, auditableOpeningMarketHome, { minTrain, steps })
  const stability = bootstrapStability(production.pairs.y,
    { classic: production.pairs.model, combined: production.pairs.blend },
    { B, seed: 20260721, blocks: production.pairs.dates })
  const calibration = homeReliability(production.pairs.y, production.pairs.blend)
  const dll = stability?.delta?.logloss?.ci, dbr = stability?.delta?.brier?.ci
  const nDates = new Set(production.pairs.dates).size
  const enough = production.n >= minForward && nDates >= minDates
  const passes = !!(enough && dll && dbr && dll[1] < 0 && dbr[1] <= 0
    && calibration.ece != null && calibration.ece <= maxEce)
  const status = enough ? (passes ? 'passes' : 'fails') : 'insufficient_data'
  return {
    n: legacy.n, alpha: legacy.alpha,
    logloss: { model: legacy.model.logloss, market: legacy.market.logloss, blend: legacy.blend.logloss },
    brier: { model: legacy.model.brier, market: legacy.market.brier, blend: legacy.blend.brier },
    improves: false,
    legacy_improves_descriptive: legacy.model.logloss != null && legacy.blend.logloss != null
      && legacy.blend.logloss < legacy.model.logloss,
    cohort: 'legacy_latest_market_time_unknown', auditable: false, cohorts: marketCohorts(all),
    changes_public_model: passes,
    production_chain: {
      status, n: production.n, n_available: production.n_available, n_dates: nDates,
      min_forward: minForward, min_dates: minDates, alpha: production.alpha,
      logloss: { p_learn: production.model.logloss, market_open: production.market.logloss, p_final_replay: production.blend.logloss },
      brier: { p_learn: production.model.brier, market_open: production.market.brier, p_final_replay: production.blend.brier },
      stability, calibration,
      gate: {
        passes, status,
        reason: !enough ? 'muestra forward auditable insuficiente'
          : passes ? 'pasa gate de log-loss, Brier y calibración'
            : 'no demuestra mejora OOS sobre p_learn',
        max_ece: maxEce, requires_delta_logloss_ci_below_zero: true,
        requires_delta_brier_ci_not_above_zero: true,
      },
      cohort: 'auditable_open_and_logged_p_learn', changes_public_model: passes,
    },
  }
}

// Shadow challenger: learn only the RESIDUAL around an auditable, de-vigged
// pre-game market prior. This asks whether AA's predeclared factors add signal
// after the market, rather than trying to relearn what the market already knows.
// It is measured walk-forward by date and never feeds today's public p_final.
export function marketResidualSample(row) {
  const market = auditableOpeningMarketHome(row)
  const d = row?.factor_leans || {}
  const x = ML_FACTORS.map((k) => Number(d[k] ?? 0))
  x.push(Number(row?.news_delta ?? 0))
  const y = row?.home_win === 0 || row?.home_win === 1 ? row.home_win : null
  return { x, offset: market == null ? 0 : logit(market), y, ok: market != null && y != null }
}

export function walkForwardMarketResidual(rows, { minTrain = 100, lambda = 3 } = {}) {
  const graded = prepareTrainingRows(rows).filter((r) => auditableOpeningMarketHome(r) != null)
  const byDate = {}
  for (const r of graded) (byDate[r.date] = byDate[r.date] || []).push(r)
  const dates = Object.keys(byDate).sort(), train = []
  const y = [], market = [], challenger = [], pairDates = []
  for (const D of dates) {
    if (train.length >= minTrain) {
      const fit = fitLogit(train.map(marketResidualSample), { lambda, intercept: true })
      if (fit) for (const g of byDate[D]) {
        const s = marketResidualSample(g), pm = auditableOpeningMarketHome(g)
        if (!s.ok || pm == null) continue
        const pc = predictLogit(fit, s.x, s.offset)
        if (pc == null) continue
        y.push(s.y); market.push(pm); challenger.push(pc); pairDates.push(D)
      }
    }
    train.push(...byDate[D])
  }
  return {
    n: y.length, n_available: graded.length, n_dates: new Set(pairDates).size,
    first_date: dates[0] || null, last_date: dates[dates.length - 1] || null,
    market: probMetrics(y, market), challenger: probMetrics(y, challenger),
    delta: y.length ? {
      acc: round4(probMetrics(y, challenger).acc - probMetrics(y, market).acc),
      logloss: round4(probMetrics(y, challenger).logloss - probMetrics(y, market).logloss),
      brier: round4(probMetrics(y, challenger).brier - probMetrics(y, market).brier),
    } : null,
    _pairs: { y, market, challenger, dates: pairDates },
  }
}

function homeReliability(y, p) {
  const oriented = y.map((yy, i) => ({ p: p[i] >= 0.5 ? p[i] : 1 - p[i], y: p[i] >= 0.5 ? yy : 1 - yy }))
  return reliability(oriented, (r) => r.p, (r) => r.y)
}

export function marketResidualChallengerReport(rows, { minTrain = 100, minForward = 300, lambda = 3, B = 1000 } = {}) {
  const prepared = prepareTrainingRows(rows)
  const run = walkForwardMarketResidual(prepared, { minTrain, lambda })
  const { _pairs, ...pub } = run
  const stability = bootstrapStability(_pairs.y,
    { classic: _pairs.market, combined: _pairs.challenger },
    { B, seed: 20260721, blocks: _pairs.dates })
  const calibration = {
    market: homeReliability(_pairs.y, _pairs.market),
    challenger: homeReliability(_pairs.y, _pairs.challenger),
  }
  const dll = stability?.delta?.logloss?.ci, dbr = stability?.delta?.brier?.ci
  const enough = pub.n >= minForward && pub.n_dates >= 30
  const passes = !!(enough && dll && dbr && dll[1] < 0 && dbr[1] <= 0 && calibration.challenger.ece <= 0.05)
  let reason = 'muestra forward insuficiente'
  if (enough) reason = passes ? 'pasa gate de log-loss, Brier y calibración' : 'no demuestra mejora OOS vs mercado'
  return {
    ...pub, shadow: true, published: false, changes_public_model: false,
    cohort: 'auditable_open_only', cohorts: marketCohorts(prepared), stability, calibration,
    gate: {
      passes, status: enough ? (passes ? 'passes' : 'fails') : 'insufficient_data', reason,
      min_forward: minForward, min_dates: 30, max_ece: 0.05,
      requires_delta_logloss_ci_below_zero: true, requires_delta_brier_ci_not_above_zero: true,
    },
  }
}

// Blend a HOME win-prob toward the market's HOME de-vig prob (both home-oriented).
export function marketBlend(homeProb, marketHomeProb, alpha) {
  if (homeProb == null || marketHomeProb == null || alpha == null) return null
  return round4(clampP(alpha * homeProb + (1 - alpha) * marketHomeProb))
}

// Sole authorization point for a public market anchor. Both the forward gate
// and the exact chain's publication flag must pass, and today's price must be an
// auditable pregame opening. Callers receive null for every legacy/partial case.
export function authorizedMarketAnchor(snapshot, row) {
  const chain = snapshot?.ml?.market_anchor?.production_chain
  const alpha = Number(chain?.alpha)
  if (chain?.gate?.passes !== true || chain?.changes_public_model !== true
    || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null
  const market = auditableOpeningMarketHome(row)
  return market == null ? null : { alpha, market }
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
  const graded = prepareTrainingRows(rows)
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
  const graded = prepareTrainingRows(rows)
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

// --- market studies ----------------------------------------------------------
// Every comparison below requires an explicitly timestamped opening capture.
// Generic/legacy latest prices have unknown timing and remain diagnostics only;
// they cannot support a market comparison, a signal verdict, or a public gate.
const sideWon = (side, homeWin) => ((homeWin === 0 || homeWin === 1) ? (side === 'home' ? homeWin : 1 - homeWin) : null)
const openingFavSide = (r) => { const p = auditableOpeningMarketHome(r); return p == null ? null : p >= 0.5 ? 'home' : 'away' }
const openingFavML = (r) => {
  const side = openingFavSide(r)
  return side === 'home' ? r?.odds?.ml_home_open ?? null
    : side === 'away' ? r?.odds?.ml_away_open ?? null : null
}

export const ODDS_INDICATORS = [
  { id: 'pickem_fav', label: 'Favorito en juego parejo (línea ≥ −145)', test: (r) => { const f = openingFavML(r); return f != null && f >= -145 }, pick: openingFavSide },
  { id: 'heavy_fav', label: 'Favorito grande (línea ≤ −190)', test: (r) => { const f = openingFavML(r); return f != null && f <= -190 }, pick: openingFavSide },
  { id: 'market_agrees', label: 'Modelo y apertura auditable coinciden', test: (r) => { const p = auditableOpeningMarketHome(r); return r.adrian_p != null && p != null && (r.adrian_p >= 0.5) === (p >= 0.5) }, pick: openingFavSide },
]

// Win rate (Wilson CI) of the market-favorite side for each pre-registered
// condition, vs the baseline market-favorite win rate. Tests the dad's "-110
// wins more than a big favorite" thesis honestly (likely "empate" at first).
export function evalOddsIndicators(rows, { minN = 40 } = {}) {
  const graded = prepareTrainingRows(rows).filter((r) => auditableOpeningMarketHome(r) != null)
  const baseWon = graded.map((r) => sideWon(openingFavSide(r), r.home_win)).filter((v) => v === 0 || v === 1)
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
  return { baseline: { n: baseWon.length, rate: base.p, lo: base.lo, hi: base.hi }, min_n: minN,
    cohort: 'auditable_open_only', list }
}

// Is the de-vigged pregame market prob a better winner-forecaster than adrian_p?
// Paired bootstrap on Δlog-loss(model − market) with the same "empate" gate.
export function oddsReport(rows, { B = 1000, minN = 40 } = {}) {
  const graded = prepareTrainingRows(rows).filter((r) => auditableOpeningMarketHome(r) != null && r.adrian_p != null)
  const n = graded.length
  if (n < minN) return { n, market: null, model: null, delta: null, tie: true, verdict: 'sin dato', disagree: null,
    auditable: true, cohort: 'auditable_open_only', min_n: minN }
  const y = graded.map((r) => r.home_win)
  const pMarket = graded.map((r) => clamp(auditableOpeningMarketHome(r), 1e-4, 1 - 1e-4))
  const pModel = graded.map((r) => clamp(r.adrian_p, 1e-4, 1 - 1e-4))
  const market = probMetrics(y, pMarket), model = probMetrics(y, pModel)
  const boot = bootstrapStability(y, { classic: pMarket, combined: pModel }, { B, blocks: graded.map((r) => r.date) }) // delta = model − market
  const dll = boot?.delta?.logloss
  const tie = !dll || (dll.ci[0] <= 0 && dll.ci[1] >= 0)
  const dis = graded.filter((r) => (r.adrian_p >= 0.5) !== (auditableOpeningMarketHome(r) >= 0.5))
  const mktWon = dis.map((r) => sideWon(openingFavSide(r), r.home_win)).filter((v) => v === 0 || v === 1)
  const disW = wilson(mktWon.filter((v) => v === 1).length, mktWon.length)
  return {
    n, market, model, delta: dll,
    tie, verdict: tie ? 'empate' : dll.ci[1] < 0 ? 'modelo mejor' : 'mercado mejor',
    disagree: { n: mktWon.length, market_win_rate: disW.p, lo: disW.lo, hi: disW.hi },
    auditable: true, cohort: 'auditable_open_only', min_n: minN,
  }
}

// The dad's "stubborn favorite" thesis, honestly: when the pregame favorite is
// LOSING early, does it come back and win MORE than a generic team trailing at
// the same point? Uses only the post-game win-prob curve of PAST graded games
// (a completed-game fact) → never an input to today's pick. Non-overlapping
// Wilson CIs → "el favorito remonta más"; overlap → empate.
export function trailedEarlyReport(rows, { throughInn = 3, minN = 30 } = {}) {
  const graded = prepareTrainingRows(rows).filter((r) => r.odds?.wp_curve && openingFavSide(r))
  let trailerN = 0, trailerWins = 0, favN = 0, favWins = 0
  const bucket = { pickem: [0, 0], heavy: [0, 0] } // [wins, n] for fav-trailed
  for (const r of graded) {
    let sh = null, sa = null // score at the end of `throughInn`
    for (const p of r.odds.wp_curve) { if (p.inn > throughInn) break; if (p.home_score != null) { sh = p.home_score; sa = p.away_score } }
    if (sh == null || sh === sa) continue // no score / tied → no clear early trailer
    const trailingSide = sh < sa ? 'home' : 'away'
    const trailingWon = (trailingSide === 'home' ? r.home_win === 1 : r.home_win === 0) ? 1 : 0
    trailerN++; trailerWins += trailingWon
    if (openingFavSide(r) === trailingSide) {
      favN++; favWins += trailingWon
      const f = openingFavML(r)
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
  const g = prepareTrainingRows(rows)
  // 1) value edge
  const val = g.filter((r) => auditableOpeningMarketHome(r) != null
    && r.value?.best_side && (r.value.best_edge ?? 0) >= 0.03)
  const valWon = val.map((r) => (r.value.best_side === 'home' ? r.home_win : 1 - r.home_win)).filter((v) => v === 0 || v === 1)
  const vW = wilson(valWon.filter((v) => v === 1).length, valWon.length)
  const value = {
    n: valWon.length, rate: vW.p, lo: vW.lo, hi: vW.hi,
    verdict: valWon.length < minN ? 'sin dato' : (vW.lo != null && vW.lo > BREAK_EVEN_110) ? 'valor real' : (vW.hi != null && vW.hi < 0.5) ? 'trampa' : 'empate',
  }
  // 2) between-book disagreement
  const withDis = g.filter((r) => auditableOpeningMarketHome(r) != null
    && r.odds?.book_disagreement != null && openingFavSide(r))
  const favWin = (arr) => { const won = arr.map((r) => sideWon(openingFavSide(r), r.home_win)).filter((v) => v === 0 || v === 1); return { n: won.length, ...wilson(won.filter((v) => v === 1).length, won.length) } }
  const disHi = favWin(withDis.filter((r) => r.odds.book_disagreement >= 0.04))
  const disLo = favWin(withDis.filter((r) => r.odds.book_disagreement < 0.04))
  const disagreement = {
    high: disHi, low: disLo,
    verdict: (disHi.n < minN || disLo.n < minN || disHi.hi == null || disLo.lo == null) ? 'sin dato' : disHi.hi < disLo.lo ? 'discrepancia = más riesgo' : 'empate',
  }
  // 3) line movement (open -> close)
  const moved = g.filter((r) => auditableOpeningMarketHome(r) != null
    && auditableClosingMarketHome(r) != null
    && r.odds?.line_move != null && Math.abs(r.odds.line_move) >= 0.03)
  const towardWon = moved.map((r) => sideWon(r.odds.line_move > 0 ? 'home' : 'away', r.home_win)).filter((v) => v === 0 || v === 1)
  const mW = wilson(towardWon.filter((v) => v === 1).length, towardWon.length)
  const line_move = {
    n: towardWon.length, rate: mW.p, lo: mW.lo, hi: mW.hi,
    verdict: towardWon.length < minN ? 'sin dato' : (mW.lo != null && mW.lo > 0.5) ? 'seguir el movimiento' : 'empate',
  }
  // Live-watcher accrual: coverage only. In-game odds FOLLOW the score, so any
  // "live steam predicts the winner" claim would be leakage by construction; a
  // real study needs a fixed pre-game reference point and is deferred until the
  // data (row.live) accrues. Counting coverage keeps the pipeline honest+visible.
  const live = { n_with_live: g.filter((r) => r.live?.n >= 2).length }
  // CLV (closing line value) — the professional gold standard: if the market
  // CLOSES closer to our pick's side than it OPENED, our morning selection was
  // ahead of the market. It accrues only from explicitly captured, auditable
  // opening and close fields; a generic latest price has unknown timing.
  const withClv = g.filter((r) => auditableOpeningMarketHome(r) != null
    && auditableClosingMarketHome(r) != null && r.ml_pick)
  const clvVals = withClv.map((r) => {
    const home = r.ml_pick === r.home
    const openHome = auditableOpeningMarketHome(r)
    const closeHome = auditableClosingMarketHome(r)
    const open = home ? openHome : 1 - openHome
    const close = home ? closeHome : 1 - closeHome
    return close - open
  })
  const clvMean = clvVals.length ? clvVals.reduce((a, b) => a + b, 0) / clvVals.length : null
  const clv = {
    n: clvVals.length, mean: clvMean != null ? round4(clvMean) : null,
    verdict: clvVals.length < minN ? 'sin dato' : clvMean > 0.005 ? 'el pick le gana al cierre' : clvMean < -0.005 ? 'el cierre nos corrige' : 'neutral',
  }
  return { min_n: minN, cohort: 'auditable_open_only',
    n_with_books: g.filter((r) => auditableOpeningMarketHome(r) != null && r.odds?.consensus?.n_books > 1).length,
    value, disagreement, line_move, live, clv }
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
const pickIsMktFav = (r) => { const side = openingFavSide(r); return side == null ? null : side === (mlPickDir(r) > 0 ? 'home' : 'away') }
const newsFavorsPick = (r) => (r.news_delta ?? 0) !== 0 && Math.sign(r.news_delta) === mlPickDir(r)
// Oriented accessors for the reconstructed context (aux) + fetched raw material
// (aux2). Directions PRE-REGISTERED 2026-07-07 (priors: venue form +, Pythag +,
// rest advantage +, fresher schedule +, opponent traveled east + [PNAS 2017],
// platoon edge +). First backtest at n≈1341: rest showed +17.8 pts consistent in
// both halves but under the n>=60 gate; the rest were ruido/sin dato — none is
// weighted anywhere until its verdict here says 'robusto'.
const pickIsHome = (r) => mlPickDir(r) > 0
const auxRestDiff = (r) => { const a = r.aux; if (!a || a.rest_h == null || a.rest_a == null) return null; const d = Math.min(a.rest_h, 5) - Math.min(a.rest_a, 5); return pickIsHome(r) ? d : -d }
const auxDensDiff = (r) => { const a = r.aux; if (!a || a.dens_h == null || a.dens_a == null) return null; const d = a.dens_a - a.dens_h; return pickIsHome(r) ? d : -d }
const auxHaf = (r) => { const a = r.aux; if (!a || a.haf == null) return null; return pickIsHome(r) ? a.haf : -a.haf }
const auxPyth = (r) => { const a = r.aux; if (!a || a.pyth == null) return null; return pickIsHome(r) ? a.pyth : -a.pyth }
const auxTzeOpp = (r) => { const a = r.aux; if (!a || a.tze_h == null || a.tze_a == null) return null; const opp = pickIsHome(r) ? a.tze_a : a.tze_h; return opp }
const platoonEdge = (r) => { const a = r.aux2; if (!a || a.platoon_h == null || a.platoon_a == null) return null; const d = a.platoon_h - a.platoon_a; return pickIsHome(r) ? d : -d }
const AUDIT_SIGNALS = [
  { id: 'market', label: 'Coincide con la apertura auditable', req: (r) => openingFavSide(r) != null, fav: (r) => pickIsMktFav(r) },
  { id: 'agree5', label: '5+ factores de acuerdo con el pick', req: () => true, fav: (r) => (r.agree ?? 0) >= 5 },
  { id: 'prob60', label: 'Prob. del pick ≥ 60%', req: () => true, fav: (r) => mlPickProb(r) >= 0.60 },
  { id: 'pitcher', label: 'Mejor ERA reciente del abridor', req: (r) => pickEraAdv(r) != null, fav: (r) => pickEraAdv(r) > 0 },
  { id: 'streak3', label: 'Racha del equipo del pick ≥ 3', req: () => true, fav: (r) => (pickStreak(r) ?? 0) >= 3 },
  { id: 'news', label: 'Noticias/lesiones a favor del pick', req: () => true, fav: (r) => newsFavorsPick(r) },
  // context signals (aux/aux2) — fav true/false only past the pre-set threshold
  { id: 'aux_rest', label: 'Ventaja de descanso real del pick (≥1 día)', req: (r) => auxRestDiff(r) != null, fav: (r) => { const v = auxRestDiff(r); return v >= 1 ? true : v <= -1 ? false : null } },
  { id: 'aux_dens', label: 'Calendario más fresco (juegos últimos 7d)', req: (r) => auxDensDiff(r) != null, fav: (r) => { const v = auxDensDiff(r); return v >= 1 ? true : v <= -1 ? false : null } },
  { id: 'aux_haf', label: 'Mejor forma casa/ruta específica', req: (r) => auxHaf(r) != null, fav: (r) => { const v = auxHaf(r); return v >= 0.15 ? true : v <= -0.15 ? false : null } },
  { id: 'aux_pyth', label: 'Mejor pitagórico L20', req: (r) => auxPyth(r) != null, fav: (r) => { const v = auxPyth(r); return v >= 0.05 ? true : v <= -0.05 ? false : null } },
  { id: 'aux_tze', label: 'Rival viajó al ESTE ≥2 husos (PNAS)', req: (r) => auxTzeOpp(r) != null, fav: (r) => { const v = auxTzeOpp(r); return v >= 2 ? true : null } },
  { id: 'platoon', label: 'Ventaja de platoon (bates vs mano del abridor)', req: (r) => platoonEdge(r) != null, fav: (r) => { const v = platoonEdge(r); return v >= 0.03 ? true : v <= -0.03 ? false : null } },
]
// deterministic seeded bootstrap CI of mean(a) − mean(b) over 0/1 arrays.
function bootGap(a, b, B = 1000, seed = 20260706, aBlocks = null, bBlocks = null) {
  if (!a.length || !b.length) return null
  const rnd = bootstrapRng(seed)
  const blockMode = Array.isArray(aBlocks) && aBlocks.length === a.length && Array.isArray(bBlocks) && bBlocks.length === b.length
  const grouped = new Map()
  if (blockMode) {
    const add = (key, side, value) => { const g = grouped.get(key) || { a: [], b: [] }; g[side].push(value); grouped.set(key, g) }
    a.forEach((v, i) => add(String(aBlocks[i]), 'a', v)); b.forEach((v, i) => add(String(bBlocks[i]), 'b', v))
  }
  const groups = [...grouped.values()]
  const ds = []
  for (let t = 0; t < B; t++) {
    let aa = [], bb = []
    if (groups.length) {
      for (let i = 0; i < groups.length; i++) { const g = groups[(rnd() * groups.length) | 0]; aa.push(...g.a); bb.push(...g.b) }
      // A sampled slate may contain only one side; fall back for that replicate.
      if (!aa.length || !bb.length) { aa = a; bb = b }
    } else {
      aa = Array.from({ length: a.length }, () => a[(rnd() * a.length) | 0])
      bb = Array.from({ length: b.length }, () => b[(rnd() * b.length) | 0])
    }
    const ma = aa.reduce((s, v) => s + v, 0) / aa.length, mb = bb.reduce((s, v) => s + v, 0) / bb.length
    ds.push(ma - mb)
  }
  ds.sort((x, y) => x - y)
  return { lo: round4(ds[Math.floor(0.025 * B)]), hi: round4(ds[Math.floor(0.975 * B)]), method: groups.length ? 'date_block' : 'iid' }
}
export function signalAudit(rows, { minN = 60 } = {}) {
  const graded = prepareTrainingRows(rows)
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
    const ci = bootGap(favG.map((x) => x.y), unfG.map((x) => x.y), 1000, 20260706,
      favG.map((x) => x.date), unfG.map((x) => x.date))
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
  return { baseline: { n: scored.length, rate: base.p, lo: base.lo, hi: base.hi }, min_n: minN,
    market_cohort: 'auditable_open_only', list }
}

// Gate de selección ORO v1: hipótesis de apertura auditable + 5 factores +
// mejor abridor reciente. Replay cronológico, máximo 2/día, sin rellenar
// cupos. Si falta una apertura verificable la fila no aporta evidencia al gate.
export function lockGateReport(rows, { split = 0.70, max = 2 } = {}) {
  const graded = prepareTrainingRows(rows).filter((r) => r.ml_result)
  const dates = [...new Set(graded.map((r) => r.date))].sort()
  const cut = dates[Math.floor(dates.length * split)] || null
  const qualifies = (r) => {
    const marketSide = openingFavSide(r)
    if (r.adrian_p == null || (r.agree ?? 0) < 5 || !marketSide) return false
    const pickHome = r.ml_pick === r.home
    if (marketSide !== (pickHome ? 'home' : 'away')) return false
    const conf = Math.abs(r.adrian_p - 0.5) * 2 + ((r.agree ?? 0) / 6) * 0.45
    if (conf <= 0.7) return false
    const h = r.pitcher_recent?.home, a = r.pitcher_recent?.away
    if (!h || !a || Number(h.n) < 2 || Number(a.n) < 2 || !Number.isFinite(Number(h.era)) || !Number.isFinite(Number(a.era))) return false
    return pickHome ? Number(h.era) < Number(a.era) : Number(a.era) < Number(h.era)
  }
  const score = (r) => {
    const pickHome = r.ml_pick === r.home
    const model = mlPickProb(r)
    const mh = auditableOpeningMarketHome(r)
    const market = mh == null ? model : (pickHome ? mh : 1 - mh)
    return 0.5 * model + 0.4 * market + 0.1
  }
  const evaluate = (period) => {
    const byDate = {}
    for (const r of graded) {
      if (period === 'train' && r.date >= cut) continue
      if (period === 'test' && r.date < cut) continue
      if (!qualifies(r)) continue
      ;(byDate[r.date] = byDate[r.date] || []).push(r)
    }
    const picks = []
    for (const day of Object.values(byDate)) picks.push(...day.sort((a, b) => score(b) - score(a)).slice(0, max))
    const wins = picks.filter((r) => r.ml_result === 'win').length
    const losses = picks.filter((r) => r.ml_result === 'loss').length
    return { n: wins + losses, days: Object.keys(byDate).length, wins, losses, ...wilson(wins, wins + losses) }
  }
  const train = evaluate('train'), test = evaluate('test'), all = evaluate('all')
  const passes = all.n >= 100 && test.n >= 30 && all.lo != null && all.lo > BREAK_EVEN_110
    && train.p > BREAK_EVEN_110 && test.p > BREAK_EVEN_110
  return { rule: 'market_agree5_starter_v1', cut, max_per_day: max, train, test, all,
    gate: { passes, threshold: BREAK_EVEN_110, reason: passes ? 'pasa' : 'muestra/intervalo insuficiente' } }
}

// --- the canonical snapshot the robot writes and the app reads ---------------
// `rows` = every logged games_v1 row (graded + ungraded). Everything is fit on
// the graded subset of the CURRENT formula version. `now` is passed in (learn.js
// never touches the clock).
function trainingQualityReport(rows, unique, accepted) {
  const excluded = {
    ungraded: 0, missing_final: 0, formula_mismatch: 0,
    invalid_status: 0, integrity_ineligible: 0, temporal_cohort_unverified: 0,
  }
  for (const r of unique) {
    if (r.graded !== true) { excluded.ungraded++; continue }
    if (!hasFinalOutcome(r) || !r.date) { excluded.missing_final++; continue }
    if (r.formula_version !== FORMULA_VERSION) { excluded.formula_mismatch++; continue }
    if (BAD_GAME_STATUS.test(String(r.status || ''))) { excluded.invalid_status++; continue }
    if (r.integrity?.training_eligible !== true) { excluded.integrity_ineligible++; continue }
    if (!hasVerifiedTemporalCohort(r)) excluded.temporal_cohort_unverified++
  }
  return {
    input_rows: rows.length, unique_rows: unique.length,
    duplicate_game_pk_removed: rows.length - unique.length,
    accepted_training_rows: accepted.length, excluded,
    temporal_policy: 'ledger_eligible_verified_cohort_only',
  }
}

export function buildSnapshot(rows, { now = null } = {}) {
  const input = Array.isArray(rows) ? rows : []
  const unique = dedupeGameRows(input)
  const graded = prepareTrainingRows(unique)
  const dates = [...new Set(graded.map((r) => r.date))].sort()
  const mlFit = fitLogit(graded.map(mlSample), { lambda: 1 })
  const totalFit = fitLogit(graded.map(totalSample), { lambda: 1, intercept: true })
  const trust = betaTrust(graded)
  return {
    updated_at: now, n_graded: graded.length, n_total: unique.length,
    first_date: dates[0] || null, last_date: dates[dates.length - 1] || null,
    formula_version: FORMULA_VERSION,
    training_quality: trainingQualityReport(input, unique, graded),
    ml: {
      fit: mlFit, weights: mlWeights(mlFit),
      calibration: { ...reliability(graded, mlPickProb, mlPickWon), platt: fitPlatt(graded, mlPickProb, mlPickWon) },
      trust,
      oos: walkForwardReplay(graded, { market: 'ml' }),
      combined: ensembleReport(graded, { market: 'ml' }),
      market_anchor: marketAnchorReport(graded),
      market_residual_challenger: marketResidualChallengerReport(graded),
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
    lock_gate: lockGateReport(graded),
    // coverage of the reconstructed/fetched context blocks (the audit's aux_*
    // and platoon verdicts mature as these counts grow)
    context: {
      n_with_aux: unique.filter((r) => r.aux).length,
      n_with_platoon: unique.filter((r) => r.aux2?.platoon_h != null && r.aux2?.platoon_a != null).length,
      aux_stack: 'probado 2026-07-07: empate OOS vs p_final (Δlogloss CI cruza 0) — no adoptado',
    },
    n_backfilled: graded.filter((r) => r.backfilled).length,
    odds: {
      n_with_line: graded.filter((r) => auditableOpeningMarketHome(r) != null).length,
      n_with_curve: graded.filter((r) => r.odds?.wp_curve).length,
      indicators: evalOddsIndicators(graded),
      market_vs_model: oddsReport(graded),
      trailed_early: trailedEarlyReport(graded),
      microstructure: marketMicrostructureReport(graded),
    },
    misses: graded.filter((r) => r.ml_result === 'loss').slice(-15).reverse().map(missReport(trust)),
  }
}
