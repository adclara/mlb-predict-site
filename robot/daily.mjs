// Daily Adrian robot (Node, runs in GitHub Actions). Computes the day's plays
// with the SAME formula as the app (imports the pure adrian.js/engine.js) over
// live MLB data, saves them to history, and grades past days against final
// scores — building a real track record with no server and no secrets.
//
// Layout when deployed into the site repo's robot/ dir:
//   robot/daily.mjs (this) + adrian.js + engine.js + venues.js
//   ../data/*.json (priors) and ../data/history/ (output)
import fs from 'fs'
import { analyzeGame, leagueAttempts, selectLocks, selectPlays } from './adrian.js'
import { eloProb, expectedRuns, simulateF5, simulateGame } from './engine.js'
import { analysisToRow, aprendeOpinion, buildSnapshot, FORMULA_VERSION, marketBlend } from './learn.js'
import { mergeOddsBlocks, riskScore, valueEdge } from './odds.js'
import { buildOddsForDate } from './espn_odds.mjs'
import { applyEloUpdates, loadEloState } from './elo_live.mjs'
import { fetchForecasts } from './weather.mjs'
import { auxForGame, buildTeamContext } from './context.mjs'
import { backfillSeasons, buildHistoryStudy } from './backfill_history.mjs'

const API = 'https://statsapi.mlb.com/api/v1'
const DATA = process.env.DATA_DIR || 'data'
const HIST = `${DATA}/history`
const GAMES = `${HIST}/games` // per-game feature+outcome logs for Adrian Learning
const LEAGUE_FIP = 4.2, LEAGUE_KBB = 0.13, LEAGUE_PEN_FIP = 4.05
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const get = (u) => fetch(u).then((r) => r.json())
const isoMinus = (iso, d) => { const x = new Date(iso + 'T00:00:00'); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10) }
const ipToFloat = (ip) => { const s = parseFloat(ip); if (!isFinite(s)) return 0; const w = Math.trunc(s); return w + Math.round((s - w) * 10) * 10 / 30 }

// --- priors -----------------------------------------------------------------
const priors = { elo: j(`${DATA}/elo.json`), pitchers: j(`${DATA}/pitchers.json`), teams: j(`${DATA}/teams.json`), meta: j(`${DATA}/meta.json`) }
const ABBR_FIX = { ATH: 'OAK' }
const fixAbbr = (a) => ABBR_FIX[a] || a
// Yesterday's learning snapshot (walk-forward safe for TODAY: trained only on
// already-graded past games). Missing/stale -> the classic formula runs alone.
const prevSnap = (() => { try { return j(`${HIST}/learning.json`) } catch { return null } })()
// Season-to-date FIP per probable pitcher (fetched fresh each run) blended with
// the deployed prior by innings reliability — priors no longer go stale between
// manual deploys. _freshFip: id -> {fip, ip}.
const _freshFip = new Map()
const pitcherPrior = (id) => {
  const p = id != null ? priors.pitchers[String(id)] : null
  const base = p ? { fip: p[0], kbb: p[1] } : { fip: LEAGUE_FIP, kbb: LEAGUE_KBB }
  const fresh = id != null ? _freshFip.get(id) : null
  if (!fresh) return base
  const w = fresh.ip / (fresh.ip + 40)
  return { ...base, fip: Math.round((w * fresh.fip + (1 - w) * base.fip) * 100) / 100 }
}
const teamPrior = (a) => priors.teams[a] || { pen_fip: LEAGUE_PEN_FIP, park: 1.0 }
const eloOf = (a) => priors.elo[a] ?? 1500

// --- live MLB fetch ---------------------------------------------------------
function parseGame(g) {
  const t = g.teams || {}, home = t.home || {}, away = t.away || {}, hp = home.probablePitcher || {}, ap = away.probablePitcher || {}
  return {
    game_pk: g.gamePk, game_date: g.officialDate || (g.gameDate || '').slice(0, 10), game_datetime: g.gameDate || null, day_night: g.dayNight || null,
    series_game: g.seriesGameNumber ?? null, series_len: g.gamesInSeries ?? null, // series context (was fetched & dropped)
    home_sp_hand: hp.pitchHand?.code ?? null, away_sp_hand: ap.pitchHand?.code ?? null, // platoon raw material
    status: (g.status || {}).detailedState || (g.status || {}).abstractGameState,
    home_team_id: (home.team || {}).id, away_team_id: (away.team || {}).id,
    home_team_name: (home.team || {}).name, away_team_name: (away.team || {}).name,
    home_team_abbr: fixAbbr((home.team || {}).abbreviation), away_team_abbr: fixAbbr((away.team || {}).abbreviation),
    home_probable_pitcher_id: hp.id || null, away_probable_pitcher_id: ap.id || null,
    home_probable_pitcher_name: hp.fullName || null, away_probable_pitcher_name: ap.fullName || null,
    home_score: home.score ?? null, away_score: away.score ?? null,
    // orden al bate {id,name} — solo cuando MLB publica el lineup (~2-3h antes); si no, []
    home_lineup: ((g.lineups || {}).homePlayers || []).map((p) => ({ id: p.id, name: p.fullName || null })),
    away_lineup: ((g.lineups || {}).awayPlayers || []).map((p) => ({ id: p.id, name: p.fullName || null })),
  }
}
async function fetchSchedule(date) {
  const data = await get(`${API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,linescore,venue,lineups`)
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
async function fetchSeasonFip(id, season) {
  if (id == null || _freshFip.has(id)) return
  try {
    const d = await get(`${API}/people/${id}/stats?stats=season&group=pitching&season=${season}`)
    const st = d.stats?.[0]?.splits?.[0]?.stat
    if (!st) return
    const ip = ipToFloat(st.inningsPitched)
    if (!ip || ip < 5) return // too few innings to say anything
    const hr = +st.homeRuns || 0, bb = +st.baseOnBalls || 0, hbp = +st.hitByPitch || 0, k = +st.strikeOuts || 0
    _freshFip.set(id, { fip: Math.round(((13 * hr + 3 * (bb + hbp) - 2 * k) / ip + 3.1) * 100) / 100, ip })
  } catch { /* prior alone */ }
}
// Pitcher throwing hand — the schedule's probablePitcher hydrate does NOT carry
// pitchHand in production, so fall back to a cached person lookup (≤30/day).
const _hand = new Map()
async function fetchPitcherHand(id) {
  if (id == null || _hand.has(id)) return _hand.get(id) ?? null
  let hand = null
  try {
    const d = await get(`${API}/people/${id}`)
    hand = d.people?.[0]?.pitchHand?.code ?? null
  } catch { /* sin dato */ }
  _hand.set(id, hand)
  return hand
}

// Team hitting splits vs LHP/RHP (statsapi statSplits, sitCodes vl/vr) — the raw
// material for the platoon refinement of Adrian's "bats" factor. Best-effort,
// one cached call per team per run; failures leave the split null ("sin dato").
const _splits = new Map()
async function fetchTeamSplits(teamId, season) {
  if (teamId == null || _splits.has(teamId)) return _splits.get(teamId) ?? null
  let out = null
  try {
    const d = await get(`${API}/teams/${teamId}/stats?stats=statSplits&group=hitting&sitCodes=vl,vr&season=${season}`)
    for (const blk of d.stats || []) for (const s of blk.splits || []) {
      const code = s.split?.code || s.split?.description
      const ops = Number(s.stat?.ops)
      if (!isFinite(ops)) continue
      out = out || {}
      if (String(code).toLowerCase().includes('l') && !String(code).toLowerCase().includes('r')) out.vsL = ops
      if (String(code).toLowerCase().includes('r') && !String(code).toLowerCase().includes('l')) out.vsR = ops
      if (code === 'vl') out.vsL = ops
      if (code === 'vr') out.vsR = ops
    }
  } catch { /* sin dato */ }
  _splits.set(teamId, out)
  return out
}
// Top hitters per team (best-effort, cached, 1 call/team) — the roster with
// season hitting hydrated, so the brief can answer "quiénes son los mejores
// bateadores". Parses defensively across statsapi shapes; any failure → [].
const _hitters = new Map()
const _hitterMap = new Map() // teamId -> Map(playerId -> {name,ops,hr,avg,pos}) — todo el roster
async function fetchTeamHitters(teamId, season) {
  if (teamId == null) return []
  if (_hitters.has(teamId)) return _hitters.get(teamId)
  let top = []
  const idMap = new Map()
  try {
    const d = await get(`${API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(type=season,group=hitting,season=${season}))`)
    const players = []
    for (const m of d.roster || []) {
      const p = m.person || {}
      let st = null
      for (const blk of p.stats || []) for (const s of blk.splits || []) { if (s.stat && (s.stat.ops != null || s.stat.atBats != null)) st = s.stat }
      if (!st) continue
      const ab = Number(st.atBats) || 0, ops = Number(st.ops)
      const rec = {
        name: p.fullName || p.lastName || '?',
        ops: isFinite(ops) ? Math.round(ops * 1000) / 1000 : null,
        hr: Number(st.homeRuns) || 0, avg: st.avg ?? null,
        pos: (m.position && m.position.abbreviation) || null,
      }
      // mapa por id: TODO el roster (sin gate de AB, para que el lineup no muestre blancos)
      if (p.id != null) idMap.set(p.id, rec)
      // top-3 para brief.hitters: sí exige 40+ AB y OPS válido
      if (ab >= 40 && isFinite(ops)) players.push({ name: rec.name, ops: rec.ops, hr: rec.hr, avg: rec.avg })
    }
    players.sort((a, b) => b.ops - a.ops)
    top = players.slice(0, 3)
  } catch { /* sin dato */ }
  _hitters.set(teamId, top)
  _hitterMap.set(teamId, idMap)
  return top
}

// Compact human-facing brief for one game — the "por qué" behind the play:
// Adrián's own reasons (already generated, previously dropped), the pitcher
// matchup (season FIP + recent ERA + fatigue + hand), bullpen edge, team
// offense, top hitters, and the first-5-innings (F5) win split. Descriptive
// only; never an input to any pick.
function buildBrief(a, prediction, f5, priors, g, homeHand, awayHand, hitters) {
  const f = prediction.features || {}
  const rr = (x) => (x == null ? null : Math.round(x * 100) / 100)
  const reasons = []
  for (const r of [...(a.ml?.reasons || []), ...(a.total?.reasons || [])]) { if (r?.text && !reasons.includes(r.text)) reasons.push(r.text) }
  const hOff = priors.teams[g.home_team_abbr] || {}, aOff = priors.teams[g.away_team_abbr] || {}
  const pr = a.pitcher_recent || {}
  // Alineación al bate: une el orden (del schedule) con las stats del roster por id.
  const lineupSide = (arr, teamId) => {
    const m = _hitterMap.get(teamId) || new Map()
    return (arr || []).slice(0, 9).map((e, i) => {
      const s = m.get(e.id) || {}
      return { order: i + 1, id: e.id ?? null, name: e.name || s.name || null, ops: s.ops ?? null, hr: s.hr ?? null, avg: s.avg ?? null, pos: s.pos ?? null }
    })
  }
  return {
    reasons: reasons.slice(0, 5),
    lineups: { home: lineupSide(g.home_lineup, g.home_team_id), away: lineupSide(g.away_lineup, g.away_team_id) },
    pitchers: {
      home: { name: g.home_probable_pitcher_name || null, fip: rr(f.home_sp_fip), hand: homeHand, era: pr.home?.recent?.era ?? null, n: pr.home?.recent?.n ?? null, fatigue: pr.home?.fatigue?.level ?? null },
      away: { name: g.away_probable_pitcher_name || null, fip: rr(f.away_sp_fip), hand: awayHand, era: pr.away?.recent?.era ?? null, n: pr.away?.recent?.n ?? null, fatigue: pr.away?.fatigue?.level ?? null },
    },
    bullpen: { home_fip: rr(f.home_pen_fip), away_fip: rr(f.away_pen_fip) },
    offense: {
      home: { ops: hOff.ops ?? null, runs: hOff.runs_pg ?? null },
      away: { ops: aOff.ops ?? null, runs: aOff.runs_pg ?? null },
    },
    hitters: { home: hitters?.home || [], away: hitters?.away || [] },
    f5: f5?.f5_moneyline ? { home_lead: round3d(f5.f5_moneyline.home_lead), away_lead: round3d(f5.f5_moneyline.away_lead), nrfi: f5.nrfi != null ? round3d(f5.nrfi) : null } : null,
  }
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

// --- cerebro v2: walk-forward ensemble + market anchor -----------------------
// The snapshot itself validated (CI-gated) that the combined model beats the
// classic ("combinado mejor") and that anchoring to the market improves log-loss
// ("mercado mejor" / market_anchor.improves). aprendeOpinion gives the ensemble+
// Platt prob from YESTERDAY's snapshot; marketBlend anchors it to the de-vig
// consensus with the walk-forward alpha. adrian_p is stored untouched, so the
// games_v1 training rows stay valid (no FORMULA_VERSION bump).
const round2d = (x) => Math.round(x * 100) / 100
const round3d = (x) => Math.round(x * 1000) / 1000
// Walk-forward-backtested split of roles (2026-07-07, n=1248 OOS):
//   · SELECTION keeps the phase-1 rules on the CLASSIC confidence scale — the
//     fijos criteria backtested 66.3% / ROI +4.5%; re-gating on the calibrated
//     scale collapsed them to 0.33/day at −15.6% ROI (calibrated probs rarely
//     clear a threshold designed for the overconfident classic scale).
//   · p_final (ensemble+Platt anchored to the market) is the best FORECASTER
//     (acc 55.5% vs 53.9%, logloss 0.687 vs 0.724) → it is what we DISPLAY and
//     what gates honesty: a pick that p_final says loses (<50%) is demoted out
//     of selection rather than posted with a made-up probability.
function applyBrainV2(a, r) {
  const op = aprendeOpinion(a, prevSnap)
  const anch = prevSnap?.ml?.market_anchor
  const alpha = anch?.improves && anch.alpha != null ? anch.alpha : null
  const mkt = r.odds?.consensus?.p_home ?? r.odds?.p_home_mkt ?? null
  let pF = op?.ml?.p_comb ?? null
  if (alpha != null && mkt != null) pF = marketBlend(pF ?? r.adrian_p, mkt, alpha)
  r.p_learn = op?.ml?.p_comb ?? null
  r.p_final = pF != null ? r4(pF) : null
  r.p_over_learn = op?.total?.p_comb ?? null
  const pO = r.p_over_learn
  if (pF == null && pO == null) return a // no snapshot and no line -> pure classic
  const ml = { ...a.ml }
  if (pF != null) {
    const pickHome = a.ml.pick === a.home
    ml.prob_v2 = round3d(pickHome ? pF : 1 - pF) // calibrated prob OF THE PICK side
    ml.engine = 'v2'
    ml.aligned = ml.prob_v2 >= 0.5
    // Honesty gate: market+learning say the pick loses -> demote below minConf.
    if (!ml.aligned) ml.confScore = round2d(Math.max(0, ml.confScore - 0.35))
  }
  const total = { ...a.total }
  if (pO != null) {
    total.prob_v2 = round3d(a.total.side === 'over' ? pO : 1 - pO)
    total.engine = 'v2'
    total.aligned = total.prob_v2 >= 0.5
    if (!total.aligned) total.confScore = round2d(Math.max(0, total.confScore - 0.35))
  }
  return { ...a, ml, total, plays: [ml, total], bestPlay: total.confScore > ml.confScore ? total : ml }
}

// --- 💎 Gemas: the calibrated brain's high-probability tier -------------------
// A gem = a game whose walk-forward p_final gives one side >= 65%. This tier is
// EXACTLY calibrated on the season replay (says 68.5% -> hits 68.7%, n=67,
// halves 65%/72%) and rare (~0.6/day). Honest framing: gems maximize WIN
// probability at market prices (ROI ~ -3%, the vig) — the ROI edge lives in the
// ORO fijos; the page says so.
const GEM_MIN_P = 0.65
function selectGems(rows, { max = 3 } = {}) {
  const gems = []
  for (const r of rows) {
    if (r.p_final == null) continue
    const home = r.p_final >= 0.5
    const prob = home ? r.p_final : 1 - r.p_final
    if (prob < GEM_MIN_P) continue
    const pick = home ? r.home : r.away
    const cons = r.odds?.consensus?.p_home ?? r.odds?.p_home_mkt
    gems.push({
      market: 'ml', game_pk: r.game_pk, matchup: r.matchup, pick, label: `Gana ${pick}`,
      prob: Math.round(prob * 1000) / 1000,
      consensus_prob: cons == null ? null : Math.round((home ? cons : 1 - cons) * 1000) / 1000,
      engine: 'v2', source: 'p_final',
    })
  }
  gems.sort((a, b) => b.prob - a.prob)
  return gems.slice(0, max)
}

// --- compute today's plays + per-game learning rows -------------------------
async function computeDay(date) {
  const games = await fetchSchedule(date)
  if (!games.length) return null
  const season = priors.meta?.season || new Date(date).getFullYear()
  const ids = [...new Set(games.flatMap((g) => [g.home_probable_pitcher_id, g.away_probable_pitcher_id]).filter(Boolean))]
  const [recentByTeam, injuries, wxByPk] = await Promise.all([
    fetchAllRecent(date), fetchTransactions(isoMinus(date, 4), date),
    fetchForecasts(games).catch(() => new Map()), // forecast weather (Open-Meteo, free)
  ])
  await Promise.all(ids.map((id) => Promise.all([fetchPitcherRecent(id, season, date), fetchSeasonFip(id, season), fetchPitcherHand(id)])))
  const teamIds = [...new Set(games.flatMap((g) => [g.home_team_id, g.away_team_id]).filter(Boolean))]
  await Promise.all(teamIds.map((tid) => Promise.all([fetchTeamSplits(tid, season), fetchTeamHitters(tid, season)])))
  // Reconstructed team context from OUR OWN logs (venue form, Pythag, real rest,
  // tz travel) — walk-forward safe (strictly earlier dates), zero extra fetches.
  // Simulated 2026-07-07: none of these beat p_final/the lock rule yet (the
  // market prices them), so they are LOGGED + pre-registered in signalAudit and
  // shown as context — never weighted until a CI verdict says 'robusto'.
  const auxCtx = buildTeamContext(readAllGameRows())
  const lgAtt = leagueAttempts(priors.teams)
  const rows = []
  const analyses = games.map((g) => {
    const rh = recentByTeam.get(g.home_team_id) || [], ra = recentByTeam.get(g.away_team_id) || []
    const prediction = predict(g, formFromRecent(rh, g.game_date), formFromRecent(ra, g.game_date))
    const pitcherRecent = { home: _pr.get(g.home_probable_pitcher_id) || null, away: _pr.get(g.away_probable_pitcher_id) || null }
    const weather = wxByPk.get(g.game_pk) || null // revives the (previously null) weather factor
    const f5 = f5For(prediction)
    const a = analyzeGame({ game: g, prediction, f5, forms: { recentHome: rh, recentAway: ra }, priors, weather, injuries, pitcherRecent, lgAttempts: lgAtt })
    // Learning row (all games, not just the 3 selected plays); Y filled on grading.
    const f = prediction.features
    // Additive context blocks (aux = reconstructed; aux2 = fetched raw material).
    const aux = auxForGame(auxCtx, { date: g.game_date, home: g.home_team_abbr, away: g.away_team_abbr })
    const hSplit = _splits.get(g.home_team_id) || null, aSplit = _splits.get(g.away_team_id) || null
    const LG_OPS = 0.72
    const homeHand = g.home_sp_hand ?? _hand.get(g.home_probable_pitcher_id) ?? null
    const awayHand = g.away_sp_hand ?? _hand.get(g.away_probable_pitcher_id) ?? null
    const platoonOf = (split, oppHand) => (split && oppHand ? (oppHand === 'L' ? split.vsL : split.vsR) : null)
    const pH = platoonOf(hSplit, awayHand), pA = platoonOf(aSplit, homeHand)
    const aux2 = {
      day_night: g.day_night ?? null, series_game: g.series_game ?? null, series_len: g.series_len ?? null,
      home_sp_hand: homeHand, away_sp_hand: awayHand,
      platoon_h: pH != null ? Math.round((pH - LG_OPS) * 1000) / 1000 : null, // home bats vs away starter's hand, vs league
      platoon_a: pA != null ? Math.round((pA - LG_OPS) * 1000) / 1000 : null,
    }
    const brief = buildBrief(a, prediction, f5, priors, g, homeHand, awayHand, { home: _hitters.get(g.home_team_id) || [], away: _hitters.get(g.away_team_id) || [] })
    rows.push({ ...analysisToRow(a), date, game_date: g.game_date, game_datetime: g.game_datetime || null, park_factor: f.park_factor, elo_diff: f.elo_diff, sp_fip_diff: f.sp_fip_diff, weather_forecast: weather, wx_runs: a.total.components?.wx ?? 0, aux, aux2, brief, odds: null })
    return a
  })
  // Opening market line (ESPN, free) — additive, best-effort. Captured pre-game
  // so it's anti-leakage safe. FORMULA_VERSION is NOT bumped (odds is metadata).
  await attachOdds(rows, games, date, 'open')
  // Value (model vs de-vig consensus) + risk per game — additive, descriptive.
  // Then the v2 brain (needs the odds consensus, so it runs after attachOdds).
  const analysesV2 = analyses.map((a, i) => {
    const r = rows[i]
    r.value = valueEdge(r.adrian_p, r.odds)
    r.edge = r.value?.best_edge ?? null
    r.value_side = r.value?.best_side ?? null
    r.risk = riskScore({ odds: r.odds, adrian_p: r.adrian_p, pitcher_recent: r.pitcher_recent, news_delta: r.news_delta, ml_pick: r.ml_pick, home: r.home })
    return applyBrainV2(a, r)
  })
  const { plays } = selectPlays(analysesV2)
  const oddsByPk = new Map(rows.map((r) => [r.game_pk, r.odds]))
  const locks = selectLocks(analysesV2, oddsByPk)
  const gems = selectGems(rows)
  // Probable pitchers at compute time — the scratch validator compares later
  // runs against the pair frozen with the picks (a changed starter invalidates
  // the analysis a fijo was built on; we FLAG it, never silently swap picks).
  const pitcherMap = {}
  for (const g of games) pitcherMap[g.game_pk] = { h: g.home_probable_pitcher_id ?? null, a: g.away_probable_pitcher_id ?? null, hn: g.home_probable_pitcher_name ?? null, an: g.away_probable_pitcher_name ?? null }
  return {
    plays: plays.map((p) => ({ game_pk: p.game_pk, matchup: p.matchup, market: p.market, side: p.side || null, line: p.line ?? null, pick: p.pick || null, label: p.label, prob: p.prob, prob_v2: p.prob_v2 ?? null, confidence: p.confidence, engine: p.engine ?? 'classic' })),
    locks,
    gems,
    pitcherMap,
    rows,
  }
}

// Flag frozen picks whose game's PROBABLE STARTER changed since posting.
function validateFrozenPitchers(rec, pitcherMap) {
  const st = rec.pitchers || {}
  let changed = false
  for (const [pk, cur] of Object.entries(pitcherMap || {})) {
    const old = st[pk]
    if (!old) continue
    const notes = []
    if (old.h && cur.h && old.h !== cur.h) notes.push(`local: ${old.hn || old.h} → ${cur.hn || cur.h}`)
    if (old.a && cur.a && old.a !== cur.a) notes.push(`visita: ${old.an || old.a} → ${cur.an || cur.a}`)
    if (!notes.length) continue
    for (const list of [rec.plays, rec.locks, rec.gems]) {
      for (const p of list || []) {
        if (String(p.game_pk) !== String(pk) || p.result || p.scratch_warning) continue
        p.scratch_warning = true
        p.scratch_note = `Abridor cambió (${notes.join(' · ')}) — el análisis original ya no aplica`
        changed = true
      }
    }
  }
  return changed
}

// Attach ESPN market odds to rows in place (additive, best-effort). `stage`:
// 'open' (pre-game line) or 'final' (adds the win-prob curve). Merges over any
// previously-captured block, keeping earlier non-null fields.
async function attachOdds(rows, games, date, stage) {
  let m
  try { m = await buildOddsForDate(date, games) } catch { return false }
  if (!m || !m.size) return false
  let added = false
  for (const r of rows) {
    const o = m.get(r.game_pk)
    if (!o) continue
    const hadCurve = !!r.odds?.wp_curve, hadLine = r.odds?.ml_home != null
    const fresh = { ...Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)), stage, captured_at: new Date().toISOString() }
    r.odds = mergeOddsBlocks(r.odds, fresh) // preserves the opening price + derives line_move
    if ((!hadCurve && r.odds.wp_curve) || (!hadLine && r.odds.ml_home != null)) added = true
  }
  return added
}

// Capture game-time weather onto now-final games (best-effort, in place). MLB only
// populates gameData.weather near first pitch, so we grab it at GRADING time. It is
// stored as an ADDITIVE, DESCRIPTIVE fact (stage:'observed', like the win-prob curve)
// and is NEVER read by any prediction path (computeDay analyzes with weather:null and
// mlSample/totalSample don't use it) — logging it now just accrues data so a future
// study can CI-gate whether weather predicts totals (and only a FORECAST, not this
// observed value, could ever feed a pre-game pick). Any fetch failure is swallowed.
async function attachWeather(rows, byPk) {
  let added = false
  for (const r of rows) {
    if (r.weather || !r.graded) continue
    const g = byPk.get(r.game_pk)
    if (!isFinal(g)) continue
    try {
      const data = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${r.game_pk}/feed/live`).then((x) => x.json())
      const w = data?.gameData?.weather
      if (w && w.temp != null) {
        r.weather = { condition: w.condition || null, temp: Number(w.temp) || null, wind: w.wind || null, source: 'mlb', stage: 'observed', captured_at: new Date().toISOString() }
        added = true
      }
    } catch { /* best-effort — never break the daily run over weather */ }
  }
  return added
}

// Merge-write the per-game log for a date, preserving any Y already graded AND
// any previously-captured odds block (so the morning opening line survives the
// evening re-run).
function upsertGames(date, rows) {
  const fp = `${GAMES}/${date}.json`
  const prev = {}
  if (fs.existsSync(fp)) { try { for (const r of j(fp).games || []) prev[r.game_pk] = r } catch { /* rewrite */ } }
  const merged = rows.map((r) => {
    const p = prev[r.game_pk]
    // Merge the fresh capture over the stored block so the morning OPENING price
    // (p_home_open) and any win-prob curve survive the intraday/closing re-runs.
    const withOdds = { ...r, odds: mergeOddsBlocks(p?.odds, r.odds) }
    return p && p.graded ? { ...withOdds, home_win: p.home_win, total_runs: p.total_runs, ml_result: p.ml_result, total_result: p.total_result, final: p.final, graded: true } : withOdds
  })
  fs.writeFileSync(fp, JSON.stringify({ date, generated_at: new Date().toISOString(), schema: 'games_v1', formula_version: FORMULA_VERSION, games: merged }, null, 2))
}

// --- grade a past day against final scores (given a fetched schedule) --------
const isFinal = (g) => g && g.home_score != null && /Final|Game Over|Completed/.test(g.status || '')

function gradeList(list, byPk) {
  let done = true
  for (const play of list || []) {
    if (play.result) continue
    const g = byPk.get(play.game_pk)
    if (!isFinal(g)) { done = false; continue }
    const total = g.home_score + g.away_score
    if (play.market === 'ml') play.result = ((play.pick === g.home_team_abbr) === (g.home_score > g.away_score)) ? 'win' : 'loss'
    else if (play.market === 'total') play.result = total === play.line ? 'push' : (total > play.line) === (play.side === 'over') ? 'win' : 'loss'
    play.final = `${g.away_score}-${g.home_score}`
  }
  return done
}
function gradePicks(rec, byPk) {
  const playsDone = gradeList(rec.plays, byPk)
  const locksDone = gradeList(rec.locks, byPk) // fijos share the ml grading logic
  const gemsDone = gradeList(rec.gems, byPk)   // 💎 gemas too
  rec.graded = playsDone && locksDone && gemsDone
  return rec.graded
}

// Grade EVERY logged game (not just the 3 picks) for the learning dataset.
function gradeGames(rec, byPk) {
  let changed = false
  for (const row of rec.games) {
    if (row.graded) continue
    const g = byPk.get(row.game_pk)
    if (!isFinal(g)) continue
    const hs = g.home_score, as = g.away_score, tot = hs + as
    row.home_win = hs > as ? 1 : 0
    row.total_runs = tot
    row.final = `${as}-${hs}`
    row.ml_result = ((row.ml_pick === g.home_team_abbr) === (hs > as)) ? 'win' : 'loss'
    row.total_result = tot === row.line ? 'push' : (tot > row.line) === (row.side === 'over') ? 'win' : 'loss'
    row.graded = true
    changed = true
  }
  return changed
}

// Attach a compact LIVE summary from the watcher's snapshots onto now-graded rows
// (descriptive accrual for a future pre-registered steam study — never an input).
function attachLiveSummary(rows, liveStore) {
  let changed = false
  for (const r of rows) {
    if (!r.graded || r.live || (r.home_win !== 0 && r.home_win !== 1)) continue
    const g = liveStore?.games?.[String(r.game_pk)]
    const snaps = (g?.snapshots || []).filter((s) => s.cons != null)
    if (snaps.length < 2) continue
    const wps = (g.snapshots || []).map((s) => (r.home_win === 1 ? s.wp : s.wp == null ? null : 1 - s.wp)).filter((v) => v != null)
    r.live = {
      n: g.snapshots.length,
      steam: Math.round((snaps[snaps.length - 1].cons - snaps[0].cons) * 1e4) / 1e4,
      min_wp_winner: wps.length ? Math.round(Math.min(...wps) * 1e4) / 1e4 : null,
    }
    changed = true
  }
  return changed
}

// --- learning snapshot ------------------------------------------------------
function readAllGameRows() {
  const files = fs.existsSync(GAMES) ? fs.readdirSync(GAMES).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : []
  const rows = []
  for (const f of files) { try { for (const r of j(`${GAMES}/${f}`).games || []) rows.push(r) } catch { /* skip */ } }
  return rows
}
function buildLearning(rows) {
  const snap = buildSnapshot(rows, { now: new Date().toISOString() })
  fs.writeFileSync(`${HIST}/learning.json`, JSON.stringify(snap, null, 2))
  return snap
}

// --- main -------------------------------------------------------------------
// MLB's officialDate is Eastern — so is the robot's "today". Running on the UTC
// date would make the late-night crons (03:00/06:30 UTC = 11pm/2:30am ET) roll
// over to TOMORROW and freeze half-baked picks; ET keeps every run on the right
// slate. Before 8am ET a run is grading/odds-capture only (never posts plays).
const ET = 'America/New_York'
function etNow() {
  const d = new Date()
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: ET }).format(d) // YYYY-MM-DD
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', hour12: false }).format(d)) % 24
  return { date, hour }
}
async function main() {
  fs.mkdirSync(GAMES, { recursive: true })
  const et = etNow()
  const today = process.argv[2] || et.date
  const posting = !!process.argv[2] || et.hour >= 8 // manual runs always post

  const existingToday = fs.existsSync(`${HIST}/${today}.json`) ? j(`${HIST}/${today}.json`) : null
  const day = await computeDay(today)
  if (day) {
    if (posting || existingToday) {
      // Freeze the FIRST-generated plays + fijos of the day (a posted "fijo" must not
      // silently change on an intraday re-run); the per-game logs still refresh live
      // with the latest odds/consensus/line movement below via upsertGames.
      // `?? day.locks`: a pre-upgrade day file has plays but no locks field — backfill
      // the fijos once from the fresh compute, then they freeze like everything else.
      const frozen = existingToday && existingToday.plays?.length
      const plays = frozen ? existingToday.plays : day.plays
      const locks = frozen ? (existingToday.locks ?? day.locks) : day.locks
      const gems = frozen ? (existingToday.gems ?? day.gems) : day.gems
      const pitchers = frozen ? (existingToday.pitchers ?? day.pitcherMap) : day.pitcherMap
      const generated_at = frozen ? existingToday.generated_at : new Date().toISOString()
      const rec = { date: today, generated_at, graded: false, plays, locks, gems, pitchers }
      if (frozen) validateFrozenPitchers(rec, day.pitcherMap) // scratch flags on later runs
      fs.writeFileSync(`${HIST}/${today}.json`, JSON.stringify(rec, null, 2))
    }
    // Always log the games (pre-8am ET this captures the EARLIEST opening line).
    upsertGames(today, day.rows)
  }

  // Grade past days (picks + full game logs) over a wide window, one fetch/date.
  const dateOf = (f) => f.replace('.json', '')
  const pickFiles = fs.existsSync(HIST) ? fs.readdirSync(HIST).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)) : []
  const gameFiles = fs.existsSync(GAMES) ? fs.readdirSync(GAMES).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)) : []
  const dates = [...new Set([...pickFiles, ...gameFiles].map(dateOf))].sort().slice(-45)
  for (const date of dates) {
    if (date === today) continue
    const pickRec = fs.existsSync(`${HIST}/${date}.json`) ? j(`${HIST}/${date}.json`) : null
    const gamesRec = fs.existsSync(`${GAMES}/${date}.json`) ? j(`${GAMES}/${date}.json`) : null
    const needPick = pickRec && !pickRec.graded
    const needGames = gamesRec && gamesRec.games.some((r) => !r.graded)
    if (!needPick && !needGames) continue
    const byPk = new Map((await fetchSchedule(date)).map((g) => [g.game_pk, g]))
    if (needPick) { gradePicks(pickRec, byPk); fs.writeFileSync(`${HIST}/${date}.json`, JSON.stringify(pickRec, null, 2)) }
    if (needGames) {
      const changed = gradeGames(gamesRec, byPk)
      // Closing line + win-prob curve for now-final games (win-prob is a fixed
      // historical fact → used only for PAST-game studies, never today's pick).
      const oddsAdded = await attachOdds(gamesRec.games, [...byPk.values()], date, 'final')
      const wxAdded = await attachWeather(gamesRec.games, byPk)
      // In-game watcher summary (steam / comeback depth) for the graded rows.
      let liveAdded = false
      const liveFp = `${HIST}/live/${date}.json`
      if (fs.existsSync(liveFp)) { try { liveAdded = attachLiveSummary(gamesRec.games, j(liveFp)) } catch { /* best-effort */ } }
      if (changed || oddsAdded || wxAdded || liveAdded) fs.writeFileSync(`${GAMES}/${date}.json`, JSON.stringify(gamesRec, null, 2))
    }
  }

  // Rebuild the classic picks index with a running record.
  const idxFiles = pickFiles.sort()
  const idx = []
  let w = 0, l = 0, ps = 0, lw = 0, ll = 0, lps = 0, gw = 0, gloss = 0, units = 0
  const tierRec = { oro: { wins: 0, losses: 0 }, plata: { wins: 0, losses: 0 } }
  for (const f of idxFiles) {
    const rec = j(`${HIST}/${f}`)
    const g = rec.plays.filter((p) => p.result)
    for (const p of g) { if (p.result === 'win') w++; else if (p.result === 'loss') l++; else ps++ }
    const gl = (rec.locks || []).filter((p) => p.result)
    for (const p of gl) {
      if (p.result === 'win') lw++; else if (p.result === 'loss') ll++; else lps++
      const t = p.tier === 'plata' ? tierRec.plata : tierRec.oro // pre-tier locks count as oro
      if (p.result === 'win') t.wins++; else if (p.result === 'loss') t.losses++
      // Public units ledger: flat 1u per fijo at the captured price (-110 when
      // the price wasn't stored — pre-ledger locks only).
      if (p.result === 'win' || p.result === 'loss') {
        const ml = p.price ?? -110
        units += p.result === 'win' ? (ml > 0 ? ml / 100 : 100 / Math.abs(ml)) : -1
      }
    }
    for (const p of (rec.gems || []).filter((x) => x.result)) { if (p.result === 'win') gw++; else if (p.result === 'loss') gloss++ }
    const gg = (rec.gems || []).filter((p) => p.result)
    idx.push({
      date: rec.date, n: rec.plays.length, graded: !!rec.graded,
      wins: g.filter((p) => p.result === 'win').length, losses: g.filter((p) => p.result === 'loss').length,
      locks_n: (rec.locks || []).length, locks_wins: gl.filter((p) => p.result === 'win').length, locks_losses: gl.filter((p) => p.result === 'loss').length,
      gems_n: (rec.gems || []).length, gems_wins: gg.filter((p) => p.result === 'win').length, gems_losses: gg.filter((p) => p.result === 'loss').length,
    })
  }
  const rate = (a, b) => (a + b ? Math.round(a / (a + b) * 1000) / 1000 : null)
  fs.writeFileSync(`${HIST}/index.json`, JSON.stringify({
    updated_at: new Date().toISOString(),
    record: { wins: w, losses: l, pushes: ps, win_rate: rate(w, l) },
    locks_record: {
      wins: lw, losses: ll, pushes: lps, win_rate: rate(lw, ll),
      units: Math.round(units * 100) / 100, // 1u plana por fijo, al precio capturado
      oro: { ...tierRec.oro, win_rate: rate(tierRec.oro.wins, tierRec.oro.losses) },
      plata: { ...tierRec.plata, win_rate: rate(tierRec.plata.wins, tierRec.plata.losses) },
    },
    gems_record: { wins: gw, losses: gloss, win_rate: rate(gw, gloss) },
    days: idx.reverse(),
  }, null, 2))

  // One-time: historical seasons (2023-25) + multi-season context study — 10×
  // the statistical power for the pre-registered signals. Skipped once done.
  const SEASONS = `${HIST}/seasons`
  const seasonsMissing = [2023, 2024, 2025].some((y) => !fs.existsSync(`${SEASONS}/${y}.json`))
  if (seasonsMissing) {
    try {
      const sum = await backfillSeasons(SEASONS)
      const study = buildHistoryStudy(SEASONS, `${HIST}/history_study.json`)
      console.log(`backfill histórico: ${sum.join(' | ')}${study ? ` | estudio pooled: ${Object.entries(study.pooled).map(([k, v]) => `${k}:${v.verdict}`).join(', ')}` : ''}`)
    } catch (e) { console.error('backfill histórico falló (no fatal):', e.message) }
  }

  // Live Elo: apply newly-graded finals so ratings never go stale (idempotent).
  const allRows = readAllGameRows()
  const eloState = loadEloState(`${DATA}/elo_state.json`, today)
  const eloApplied = applyEloUpdates(priors.elo, eloState, allRows, { today })
  if (eloApplied > 0) fs.writeFileSync(`${DATA}/elo.json`, JSON.stringify(priors.elo))
  fs.writeFileSync(`${DATA}/elo_state.json`, JSON.stringify(eloState))

  // Rebuild the Adrian Learning snapshot from all graded game logs.
  const snap = buildLearning(allRows)
  console.log(`adrian_daily: ${today} -> ${day ? day.plays.length : 0} plays; record ${w}-${l} (${ps} push); elo+${eloApplied}; learning n=${snap.n_graded}/${snap.n_total}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
