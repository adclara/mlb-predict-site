// In-browser prediction engine — a transparent port of the Python model's core
// (Elo + expected runs + negative-binomial Monte Carlo + an honest F5 split).
// The full LightGBM/base-out model stays in the private backend; this runs live
// in the browser so the GitHub Pages app needs no server. Numbers are close to,
// not identical to, the backtested model (which is what the Performance page shows).

export const LG_RPG = 4.4 // league runs/game baseline
export const LEAGUE_FIP = 4.2
export const LEAGUE_KBB = 0.13
export const LEAGUE_PEN_FIP = 4.05
export const LEAGUE_STAFF_FIP = (5 * LEAGUE_FIP + 4 * LEAGUE_PEN_FIP) / 9
export const HFA_ELO = 24 // home-field advantage in Elo points
export const ELO_WEIGHT = 0.8 // matches the backend ensemble
const DISPERSION = 6.0
const SP_INN = 5
const PEN_INN = 4

// --- deterministic random samplers -----------------------------------------
// Simulations must be reproducible: an intraday re-run with identical inputs
// cannot move a probability merely because Math.random produced another stream.
// Existing callers remain compatible; `seed` is an optional final argument.
// When omitted, a stable FNV-1a hash of the inputs becomes the seed.
export function stableSeed(...parts) {
  let h = 0x811c9dc5
  const s = parts.map((x) => x == null ? 'null' : typeof x === 'object' ? JSON.stringify(x) : String(x)).join('|')
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h || 0x9e3779b9
}

export function seededRng(seed) {
  let x = (typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : stableSeed(seed)) || 0x9e3779b9
  return () => {
    // xorshift32: all operations are exact 32-bit integer operations in JS.
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}

function randn(rng) {
  let u = 0, v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
// Marsaglia-Tsang gamma sampler (shape k > 0, scale theta).
function gammaSample(k, theta, rng) {
  if (k < 1) {
    const u = rng()
    return gammaSample(1 + k, theta, rng) * Math.pow(u, 1 / k)
  }
  const d = k - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x, v
    do {
      x = randn(rng)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * theta
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * theta
  }
}
function poissonSample(lambda, rng) {
  if (lambda <= 0) return 0
  if (lambda < 30) {
    const L = Math.exp(-lambda)
    let k = 0, p = 1
    do { k++; p *= rng() } while (p > L)
    return k - 1
  }
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * randn(rng)))
}
// Negative binomial with mean mu and dispersion r, as a Gamma-Poisson mixture.
function nbinomSample(mu, r = DISPERSION, rng) {
  if (mu <= 0) mu = 0.1
  return poissonSample(gammaSample(r, mu / r, rng), rng)
}

// --- Elo --------------------------------------------------------------------
export function eloProb(eloHome, eloAway) {
  return 1 / (1 + Math.pow(10, -((eloHome + HFA_ELO) - eloAway) / 400))
}

// --- expected runs (mu) -----------------------------------------------------
function offTilt(elo) {
  return Math.min(1.15, Math.max(0.85, 1 + (elo - 1500) / 2500))
}
function staffSuppress(spFip, penFip) {
  const staff = (SP_INN * spFip + PEN_INN * penFip) / (SP_INN + PEN_INN)
  return staff / LEAGUE_STAFF_FIP // >1 => more hittable staff
}
// Home offense faces the AWAY staff, and vice-versa; park scales both.
export function expectedRuns({ eloHome, eloAway, homeSp, homePen, awaySp, awayPen, park }) {
  const p = park || 1.0
  const muHome = LG_RPG * offTilt(eloHome) * staffSuppress(awaySp, awayPen) * p
  const muAway = LG_RPG * offTilt(eloAway) * staffSuppress(homeSp, homePen) * p
  return { muHome: Math.max(2.5, muHome), muAway: Math.max(2.5, muAway) }
}

// --- Monte Carlo (full game) ------------------------------------------------
export function simulateGame(muHome, muAway, totalLine = 8.5, n = 4000, seed = null) {
  const rng = seededRng(seed ?? stableSeed('game', muHome, muAway, totalLine, n))
  let homeWins = 0, hcover = 0, acover = 0, over = 0
  let sumH = 0, sumA = 0
  const totalHist = {}, homeHist = {}, awayHist = {}
  const bump = (h, k) => { const v = Math.min(k, 15); h[v] = (h[v] || 0) + 1 }
  for (let i = 0; i < n; i++) {
    const h = nbinomSample(muHome, DISPERSION, rng)
    const a = nbinomSample(muAway, DISPERSION, rng)
    sumH += h; sumA += a
    if (h > a || (h === a && rng() < 0.5)) homeWins++
    if (h - a >= 2) hcover++ // home -1.5
    if (a - h >= 2) acover++ // away -1.5
    if (h + a > totalLine) over++
    bump(totalHist, h + a); bump(homeHist, h); bump(awayHist, a)
  }
  const norm = (hist) => {
    const out = {}
    for (let k = 0; k <= 15; k++) out[k] = (hist[k] || 0) / n
    return out
  }
  return {
    p_home_win: homeWins / n,
    p_away_win: 1 - homeWins / n,
    p_home_runline: hcover / n,
    p_away_runline: acover / n,
    p_over: over / n,
    p_under: 1 - over / n,
    expected_home_runs: sumH / n,
    expected_away_runs: sumA / n,
    total_distribution: norm(totalHist),
    home_distribution: norm(homeHist),
    away_distribution: norm(awayHist),
  }
}

// --- honest F5 (split by starter vs bullpen, not a 5/9 slice) ----------------
function splitPerInning(mu, spFip, penFip) {
  const denom = SP_INN * Math.max(spFip, 0.5) + PEN_INN * Math.max(penFip, 0.5)
  const k = denom > 0 ? mu / denom : 0
  return { sp: k * Math.max(spFip, 0.5), pen: k * Math.max(penFip, 0.5) }
}
export function simulateF5({ muHome, muAway, homeSp, homePen, awaySp, awayPen }, line = 4.5, n = 4000, seed = null) {
  const rng = seededRng(seed ?? stableSeed('f5', muHome, muAway, homeSp, homePen, awaySp, awayPen, line, n))
  // Home offense faces the AWAY pitchers over innings 1-5 (their starter).
  const hRate = splitPerInning(muHome, awaySp, awayPen).sp // home runs/inning vs away SP
  const aRate = splitPerInning(muAway, homeSp, homePen).sp
  const muHomeF5 = hRate * SP_INN
  const muAwayF5 = aRate * SP_INN
  let over = 0, homeLead = 0, awayLead = 0, sumH = 0, sumA = 0
  for (let i = 0; i < n; i++) {
    const h = nbinomSample(muHomeF5, DISPERSION, rng)
    const a = nbinomSample(muAwayF5, DISPERSION, rng)
    sumH += h; sumA += a
    if (h + a > line) over++
    if (h > a) homeLead++
    else if (a > h) awayLead++
  }
  // NRFI: no run in the FIRST inning for either side (Poisson P(0)=e^-rate).
  const nrfi = Math.exp(-hRate) * Math.exp(-aRate)
  return {
    f5_total: { line, over: over / n, under: 1 - over / n },
    f5_moneyline: { home_lead: homeLead / n, away_lead: awayLead / n },
    nrfi,
    yrfi: 1 - nrfi,
    expected_f5_runs: { home: sumH / n, away: sumA / n },
  }
}
