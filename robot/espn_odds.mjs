// Robot-side ESPN odds fetcher. Maps ESPN events → MLB game_pk (by date + team
// abbrs, doubleheader/UTC-rollover aware) and returns a Map(game_pk → odds block)
// built by the pure parsers in odds.js. Best-effort: any failure → that game
// simply gets no odds ("sin dato"). No secrets, no scraping — ESPN's public API.
//
// Import path note: in the deployed/scratchpad robot dir everything is FLAT, so
// this imports './odds.js' (deploy_demo.sh copies odds.js next to it). It is run
// from that flat dir, never from scripts/ directly (same as daily.mjs/learn.js).
import { mergeExtraBooks, parseCoreOdds, parseScoreboard, parseSummaryOdds } from './odds.js'

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb'
const CORE = 'https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb'
const getJSON = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
const matchupKey = (away, home) => `${away}@${home}`

export function fetchScoreboard(dateISO) {
  return getJSON(`${ESPN}/scoreboard?dates=${dateISO.replace(/-/g, '')}`)
}
export function fetchSummary(espnId) {
  return getJSON(`${ESPN}/summary?event=${espnId}`)
}
// Multi-provider odds from the core API (pickcenter often carries ONE book).
// The list endpoint returns items as $ref POINTERS (verified in production) —
// dereference up to 8 providers with a small pool before parsing.
export async function fetchCoreOddsItems(espnId) {
  const list = await getJSON(`${CORE}/events/${espnId}/competitions/${espnId}/odds?limit=20`)
  const items = list?.items || []
  const inline = items.filter((it) => it.provider || it.homeTeamOdds)
  const refs = items.filter((it) => !it.provider && it.$ref).slice(0, 8)
  const fetched = []
  await Promise.all(refs.map(async (it) => {
    try { fetched.push(await getJSON(String(it.$ref).replace(/^http:/, 'https:'))) } catch { /* skip provider */ }
  }))
  return [...inline, ...fetched]
}

// Pick the ESPN event for an MLB game from candidates sharing the same matchup.
// One candidate → use it. Doubleheader (>1) → nearest start time if the MLB game
// has a datetime, else abstain (null) rather than risk a wrong attach.
function pickEvent(candidates, mlbDatetime) {
  if (!candidates || !candidates.length) return null
  if (candidates.length === 1) return candidates[0]
  if (!mlbDatetime) return null
  const t = new Date(mlbDatetime).getTime()
  return candidates.reduce((best, e) => {
    const d = Math.abs(new Date(e.datetime || 0).getTime() - t)
    return d < best.d ? { e, d } : best
  }, { e: null, d: Infinity }).e
}

// dateISO: MLB ET officialDate. mlbGames: [{ game_pk, home_team_abbr,
// away_team_abbr, game_datetime? }] (abbrs already fixAbbr'd to OAK/CWS/AZ).
// Returns Map(game_pk -> odds). onSummary optional: (game_pk, espn_id, odds).
export async function buildOddsForDate(dateISO, mlbGames) {
  const out = new Map()
  let events
  try { events = parseScoreboard(await fetchScoreboard(dateISO)) } catch { return out }
  const byMatchup = new Map()
  for (const ev of events) {
    const k = matchupKey(ev.away_abbr, ev.home_abbr)
    ;(byMatchup.get(k) || byMatchup.set(k, []).get(k)).push(ev)
  }
  // resolve each MLB game to an ESPN event id (dedupe fetches)
  const wanted = new Map() // game_pk -> espn_id
  const idToPks = new Map() // espn_id -> [game_pk]
  for (const g of mlbGames) {
    const ev = pickEvent(byMatchup.get(matchupKey(g.away_team_abbr, g.home_team_abbr)), g.game_datetime)
    if (!ev) continue
    wanted.set(g.game_pk, ev.espn_id)
    ;(idToPks.get(ev.espn_id) || idToPks.set(ev.espn_id, []).get(ev.espn_id)).push(g.game_pk)
  }
  // fetch summaries (+ core multi-provider odds) with a small concurrency pool
  const ids = [...idToPks.keys()]
  const POOL = 6
  for (let i = 0; i < ids.length; i += POOL) {
    await Promise.all(ids.slice(i, i + POOL).map(async (id) => {
      try {
        let odds = { ...parseSummaryOdds(await fetchSummary(id)), espn_id: id }
        try { odds = mergeExtraBooks(odds, parseCoreOdds({ items: await fetchCoreOddsItems(id) })) } catch { /* core is a bonus */ }
        for (const pk of idToPks.get(id)) out.set(pk, odds)
      } catch { /* leave those games with no odds */ }
    }))
  }
  return out
}
