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

// --- multi-book helpers -----------------------------------------------------
const round4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4)
const clampR = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ESPN's total-price shape varies by provider/era. Parse only an actual
// American price; the total line itself is never treated as juice.
function amOdds(v) {
  if (v == null) return null
  if (typeof v === 'number') return v === 0 ? null : v
  const s = String(v).trim().toUpperCase()
  if (s === 'EVEN' || s === 'EV') return 100
  const n = Number(s.replace('+', ''))
  return isFinite(n) && n !== 0 ? n : null
}
function totalSidePrice(o, side) {
  const cap = side[0].toUpperCase() + side.slice(1)
  const roots = [o?.[`${side}Odds`], o?.[`total${cap}Odds`], o?.total?.[side], o?.odds?.[side]]
  for (const x of roots) {
    const p = amOdds(x?.moneyLine) ?? amOdds(x?.current?.moneyLine?.american ?? x?.current?.moneyLine)
      ?? amOdds(x?.close?.moneyLine?.american ?? x?.close?.moneyLine) ?? amOdds(x)
    if (p != null) return p
  }
  return null
}
// De-vigged consensus across every priced book: the MEDIAN home prob (robust to a
// single off book) plus a `disagreement` = spread of home probs between books (how
// much the market itself is unsure — a pure risk signal, 0 when only one book).
export function consensusOf(books) {
  const ph = (books || []).map((b) => b.p_home_mkt).filter((v) => v != null)
  if (!ph.length) return { p_home: null, p_away: null, n_books: 0, disagreement: null }
  const m = median(ph)
  return { p_home: round4(m), p_away: round4(1 - m), n_books: ph.length, disagreement: ph.length > 1 ? round4(Math.max(...ph) - Math.min(...ph)) : 0 }
}

// --- ESPN summary → additive `odds` block (all fields nullable → "sin dato") -
// Now reads ALL of ESPN's pickcenter providers (not just [0]): keeps a per-book
// list, a de-vig CONSENSUS (median), and the between-book disagreement. The
// top-level p_home_mkt/fav_side become the consensus (a better single number than
// any one book); ml_home/ml_away stay the primary book so the American-line
// thresholds in learn.js keep their meaning. All pregame → anti-leakage safe.
export function parseSummaryOdds(json) {
  const pcs = json?.pickcenter || []
  const books = []
  for (const pc of pcs) {
    const ml_home = pc?.homeTeamOdds?.moneyLine ?? null
    const ml_away = pc?.awayTeamOdds?.moneyLine ?? null
    const [ph, pa] = devigMoneyline(ml_home, ml_away)
    if (ph == null) continue // unpriced book → skip
    books.push({ provider: pc?.provider?.name ?? null, ml_home, ml_away, over_under: pc?.overUnder ?? null,
      over_price: totalSidePrice(pc, 'over'), under_price: totalSidePrice(pc, 'under'),
      spread: pc?.spread ?? null, p_home_mkt: round4(ph), p_away_mkt: round4(pa) })
  }
  const cons = consensusOf(books)
  const primary = pcs[0] || null
  const ml_home = primary?.homeTeamOdds?.moneyLine ?? null
  const ml_away = primary?.awayTeamOdds?.moneyLine ?? null
  const p_home_mkt = cons.p_home ?? devigMoneyline(ml_home, ml_away)[0]
  const p_away_mkt = cons.p_away ?? devigMoneyline(ml_home, ml_away)[1]
  const wp_curve = downsampleWinProb(json)
  return {
    provider: primary?.provider?.name ?? null,
    ml_home, ml_away,
    over_under: primary?.overUnder ?? null,
    over_price: totalSidePrice(primary, 'over'), under_price: totalSidePrice(primary, 'under'),
    spread: primary?.spread ?? null,
    p_home_mkt, p_away_mkt,
    fav_side: p_home_mkt == null ? null : p_home_mkt >= 0.5 ? 'home' : 'away',
    books: books.length ? books : null,
    consensus: cons.n_books ? { p_home: cons.p_home, p_away: cons.p_away, n_books: cons.n_books } : null,
    book_disagreement: cons.disagreement,
    wp_curve: wp_curve.length ? wp_curve : null,
  }
}

// --- ESPN CORE odds endpoint → extra books ----------------------------------
// Production showed pickcenter usually carries ONE priced book, which starves
// the consensus/disagreement signal. The core endpoint
// (/events/{id}/competitions/{id}/odds) lists several providers. Shapes vary by
// era, so parse defensively: moneyLine may be a number, or nested under
// current/close/open as {american: "-150"|"EVEN"}.
const sideML = (o) => {
  if (!o) return null
  return amOdds(o.moneyLine) ?? amOdds(o.current?.moneyLine?.american ?? o.current?.moneyLine)
    ?? amOdds(o.close?.moneyLine?.american ?? o.close?.moneyLine)
    ?? amOdds(o.open?.moneyLine?.american ?? o.open?.moneyLine)
}
export function parseCoreOdds(json) {
  const books = []
  for (const it of json?.items || []) {
    const ml_home = sideML(it.homeTeamOdds)
    const ml_away = sideML(it.awayTeamOdds)
    const [ph, pa] = devigMoneyline(ml_home, ml_away)
    if (ph == null) continue
    books.push({ provider: it.provider?.name ?? null, ml_home, ml_away, over_under: it.overUnder ?? null,
      over_price: totalSidePrice(it, 'over'), under_price: totalSidePrice(it, 'under'),
      spread: it.spread ?? null, p_home_mkt: round4(ph), p_away_mkt: round4(pa) })
  }
  return books
}

// Merge extra (core) books into a parsed odds block, deduped by provider, and
// recompute the consensus + between-book disagreement over the union.
export function mergeExtraBooks(odds, extraBooks) {
  if (!odds || !extraBooks?.length) return odds
  const seen = new Set((odds.books || []).map((b) => String(b.provider || '').toLowerCase()))
  const merged = [...(odds.books || [])]
  for (const b of extraBooks) {
    const k = String(b.provider || '').toLowerCase()
    if (k && seen.has(k)) continue
    seen.add(k)
    merged.push(b)
  }
  if (!merged.length) return odds
  const cons = consensusOf(merged)
  return {
    ...odds,
    books: merged,
    consensus: cons.n_books ? { p_home: cons.p_home, p_away: cons.p_away, n_books: cons.n_books } : odds.consensus,
    book_disagreement: cons.disagreement ?? odds.book_disagreement,
    p_home_mkt: cons.p_home ?? odds.p_home_mkt,
    p_away_mkt: cons.p_away ?? odds.p_away_mkt,
    fav_side: cons.p_home != null ? (cons.p_home >= 0.5 ? 'home' : 'away') : odds.fav_side,
    ml_home: odds.ml_home ?? merged[0]?.ml_home ?? null,
    ml_away: odds.ml_away ?? merged[0]?.ml_away ?? null,
  }
}

// Merge a freshly-captured odds block over a stored one, PRESERVING the earliest
// opening price (`p_home_open`) and any win-prob curve, and (re)deriving the
// open→close `line_move`. Used both for the live intraday refresh and the
// closing-line capture at grading. Additive metadata — never gated.
export function mergeOddsBlocks(prev, fresh) {
  if (!fresh) return prev ?? null
  const out = prev ? { ...prev, ...fresh, wp_curve: fresh.wp_curve ?? prev.wp_curve } : { ...fresh }
  const explicitPregame = fresh.capture_phase === 'pregame' || fresh.is_pregame === true || fresh.stage === 'pregame'
  const explicitClose = fresh.capture_phase === 'close' || fresh.capture_phase === 'postgame'
    || fresh.stage === 'close' || fresh.stage === 'final'
  const openMap = {
    p_home_open: 'p_home_mkt', ml_home_open: 'ml_home', ml_away_open: 'ml_away',
    over_under_open: 'over_under', over_price_open: 'over_price', under_price_open: 'under_price',
    spread_open: 'spread',
  }
  const prevAudited = prev?.captured_at_open != null && prev?.open_provenance === 'explicit_pregame'
  const freshPersistedAudited = fresh.captured_at_open != null && fresh.open_provenance === 'explicit_pregame'
  // Preserve the earliest known opening. Legacy persisted openings remain
  // readable but are explicitly marked unknown; a late/final capture can never
  // manufacture a new opening field.
  for (const [dst, src] of Object.entries(openMap)) {
    if (prevAudited && prev?.[dst] != null) out[dst] = prev[dst]
    else if (explicitPregame && fresh[src] != null) out[dst] = fresh[src]
    else if (freshPersistedAudited && fresh[dst] != null) out[dst] = fresh[dst]
    else if (prev?.[dst] != null) out[dst] = prev[dst]
    else delete out[dst]
  }
  if (prevAudited) out.captured_at_open = prev.captured_at_open
  else if (explicitPregame && fresh.captured_at != null) out.captured_at_open = fresh.captured_at
  else if (freshPersistedAudited) out.captured_at_open = fresh.captured_at_open
  else delete out.captured_at_open
  if (out.p_home_open != null || out.over_under_open != null) {
    out.open_provenance = out.captured_at_open != null ? 'explicit_pregame' : 'legacy_unknown'
    out.provider_open = prevAudited ? prev.provider_open ?? null
      : explicitPregame ? fresh.provider ?? null : freshPersistedAudited ? fresh.provider_open ?? null : prev?.provider_open ?? null
  } else {
    delete out.open_provenance; delete out.provider_open
  }
  if (explicitClose) {
    if (fresh.p_home_mkt != null) out.p_home_close = fresh.p_home_mkt
    if (fresh.ml_home != null) out.ml_home_close = fresh.ml_home
    if (fresh.ml_away != null) out.ml_away_close = fresh.ml_away
    if (fresh.over_under != null) out.over_under_close = fresh.over_under
    if (fresh.over_price != null) out.over_price_close = fresh.over_price
    if (fresh.under_price != null) out.under_price_close = fresh.under_price
    if (fresh.spread != null) out.spread_close = fresh.spread
    out.captured_at_close = fresh.captured_at ?? fresh.captured_at_close ?? null
    out.provider_close = fresh.provider ?? fresh.provider_close ?? null
    out.close_provenance = out.captured_at_close != null && out.provider_close != null
      ? 'explicit_close_capture' : 'unknown'
  } else if (prev) {
    for (const k of ['p_home_close', 'ml_home_close', 'ml_away_close', 'over_under_close', 'over_price_close', 'under_price_close', 'spread_close', 'captured_at_close', 'provider_close', 'close_provenance']) {
      if (prev[k] != null) out[k] = prev[k]
    }
  }
  const currentHome = out.p_home_close ?? out.p_home_mkt
  const currentTotal = out.over_under_close ?? out.over_under
  if (out.p_home_open != null && currentHome != null) out.line_move = round4(currentHome - out.p_home_open)
  if (out.over_under_open != null && currentTotal != null) out.total_line_move = round4(currentTotal - out.over_under_open)
  return out
}

export function hasAuditableOpening(odds, market = 'ml') {
  if (!odds || odds.captured_at_open == null || !Number.isFinite(Date.parse(odds.captured_at_open))
    || odds.open_provenance !== 'explicit_pregame') return false
  if (market === 'total') {
    return Number.isFinite(Number(odds.over_under_open))
      && Number.isFinite(Number(odds.over_price_open)) && Number(odds.over_price_open) !== 0
      && Number.isFinite(Number(odds.under_price_open)) && Number(odds.under_price_open) !== 0
  }
  return Number(odds.p_home_open) > 0 && Number(odds.p_home_open) < 1
    && Number.isFinite(Number(odds.ml_home_open)) && Number(odds.ml_home_open) !== 0
    && Number.isFinite(Number(odds.ml_away_open)) && Number(odds.ml_away_open) !== 0
}

// --- value engine: where OUR number beats the market (the Yankees/Tampa case) -
// edge = model prob − de-vig consensus prob, per side; EV = expected units won per
// unit staked at the book's actual American price. Positive edge = the model thinks
// the market is wrong (higher payout, higher variance). Descriptive/CI-gated — the
// season study already found FIGHTING the market underperforms, so value plays are
// surfaced SEPARATELY from the safe "fijos", never sold as guaranteed.
const impliedPayout = (ml) => (ml == null ? null : ml > 0 ? ml / 100 : 100 / Math.abs(ml))
const evOf = (p, ml) => { const b = impliedPayout(ml); return b == null ? null : round4(p * b - (1 - p)) }
export function valueEdge(pModelHome, odds) {
  if (pModelHome == null || !odds) return null
  const consH = odds.consensus?.p_home ?? odds.p_home_mkt
  if (consH == null) return null
  const home = { model: round4(pModelHome), market: round4(consH), edge: round4(pModelHome - consH), price: odds.ml_home, ev: evOf(pModelHome, odds.ml_home) }
  const away = { model: round4(1 - pModelHome), market: round4(1 - consH), edge: round4((1 - pModelHome) - (1 - consH)), price: odds.ml_away, ev: evOf(1 - pModelHome, odds.ml_away) }
  const best = home.edge >= away.edge ? 'home' : 'away'
  return { home, away, best_side: best, best_edge: (best === 'home' ? home : away).edge }
}

// --- per-game risk score (0-100) — "¿es riesgoso o no?" ----------------------
// Transparent, additive: books disagreeing, the model straying from the market, a
// big line move, and a tired/injured pick-side starter all add risk. Purely
// descriptive (a UI flag), never an input to the pick itself.
export function riskScore({ odds, adrian_p, pitcher_recent, news_delta, ml_pick, home } = {}) {
  if (!odds) return null
  const reasons = []
  let s = 0
  const dis = odds.book_disagreement ?? 0
  if (dis > 0) { s += clampR(dis * 400, 0, 30); if (dis >= 0.04) reasons.push(`Las casas discrepan (${(dis * 100).toFixed(1)} pts entre libros)`) }
  const cons = odds.consensus?.p_home ?? odds.p_home_mkt
  if (cons != null && adrian_p != null) { const gap = Math.abs(adrian_p - cons); s += clampR(gap * 120, 0, 35); if (gap >= 0.1) reasons.push(`El modelo se aparta del mercado (${Math.round(gap * 100)} pts)`) }
  const lm = odds.line_move
  if (lm != null) { s += clampR(Math.abs(lm) * 150, 0, 15); if (Math.abs(lm) >= 0.05) reasons.push('La línea se movió fuerte tras la apertura') }
  const pickHome = ml_pick === home
  const pr = pickHome ? pitcher_recent?.home : pitcher_recent?.away
  const fat = pr?.fatigue
  if (fat === 'alta') { s += 15; reasons.push('Abridor del pick con fatiga alta') } else if (fat === 'media') { s += 7 }
  if (news_delta != null && ml_pick) { const against = pickHome ? news_delta < 0 : news_delta > 0; if (against) { s += clampR(Math.abs(news_delta) * 40, 0, 15); reasons.push('Lesiones/noticias en contra del pick') } }
  const score = clampR(Math.round(s), 0, 100)
  return { score, level: score >= 55 ? 'alto' : score >= 30 ? 'medio' : 'bajo', reasons }
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
