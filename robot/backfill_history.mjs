// One-time historical seasons backfill (2023-2025) + context study at 10× the
// sample. Runs inside GitHub Actions on the first run that finds no
// data/history/seasons/ dir; pure statsapi schedule pulls (free), stored as
// compact tuples [date, home, away, awayRuns, homeRuns]. The study evaluates the
// SAME pre-registered context signals (real rest, schedule density, venue form,
// Pythag, eastward travel) on ~7,000 games with the HOME team as the reference
// side (no model/odds exist for the past, so hypotheses are about home win rate
// lifts — direction-preserving versions of the aux_* audit signals).
import fs from 'fs'
import { buildTeamContext, auxForGame } from './context.mjs'

const API = 'https://statsapi.mlb.com/api/v1'
const get = (u) => fetch(u).then((r) => r.json())
const ABBR_FIX = { ATH: 'OAK', CHW: 'CWS', ARI: 'AZ' }
const fix = (a) => ABBR_FIX[a] || a

export async function backfillSeasons(dir, years = [2023, 2024, 2025]) {
  fs.mkdirSync(dir, { recursive: true })
  const summary = []
  // Month-by-month chunks (lighter payloads; a failing chunk names itself in the
  // log). The summary is ALSO persisted to backfill_log.json so a production
  // failure is diagnosable from the repo, not just the Actions console.
  const CHUNKS = [['03-15', '04-30'], ['05-01', '05-31'], ['06-01', '06-30'], ['07-01', '07-31'], ['08-01', '08-31'], ['09-01', '10-05']]
  for (const y of years) {
    const fp = `${dir}/${y}.json`
    if (fs.existsSync(fp)) { summary.push(`${y}: ya existe`); continue }
    const games = []
    const errs = []
    for (const [a, b] of CHUNKS) {
      try {
        const data = await get(`${API}/schedule?sportId=1&startDate=${y}-${a}&endDate=${y}-${b}&gameType=R&hydrate=team`)
        for (const d of data.dates || []) for (const g of d.games || []) {
          if (g.status?.abstractGameState !== 'Final') continue
          const h = fix(g.teams?.home?.team?.abbreviation), aa = fix(g.teams?.away?.team?.abbreviation)
          const hs = g.teams?.home?.score, as = g.teams?.away?.score
          if (!h || !aa || hs == null || as == null || hs === as) continue
          games.push([d.date, h, aa, as, hs])
        }
      } catch (e) { errs.push(`${a}..${b}: ${e.message}`) }
    }
    if (games.length < 1000) { summary.push(`${y}: incompleto (${games.length})${errs.length ? ` [${errs.join(' | ')}]` : ''} — no guardado`); continue }
    games.sort((x, z) => (x[0] < z[0] ? -1 : 1))
    fs.writeFileSync(fp, JSON.stringify({ season: y, n: games.length, games }))
    summary.push(`${y}: ${games.length} juegos${errs.length ? ` (chunks con error: ${errs.length})` : ''}`)
  }
  try { fs.writeFileSync(`${dir}/backfill_log.json`, JSON.stringify({ at: new Date().toISOString(), summary }, null, 2)) } catch { /* log best-effort */ }
  return summary
}

const wilson = (k, n, z = 1.96) => { if (!n) return { p: null, lo: null, hi: null }; const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return { p: r4(p), lo: r4((c - m) / d), hi: r4((c + m) / d) } }
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4)
function bootGap(a, b, B = 1000, seed = 20260708) {
  if (a.length < 5 || b.length < 5) return null
  let s = seed >>> 0; const rnd = () => (s = (1664525 * s + 1013904223) >>> 0) / 4294967296
  const ds = []
  for (let t = 0; t < B; t++) { let sa = 0; for (let i = 0; i < a.length; i++) sa += a[(rnd() * a.length) | 0]; let sb = 0; for (let i = 0; i < b.length; i++) sb += b[(rnd() * b.length) | 0]; ds.push(sa / a.length - sb / b.length) }
  ds.sort((x, y) => x - y)
  return { lo: r4(ds[Math.floor(0.025 * B)]), hi: r4(ds[Math.floor(0.975 * B)]) }
}

// HOME-side oriented signal values from an aux block (+ favors home).
const SIGNALS = {
  rest: { thr: 1, val: (x) => (x.rest_h == null || x.rest_a == null ? null : Math.min(x.rest_h, 5) - Math.min(x.rest_a, 5)) },
  dens: { thr: 1, val: (x) => (x.dens_h == null || x.dens_a == null ? null : x.dens_a - x.dens_h) },
  haf: { thr: 0.15, val: (x) => x.haf },
  pyth: { thr: 0.05, val: (x) => x.pyth },
  tze_opp: { thr: 2, val: (x) => (x.tze_a == null ? null : x.tze_a) }, // away team traveled east
}

export function buildHistoryStudy(dir, outPath) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{4}\.json$/.test(f)).sort() : []
  if (!files.length) return null
  const perSeason = [], pooled = {}
  for (const id of Object.keys(SIGNALS)) pooled[id] = { fav: [], unf: [] }
  for (const f of files) {
    const { season, games } = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'))
    const rows = games.map(([date, home, away, as, hs]) => ({ date, home, away, final: `${as}-${hs}`, home_win: hs > as ? 1 : 0 }))
    const ctx = buildTeamContext(rows)
    const rec = { season, n: rows.length, signals: {} }
    for (const [id, S] of Object.entries(SIGNALS)) {
      const fav = [], unf = []
      for (const r of rows) {
        const aux = auxForGame(ctx, r)
        if (!aux) continue
        const v = S.val(aux)
        if (v == null) continue
        if (v >= S.thr) fav.push(r.home_win)
        else if (id === 'tze_opp' ? false : v <= -S.thr) unf.push(r.home_win)
        else if (id === 'tze_opp' && v <= 0) unf.push(r.home_win) // no east travel = reference
      }
      const wf = wilson(fav.filter((y) => y === 1).length, fav.length)
      const wu = wilson(unf.filter((y) => y === 1).length, unf.length)
      rec.signals[id] = { n_fav: fav.length, n_unf: unf.length, fav_rate: wf.p, unf_rate: wu.p, gap: wf.p != null && wu.p != null ? r4(wf.p - wu.p) : null }
      pooled[id].fav.push(...fav); pooled[id].unf.push(...unf)
    }
    perSeason.push(rec)
  }
  const pooledOut = {}
  for (const [id, P] of Object.entries(pooled)) {
    const wf = wilson(P.fav.filter((y) => y === 1).length, P.fav.length)
    const wu = wilson(P.unf.filter((y) => y === 1).length, P.unf.length)
    const ci = bootGap(P.fav, P.unf)
    const gap = wf.p != null && wu.p != null ? r4(wf.p - wu.p) : null
    pooledOut[id] = {
      n_fav: P.fav.length, n_unf: P.unf.length, fav_rate: wf.p, unf_rate: wu.p, gap,
      gap_lo: ci?.lo ?? null, gap_hi: ci?.hi ?? null,
      verdict: !ci || P.fav.length < 60 || P.unf.length < 60 ? 'sin dato' : ci.lo > 0 ? 'ROBUSTO (multi-temporada)' : ci.hi < 0 ? 'contrario' : 'ruido',
    }
  }
  const study = { built_at: new Date().toISOString(), seasons: perSeason, pooled: pooledOut, note: 'Señales de contexto evaluadas sobre el equipo LOCAL en temporadas históricas (sin odds/modelo). Direcciones pre-registradas 2026-07-07.' }
  fs.writeFileSync(outPath, JSON.stringify(study, null, 2))
  return study
}
