// Team context reconstructed WALK-FORWARD from our own games_v1 logs — the
// "dormant raw material": every logged game already carries {date, home, away,
// final "as-hs", home_win}, which is enough to rebuild, for any (date, team),
// with STRICTLY EARLIER games only (same-date games excluded → doubleheader and
// leakage safe):
//   · home/away-specific recent form (win% last 10 AT HOME / ON ROAD)
//   · Pythagorean expectation over the last 20 games (rs^1.83 rule)
//   · REAL rest days (daily.mjs had rest hardcoded to 5 — a dead parameter)
//   · schedule density (games in the last 7 days)
//   · timezone travel from the PREVIOUS game's park, signed: positive = today's
//     park is EAST of yesterday's (eastward travel hurts — PNAS 2017, n=46,535)
// Pure + dependency-free: shared verbatim by the backtest scripts and daily.mjs.
import { park } from './venues.js'

const EXP = 1.83
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000)

// rows: games_v1 rows (graded or not; ungraded rows only contribute schedule
// facts like dates/parks, not results). Returns a query function:
//   ctx(date, team) -> { homeForm10, roadForm10, pyth20, rest, dens7, prevParkAbbr }
export function buildTeamContext(rows) {
  // Per team, chronological log of appearances: {date, atHome, rf, ra, won|null, parkAbbr}
  const byTeam = new Map()
  const add = (team, rec) => { if (!byTeam.has(team)) byTeam.set(team, []); byTeam.get(team).push(rec) }
  for (const r of rows) {
    if (!r.date || !r.home || !r.away) continue
    let hs = null, as = null
    if (r.final != null) { const m = String(r.final).split('-'); as = Number(m[0]); hs = Number(m[1]) }
    const decided = r.home_win === 0 || r.home_win === 1
    add(r.home, { date: r.date, atHome: true, rf: hs, ra: as, won: decided ? r.home_win === 1 : null, parkAbbr: r.home })
    add(r.away, { date: r.date, atHome: false, rf: as, ra: hs, won: decided ? r.home_win === 0 : null, parkAbbr: r.home })
  }
  for (const log of byTeam.values()) log.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  const dayDiff = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 864e5)

  return function ctx(date, team) {
    const log = byTeam.get(team)
    if (!log) return null
    const past = log.filter((g) => g.date < date) // strictly earlier → no same-day leakage
    if (!past.length) return null
    const decided = past.filter((g) => g.won != null)
    const homeG = decided.filter((g) => g.atHome).slice(-10)
    const roadG = decided.filter((g) => !g.atHome).slice(-10)
    const l20 = decided.slice(-20).filter((g) => g.rf != null && g.ra != null)
    let rs = 0, ra = 0
    for (const g of l20) { rs += g.rf; ra += g.ra }
    const pyth = l20.length >= 5 && (rs || ra) ? Math.pow(rs, EXP) / (Math.pow(rs, EXP) + Math.pow(ra, EXP)) : null
    const last = past[past.length - 1]
    const rest = dayDiff(date, last.date) // 1 = played yesterday
    const dens7 = past.filter((g) => dayDiff(date, g.date) <= 7).length
    return {
      homeForm10: homeG.length >= 5 ? r3(homeG.filter((g) => g.won).length / homeG.length) : null,
      roadForm10: roadG.length >= 5 ? r3(roadG.filter((g) => g.won).length / roadG.length) : null,
      pyth20: r3(pyth),
      rest, dens7,
      prevParkAbbr: last.parkAbbr,
    }
  }
}

// Signed timezone shift moving from prevPark to todayPark: positive = traveling
// EAST (tz offset increases toward 0, e.g. -7 -> -4 = +3 zones east = bad per
// the circadian literature). 0 when same park/zone or no previous park.
export function tzEast(prevParkAbbr, todayParkAbbr) {
  if (!prevParkAbbr || !todayParkAbbr || prevParkAbbr === todayParkAbbr) return 0
  return park(todayParkAbbr).tz - park(prevParkAbbr).tz
}

// The additive per-game aux block (home vs away), given the ctx query + a game.
export function auxForGame(ctx, { date, home, away }) {
  const h = ctx(date, home), a = ctx(date, away)
  if (!h && !a) return null
  const haf = h?.homeForm10 != null && a?.roadForm10 != null ? r3(h.homeForm10 - a.roadForm10) : null
  const pyth = h?.pyth20 != null && a?.pyth20 != null ? r3(h.pyth20 - a.pyth20) : null
  return {
    haf, pyth,
    rest_h: h?.rest ?? null, rest_a: a?.rest ?? null,
    dens_h: h?.dens7 ?? null, dens_a: a?.dens7 ?? null,
    tze_h: h ? tzEast(h.prevParkAbbr, home) : null, // home team returning from a trip
    tze_a: a ? tzEast(a.prevParkAbbr, home) : null, // away team arriving here
  }
}
