// Odds / market helpers — pure, dependency-free (node-importable, shared by the
// robot and the browser, like learn.js). Turns ESPN's free public API payloads
// (pickcenter moneyline + winprobability curve) into an additive `odds` block
// for a games_v1 row. No fetching here (see scripts/espn_odds.mjs and the
// browser hook); parsing + math only.
//
// HONEST FRAMING: we never claim a book "cheats". We only measure where the
// market price / live win-probability diverges from the scoreboard and whether
// that is predictive — every downstream claim is CI-gated in learn.js.

// --- de-vig (ported verbatim from backend/betting/odds_utils.py) ------------
export function americanToImplied(odds) {
  if (odds == null) return null
  if (odds === 0) return 0.5
  return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100)
}
export function removeVig(pa, pb) {
  const total = pa + pb
  if (!total) return [0.5, 0.5]
  return [pa / total, pb / total]
}
// De-vigged [pHome, pAway] from a two-sided moneyline; null if either side missing.
export function devigMoneyline(homeML, awayML) {
  const ph = americanToImplied(homeML), pa = americanToImplied(awayML)
  if (ph == null || pa == null) return [null, null]
  return removeVig(ph, pa)
}

// --- ESPN → MLB abbreviation normalizer (verified live) ---------------------
// ESPN uses ATH/CHW/ARI where the games_v1 rows use OAK/CWS/AZ (MLB statsapi
// gives CWS/AZ natively; fixAbbr maps ATH→OAK). All other abbrs match.
const ESPN_ABBR = { ATH: 'OAK', CHW: 'CWS', ARI: 'AZ' }
export const espnAbbrToMlb = (a) => ESPN_ABBR[a] || a

// --- ESPN scoreboard → light event list -------------------------------------
// Returns [{ espn_id, date(YYYY-MM-DD, UTC slice), state:'pre'|'in'|'post',
//            home_abbr, away_abbr }] with abbrs normalized to MLB.
export function parseScoreboard(json) {
  const out = []
  for (const e of json?.events || []) {
    const comp = e.competitions?.[0]
    const cs = comp?.competitors || []
    const home = cs.find((c) => c.homeAway === 'home')?.team?.abbreviation
    const away = cs.find((c) => c.homeAway === 'away')?.team?.abbreviation
    if (!home || !away) continue
    out.push({
      espn_id: String(e.id),
      date: (e.date || '').slice(0, 10),
      datetime: e.date || null,
      state: e.status?.type?.state || null, // 'pre' | 'in' | 'post'
      home_abbr: espnAbbrToMlb(home),
      away_abbr: espnAbbrToMlb(away),
    })
  }
  return out
}

// --- win-probability curve: last point per half-inning ----------------------
// Joins winprobability[].playId → the matching play in the `plays[]` array
// (ESPN's playsMap only holds $ref pointers into plays), and keeps the LAST
// winprob point of each (half, inning), carrying the score at that point.
// half: 'T' (top, away batting) | 'B' (bottom, home batting).
export function downsampleWinProb(json) {
  const wp = json?.winprobability || []
  const plays = json?.plays || []
  const byId = new Map(plays.map((p) => [String(p.id), p]))
  const pm = json?.playsMap || {}
  const resolve = (playId) => {
    const direct = byId.get(String(playId))
    if (direct) return direct
    const ref = pm[playId]?.$ref // e.g. "#/plays/37"
    const idx = ref && /#\/plays\/(\d+)/.exec(ref)?.[1]
    return idx != null ? plays[Number(idx)] : null
  }
  const byHalf = new Map() // key `${inn}-${half}` -> {half, inn, home_wp, home_score, away_score, seq}
  let seq = 0
  for (const w of wp) {
    const play = resolve(w.playId)
    const per = play?.period
    if (!per || per.number == null) continue
    const half = per.type === 'Bottom' ? 'B' : 'T'
    const key = `${per.number}-${half}`
    byHalf.set(key, {
      half, inn: per.number,
      home_wp: typeof w.homeWinPercentage === 'number' ? Math.round(w.homeWinPercentage * 1e4) / 1e4 : null,
      home_score: play.homeScore ?? null, away_score: play.awayScore ?? null,
      seq: seq++,
    })
  }
  return [...byHalf.values()]
    .sort((a, b) => (a.inn - b.inn) || (a.half === 'T' ? -1 : 1))
    .map(({ seq: _s, ...pt }) => pt)
}

// --- ESPN summary → additive `odds` block (all fields nullable → "sin dato") -
export function parseSummaryOdds(json) {
  const pc = json?.pickcenter?.[0] || null
  const ml_home = pc?.homeTeamOdds?.moneyLine ?? null
  const ml_away = pc?.awayTeamOdds?.moneyLine ?? null
  const [p_home_mkt, p_away_mkt] = devigMoneyline(ml_home, ml_away)
  const wp_curve = downsampleWinProb(json)
  return {
    provider: pc?.provider?.name ?? null,
    ml_home, ml_away,
    over_under: pc?.overUnder ?? null,
    spread: pc?.spread ?? null,
    p_home_mkt, p_away_mkt,
    fav_side: p_home_mkt == null ? null : p_home_mkt >= 0.5 ? 'home' : 'away',
    wp_curve: wp_curve.length ? wp_curve : null,
  }
}

// --- curve-derived features (need who won; computed by the study, not capture) -
// early = through inning `throughInn` (default 3). "fav trailed early" = the
// pregame-favorite side was behind on the scoreboard at any point in that span.
export function curveFeatures(odds, homeWon, throughInn = 3) {
  const curve = odds?.wp_curve
  if (!curve || !curve.length || homeWon == null || !odds.fav_side) return { fav_trailed_early: null, min_wp_winner: null }
  const favHome = odds.fav_side === 'home'
  let favTrailed = false
  for (const p of curve) {
    if (p.inn > throughInn) break
    if (p.home_score == null || p.away_score == null) continue
    const favBehind = favHome ? p.home_score < p.away_score : p.away_score < p.home_score
    if (favBehind) favTrailed = true
  }
  // min win-prob the eventual winner dipped to (comeback depth), from the curve
  let minWp = 1
  for (const p of curve) {
    if (p.home_wp == null) continue
    const winnerWp = homeWon ? p.home_wp : 1 - p.home_wp
    if (winnerWp < minWp) minWp = winnerWp
  }
  return { fav_trailed_early: favTrailed, min_wp_winner: Math.round(minWp * 1e4) / 1e4 }
}

// --- Adrian play × market: the honest "consensus" tier ----------------------
// Season study (n=1333, holds in both halves): a moneyline pick that AGREES with
// the market wins ~57.5% vs ~45.6% when it fights the market; agree>=5 AND the
// market-favorite hits ~63.5%. This maps a play + its live odds to a tier so the
// UI can flag the higher-probability picks (never a profit promise — CI-honest).
// ML plays only (totals have no moneyline consensus). `play.matchup` is "AWAY @ HOME".
export function marketConsensus(play, odds) {
  if (!play || play.market !== 'ml' || !odds || !odds.fav_side) return { level: 'neutral', pickIsFav: null }
  const home = String(play.matchup || '').split('@')[1]?.trim()
  if (!home) return { level: 'neutral', pickIsFav: null }
  const pickIsHome = play.pick === home
  const pickIsFav = odds.fav_side === (pickIsHome ? 'home' : 'away')
  if (!pickIsFav) return { level: 'against', pickIsFav: false }
  if ((play.agree ?? 0) >= 5) return { level: 'strong', pickIsFav: true }
  return { level: 'market', pickIsFav: true }
}
