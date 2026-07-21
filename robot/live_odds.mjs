// Live odds ("logros") watcher — runs in the independent mlb-live-observer
// workflow so its 45-minute loop never blocks daily.mjs. While games are IN
// PROGRESS it snapshots the multi-book moneyline +
// de-vig consensus + live win probability every ~5 minutes into
// data/history/live/<date>.json, and commits/pushes every ~10 minutes so the
// GitHub Pages site updates near-live. When a game goes final it captures the
// per-provider line-movement history once (the definitive open→close curve).
// Best-effort everywhere: any ESPN hiccup skips a snapshot, never crashes the
// run. Free public endpoints only — no keys, no secrets (project ethic).
import fs from 'fs'
import { execSync } from 'child_process'
import { parseSummaryOdds, consensusOf, espnAbbrToMlb } from './odds.js'
import { fetchScoreboard, fetchSummary } from './espn_odds.mjs'

const DATA = process.env.DATA_DIR || 'data'
const LIVE = `${DATA}/history/live`
const CORE = 'https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb'
const API = 'https://statsapi.mlb.com/api/v1'

const getJSON = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4)

// --- pure helpers (exported for tests) ---------------------------------------
// Scoreboard event → light live state (inning/half come from status).
export function liveEvents(scoreboardJson) {
  const out = []
  for (const e of scoreboardJson?.events || []) {
    const comp = e.competitions?.[0]
    const cs = comp?.competitors || []
    const home = cs.find((c) => c.homeAway === 'home'), away = cs.find((c) => c.homeAway === 'away')
    if (!home?.team?.abbreviation || !away?.team?.abbreviation) continue
    const st = e.status || comp?.status || {}
    out.push({
      espn_id: String(e.id),
      state: st.type?.state || null, // 'pre' | 'in' | 'post'
      inning: st.period ?? null,
      half: /top/i.test(st.type?.shortDetail || '') ? 'T' : /bot|mid|end/i.test(st.type?.shortDetail || '') ? 'B' : null,
      home_abbr: espnAbbrToMlb(home.team.abbreviation),
      away_abbr: espnAbbrToMlb(away.team.abbreviation),
      home_score: home.score != null ? Number(home.score) : null,
      away_score: away.score != null ? Number(away.score) : null,
    })
  }
  return out
}

// Summary odds + win-prob → one compact snapshot row. `now` injected for tests.
export function buildSnapshot(ev, summaryOdds, now) {
  const books = (summaryOdds?.books || []).map((b) => ({ p: b.provider, h: b.ml_home, a: b.ml_away }))
  const cons = summaryOdds?.consensus ? summaryOdds.consensus.p_home : summaryOdds?.p_home_mkt ?? null
  const lastWp = summaryOdds?.wp_curve?.length ? summaryOdds.wp_curve[summaryOdds.wp_curve.length - 1].home_wp : null
  return {
    t: now, state: ev.state, inn: ev.inning, half: ev.half,
    hs: ev.home_score, as: ev.away_score,
    wp: r4(lastWp),
    cons: r4(cons),
    dis: summaryOdds?.book_disagreement ?? null,
    books: books.length ? books : null,
  }
}

// Append with downsampling: skip if the game's last snapshot is younger than
// minGapMs (default 4.5 min) and the game state didn't change.
export function appendSnapshot(gameRec, snap, { minGapMs = 270e3 } = {}) {
  const arr = gameRec.snapshots
  const last = arr[arr.length - 1]
  if (last && new Date(snap.t) - new Date(last.t) < minGapMs && last.state === snap.state) return false
  arr.push(snap)
  return true
}

// --- core-API line movement (once per game, at final) -------------------------
// The odds list gives the priced providers; the movement endpoint per provider
// returns the full open→close timeline. We keep a compact version of the first
// provider that answers (usually ESPN BET) — enough for the steam study.
async function fetchMovementClose(espnId) {
  try {
    const list = await getJSON(`${CORE}/events/${espnId}/competitions/${espnId}/odds`)
    const items = list?.items || []
    const provs = items.map((it) => ({ id: it.provider?.id ?? (it.$ref || '').match(/odds\/(\d+)/)?.[1], name: it.provider?.name ?? null })).filter((p) => p.id)
    for (const p of provs.slice(0, 3)) {
      try {
        const mv = await getJSON(`${CORE}/events/${espnId}/competitions/${espnId}/odds/${p.id}/history/0/movement?limit=100`)
        const rows = (mv?.items || []).map((m) => ({
          t: m.timestamp || m.lastModified || null,
          h: m.homeOdds ?? null,
          a: m.awayOdds ?? null,
          line: m.line ?? null, ou: m.overUnder ?? null,
        })).filter((r) => r.t)
        if (rows.length) return { provider_id: p.id, provider: p.name, n: rows.length, rows: rows.slice(-60) }
      } catch { /* next provider */ }
    }
  } catch { /* no movement available */ }
  return null
}

// --- MLB matchup → game_pk map (one schedule fetch) ---------------------------
async function gamePkMap(date) {
  const m = new Map()
  try {
    const data = await getJSON(`${API}/schedule?sportId=1&date=${date}&hydrate=team`)
    for (const d of data.dates || []) for (const g of d.games || []) {
      const h = g.teams?.home?.team?.abbreviation, a = g.teams?.away?.team?.abbreviation
      if (h && a) m.set(`${espnAbbrToMlb(a)}@${espnAbbrToMlb(h)}`, g.gamePk)
    }
  } catch { /* fall back to espn ids as keys */ }
  return m
}

// --- git: commit/push the live file mid-run (Actions only) --------------------
export function commitLive(reason) {
  if (!process.env.GITHUB_ACTIONS) return false
  try {
    execSync(`git add ${LIVE}`, { stdio: 'pipe' })
    execSync(`git diff --cached --quiet || git commit -m "live odds: ${reason}"`, { stdio: 'pipe', shell: '/bin/bash' })
    execSync('git pull --rebase --autostash origin "$GITHUB_REF_NAME" && git push', { stdio: 'pipe', shell: '/bin/bash' })
    return true
  } catch { return false } // next tick retries; the workflow's final step is the catch-all
}

// --- main watcher --------------------------------------------------------------
const ET = 'America/New_York'
const etDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: ET }).format(new Date())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function watch({ date = null, budgetMs = 45 * 60e3, tickMs = 5 * 60e3, maxTicks = null } = {}) {
  const day = date || etDate()
  fs.mkdirSync(LIVE, { recursive: true })
  const fp = `${LIVE}/${day}.json`
  const store = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : { date: day, updated_at: null, games: {} }
  const pkByMatchup = await gamePkMap(day)
  const t0 = Date.now()
  let tick = 0, sinceCommit = 0, wrote = false

  for (;;) {
    tick++
    let events = []
    try { events = liveEvents(await fetchScoreboard(day)) } catch { /* espn hiccup: try next tick */ }
    const inGame = events.filter((e) => e.state === 'in')
    const finals = events.filter((e) => e.state === 'post')

    // snapshot every in-progress game (summary carries odds + live win prob)
    for (const ev of inGame) {
      try {
        const odds = parseSummaryOdds(await fetchSummary(ev.espn_id))
        const key = String(pkByMatchup.get(`${ev.away_abbr}@${ev.home_abbr}`) ?? `espn:${ev.espn_id}`)
        if (!store.games[key]) store.games[key] = { matchup: `${ev.away_abbr} @ ${ev.home_abbr}`, home: ev.home_abbr, away: ev.away_abbr, espn_id: ev.espn_id, snapshots: [] }
        if (appendSnapshot(store.games[key], buildSnapshot(ev, odds, new Date().toISOString()))) wrote = true
      } catch { /* skip this game this tick */ }
    }
    // one-time movement capture for games that just finished
    for (const ev of finals) {
      const key = String(pkByMatchup.get(`${ev.away_abbr}@${ev.home_abbr}`) ?? `espn:${ev.espn_id}`)
      const rec = store.games[key]
      if (!rec || rec.movement_close) continue
      const mv = await fetchMovementClose(ev.espn_id)
      if (mv) { rec.movement_close = mv; rec.final = `${ev.away_score}-${ev.home_score}`; wrote = true }
    }

    if (wrote) {
      store.updated_at = new Date().toISOString()
      fs.writeFileSync(fp, JSON.stringify(store, null, 1))
      sinceCommit++
      wrote = false
    }
    // push every ~2 ticks (~10 min) so the site refreshes near-live
    if (sinceCommit >= 2) { if (commitLive(`${day} t${tick}`)) sinceCommit = 0 }

    const elapsed = Date.now() - t0
    const done = !inGame.length && !events.some((e) => e.state === 'pre')
    if (maxTicks && tick >= maxTicks) break
    if (elapsed + tickMs > budgetMs) break // leave room for the next hourly run
    if (!inGame.length) {
      if (done) break // slate over
      // pregame: exit — the next hourly run will pick the games up
      break
    }
    await sleep(tickMs)
  }
  if (sinceCommit > 0) commitLive(`${day} final`)
  const nGames = Object.keys(store.games).length
  const nSnaps = Object.values(store.games).reduce((s, g) => s + g.snapshots.length, 0)
  console.log(`live_odds: ${day} -> ${nGames} games, ${nSnaps} snapshots, ${tick} ticks`)
  return store
}

// CLI entry (skipped when imported by tests): node robot/live_odds.mjs [date]
if (process.argv[1] && process.argv[1].endsWith('live_odds.mjs')) {
  watch({ date: process.argv[2] || null }).catch((e) => { console.error('live_odds error (non-fatal):', e.message); process.exit(0) })
}
