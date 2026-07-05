// Daily Adrian robot (Node, runs in GitHub Actions). Computes the day's plays
// with the SAME formula as the app (imports the pure adrian.js/engine.js) over
// live MLB data, saves them to history, and grades past days against final
// scores — building a real track record with no server and no secrets.
//
// Layout when deployed into the site repo's robot/ dir:
//   robot/daily.mjs (this) + adrian.js + engine.js + venues.js
//   ../data/*.json (priors) and ../data/history/ (output)
import fs from 'fs'
import { analyzeGame, leagueAttempts, selectPlays } from './adrian.js'
import { eloProb, expectedRuns, simulateF5, simulateGame } from './engine.js'

const API = 'https://statsapi.mlb.com/api/v1'
const DATA = process.env.DATA_DIR || 'data'
const HIST = `${DATA}/history`
const LEAGUE_FIP = 4.2, LEAGUE_KBB = 0.13, LEAGUE_PEN_FIP = 4.05
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const get = (u) => fetch(u).then((r) => r.json())
const isoMinus = (iso, d) => { const x = new Date(iso + 'T00:00:00'); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10) }
const ipToFloat = (ip) => { const s = parseFloat(ip); if (!isFinite(s)) return 0; const w = Math.trunc(s); return w + Math.round((s - w) * 10) * 10 / 30 }

// --- priors -----------------------------------------------------------------
const priors = { elo: j(`${DATA}/elo.json`), pitchers: j(`${DATA}/pitchers.json`), teams: j(`${DATA}/teams.json`), meta: j(`${DATA}/meta.json`) }
const ABBR_FIX = { ATH: 'OAK' }
const fixAbbr = (a) => ABBR_FIX[a] || a
const pitcherPrior = (id) => { const p = id != null ? priors.pitchers[String(id)] : null; return p ? { fip: p[0], kbb: p[1] } : { fip: LEAGUE_FIP, kbb: LEAGUE_KBB } }
const teamPrior = (a) => priors.teams[a] || { pen_fip: LEAGUE_PEN_FIP, park: 1.0 }
const eloOf = (a) => priors.elo[a] ?? 1500

// --- live MLB fetch ---------------------------------------------------------
function parseGame(g) {
  const t = g.teams || {}, home = t.home || {}, away = t.away || {}, hp = home.probablePitcher || {}, ap = away.probablePitcher || {}
  return {
    game_pk: g.gamePk, game_date: g.officialDate || (g.gameDate || '').slice(0, 10), day_night: g.dayNight || null,
    status: (g.status || {}).detailedState || (g.status || {}).abstractGameState,
    home_team_id: (home.team || {}).id, away_team_id: (away.team || {}).id,
    home_team_name: (home.team || {}).name, away_team_name: (away.team || {}).name,
    home_team_abbr: fixAbbr((home.team || {}).abbreviation), away_team_abbr: fixAbbr((away.team || {}).abbreviation),
    home_probable_pitcher_id: hp.id || null, away_probable_pitcher_id: ap.id || null,
    home_probable_pitcher_name: hp.fullName || null, away_probable_pitcher_name: ap.fullName || null,
    home_score: home.score ?? null, away_score: away.score ?? null,
  }
}
async function fetchSchedule(date) {
  const data = await get(`${API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,linescore,venue`)
  const games = []
  for (const d of data.dates || []) for (const g of d.games || []) if ((g.gameType || 'R') === 'R') games.push(parseGame(g))
  return games
}
async function fetchAllRecent(beforeDate, days = 25) {
  const start = isoMinus(beforeDate, days)
  const data = await get(`${API}/schedule?sportId=1&startDate=${start}&endDate=${beforeDate}&gameType=R&hydrate=team,linescore`)
  const byTeam = new Map()
  for (const d of data.dates || []) { if (d.date >= beforeDate) continue; for (const g of d.games || []) {
    if ((g.status || {}).abstractGameState !== 'Final') continue
    const t = g.teams || {}, hs = t.home?.score, as = t.away?.score
    if (hs == null || as == null) continue
    for (const [id, rf, ra] of [[t.home?.team?.id, hs, as], [t.away?.team?.id, as, hs]]) {
      if (id == null) continue; if (!byTeam.has(id)) byTeam.set(id, []); byTeam.get(id).push({ date: d.date, rf, ra, won: rf > ra ? 1 : 0 })
    }
  } }
  for (const rows of byTeam.values()) rows.sort((a, b) => (a.date < b.date ? 1 : -1))
  return byTeam
}
const startF5 = (ip, er) => (ip < 5 ? 'white' : er <= 2 ? 'green' : 'red')
const _plog = new Map()
async function pitcherLog(id, season) {
  if (_plog.has(id)) return _plog.get(id)
  let starts = []
  try {
    const data = await get(`${API}/people/${id}/stats?stats=gameLog&group=pitching&season=${season}&sportId=1`)
    const rows = []
    for (const blk of data.stats || []) for (const s of blk.splits || []) { const st = s.stat || {}; const ip = ipToFloat(st.inningsPitched); rows.push({ date: s.date, gs: Number(st.gamesStarted) || 0, ip, er: +st.earnedRuns || 0, h: +st.hits || 0, hr: +st.homeRuns || 0, pitches: Number(st.numberOfPitches ?? st.pitchesThrown) || 0 }) }
    starts = rows.filter((s) => s.gs > 0 || s.ip >= 2).map((s) => ({ ...s, f5: startF5(s.ip, s.er) })).reverse()
  } catch { /* empty */ }
  _plog.set(id, starts)
  return starts
}
const _pr = new Map()
async function fetchPitcherRecent(id, season, gameDate) {
  if (id == null) return null
  const all = await pitcherLog(id, season)
  const starts = gameDate ? all.filter((s) => s.date < gameDate) : all // anti-leakage
  const last3 = starts.slice(0, 3)
  let ip = 0, er = 0, h = 0, hr = 0; for (const s of last3) { ip += s.ip; er += s.er; h += s.h; hr += s.hr }
  const recent = ip > 0 ? { ip, era: Math.round(9 * er / ip * 100) / 100, h9: Math.round(9 * h / ip * 10) / 10, hr9: Math.round(9 * hr / ip * 10) / 10, n: last3.length } : null
  const av = last3.filter((s) => s.pitches).length ? Math.round(last3.reduce((a, s) => a + s.pitches, 0) / last3.filter((s) => s.pitches).length) : null
  let fatigue = null
  if (gameDate && starts[0]?.date) { const rest = Math.round((new Date(gameDate + 'T00:00:00') - new Date(starts[0].date + 'T00:00:00')) / 864e5); fatigue = { restDays: rest, avgPitches: av, level: rest <= 3 || (av && av >= 106) ? 'alta' : rest === 4 || (av && av >= 99) ? 'media' : 'normal' } }
  const out = { id, starts, recent, fatigue }; _pr.set(id, out); return out
}
async function fetchTransactions(start, end) {
  try {
    const data = await get(`${API}/transactions?startDate=${start}&endDate=${end}`)
    const inj = /injured list|injury|il\b|10-day|15-day|60-day|activated|placed/i, rows = []
    for (const t of data.transactions || []) { const d = t.description || ''; if (!inj.test(`${t.typeDesc || ''} ${d}`)) continue; rows.push({ date: t.date, teamId: t.toTeam?.id ?? t.fromTeam?.id, type: t.typeDesc, desc: d }) }
    return rows
  } catch { return [] }
}

// --- prediction glue (mirrors browserApi.predict) ---------------------------
function formFromRecent(rows, asOf) {
  if (!rows || !rows.length) return { rs_l10: 4.5, ra_l10: 4.5, form_l20: 0.5, rest: 5, pen_load_l3: 0 }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
  const rf = rows.map((r) => r.rf), ra = rows.map((r) => r.ra), won = rows.map((r) => r.won)
  const cut = new Date(new Date(asOf + 'T00:00:00').getTime() - 3 * 864e5)
  return { rs_l10: mean(rf.slice(0, 10)) ?? 4.5, ra_l10: mean(ra.slice(0, 10)) ?? 4.5, form_l20: mean(won.slice(0, 20)) ?? 0.5, rest: 5, pen_load_l3: rows.filter((r) => new Date(r.date + 'T00:00:00') >= cut).length }
}
const r4 = (x) => Math.round(x * 1e4) / 1e4
function predict(g, hf, af) {
  const hSp = pitcherPrior(g.home_probable_pitcher_id), aSp = pitcherPrior(g.away_probable_pitcher_id)
  const hT = teamPrior(g.home_team_abbr), aT = teamPrior(g.away_team_abbr), eH = eloOf(g.home_team_abbr), eA = eloOf(g.away_team_abbr)
  const f = { home_sp_fip: hSp.fip, away_sp_fip: aSp.fip, sp_fip_diff: hSp.fip - aSp.fip, home_pen_fip: hT.pen_fip, away_pen_fip: aT.pen_fip, park_factor: hT.park, home_rs_l10: hf.rs_l10, away_rs_l10: af.rs_l10, home_form_l20: hf.form_l20, away_form_l20: af.form_l20, home_pen_load_l3: hf.pen_load_l3, away_pen_load_l3: af.pen_load_l3, elo_diff: eH - eA, home_field_adv: 0.034 }
  const { muHome, muAway } = expectedRuns({ eloHome: eH, eloAway: eA, homeSp: f.home_sp_fip, homePen: f.home_pen_fip, awaySp: f.away_sp_fip, awayPen: f.away_pen_fip, park: f.park_factor })
  const sim = simulateGame(muHome, muAway, 8.5)
  const pHome = 0.8 * eloProb(eH, eA) + 0.2 * sim.p_home_win
  return { game_pk: g.game_pk, moneyline: { home: r4(pHome), away: r4(1 - pHome) }, expected_runs: { home: Math.round(sim.expected_home_runs * 100) / 100, away: Math.round(sim.expected_away_runs * 100) / 100 }, features: f, _mu: { muHome, muAway } }
}
const f5For = (p) => simulateF5({ muHome: p._mu.muHome, muAway: p._mu.muAway, homeSp: p.features.home_sp_fip, homePen: p.features.home_pen_fip, awaySp: p.features.away_sp_fip, awayPen: p.features.away_pen_fip })

// --- compute today's plays --------------------------------------------------
async function computeDay(date) {
  const games = await fetchSchedule(date)
  if (!games.length) return null
  const season = priors.meta?.season || new Date(date).getFullYear()
  const ids = [...new Set(games.flatMap((g) => [g.home_probable_pitcher_id, g.away_probable_pitcher_id]).filter(Boolean))]
  const [recentByTeam, injuries] = await Promise.all([fetchAllRecent(date), fetchTransactions(isoMinus(date, 4), date)])
  await Promise.all(ids.map((id) => fetchPitcherRecent(id, season, date)))
  const lgAtt = leagueAttempts(priors.teams)
  const analyses = games.map((g) => {
    const rh = recentByTeam.get(g.home_team_id) || [], ra = recentByTeam.get(g.away_team_id) || []
    const prediction = predict(g, formFromRecent(rh, g.game_date), formFromRecent(ra, g.game_date))
    const pitcherRecent = { home: _pr.get(g.home_probable_pitcher_id) || null, away: _pr.get(g.away_probable_pitcher_id) || null }
    return analyzeGame({ game: g, prediction, f5: f5For(prediction), forms: { recentHome: rh, recentAway: ra }, priors, weather: null, injuries, pitcherRecent, lgAttempts: lgAtt })
  })
  const { plays } = selectPlays(analyses)
  return plays.map((p) => ({ game_pk: p.game_pk, matchup: p.matchup, market: p.market, side: p.side || null, line: p.line ?? null, pick: p.pick || null, label: p.label, prob: p.prob, confidence: p.confidence }))
}

// --- grade a past day against final scores ----------------------------------
async function gradeDay(rec) {
  const games = await fetchSchedule(rec.date)
  const byPk = new Map(games.map((g) => [g.game_pk, g]))
  let done = true
  for (const play of rec.plays) {
    if (play.result) continue
    const g = byPk.get(play.game_pk)
    if (!g || g.home_score == null || !/Final|Game Over|Completed/.test(g.status || '')) { done = false; continue }
    const total = g.home_score + g.away_score
    if (play.market === 'ml') play.result = ((play.pick === g.home_team_abbr) === (g.home_score > g.away_score)) ? 'win' : 'loss'
    else if (play.market === 'total') play.result = total === play.line ? 'push' : (total > play.line) === (play.side === 'over') ? 'win' : 'loss'
    play.final = `${g.away_score}-${g.home_score}`
  }
  rec.graded = done
  return rec
}

// --- main -------------------------------------------------------------------
async function main() {
  fs.mkdirSync(HIST, { recursive: true })
  const today = process.argv[2] || new Date().toISOString().slice(0, 10)

  const plays = await computeDay(today)
  if (plays) fs.writeFileSync(`${HIST}/${today}.json`, JSON.stringify({ date: today, generated_at: new Date().toISOString(), graded: false, plays }, null, 2))

  // Grade any ungraded past days (up to 5 back).
  const files = fs.existsSync(HIST) ? fs.readdirSync(HIST).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : []
  for (const f of files.slice(-6)) {
    const rec = j(`${HIST}/${f}`)
    if (rec.graded || rec.date === today) continue
    await gradeDay(rec)
    fs.writeFileSync(`${HIST}/${f}`, JSON.stringify(rec, null, 2))
  }

  // Rebuild index with a running record.
  const idx = []
  let w = 0, l = 0, ps = 0
  for (const f of files) {
    const rec = j(`${HIST}/${f}`)
    const g = rec.plays.filter((p) => p.result)
    for (const p of g) { if (p.result === 'win') w++; else if (p.result === 'loss') l++; else ps++ }
    idx.push({ date: rec.date, n: rec.plays.length, graded: !!rec.graded, wins: g.filter((p) => p.result === 'win').length, losses: g.filter((p) => p.result === 'loss').length })
  }
  fs.writeFileSync(`${HIST}/index.json`, JSON.stringify({ updated_at: new Date().toISOString(), record: { wins: w, losses: l, pushes: ps, win_rate: w + l ? Math.round(w / (w + l) * 1000) / 1000 : null }, days: idx.reverse() }, null, 2))
  console.log(`adrian_daily: ${today} -> ${plays ? plays.length : 0} plays; record ${w}-${l} (${ps} push)`)
}
main().catch((e) => { console.error(e); process.exit(1) })
