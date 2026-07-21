// "Estadística Adrian" v2 — Adrian Clara's method, quantified and auditable.
// Evaluates THREE markets per game (moneyline winner + total OVER + total UNDER),
// scores each, and the formula decides which play carries the most weight — with
// the reasons spelled out. The total lean is driven by Adrian's real edge: the
// starter's RECENT form (last starts, not last year) + the team's contact/offense
// profile, on top of the model's base run expectation. Runs server-side in
// GitHub Actions; the browser only receives the already-computed result.

import { park } from './venues.js'
import { marketConsensus } from './odds.js'

// League reference points (approx recent MLB).
const LG_STAFF_FIP = 4.15
const LG_ERA = 4.2
const LG_RS = 4.4
const LG_OPS = 0.72
const LG_SB_PER_G = 0.55
const TOTAL_SIGMA = 2.9 // std of a game's total runs (for over/under probs)

// Win-factor weights (moneyline). Reflect Adrian's emphasis.
export const WEIGHTS = { momentum: 0.22, pitching: 0.24, f5: 0.16, bats: 0.16, schedule: 0.08, manager: 0.06 }
const K = 0.9
const MAX_DP = 0.15

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
// Normal CDF via an erf approximation (Abramowitz-Stegun 7.1.26).
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp(-z * z / 2)
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}

// --- win factors (moneyline) ------------------------------------------------
export function momentum(rows) {
  const last10 = (rows || []).slice(0, 10)
  if (!last10.length) return 0
  let num = 0, den = 0
  last10.forEach((g, i) => { const w = 10 - i; num += w * (g.won ? 1 : -1); den += w })
  return clamp(num / den, -1, 1)
}
export function streakLen(rows) {
  const r = rows || []
  if (!r.length) return 0
  const first = r[0].won
  let n = 0
  for (const g of r) { if (!!g.won === !!first) n++; else break }
  return first ? n : -n
}
const staffFip = (sp, pen) => 0.6 * (sp ?? LG_STAFF_FIP) + 0.4 * (pen ?? 4.05)
function batsScore(rsL10, sb, ops) {
  const heat = clamp(((rsL10 ?? LG_RS) - LG_RS) / 2.5, -0.7, 0.7)
  const perG = sb && sb.g ? sb.sb / sb.g : LG_SB_PER_G
  const success = sb && sb.sb + sb.cs > 0 ? sb.sb / (sb.sb + sb.cs) : 0.72
  const steal = clamp((perG - LG_SB_PER_G) / 1.0, -0.3, 0.5) * (success >= 0.7 ? 1 : 0.6)
  const contact = ops ? clamp((ops - LG_OPS) / 0.12, -0.5, 0.6) : 0
  return clamp(heat + 0.5 * steal + 0.4 * contact, -1, 1)
}
function aggrScore(sb, lgAttempts) {
  const att = sb && sb.g ? (sb.sb + sb.cs) / sb.g : lgAttempts
  return clamp((att - lgAttempts) / 0.8, 0, 0.3)
}
export function parseWind(wind) {
  if (!wind) return null
  const mph = parseFloat(wind) || 0
  const s = wind.toLowerCase()
  let dir = 'cross'
  if (s.includes('out to')) dir = 'out'
  else if (s.includes('in from')) dir = 'in'
  return { mph, dir }
}
function weatherRuns(weather) {
  if (!weather) return 0
  const w = parseWind(weather.wind)
  let runs = 0
  if (w) runs += (w.dir === 'out' ? 1 : w.dir === 'in' ? -1 : 0) * clamp(w.mph / 18, 0, 1)
  const t = weather.temp
  if (t != null) runs += t >= 82 ? 0.3 : t <= 52 ? -0.3 : 0
  return clamp(runs, -1, 1)
}
function travelPenalty(homeAbbr, awayAbbr) {
  const eastShift = park(homeAbbr).lon - park(awayAbbr).lon
  const mag = clamp(Math.abs(eastShift) / 45, 0, 0.3)
  return eastShift > 0 ? mag : mag * 0.6
}
function newsScore(teamId, injuries) {
  let s = 0
  for (const tx of injuries || []) {
    if (tx.teamId !== teamId) continue
    const d = (tx.desc || '').toLowerCase()
    if (/activated|reinstated/.test(d)) s += 0.08
    else if (/placed|injured list|transferred/.test(d)) s -= 0.15
  }
  return clamp(s, -0.5, 0.3)
}
export function leagueAttempts(teams) {
  const vals = Object.values(teams || {}).filter((t) => t.g).map((t) => (t.sb + t.cs) / t.g)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : LG_SB_PER_G * 1.3
}

// --- run environment (totals): the pitcher-recent-form + contact edge --------
// A starter's recent runs allowed above/below league -> the opposing offense
// scores more/less. Returns runs added to the game total (can be negative).
function pitcherRecentAdj(recent) {
  // era == null (not falsy): a 0.00 recent ERA is a genuinely dominant starter,
  // not missing data — it must still push the total DOWN.
  if (!recent || recent.era == null || recent.n === 0) return 0
  return clamp((recent.era - LG_ERA) * 0.22, -1.2, 1.4) // shelled recently -> up
}
function contactAdj(ops) {
  return ops ? clamp((ops - LG_OPS) * 3.0, -0.8, 1.0) : 0
}

function runEnvironment(ctx) {
  const { prediction, priors, weather, pitcherRecent } = ctx
  const home = ctx.game.home_team_abbr, away = ctx.game.away_team_abbr
  const hT = priors.teams[home] || {}, aT = priors.teams[away] || {}
  const base = prediction.expected_runs.home + prediction.expected_runs.away
  const line = Math.round(base * 2) / 2 // reference line = model's base expectation

  const reasons = []
  // Starter recent form: the away starter's form drives the HOME offense (they face him).
  const aStart = pitcherRecentAdj(pitcherRecent?.away?.recent) // -> home scores
  const hStart = pitcherRecentAdj(pitcherRecent?.home?.recent) // -> away scores
  const homeContact = contactAdj(hT.ops)
  const awayContact = contactAdj(aT.ops)
  const wx = weatherRuns(weather)
  // Fatigue: a tired starter (short rest / heavy recent pitch load) gets
  // squeezed for more runs -> the opposing offense's total goes up.
  const fatAdj = (rec) => (rec?.fatigue?.level === 'alta' ? 0.4 : rec?.fatigue?.level === 'media' ? 0.15 : 0)
  const aFat = fatAdj(pitcherRecent?.away), hFat = fatAdj(pitcherRecent?.home)
  const adjTotal = base + aStart + hStart + homeContact + awayContact + wx + aFat + hFat

  // Reasons (only the meaningful movers).
  const sr = (rec, teamAbbr, oppAbbr, name) => {
    if (!rec || !rec.recent || !rec.recent.n) return
    if (rec.recent.era >= 5.5) reasons.push({ text: `${name || `abridor de ${teamAbbr}`} viene golpeado: ${rec.recent.era} ERA en sus últimas ${rec.recent.n} salidas → sube el total de ${oppAbbr}`, tone: 'warn', over: true })
    else if (rec.recent.era <= 3.0) reasons.push({ text: `${name || `abridor de ${teamAbbr}`} llega fino: ${rec.recent.era} ERA reciente → baja el total`, tone: 'positive', over: false })
  }
  sr(pitcherRecent?.away, away, home, ctx.game.away_probable_pitcher_name)
  sr(pitcherRecent?.home, home, away, ctx.game.home_probable_pitcher_name)
  const fr = (rec, teamAbbr, name) => {
    const fq = rec?.fatigue
    if (fq && fq.level === 'alta') reasons.push({ text: `${name || `abridor de ${teamAbbr}`} con fatiga (${fq.restDays != null ? `${fq.restDays}d descanso` : ''}${fq.avgPitches ? `${fq.restDays != null ? ', ' : ''}~${fq.avgPitches} pitcheos` : ''}) → sube el total`, tone: 'warn', over: true })
  }
  fr(pitcherRecent?.away, away, ctx.game.away_probable_pitcher_name)
  fr(pitcherRecent?.home, home, ctx.game.home_probable_pitcher_name)
  if (hT.ops && hT.ops >= 0.76) reasons.push({ text: `${home} batea mucho contacto (OPS ${hT.ops}) → sube`, tone: 'neutral', over: true })
  if (aT.ops && aT.ops >= 0.76) reasons.push({ text: `${away} batea mucho contacto (OPS ${aT.ops}) → sube`, tone: 'neutral', over: true })
  if (wx > 0.2) reasons.push({ text: 'Viento/calor a favor de carreras → sube', tone: 'neutral', over: true })
  if (wx < -0.2) reasons.push({ text: 'Viento/frío en contra → baja', tone: 'neutral', over: false })

  const pOver = clamp(1 - normCdf((line - adjTotal) / TOTAL_SIGMA), 0.05, 0.95)
  const side = pOver >= 0.5 ? 'over' : 'under'
  const prob = side === 'over' ? pOver : 1 - pOver
  // components: the RAW (unrounded) pieces of adjTotal, additive for the learner
  // (Adrian Learning re-weights these). The displayed base/adjTotal stay rounded.
  const components = { base, adjTotal, aStart, hStart, homeContact, awayContact, wx, aFat, hFat }
  return { line, adjTotal: Math.round(adjTotal * 10) / 10, base: Math.round(base * 10) / 10, pOver, side, prob, reasons, components }
}

// --- per-game analysis: moneyline + total, each a candidate play ------------
export function analyzeGame(ctx) {
  const { game, prediction, f5, forms, priors, injuries, lgAttempts } = ctx
  const home = game.home_team_abbr, away = game.away_team_abbr
  const feat = prediction.features || {}
  const hSb = priors.teams[home] || {}, aSb = priors.teams[away] || {}

  const homeStaff = staffFip(feat.home_sp_fip, feat.home_pen_fip)
  const awayStaff = staffFip(feat.away_sp_fip, feat.away_pen_fip)
  const pitchHome = clamp((awayStaff - homeStaff) / 1.5, -1, 1)
  const f5Home = f5?.f5_moneyline ? clamp(f5.f5_moneyline.home_lead - f5.f5_moneyline.away_lead, -1, 1) : 0

  const F = {
    momentum: { home: momentum(forms.recentHome), away: momentum(forms.recentAway) },
    pitching: { home: pitchHome, away: -pitchHome },
    f5: { home: f5Home, away: -f5Home },
    bats: { home: batsScore(feat.home_rs_l10, hSb, hSb.ops), away: batsScore(feat.away_rs_l10, aSb, aSb.ops) },
    schedule: { home: 0, away: -travelPenalty(home, away) },
    manager: { home: aggrScore(hSb, lgAttempts), away: aggrScore(aSb, lgAttempts) },
  }
  const news = { home: newsScore(game.home_team_id, injuries), away: newsScore(game.away_team_id, injuries) }

  let signal = 0
  for (const k of Object.keys(WEIGHTS)) signal += WEIGHTS[k] * (F[k].home - F[k].away)
  signal += news.home - news.away
  const modelP = prediction.moneyline.home
  const adrianP = clamp(modelP + clamp(K * signal, -MAX_DP, MAX_DP), 0.05, 0.95)
  const mlPick = adrianP >= 0.5 ? 'home' : 'away'
  const mlAbbr = mlPick === 'home' ? home : away
  const oppAbbr = mlPick === 'home' ? away : home
  const dir = mlPick === 'home' ? 1 : -1
  let agree = 0
  for (const k of Object.keys(WEIGHTS)) if (Math.sign(F[k].home - F[k].away) === dir) agree++
  const mlProb = mlPick === 'home' ? adrianP : 1 - adrianP
  const mlConf = Math.abs(adrianP - 0.5) * 2 + (agree / 6) * 0.45
  const pickModelP = mlPick === 'home' ? modelP : 1 - modelP
  const mlReasons = Object.keys(WEIGHTS)
    .map((k) => ({ k, v: WEIGHTS[k] * (F[k].home - F[k].away) * dir }))
    .filter((x) => x.v > 0.01).sort((a, b) => b.v - a.v).slice(0, 3)
    .map((x) => FACTOR_REASON[x.k](mlAbbr))

  // Total (over/under) with pitcher-recent + contact.
  const re = runEnvironment(ctx)
  // Only reasons that agree with the chosen side — a BAJA pick must never show a
  // "→ sube" reason (and vice-versa). Confidence counts the same matching set.
  const totalReasons = re.reasons.filter((r) => r.over === (re.side === 'over'))
  const totalConf = Math.abs(re.prob - 0.5) * 2 + Math.min(0.35, totalReasons.length * 0.12)

  const ml = {
    market: 'ml', game_pk: game.game_pk, matchup: `${away} @ ${home}`,
    pick: mlAbbr, label: `Gana ${mlAbbr}`, prob: round3(mlProb),
    confScore: round2(mlConf), confidence: tier(mlConf),
    isValue: pickModelP < 0.5 && tier(mlConf) !== 'baja', reasons: mlReasons,
    // Intermediates for Adrian Learning (additive; classic UI ignores them).
    model_p: round3(modelP), signal: round4(signal), adrian_p: round3(adrianP), agree,
  }
  const total = {
    market: 'total', game_pk: game.game_pk, matchup: `${away} @ ${home}`,
    side: re.side, line: re.line, label: `${re.side === 'over' ? 'ALTA' : 'BAJA'} ${re.line}`,
    prob: round3(re.prob), expected: re.adjTotal, base: re.base,
    confScore: round2(totalConf), confidence: tier(totalConf),
    isValue: false, reasons: totalReasons.slice(0, 3),
    // Intermediates for Adrian Learning (additive; raw unrounded components).
    p_over: round3(re.pOver), adj_total: re.components.adjTotal, base_raw: re.components.base, components: re.components,
  }

  return {
    game_pk: game.game_pk, home, away, matchup: `${away} @ ${home}`,
    home_name: game.home_team_name, away_name: game.away_team_name,
    home_pitcher: game.home_probable_pitcher_name, away_pitcher: game.away_probable_pitcher_name,
    home_pitcher_id: game.home_probable_pitcher_id, away_pitcher_id: game.away_probable_pitcher_id,
    status: game.status, dayNight: game.day_night, weather: ctx.weather || null,
    pitcher_recent: ctx.pitcherRecent || null,
    l10_home: (forms.recentHome || []).slice(0, 10).map((g) => (g.won ? 1 : 0)),
    l10_away: (forms.recentAway || []).slice(0, 10).map((g) => (g.won ? 1 : 0)),
    streak_home: streakLen(forms.recentHome), streak_away: streakLen(forms.recentAway),
    factors: F, news, ml, total,
    plays: [ml, total],
    bestPlay: total.confScore > ml.confScore ? total : ml,
  }
}

const round2 = (x) => Math.round(x * 100) / 100
const round3 = (x) => Math.round(x * 1000) / 1000
const round4 = (x) => Math.round(x * 10000) / 10000
const tier = (c) => (c > 0.7 ? 'alta' : c > 0.45 ? 'media' : 'baja')
const FACTOR_REASON = {
  momentum: (abbr) => ({ text: `${abbr} llega con mejor momentum (últimos 10)`, tone: 'positive' }),
  pitching: (abbr) => ({ text: `${abbr} tiene ventaja de picheo (abridor + bullpen)`, tone: 'positive' }),
  f5: (abbr) => ({ text: `${abbr} domina en las primeras 5 entradas`, tone: 'positive' }),
  bats: (abbr) => ({ text: `${abbr} batea/corre mejor (contacto + robos)`, tone: 'positive' }),
  schedule: (abbr) => ({ text: `${abbr} con ventaja de descanso/viaje`, tone: 'neutral' }),
  manager: (abbr) => ({ text: `${abbr}: manager agresivo (fabrica carreras)`, tone: 'neutral' }),
}

// --- slate selection: rank ALL candidate plays across markets ---------------
export function selectPlays(analyses, { max = 3, minConf = 0.45 } = {}) {
  const all = analyses.flatMap((a) => a.plays.map((p) => ({ ...p, _a: a })))
  const ranked = all.sort((x, y) => (y.confScore + (y.isValue ? 0.08 : 0)) - (x.confScore + (x.isValue ? 0.08 : 0)))
  // At most one play per game in the top picks (don't double up a single game).
  const plays = []
  const usedGames = new Set()
  for (const p of ranked) {
    if (p.confScore < minConf || usedGames.has(p.game_pk)) continue
    usedGames.add(p.game_pk)
    plays.push(p)
    if (plays.length >= max) break
  }
  // A parlay cannot be priced by multiplying marginal probabilities: legs can
  // share the same run environment, starter and bullpen. Keep this field null
  // until a joint simulation is calibrated and a real payout is captured.
  return { plays, combo: null, ranked: analyses.sort((x, y) => y.bestPlay.confScore - x.bestPlay.confScore) }
}

// --- "Fijos del día": the 0-2 highest-SAFETY moneyline picks ------------------
// A game only qualifies when THREE independently-audited signals line up:
//   1) market favorite, 2) 5+ AA factors, 3) the pick's starter has the better
// recent ERA with >=2 measured starts on BOTH sides. Historical screens are
// discovery evidence only; the native immutable forward cohort controls the
// public gate. Until that gate passes, candidates remain in shadow.
// PLATA is no longer used to fill a quota: its own replay was unstable/negative.
// Some days return zero or one pick; abstention is part of the model.
// Higher-probability tier, never a guarantee. `oddsByPk` is a Map or object
// keyed by game_pk holding the merged odds block.
const MAX_LOCK_DISAGREE = 0.06 // books apart by >6 pts → too much market doubt
// Above this implied break-even, even the gold pool's historical win rate can't
// beat the price (structural math, not a fitted threshold): the fijo still shows
// (max win probability is the mandate) but carries a "línea cara" warning.
const PRICE_WARN_BREAKEVEN = 0.68

// Pure/exported for regression tests. `analysis.pitcher_recent` is the live
// shape ({home:{recent:{era,n}}}); rows logged by learn.js flatten recent one
// level, so the defensive `recent || side` also supports replay fixtures.
export function starterRecentGate(analysis, pick) {
  const side = (x) => {
    const r = x?.recent || x || null
    return r && r.era != null && Number.isFinite(Number(r.era)) && Number(r.n) >= 2
      ? { era: Number(r.era), n: Number(r.n) } : null
  }
  const home = side(analysis?.pitcher_recent?.home)
  const away = side(analysis?.pitcher_recent?.away)
  if (!home || !away || !pick) return { passes: false, pick_era: null, opp_era: null }
  const pickHome = pick === analysis.home
  const mine = pickHome ? home : away, opp = pickHome ? away : home
  return { passes: mine.era < opp.era, pick_era: mine.era, opp_era: opp.era, starts: Math.min(mine.n, opp.n) }
}

export function selectLocks(analyses, oddsByPk, { max = 2 } = {}) {
  const getOdds = (pk) => (oddsByPk?.get ? oddsByPk.get(pk) : oddsByPk?.[pk]) || null
  const gold = []
  for (const a of analyses) {
    const ml = a.ml
    if (!ml || ml.confidence !== 'alta') continue
    if (ml.aligned === false) continue // v2 honesty gate: never post a fijo the calibrated brain says loses
    const odds = getOdds(a.game_pk)
    if (!odds || !odds.fav_side) continue
    const mc = marketConsensus(ml, odds) // 'strong' = market fav + agree>=5 (both robust signals)
    if (mc.level !== 'strong') continue
    const starter = starterRecentGate(a, ml.pick)
    if (!starter.passes) continue
    const disagree = odds.book_disagreement ?? 0
    if (disagree > MAX_LOCK_DISAGREE) continue
    const consHome = odds.consensus?.p_home ?? odds.p_home_mkt
    const consForPick = consHome == null ? ml.prob : (ml.pick === a.home ? consHome : 1 - consHome)
    const mlPrice = ml.pick === a.home ? odds.ml_home : odds.ml_away
    const breakeven = mlPrice == null ? consForPick : (mlPrice < 0 ? Math.abs(mlPrice) / (Math.abs(mlPrice) + 100) : 100 / (mlPrice + 100))
    // Safety = mostly the model's own prob, backed by the market consensus and a
    // strong (5+ factor) market agreement, penalized by book disagreement.
    const safety = round3(0.5 * ml.prob + 0.4 * consForPick + (mc.level === 'strong' ? 0.1 : 0) - disagree)
    const lock = {
      market: 'ml', game_pk: a.game_pk, matchup: a.matchup, pick: ml.pick, label: ml.label,
      prob: ml.prob, confidence: ml.confidence, reasons: ml.reasons,
      market_consensus: mc.level, consensus_prob: round3(consForPick),
      book_disagreement: round3(disagree), n_books: odds.consensus?.n_books ?? (odds.books?.length ?? 1),
      engine: ml.engine ?? 'classic', prob_v2: ml.prob_v2 ?? null,
      price: mlPrice ?? null, // American price at capture — feeds the public units ledger
      price_warning: breakeven > PRICE_WARN_BREAKEVEN, // ROI honesty flag, not a filter
      safety, selection_rule: 'market_agree5_starter_v1', starter_gate: starter,
    }
    gold.push({ ...lock, tier: 'oro' })
  }
  // Rank the qualifiers, but never fill a missing slot with a failed gate.
  gold.sort((x, y) => y.safety - x.safety)
  return gold.slice(0, max)
}
