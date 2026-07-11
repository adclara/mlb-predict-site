// AA Sports — NBA en MODO SOMBRA (corre en GitHub Actions).
//
// Igual que la sombra de soccer: registra picks diarios en D1 (sport='nba')
// SIN publicarlos, y los gradea con los marcadores finales de ESPN. Es el
// período de prueba en vivo que el backtest no pudo cubrir (ESPN no conserva
// odds históricas): aquí se guarda TAMBIÉN la prob del mercado (market_prob)
// para medir modelo-vs-mercado con odds reales antes de publicar nada.
//
// Qué hace cada corrida:
//   1. RATINGS: reconstruye el Elo con las 10 temporadas de data/fase2/nba
//      (params CONGELADOS del backtest) + los juegos de la temporada en curso
//      que aún no están en fase2 (ESPN por fecha).
//   2. GRADEA: picks pendientes → win/loss con el final de ESPN.
//   3. REGISTRA: juegos por jugar de hoy/mañana (solo regular/playoffs, nada
//      de Summer League ni pretemporada) con prob del modelo + market_prob.
//
// Fuera de temporada corre y no registra nada (barato). Los picks reales
// empiezan solos cuando arranque la 2026-27 en octubre.
//
// Requiere CLOUDFLARE_API_TOKEN. Uso: node robot/nba_shadow.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeElo, loadSeasons } from './nba_model.mjs';
import { probs2way } from './lib/espn_odds.mjs';

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const D1_DATABASE_ID = 'ed0969d8-050a-4987-ab98-b047c30f76c9';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const ENGINE = 'nba-shadow-v1';

if (!API_TOKEN) { console.log('Sin CLOUDFLARE_API_TOKEN; modo sombra omitido.'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (d) => d.toISOString().slice(0, 10);
const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

async function espn(path) {
  try {
    const res = await fetch(`${ESPN}/${path}`, { headers: { 'user-agent': 'aa-sports-shadow/1.0' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

async function d1(sql, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(`D1: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  return (body.result && body.result[0] && body.result[0].results) || [];
}

async function ensureMarketProb() {
  try { await d1('ALTER TABLE predictions ADD COLUMN market_prob REAL'); console.log('D1: columna market_prob creada'); }
  catch (e) { /* ya existe */ }
}

/* ── 1) ratings: histórico + temporada en curso ──────────────────────────── */
function frozenParams() {
  // los del backtest (grid solo en burn-in); el JSON manda si existe
  const p = join(process.cwd(), 'data', 'fase2', 'nba', 'nba_backtest.json');
  if (existsSync(p)) {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.params && j.params.k) return { k: j.params.k, hfa: j.params.hfa, carry: j.params.carry, b2b: j.params.b2b };
  }
  return { k: 15, hfa: 70, carry: 0.75, b2b: 30 };
}

function gameFromEvent(ev, d) {
  const c = (ev.competitions && ev.competitions[0]) || {};
  const comp = c.competitors || [];
  const home = comp.find((x) => x.homeAway === 'home') || {};
  const away = comp.find((x) => x.homeAway === 'away') || {};
  return {
    date: d, neutral: !!c.neutralSite,
    home: home.team && home.team.abbreviation, hs: num(home.score),
    away: away.team && away.team.abbreviation, as: num(away.score),
    _status: (c.status && c.status.type) || {},
    _seasonType: (ev.season && ev.season.type) || null,
    _odds: Array.isArray(c.odds) && c.odds[0] ? c.odds[0] : null,
    _id: String(ev.id),
  };
}

async function buildRatings(today) {
  const params = frozenParams();
  const elo = makeElo(params);
  const seasons = loadSeasons();
  let lastDate = '2000-01-01';
  for (const s of seasons) {
    elo.newSeason();
    const games = [...s.games].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const g of games) {
      if (g.hs == null || g.as == null || !g.home || !g.away || g.hs === g.as) continue;
      elo.update(g, elo.predict(g));
      if (g.date > lastDate) lastDate = g.date;
    }
  }
  console.log(`Ratings base: ${seasons.length} temporadas hasta ${lastDate} (K=${params.k} HFA=${params.hfa})`);

  // temporada en curso: finales posteriores a fase2 (regular/playoffs)
  const start = new Date(lastDate + 'T12:00Z');
  start.setUTCDate(start.getUTCDate() + 1);
  const dates = [];
  for (const d = start; day(d) < day(today); d.setUTCDate(d.getUTCDate() + 1)) dates.push(day(d));
  let applied = 0, prevDate = lastDate;
  for (let i = 0; i < dates.length; i += 10) {
    const batch = dates.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (d) => {
      const data = await espn(`scoreboard?dates=${d.replaceAll('-', '')}`);
      return (data && Array.isArray(data.events) ? data.events : []).map((ev) => gameFromEvent(ev, d));
    }));
    for (const g of results.flat().sort((a, b) => a.date.localeCompare(b.date))) {
      if (![2, 3].includes(g._seasonType)) continue;
      if (!String(g._status.name || '').toUpperCase().includes('FINAL')) continue;
      if (g.hs == null || g.as == null || !g.home || !g.away || g.hs === g.as) continue;
      // salto de >60 días entre juegos = frontera de temporada → regresión al centro
      if (new Date(g.date) - new Date(prevDate) > 60 * 86400000) elo.newSeason();
      elo.update(g, elo.predict(g));
      prevDate = g.date;
      applied++;
    }
    await sleep(120);
  }
  console.log(`Ratings al día: +${applied} juegos de la temporada en curso`);
  return { elo, prevDate };
}

/* ── main ────────────────────────────────────────────────────────────────── */
const tierOf = (p) => (p >= 0.7 ? 't70' : p >= 0.65 ? 't65' : p >= 0.6 ? 't60' : p >= 0.55 ? 't55' : 'open');

async function main() {
  const today = new Date();
  const dates = [day(today), day(new Date(today.getTime() + 86400000))];
  await ensureMarketProb();

  /* gradear pendientes (hasta 5 días atrás) */
  const pending = await d1(
    "SELECT date, event_id, home, away, pick FROM predictions WHERE sport = 'nba' AND result IS NULL AND pick IS NOT NULL AND date < ? ORDER BY date DESC LIMIT 80",
    [day(today)],
  );
  console.log(`Sombra NBA: ${pending.length} picks por gradear`);
  const byDate = new Map();
  for (const p of pending) {
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p);
  }
  for (const [d, rows] of byDate) {
    const data = await espn(`scoreboard?dates=${d.replaceAll('-', '')}`);
    if (!data) continue;
    for (const p of rows) {
      const ev = (data.events || []).find((e) => String(e.id) === String(p.event_id));
      if (!ev) continue;
      const g = gameFromEvent(ev, d);
      if (!String(g._status.name || '').toUpperCase().includes('FINAL')) continue;
      if (g.hs == null || g.as == null || g.hs === g.as) continue;
      const winner = g.hs > g.as ? p.home : p.away;
      const result = winner === p.pick ? 'win' : 'loss';
      await d1("UPDATE predictions SET result = ?, status = 'final' WHERE sport = 'nba' AND date = ? AND event_id = ?", [result, p.date, p.event_id]);
      console.log(`  graded ${p.date} ${p.away}@${p.home}: ${g.as}-${g.hs} → ${p.pick} ${result}`);
    }
    await sleep(150);
  }

  /* ratings al día y registro de picks */
  const { elo } = await buildRatings(today);
  let logged = 0, withMkt = 0;
  for (const d of dates) {
    const data = await espn(`scoreboard?dates=${d.replaceAll('-', '')}`);
    if (!data || !Array.isArray(data.events)) continue;
    let nEv = 0, nPre = 0;
    for (const ev of data.events) {
      nEv++;
      const g = gameFromEvent(ev, d);
      if (![2, 3].includes(g._seasonType)) continue;              // ni Summer League ni pretemporada
      if (String(g._status.state || '').toLowerCase() !== 'pre') continue;
      if (!g.home || !g.away) continue;
      nPre++;
      const pH = elo.predict({ date: d, home: g.home, away: g.away, neutral: g.neutral });
      const side = pH >= 0.5 ? { code: g.home, p: pH } : { code: g.away, p: 1 - pH };
      const mkt = probs2way(g._odds);
      const mktSide = mkt ? (side.code === g.home ? mkt.pH : mkt.pA) : null;
      if (mktSide != null) withMkt++;
      await d1(
        `INSERT OR REPLACE INTO predictions
         (sport, date, event_id, league, start_time, status, home, away, pick, prob, confidence, engine_version, result, market_prob, updated_at)
         VALUES ('nba', ?, ?, 'nba', ?, 'pre', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [d, g._id, ev.date || d, g.home, g.away, side.code, Math.round(side.p * 1000) / 1000, tierOf(side.p), ENGINE, mktSide != null ? Math.round(mktSide * 1000) / 1000 : null, new Date().toISOString()],
      );
      logged++;
    }
    if (nEv) console.log(`  nba ${d}: ${nEv} eventos, ${nPre} pre (regular/playoffs)`);
    await sleep(150);
  }
  console.log(`Sombra NBA: ${logged} picks registrados (${withMkt} con market_prob) — ${dates.join(', ')}`);

  /* resumen del track record + modelo vs mercado */
  const rec = await d1("SELECT confidence, COUNT(*) n, SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) w FROM predictions WHERE sport = 'nba' AND result IS NOT NULL GROUP BY confidence");
  console.log('Track record sombra por tier:', JSON.stringify(rec));
  const mvsm = await d1("SELECT COUNT(*) n, AVG(prob - market_prob) avg_edge, AVG(ABS(prob - market_prob)) avg_gap FROM predictions WHERE sport = 'nba' AND market_prob IS NOT NULL");
  console.log('Modelo vs mercado (picks con odds):', JSON.stringify(mvsm));
}

await main();
