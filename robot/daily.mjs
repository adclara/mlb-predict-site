// Daily Adrian robot (Node, runs in GitHub Actions). Computes the day's plays
// with the SAME formula as the app (imports the pure adrian.js/engine.js) over
// live MLB data, saves them to history, and grades past days against final
// scores — building a real track record with no server and no secrets.
//
// Layout when deployed into the site repo's robot/ dir:
//   robot/daily.mjs (this) + adrian.js + engine.js + venues.js
//   ../data/*.json (priors) and ../data/history/ (output)
import fs from 'fs'
import { createHash } from 'crypto'
import { pathToFileURL } from 'url'
import { analyzeGame, leagueAttempts, selectLocks, selectPlays } from './adrian.js'
import { eloProb, expectedRuns, simulateF5, simulateGame } from './engine.js'
import { analysisToRow, aprendeOpinion, authorizedMarketAnchor, buildSnapshot, FORMULA_VERSION, marketBlend } from './learn.js'
import { buildMarketLab, gradeMarketLab } from './market_lab.mjs'
import { devigMoneyline, mergeOddsBlocks, riskScore, valueEdge } from './odds.js'
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
const FEATURE_SCHEMA_VERSION = 'mlb_features_v1_immutable'
const FEATURE_GENERATOR_VERSION = 'daily_integrity_v1'
const SELECTION_POLICY_VERSION = 'public_ledger_v1'
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const get = (u) => fetch(u).then((r) => r.json())
const isoMinus = (iso, d) => { const x = new Date(iso + 'T00:00:00'); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10) }
const ipToFloat = (ip) => { const s = parseFloat(ip); if (!isFinite(s)) return 0; const w = Math.trunc(s); return w + Math.round((s - w) * 10) * 10 / 30 }

const VOID_STATUS_RE = /Postponed|Cancelled|Canceled/i
const LIVE_STATUS_RE = /In Progress|Live/i
const FINAL_STATUS_RE = /Final|Game Over|Completed/i
const validIso = (v) => typeof v === 'string' && Number.isFinite(new Date(v).getTime())
const beforeFirstPitch = (asOf, firstPitch) => validIso(asOf) && validIso(firstPitch) && new Date(asOf) < new Date(firstPitch)
const stableValue = (v) => {
  if (Array.isArray(v)) return v.map(stableValue)
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stableValue(v[k])]))
}
const sha256 = (v) => createHash('sha256').update(JSON.stringify(stableValue(v))).digest('hex')

// Only outcome/post-game facts may change after a feature row is frozen.
const FEATURE_MUTABLE_KEYS = new Set([
  'feature_hash', 'observed', 'graded', 'home_win', 'total_runs',
  'f5_home_score', 'f5_away_score', 'final', 'ml_result', 'total_result',
  'f5_complete', 'f5_result', 'f5_total_runs', 'outcome_status',
  'weather', 'live', 'invalid_reason', 'provisional_hash',
  'integrity', 'learning_eligible', 'feature_scope',
])
function featurePayload(row) {
  return Object.fromEntries(Object.entries(row || {}).filter(([k]) => !FEATURE_MUTABLE_KEYS.has(k)))
}

export function capturePhaseFor(game, capturedAt) {
  const status = game?.status || ''
  const isFinal = FINAL_STATUS_RE.test(status)
  const isLive = LIVE_STATUS_RE.test(status)
  const isVoid = VOID_STATUS_RE.test(status)
  const pregame = !isFinal && !isLive && !isVoid
    && beforeFirstPitch(capturedAt, game?.game_datetime)
  return { capture_phase: pregame ? 'pregame' : isFinal ? 'postgame' : isVoid ? 'void' : 'live', is_pregame: pregame }
}

export function freezeFeatureRow(row, asOf, { eligible = true } = {}) {
  const firstPitch = row?.first_pitch ?? row?.game_datetime ?? null
  const causal = eligible && beforeFirstPitch(asOf, firstPitch) && !VOID_STATUS_RE.test(row?.status || '')
  const out = {
    ...row,
    feature_as_of: asOf,
    first_pitch: firstPitch,
    decision_captured_at: causal ? asOf : null,
    capture_phase: causal ? 'pregame' : 'post_start',
    learning_eligible: causal,
    feature_scope: causal ? 'pregame_immutable' : 'shadow_post_start',
    observed: mergeObserved(null, row, asOf),
    integrity: {
      ledger_version: 'v2',
      cohort: causal ? 'native_pregame_immutable' : 'native_post_start',
      training_eligible: causal,
      reason: causal ? 'feature_snapshot_before_first_pitch' : 'first_capture_not_before_first_pitch',
      first_pitch: firstPitch,
      official_date: row?.game_date ?? row?.date ?? null,
    },
    versions: {
      formula: FORMULA_VERSION,
      feature_schema: FEATURE_SCHEMA_VERSION,
      feature_generator: FEATURE_GENERATOR_VERSION,
      selection_policy: SELECTION_POLICY_VERSION,
    },
  }
  out.feature_hash = sha256(featurePayload(out))
  return out
}

function observedFrom(row, asOf) {
  return {
    ...(row?.observed || {}),
    captured_at: asOf,
    status: row?.status ?? null,
    first_pitch: row?.game_datetime ?? row?.first_pitch ?? null,
    scores: {
      home: row?.observed?.scores?.home ?? row?.home_score ?? null,
      away: row?.observed?.scores?.away ?? row?.away_score ?? null,
    },
    odds: row?.observed?.odds ?? row?.odds ?? null,
    weather_forecast: row?.weather_forecast ?? null,
    pitchers: row?.brief?.pitchers ?? null,
    lineups: row?.brief?.lineups ?? null,
  }
}

function mergeObserved(previous, row, asOf) {
  const incoming = observedFrom(row, asOf), old = previous || {}
  return {
    ...old, ...incoming,
    scores: {
      home: incoming.scores?.home ?? old.scores?.home ?? null,
      away: incoming.scores?.away ?? old.scores?.away ?? null,
    },
    odds: incoming.odds ?? old.odds ?? null,
  }
}

export function mergeGameRows(previousRows, freshRows, { asOf, freezeFeatures = false } = {}) {
  const prev = new Map((previousRows || []).filter((r) => r?.game_pk != null).map((r) => [String(r.game_pk), r]))
  const out = []
  const seen = new Set()
  for (const fresh of freshRows || []) {
    if (fresh?.game_pk == null || seen.has(String(fresh.game_pk))) continue
    const key = String(fresh.game_pk); seen.add(key)
    const old = prev.get(key)
    if (old?.feature_hash) {
      out.push({ ...old, observed: mergeObserved(old.observed, fresh, asOf) })
      continue
    }
    // Before publication a provisional row may refresh. At the publication
    // cutoff it becomes immutable; a first capture after the start is retained
    // only as a non-learnable shadow fact.
    const firstPitch = fresh.first_pitch ?? fresh.game_datetime ?? old?.first_pitch ?? old?.game_datetime ?? null
    const pregame = beforeFirstPitch(asOf, firstPitch) && !VOID_STATUS_RE.test(fresh.status || '')
    if (freezeFeatures || !pregame) {
      const openingOdds = mergeOddsBlocks(old?.odds, fresh.odds)
      const frozen = freezeFeatureRow({ ...fresh, odds: openingOdds, first_pitch: firstPitch }, asOf, { eligible: pregame })
      if (old && !pregame) {
        // Never replace a migrated/as-of row with a later recomputation. Seal
        // the existing bytes, preserve its migration verdict, and append only
        // observations. Unknown legacy timing remains excluded.
        const migratedEligible = old.integrity?.training_eligible === true
        const legacy = {
          ...old,
          first_pitch: old.first_pitch ?? firstPitch,
          feature_as_of: old.feature_as_of ?? old.decision_captured_at ?? null,
          learning_eligible: migratedEligible,
          feature_scope: migratedEligible ? 'backfill_asof' : 'legacy_unverifiable',
          integrity: old.integrity || {
            ledger_version: 'v2', cohort: 'legacy_native_mutable', training_eligible: false,
            reason: 'pregame_capture_time_unverifiable', first_pitch, official_date: old.game_date ?? old.date ?? null,
          },
          versions: old.versions || {
            formula: old.formula_version ?? FORMULA_VERSION,
            feature_schema: FEATURE_SCHEMA_VERSION,
            feature_generator: 'legacy_sealed',
            selection_policy: SELECTION_POLICY_VERSION,
          },
          observed: mergeObserved(old.observed, fresh, asOf),
        }
        legacy.feature_hash = sha256(featurePayload(legacy))
        out.push(legacy)
      } else out.push(frozen)
    } else {
      out.push({ ...fresh, odds: mergeOddsBlocks(old?.odds, fresh.odds), feature_as_of: asOf,
        first_pitch: firstPitch, learning_eligible: false, feature_scope: 'provisional_pregame',
        observed: mergeObserved(old?.observed, fresh, asOf),
        provisional_hash: sha256(featurePayload(fresh)) })
    }
  }
  // Preserve rows no longer returned by the schedule; never silently delete a
  // historical event merely because an upstream response is partial.
  for (const [key, row] of prev) if (!seen.has(key)) out.push(row)
  return out
}

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
export function parseGame(g) {
  const t = g.teams || {}, home = t.home || {}, away = t.away || {}, hp = home.probablePitcher || {}, ap = away.probablePitcher || {}
  const first5ByNum = new Map((g.linescore?.innings || [])
    .filter((inn) => Number.isInteger(Number(inn.num)) && Number(inn.num) >= 1 && Number(inn.num) <= 5)
    .map((inn) => [Number(inn.num), inn]))
  const first5 = [1, 2, 3, 4, 5].map((n) => first5ByNum.get(n))
  // `Number(null) === 0`; require an explicit run value for BOTH clubs in every
  // inning so a suspended/incomplete game can never be graded as an F5 zero.
  const f5Known = first5.every((inn) => inn && inn.home?.runs != null && inn.away?.runs != null
    && Number.isFinite(Number(inn.home.runs)) && Number.isFinite(Number(inn.away.runs)))
  const f5Home = f5Known ? first5.reduce((s, inn) => s + Number(inn.home.runs), 0) : null
  const f5Away = f5Known ? first5.reduce((s, inn) => s + Number(inn.away.runs), 0) : null
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
    f5_home_score: f5Home, f5_away_score: f5Away,
    // orden al bate {id,name} — solo cuando MLB publica el lineup (~2-3h antes); si no, []
    home_lineup: ((g.lineups || {}).homePlayers || []).map((p) => ({ id: p.id, name: p.fullName || null })),
    away_lineup: ((g.lineups || {}).awayPlayers || []).map((p) => ({ id: p.id, name: p.fullName || null })),
  }
}
async function fetchSchedule(date) {
  const data = await get(`${API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,linescore,venue,lineups`)
  const games = new Map()
  for (const d of data.dates || []) for (const g of d.games || []) {
    if ((g.gameType || 'R') !== 'R' || g.gamePk == null) continue
    games.set(String(g.gamePk), parseGame(g))
  }
  return [...games.values()]
}
async function fetchAllRecent(beforeDate, days = 25) {
  const start = isoMinus(beforeDate, days)
  const data = await get(`${API}/schedule?sportId=1&startDate=${start}&endDate=${beforeDate}&gameType=R&hydrate=team,linescore`)
  const byTeam = new Map()
  const seen = new Set()
  for (const d of data.dates || []) { if (d.date >= beforeDate) continue; for (const g of d.games || []) {
    if ((g.status || {}).abstractGameState !== 'Final') continue
    if (g.gamePk == null || seen.has(String(g.gamePk))) continue
    seen.add(String(g.gamePk))
    const t = g.teams || {}, hs = t.home?.score, as = t.away?.score
    if (hs == null || as == null) continue
    const heRaw = g.linescore?.teams?.home?.errors, aeRaw = g.linescore?.teams?.away?.errors
    const he = heRaw == null || !Number.isFinite(Number(heRaw)) ? null : Number(heRaw)
    const ae = aeRaw == null || !Number.isFinite(Number(aeRaw)) ? null : Number(aeRaw)
    for (const [id, opp, rf, ra, e] of [
      [t.home?.team?.id, t.away?.team?.id, hs, as, he],
      [t.away?.team?.id, t.home?.team?.id, as, hs, ae],
    ]) {
      if (id == null) continue; if (!byTeam.has(id)) byTeam.set(id, []); byTeam.get(id).push({ date: d.date, rf, ra, won: rf > ra ? 1 : 0, opp: opp ?? null, e })
    }
  } }
  for (const rows of byTeam.values()) rows.sort((a, b) => (a.date < b.date ? 1 : -1))
  return byTeam
}

const jsonObject = (value) => {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}
const ingestSlots = (raw) => {
  if (Array.isArray(raw)) return raw
  for (const key of ['slots', 'results', 'rows', 'data']) if (Array.isArray(raw?.[key])) return raw[key]
  // Consumer contract used by Actions: one already-compacted pregame record
  // per game, with an independently measured earliest market and latest facts.
  if (raw?.games && !Array.isArray(raw.games) && typeof raw.games === 'object') {
    const slots = []
    for (const [gamePk, value] of Object.entries(raw.games)) {
      const firstPitch = value?.first_pitch ?? null
      const opening = value?.opening_market
      if (opening?.captured_at_open) slots.push({
        captured_at: opening.captured_at_open,
        games: [{ mlb_id: gamePk, start: firstPitch, status: 'pre', home: {}, away: {}, market: {
          provider: opening.provider, home_ml: opening.home_ml, away_ml: opening.away_ml,
          total: opening.total, over_price: opening.over_price, under_price: opening.under_price,
          spread: opening.spread, source_hash: opening.source_hash,
        } }],
      })
      const latest = value?.latest_pregame
      if (latest?.captured_at) slots.push({
        captured_at: latest.captured_at,
        games: [{ mlb_id: gamePk, start: firstPitch, status: latest.stage === 'pregame' || latest.stage === 'early' ? 'pre' : latest.stage,
          home: latest.home || {}, away: latest.away || {}, source_hash: latest.source_hash }],
      })
    }
    return slots
  }
  return raw && typeof raw === 'object' ? [raw] : []
}
const normalizedLineup = (side) => (Array.isArray(side?.lineup) ? side.lineup : [])
  .map((p) => typeof p === 'object' ? { id: Number(p.id), name: p.name || null } : { id: Number(p), name: null })
  .filter((p) => Number.isFinite(p.id)).slice(0, 9)

// Convert the optional D1 consumer export into per-game PRE-GAME facts. A slot
// is admissible only when its measured capture precedes that individual game's
// first pitch and both public feeds still describe it as pre-game. Pitcher and
// lineup facts use the latest admissible slot; the market opening uses the
// earliest measured price. No prediction weights cross this boundary.
export function ingestPregameFacts(raw) {
  const facts = new Map()
  const slots = ingestSlots(raw).map((slot) => {
    const payload = jsonObject(slot?.payload) || slot
    return { slot, payload, captured_at: payload?.captured_at || slot?.captured_at || payload?.scheduled_at || slot?.scheduled_at || null }
  }).filter((x) => validIso(x.captured_at)).sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at))
  for (const { slot, payload, captured_at } of slots) for (const game of Array.isArray(payload?.games) ? payload.games : []) {
    const rawPk = game?.mlb_id ?? game?.game_pk ?? game?.gamePk ?? game?.id
    const pk = Number(rawPk)
    const firstPitch = game?.start ?? game?.game_datetime ?? game?.first_pitch ?? null
    const statuses = [game?.status, game?.espn_status].filter(Boolean).map((v) => String(v).toLowerCase())
    if (!Number.isFinite(pk) || !beforeFirstPitch(captured_at, firstPitch)
      || statuses.some((v) => v !== 'pre' && !/scheduled|preview|warmup/.test(v))) continue
    const home = game?.home || {}, away = game?.away || {}
    const current = facts.get(String(pk)) || {
      game_pk: pk, first_pitch: firstPitch, feature_captured_at: null,
      pitchers: { home: null, away: null }, lineups: { home: [], away: [] }, odds: null,
    }
    current.first_pitch = current.first_pitch || firstPitch
    current.feature_captured_at = captured_at
    current.feature_source_hash = game?.source_hash ?? current.feature_source_hash ?? null
    if (home.pitcher_id != null || home.pitcher) current.pitchers.home = { id: home.pitcher_id ?? null, name: home.pitcher || null }
    if (away.pitcher_id != null || away.pitcher) current.pitchers.away = { id: away.pitcher_id ?? null, name: away.pitcher || null }
    const homeLineup = normalizedLineup(home), awayLineup = normalizedLineup(away)
    if (homeLineup.length) current.lineups.home = homeLineup
    if (awayLineup.length) current.lineups.away = awayLineup
    const market = game?.market || game?.odds || null
    const mlHome = market?.home_ml ?? market?.ml_home ?? null
    const mlAway = market?.away_ml ?? market?.ml_away ?? null
    const total = market?.total ?? market?.over_under ?? null
    if (!current.odds && (mlHome != null || mlAway != null || total != null)) {
      const [pHome, pAway] = devigMoneyline(mlHome, mlAway)
      current.odds = mergeOddsBlocks(null, {
        provider: market?.provider ?? null,
        ml_home: mlHome, ml_away: mlAway, over_under: total,
        over_price: market?.over_price ?? null, under_price: market?.under_price ?? null,
        spread: market?.spread ?? null, p_home_mkt: pHome, p_away_mkt: pAway,
        consensus: pHome == null ? null : { p_home: pHome, p_away: pAway, n_books: 1 },
        stage: 'pregame', capture_phase: 'pregame', is_pregame: true,
        captured_at, source: 'mlb_ingest_v1', ingest_slot_id: payload?.slot_id ?? slot?.slot_id ?? null,
        source_hash: market?.source_hash ?? game?.source_hash ?? null,
      })
    }
    facts.set(String(pk), current)
  }
  return facts
}

export function enrichGamesFromIngest(games, raw) {
  const facts = ingestPregameFacts(raw)
  const acceptedFacts = new Map()
  const enriched = (games || []).map((game) => {
    const fact = facts.get(String(game?.game_pk))
    if (!fact || !beforeFirstPitch(fact.feature_captured_at, game?.game_datetime)) return game
    acceptedFacts.set(String(game.game_pk), fact)
    const out = { ...game }
    const hp = fact.pitchers.home, ap = fact.pitchers.away
    if (out.home_probable_pitcher_id == null && hp?.id != null) out.home_probable_pitcher_id = hp.id
    if (!out.home_probable_pitcher_name && hp?.name) out.home_probable_pitcher_name = hp.name
    if (out.away_probable_pitcher_id == null && ap?.id != null) out.away_probable_pitcher_id = ap.id
    if (!out.away_probable_pitcher_name && ap?.name) out.away_probable_pitcher_name = ap.name
    if (!out.home_lineup?.length && fact.lineups.home.length) out.home_lineup = fact.lineups.home
    if (!out.away_lineup?.length && fact.lineups.away.length) out.away_lineup = fact.lineups.away
    return out
  })
  return { games: enriched, facts: acceptedFacts }
}

function readIngestSnapshot() {
  const file = process.env.AA_INGEST_SNAPSHOT
  if (!file) return null
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error('snapshot ausente o demasiado grande')
    return j(file)
  } catch (error) {
    console.error(`AA_INGEST_SNAPSHOT omitido (no fatal): ${error.message}`)
    return null
  }
}
const fieldingFor = (rows) => {
  const errs = rows.slice(0, 10).map((r) => r.e).filter(Number.isFinite)
  const err_l10 = errs.length ? errs.reduce((sum, e) => sum + e, 0) : null
  return { err_l10, epg: errs.length ? Math.round(err_l10 / errs.length * 100) / 100 : null, g: errs.length }
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
    // K/9 = ponches por 9 entradas — el dato base para props de ponches (descriptivo).
    _freshFip.set(id, { fip: Math.round(((13 * hr + 3 * (bb + hbp) - 2 * k) / ip + 3.1) * 100) / 100, ip, k9: Math.round((k / ip * 9) * 10) / 10 })
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
      home: { name: g.home_probable_pitcher_name || null, fip: rr(f.home_sp_fip), hand: homeHand, era: pr.home?.recent?.era ?? null, n: pr.home?.recent?.n ?? null, fatigue: pr.home?.fatigue?.level ?? null, k9: _freshFip.get(g.home_probable_pitcher_id)?.k9 ?? null },
      away: { name: g.away_probable_pitcher_name || null, fip: rr(f.away_sp_fip), hand: awayHand, era: pr.away?.recent?.era ?? null, n: pr.away?.recent?.n ?? null, fatigue: pr.away?.fatigue?.level ?? null, k9: _freshFip.get(g.away_probable_pitcher_id)?.k9 ?? null },
    },
    bullpen: { home_fip: rr(f.home_pen_fip), away_fip: rr(f.away_pen_fip) },
    offense: {
      home: { ops: hOff.ops ?? null, runs: hOff.runs_pg ?? null },
      away: { ops: aOff.ops ?? null, runs: aOff.runs_pg ?? null },
    },
    hitters: { home: hitters?.home || [], away: hitters?.away || [] },
    f5: f5?.f5_moneyline ? {
      home_lead: round3d(f5.f5_moneyline.home_lead), away_lead: round3d(f5.f5_moneyline.away_lead),
      nrfi: f5.nrfi != null ? round3d(f5.nrfi) : null,
      total_line: f5.f5_total?.line ?? null, over: f5.f5_total?.over != null ? round3d(f5.f5_total.over) : null,
      expected_home: f5.expected_f5_runs?.home != null ? round2d(f5.expected_f5_runs.home) : null,
      expected_away: f5.expected_f5_runs?.away != null ? round2d(f5.expected_f5_runs.away) : null,
    } : null,
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
// aprendeOpinion applies the learned ensemble using only the prior snapshot.
// A market anchor is an unproven challenger until the exact public chain has
// enough forward rows with an auditable opening capture and passes its CI gate.
// Legacy latest-price alpha has unknown timing and can never alter p_final.
// adrian_p is stored untouched so games_v1 keeps a stable formula version.
const round2d = (x) => Math.round(x * 100) / 100
const round3d = (x) => Math.round(x * 1000) / 1000
// Selection rules and every challenger remain subject to their own measured
// forward gate. p_final is displayed only from the learned chain authorized by
// the snapshot; an unpassed market blend is never smuggled into publication.
function applyBrainV2(a, r) {
  const op = aprendeOpinion(a, prevSnap)
  const anchor = authorizedMarketAnchor(prevSnap, r)
  let pF = op?.ml?.p_comb ?? null
  if (anchor) pF = marketBlend(pF ?? r.adrian_p, anchor.market, anchor.alpha)
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

// --- 💎 Gemas: high-probability candidates from the learned chain -----------
// A gem is a candidate whose authorized p_final gives one side >=65%. This is a
// probability tier, not a profitability claim; its public record is measured
// separately and every unpassed challenger remains in shadow.
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
  const scheduled = await fetchSchedule(date)
  const ingest = enrichGamesFromIngest(scheduled, readIngestSnapshot())
  // A postponed/cancelled listing is retained for grading/audit by
  // fetchSchedule(), but it must never become a fresh decision candidate.
  const games = ingest.games.filter((g) => !VOID_STATUS_RE.test(g.status || ''))
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
  const auxCtx = buildTeamContext(readAllGameRows({ purpose: 'context' }))
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
    const priorInSeries = Number(g.series_game) - 1
    // The prior games must also be the team's immediately preceding
    // appearances. Filtering all 25 days by opponent could silently borrow a
    // game from an older series when one current game was postponed/missing.
    const seriesRows = Number.isInteger(priorInSeries) && priorInSeries >= 1
      ? rh.slice(0, priorInSeries) : []
    const seriesKnown = priorInSeries >= 1 && seriesRows.length === priorInSeries
      && seriesRows.every((r) => r.opp === g.away_team_id && (r.won === 0 || r.won === 1))
    const seriesHomeWins = seriesKnown ? seriesRows.reduce((sum, r) => sum + r.won, 0) : null
    const aux2 = {
      day_night: g.day_night ?? null, series_game: g.series_game ?? null, series_len: g.series_len ?? null,
      series_home_wins: seriesHomeWins, series_away_wins: seriesKnown ? priorInSeries - seriesHomeWins : null,
      home_sp_hand: homeHand, away_sp_hand: awayHand,
      platoon_h: pH != null ? Math.round((pH - LG_OPS) * 1000) / 1000 : null, // home bats vs away starter's hand, vs league
      platoon_a: pA != null ? Math.round((pA - LG_OPS) * 1000) / 1000 : null,
    }
    const brief = buildBrief(a, prediction, f5, priors, g, homeHand, awayHand, { home: _hitters.get(g.home_team_id) || [], away: _hitters.get(g.away_team_id) || [] })
    brief.fielding = { home: fieldingFor(rh), away: fieldingFor(ra) }
    rows.push({ ...analysisToRow(a), date, game_date: g.game_date, game_datetime: g.game_datetime || null,
      first_pitch: g.game_datetime || null, park_factor: f.park_factor, elo_diff: f.elo_diff,
      sp_fip_diff: f.sp_fip_diff, weather_forecast: weather, wx_runs: a.total.components?.wx ?? 0,
      aux, aux2, brief, odds: ingest.facts.get(String(g.game_pk))?.odds || null,
      observed: { status: g.status ?? null, scores: { home: g.home_score ?? null, away: g.away_score ?? null } } })
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
  // Nuevos mercados pedidos (Over/F5/abridor) se registran y gradúan en SOMBRA.
  // buildMarketLab usa la línea O/U real capturada; no sale al normalizador/API.
  const marketLab = buildMarketLab(rows)
  // Probable pitchers at compute time — the scratch validator compares later
  // runs against the pair frozen with the picks (a changed starter invalidates
  // the analysis a fijo was built on; we FLAG it, never silently swap picks).
  const pitcherMap = {}
  for (const g of games) pitcherMap[g.game_pk] = { h: g.home_probable_pitcher_id ?? null, a: g.away_probable_pitcher_id ?? null, hn: g.home_probable_pitcher_name ?? null, an: g.away_probable_pitcher_name ?? null }
  return {
    plays: plays.map((p) => ({ game_pk: p.game_pk, matchup: p.matchup, market: p.market, side: p.side || null, line: p.line ?? null, pick: p.pick || null, label: p.label, prob: p.prob, prob_v2: p.prob_v2 ?? null, confidence: p.confidence, engine: p.engine ?? 'classic' })),
    locks,
    gems,
    marketLab,
    pitcherMap,
    rows,
  }
}

const startTimesFor = (rows) => new Map((rows || [])
  .filter((row) => row?.game_pk != null)
  .map((row) => [String(row.game_pk), row.first_pitch ?? row.game_datetime ?? null]))

export function annotateLedgerCandidate(play, postedAt, startByPk) {
  const scheduledStart = play?.scheduled_start_utc
    ?? startByPk?.get?.(String(play?.game_pk)) ?? null
  const causal = beforeFirstPitch(postedAt, scheduledStart)
  let scope = 'legacy_unverifiable'
  if (causal) scope = 'public_live'
  else if (validIso(postedAt) && validIso(scheduledStart)) {
    scope = Date.parse(postedAt) - Date.parse(scheduledStart) > 864e5 ? 'backtest' : 'late_invalid'
  }
  return {
    ...(play || {}), posted_at: postedAt, scheduled_start_utc: scheduledStart,
    record_scope: scope, eligible_public_record: causal, ledger_version: 'v2',
  }
}

function partitionCandidates(list, postedAt, startByPk) {
  const publicLive = [], excluded = []
  for (const play of list || []) {
    const candidate = annotateLedgerCandidate(play, postedAt, startByPk)
    ;(candidate.eligible_public_record ? publicLive : excluded).push(candidate)
  }
  return { publicLive, excluded }
}

const shadowCandidate = (play, postedAt, startByPk, scope) => {
  const temporal = annotateLedgerCandidate(play, postedAt, startByPk)
  return { ...temporal, temporal_scope: temporal.record_scope, record_scope: scope, eligible_public_record: false }
}
const shadowMarketLab = (lab, postedAt, startByPk) => {
  if (!lab) return null
  const out = { ...lab }
  for (const key of ['over', 'f5', 'pitcher_f5']) out[key] = (lab[key] || [])
    .map((play) => shadowCandidate(play, postedAt, startByPk, 'shadow_experiment'))
  return out
}

// The very first publication freezes the complete slate, including an empty
// selection. Subsequent hourly runs may append scratch warnings/observations,
// but can never manufacture a pick. The newly redesigned ORO/F5/total markets
// remain private until a genuine forward gate and human approval enable them.
export function buildSlateRecord(existing, day, { date, publishedAt } = {}) {
  const startByPk = startTimesFor(day?.rows)
  if (existing) {
    const frozenAt = existing.slate_frozen_at || existing.published_at || existing.generated_at || publishedAt
    const preserve = (list) => (list || []).map((play) => play?.record_scope
      ? play : annotateLedgerCandidate(play, frozenAt, startByPk))
    return {
      ...existing,
      date: existing.date || date,
      generated_at: existing.generated_at || frozenAt,
      published_at: existing.published_at || frozenAt,
      slate_frozen_at: frozenAt,
      ledger_version: 'v2',
      plays: preserve(existing.plays), locks: preserve(existing.locks), gems: preserve(existing.gems),
      pitchers: existing.pitchers || {},
      shadow: existing.shadow || {},
    }
  }
  const plays = partitionCandidates(day?.plays, publishedAt, startByPk)
  const gems = partitionCandidates(day?.gems, publishedAt, startByPk)
  return {
    date, generated_at: publishedAt, published_at: publishedAt, slate_frozen_at: publishedAt,
    ledger_version: 'v2', selection_policy_version: SELECTION_POLICY_VERSION,
    selection_snapshot_verified: true,
    graded: false,
    plays: plays.publicLive,
    // No newly-created public lock until its true forward-only gate passes.
    locks: [],
    gems: gems.publicLive,
    pitchers: day?.pitcherMap || {},
    shadow: {
      late_plays: plays.excluded,
      late_gems: gems.excluded,
      locks: (day?.locks || []).map((play) => shadowCandidate(play, publishedAt, startByPk, 'shadow_forward_gate')),
      market_lab: shadowMarketLab(day?.marketLab, publishedAt, startByPk),
    },
  }
}

const eligiblePublicPick = (pick) => pick?.eligible_public_record === true
  && pick.record_scope === 'public_live'
  && beforeFirstPitch(pick.posted_at, pick.scheduled_start_utc)
const resolvedPick = (pick) => ['win', 'loss', 'push'].includes(pick?.result)

export function buildPublicIndex(dailyDocs, { updatedAt = new Date().toISOString() } = {}) {
  let w = 0, l = 0, ps = 0, lw = 0, ll = 0, lps = 0, gw = 0, gloss = 0, units = 0, pricedN = 0
  const tierRec = { oro: { wins: 0, losses: 0 }, plata: { wins: 0, losses: 0 } }
  const labRec = Object.fromEntries(['over', 'f5', 'pitcher_f5'].map((key) => [key, { wins: 0, losses: 0, pushes: 0 }]))
  const days = []
  for (const rec of [...(dailyDocs || [])].sort((a, b) => String(a?.date).localeCompare(String(b?.date)))) {
    const publicPlays = (rec?.plays || []).filter(eligiblePublicPick)
    const publicLocks = (rec?.locks || []).filter(eligiblePublicPick)
    const publicGems = (rec?.gems || []).filter(eligiblePublicPick)
    const plays = publicPlays.filter(resolvedPick), locks = publicLocks.filter(resolvedPick), gems = publicGems.filter(resolvedPick)
    for (const pick of plays) pick.result === 'win' ? w++ : pick.result === 'loss' ? l++ : ps++
    for (const pick of locks) {
      pick.result === 'win' ? lw++ : pick.result === 'loss' ? ll++ : lps++
      const tier = pick.tier === 'plata' ? tierRec.plata : tierRec.oro
      if (pick.result === 'win') tier.wins++
      else if (pick.result === 'loss') tier.losses++
      if (pick.result === 'win' || pick.result === 'loss') {
        const price = Number(pick.price)
        // No synthetic -110 fallback: units are measured only when an actual
        // non-zero American price was captured with the public decision.
        if (Number.isFinite(price) && Math.abs(price) >= 100) {
          pricedN++
          units += pick.result === 'win' ? (price > 0 ? price / 100 : 100 / Math.abs(price)) : -1
        }
      }
    }
    for (const pick of gems) pick.result === 'win' ? gw++ : pick.result === 'loss' ? gloss++ : null
    const labs = [rec?.market_lab, rec?.shadow?.market_lab].filter(Boolean)
    for (const lab of labs) for (const key of Object.keys(labRec)) for (const pick of lab[key] || []) {
      if (pick.result === 'win') labRec[key].wins++
      else if (pick.result === 'loss') labRec[key].losses++
      else if (pick.result === 'push') labRec[key].pushes++
    }
    days.push({
      date: rec?.date, n: publicPlays.length, graded: !!rec?.graded,
      wins: plays.filter((p) => p.result === 'win').length,
      losses: plays.filter((p) => p.result === 'loss').length,
      locks_n: publicLocks.length,
      locks_wins: locks.filter((p) => p.result === 'win').length,
      locks_losses: locks.filter((p) => p.result === 'loss').length,
      gems_n: publicGems.length,
      gems_wins: gems.filter((p) => p.result === 'win').length,
      gems_losses: gems.filter((p) => p.result === 'loss').length,
    })
  }
  const rate = (wins, losses) => wins + losses ? Math.round(wins / (wins + losses) * 1000) / 1000 : null
  return {
    updated_at: updatedAt, ledger_version: 'v2', record_scope: 'public_live_pregame_only',
    record: { wins: w, losses: l, pushes: ps, win_rate: rate(w, l) },
    locks_record: {
      wins: lw, losses: ll, pushes: lps, win_rate: rate(lw, ll),
      priced_n: pricedN, units: pricedN ? Math.round(units * 100) / 100 : null,
      oro: { ...tierRec.oro, win_rate: rate(tierRec.oro.wins, tierRec.oro.losses) },
      plata: { ...tierRec.plata, win_rate: rate(tierRec.plata.wins, tierRec.plata.losses) },
    },
    gems_record: { wins: gw, losses: gloss, win_rate: rate(gw, gloss) },
    // Kept in the private artifact for gate evaluation; the public normalizer
    // does not expose experimental candidates.
    market_lab_record: Object.fromEntries(Object.entries(labRec)
      .map(([key, value]) => [key, { ...value, win_rate: rate(value.wins, value.losses) }])),
    days: days.reverse(),
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
    for (const list of [
      rec.plays, rec.locks, rec.gems,
      rec.market_lab?.over, rec.market_lab?.f5, rec.market_lab?.pitcher_f5,
      rec.shadow?.late_plays, rec.shadow?.late_gems, rec.shadow?.locks,
      rec.shadow?.market_lab?.over, rec.shadow?.market_lab?.f5, rec.shadow?.market_lab?.pitcher_f5,
    ]) {
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
  const gameByPk = new Map((games || []).map((g) => [String(g.game_pk), g]))
  for (const r of rows) {
    const o = m.get(r.game_pk)
    if (!o) continue
    const capturedAt = new Date().toISOString()
    const phase = capturePhaseFor(gameByPk.get(String(r.game_pk)) || r, capturedAt)
    const before = phase.is_pregame ? r.odds : (r.observed?.odds ?? r.odds)
    const hadCurve = !!before?.wp_curve, hadLine = before?.ml_home != null
    const fresh = {
      ...Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)),
      stage: phase.is_pregame ? 'pregame' : phase.capture_phase === 'postgame' ? 'final' : phase.capture_phase,
      requested_stage: stage, capture_phase: phase.capture_phase, is_pregame: phase.is_pregame,
      captured_at: capturedAt,
    }
    const merged = mergeOddsBlocks(before, fresh)
    if (phase.is_pregame) r.odds = merged
    else r.observed = { ...(r.observed || {}), captured_at: capturedAt,
      status: gameByPk.get(String(r.game_pk))?.status ?? r.status ?? null, odds: merged }
    if ((!hadCurve && merged?.wp_curve) || (!hadLine && merged?.ml_home != null)) added = true
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
    if (r.observed?.weather || !r.graded) continue
    const g = byPk.get(r.game_pk)
    if (!isFinal(g)) continue
    try {
      const data = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${r.game_pk}/feed/live`).then((x) => x.json())
      const w = data?.gameData?.weather
      if (w && w.temp != null) {
        const capturedAt = new Date().toISOString()
        r.observed = { ...(r.observed || {}), captured_at: capturedAt,
          weather: { condition: w.condition || null, temp: Number(w.temp) || null, wind: w.wind || null, source: 'mlb', stage: 'observed', captured_at: capturedAt } }
        added = true
      }
    } catch { /* best-effort — never break the daily run over weather */ }
  }
  return added
}

// Merge-write the per-game log for a date, preserving any Y already graded AND
// any previously-captured odds block (so the morning opening line survives the
// evening re-run).
function upsertGames(date, rows, { asOf = new Date().toISOString(), freezeFeatures = false } = {}) {
  const fp = `${GAMES}/${date}.json`
  let previousRows = [], previousDoc = null
  if (fs.existsSync(fp)) { try { previousDoc = j(fp); previousRows = previousDoc.games || [] } catch { /* rewrite */ } }
  const merged = mergeGameRows(previousRows, rows, { asOf, freezeFeatures })
  fs.writeFileSync(fp, JSON.stringify({
    ...(previousDoc || {}), date, generated_at: asOf, schema: 'games_v1',
    integrity_schema: 'ledger_v2', formula_version: FORMULA_VERSION, games: merged,
  }, null, 2))
}

// --- grade a past day against final scores (given a fetched schedule) --------
const isFinal = (g) => g && g.home_score != null && /Final|Game Over|Completed/.test(g.status || '')

function gradeList(list, byPk) {
  let done = true
  for (const play of list || []) {
    if (play.result) continue
    const g = byPk.get(play.game_pk) ?? byPk.get(String(play.game_pk))
    if (g && VOID_STATUS_RE.test(g.status || '')) {
      play.result = 'void'; play.void_reason = g.status || 'void'; continue
    }
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
  const marketLabDone = gradeMarketLab(rec.market_lab, byPk)
  const latePlaysDone = gradeList(rec.shadow?.late_plays, byPk)
  const lateGemsDone = gradeList(rec.shadow?.late_gems, byPk)
  const shadowLocksDone = gradeList(rec.shadow?.locks, byPk)
  const shadowLabDone = gradeMarketLab(rec.shadow?.market_lab, byPk)
  rec.graded = playsDone && locksDone && gemsDone && marketLabDone
    && latePlaysDone && lateGemsDone && shadowLocksDone && shadowLabDone
  return rec.graded
}

// Grade EVERY logged game (not just the 3 picks) for the learning dataset.
export function gradeGames(rec, byPk) {
  let changed = false
  for (const row of rec.games) {
    if (row.graded || row.outcome_status === 'void') continue
    const g = byPk.get(row.game_pk) ?? byPk.get(String(row.game_pk))
    if (g && VOID_STATUS_RE.test(g.status || '')) {
      row.outcome_status = 'void'
      row.invalid_reason = g.status || 'void'
      row.learning_eligible = false
      row.integrity = { ...(row.integrity || {}), ledger_version: 'v2', training_eligible: false,
        reason: 'game_not_completed', first_pitch: row.first_pitch ?? g.game_datetime ?? null }
      changed = true
      continue
    }
    if (!isFinal(g)) continue
    const hs = g.home_score, as = g.away_score, tot = hs + as
    row.home_win = hs > as ? 1 : 0
    row.total_runs = tot
    row.f5_home_score = g.f5_home_score ?? null
    row.f5_away_score = g.f5_away_score ?? null
    row.f5_complete = row.f5_home_score != null && row.f5_away_score != null
    row.f5_total_runs = row.f5_complete ? row.f5_home_score + row.f5_away_score : null
    row.f5_result = !row.f5_complete ? null
      : row.f5_home_score === row.f5_away_score ? 'push'
        : row.f5_home_score > row.f5_away_score ? 'home' : 'away'
    row.final = `${as}-${hs}`
    row.ml_result = ((row.ml_pick === g.home_team_abbr) === (hs > as)) ? 'win' : 'loss'
    row.total_result = tot === row.line ? 'push' : (tot > row.line) === (row.side === 'over') ? 'win' : 'loss'
    row.outcome_status = 'final'
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
    if (!r.graded || r.observed?.live || r.live || (r.home_win !== 0 && r.home_win !== 1)) continue
    const g = liveStore?.games?.[String(r.game_pk)]
    const snaps = (g?.snapshots || []).filter((s) => s.cons != null)
    if (snaps.length < 2) continue
    const wps = (g.snapshots || []).map((s) => (r.home_win === 1 ? s.wp : s.wp == null ? null : 1 - s.wp)).filter((v) => v != null)
    r.observed = { ...(r.observed || {}), live: {
      n: g.snapshots.length,
      steam: Math.round((snaps[snaps.length - 1].cons - snaps[0].cons) * 1e4) / 1e4,
      min_wp_winner: wps.length ? Math.round(Math.min(...wps) * 1e4) / 1e4 : null,
    } }
    changed = true
  }
  return changed
}

// --- learning snapshot ------------------------------------------------------
const rowOutcomeValid = (row) => row?.graded === true
  && (row.home_win === 0 || row.home_win === 1)
  && typeof row.final === 'string' && /^\d+-\d+$/.test(row.final)
  && !VOID_STATUS_RE.test(row.status || '') && row.outcome_status !== 'void'

const ledgerRowQuality = (row) => {
  let score = 0
  if (row?.integrity?.duplicate_of) score -= 1000
  if (rowOutcomeValid(row)) score += 100
  if (row?.integrity?.official_date && row.integrity.official_date === row.game_date) score += 20
  if (row?.integrity?.training_eligible === true) score += 10
  if (row?.feature_hash) score += 5
  if (row?.date && row.date === row.game_date) score += 2
  return score
}

export function dedupeLedgerRows(rows) {
  const byPk = new Map(), noPk = []
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue
    if (row.game_pk == null) { noPk.push(row); continue }
    const key = String(row.game_pk), old = byPk.get(key)
    if (!old || ledgerRowQuality(row) > ledgerRowQuality(old)) byPk.set(key, row)
  }
  return [...byPk.values(), ...noPk]
}

export function contextRows(rows) {
  return dedupeLedgerRows(rows).filter(rowOutcomeValid)
}

const pregameOddsOnly = (odds) => {
  if (!odds || odds.open_provenance !== 'explicit_pregame' || !validIso(odds.captured_at_open)) return null
  const out = { ...odds }
  for (const key of Object.keys(out)) {
    if (key === 'wp_curve' || key.endsWith('_close') || key === 'captured_at_close'
      || key === 'provider_close' || key === 'line_move' || key === 'total_line_move') delete out[key]
  }
  return out
}

export function learningRows(rows) {
  return dedupeLedgerRows(rows).filter((row) => {
    if (row?.integrity?.training_eligible !== true || !rowOutcomeValid(row)) return false
    if (row.integrity.cohort === 'backfill_asof' || row.backfilled === true) return true
    const asOf = row.feature_as_of ?? row.decision_captured_at
    const firstPitch = row.first_pitch ?? row.integrity?.first_pitch ?? row.game_datetime
    return row.feature_hash && beforeFirstPitch(asOf, firstPitch)
  }).map((row) => ({
    ...row,
    // Outcome-time telemetry is available for research, never for a fit.
    observed: undefined,
    weather: undefined,
    live: undefined,
    odds: pregameOddsOnly(row.odds),
  }))
}

function readAllGameRows({ purpose = 'raw' } = {}) {
  const files = fs.existsSync(GAMES) ? fs.readdirSync(GAMES).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : []
  const rows = []
  for (const f of files) { try { for (const r of j(`${GAMES}/${f}`).games || []) rows.push(r) } catch { /* skip */ } }
  if (purpose === 'context') return contextRows(rows)
  if (purpose === 'learning') return learningRows(rows)
  if (purpose === 'deduped') return dedupeLedgerRows(rows)
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
// slate. Before 7am ET a run is grading/odds-capture only (never posts plays).
const ET = 'America/New_York'
function etNow() {
  const d = new Date()
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: ET }).format(d) // YYYY-MM-DD
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', hour12: false }).format(d)) % 24
  return { date, hour }
}
async function main() {
  fs.mkdirSync(GAMES, { recursive: true })
  const runAt = new Date().toISOString()
  const et = etNow()
  const today = process.argv[2] || et.date
  const posting = !!process.argv[2] || et.hour >= 7 // manual runs always post

  const existingToday = fs.existsSync(`${HIST}/${today}.json`) ? j(`${HIST}/${today}.json`) : null
  const day = await computeDay(today)
  if (day) {
    if (posting || existingToday) {
      const rec = buildSlateRecord(existingToday, day, { date: today, publishedAt: runAt })
      if (existingToday) validateFrozenPitchers(rec, day.pitcherMap)
      fs.writeFileSync(`${HIST}/${today}.json`, JSON.stringify(rec, null, 2))
    }
    // Pre-cutoff rows stay provisional. The first published slate freezes every
    // game's exact feature bytes, even when the selected plays array is empty.
    upsertGames(today, day.rows, { asOf: runAt, freezeFeatures: posting || !!existingToday })
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
    const needGames = gamesRec && (gamesRec.games || []).some((r) => !r.graded
      && r.outcome_status !== 'void' && !r.integrity?.duplicate_of)
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

  // Rebuild the public record from the causal ledger only. Backtests, late
  // captures and experimental shadow candidates can never inflate this number.
  const idxFiles = pickFiles.sort()
  const publicIndex = buildPublicIndex(idxFiles.map((f) => j(`${HIST}/${f}`)), { updatedAt: runAt })
  const { wins: w, losses: l, pushes: ps } = publicIndex.record
  fs.writeFileSync(`${HIST}/index.json`, JSON.stringify(publicIndex, null, 2))

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
  const allRows = readAllGameRows({ purpose: 'context' })
  const eloState = loadEloState(`${DATA}/elo_state.json`, today)
  const eloApplied = applyEloUpdates(priors.elo, eloState, allRows, { today })
  if (eloApplied > 0) fs.writeFileSync(`${DATA}/elo.json`, JSON.stringify(priors.elo))
  fs.writeFileSync(`${DATA}/elo_state.json`, JSON.stringify(eloState))

  // Hourly ingestion/gradation is intentionally cheap. The dedicated daily
  // workflow owns refitting; an operator can still run this file standalone.
  let learningSummary = 'skipped'
  if (process.env.AA_SKIP_LEARNING !== '1') {
    const fitRows = readAllGameRows({ purpose: 'learning' })
    const snap = buildLearning(fitRows)
    learningSummary = `${snap.n_graded}/${snap.n_total}`
  }
  console.log(`adrian_daily: ${today} -> ${day ? day.plays.length : 0} plays; record ${w}-${l} (${ps} push); elo+${eloApplied}; learning ${learningSummary}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
