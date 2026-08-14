// AA Sports — NBA/WNBA en MODO SOMBRA (corre en GitHub Actions).
//
// Igual que la sombra de soccer: registra picks diarios en D1 por deporte
// SIN publicarlos, y los gradea con los marcadores finales de ESPN. Es el
// período de prueba en vivo que el backtest no pudo cubrir (ESPN no conserva
// odds históricas): aquí se guarda TAMBIÉN la prob del mercado (market_prob)
// para medir modelo-vs-mercado con odds reales antes de publicar nada.
//
// Qué hace cada corrida:
//   1. RATINGS: reconstruye el Elo con las temporadas de data/fase2/<sport>
//      (params CONGELADOS del backtest) + los juegos de la temporada en curso
//      que aún no están en fase2 (ESPN por fecha).
//   2. GRADEA: picks pendientes → win/loss con el final de ESPN.
//   3. REGISTRA: juegos por jugar de hoy/mañana (solo regular/playoffs, nada
//      de Summer League/pretemporada) con prob del modelo + market_prob.
//
// Fuera de temporada corre y no registra nada (barato). Los picks reales
// empiezan solos cuando arranque la 2026-27 en octubre.
//
// Requiere CLOUDFLARE_API_TOKEN.
// Uso NBA: node robot/nba_shadow.mjs
// Uso WNBA: AA_BASKETBALL_SPORT=wnba node robot/nba_shadow.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeElo, loadSeasons } from './nba_model.mjs';
import { priceFrom, probs2way } from './lib/espn_odds.mjs';
import { createWnbaTotalForecaster } from './wnba_market_model.mjs';

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const D1_DATABASE_ID = 'ed0969d8-050a-4987-ab98-b047c30f76c9';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const SPORT = String(process.env.AA_BASKETBALL_SPORT || 'nba').toLowerCase();
if (!['nba', 'wnba'].includes(SPORT)) throw new Error(`AA_BASKETBALL_SPORT inválido: ${SPORT}`);
const ESPN = `https://site.api.espn.com/apis/site/v2/sports/basketball/${SPORT}`;
const ENGINE = `${SPORT}-shadow-v1`;

if (!API_TOKEN) { console.log('Sin CLOUDFLARE_API_TOKEN; modo sombra omitido.'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (d) => d.toISOString().slice(0, 10);
const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const normCdf = (z) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
};

function wnbaTotalOffer(game, forecaster) {
  if (!forecaster) return null;
  const projection = forecaster.predict(game);
  if (projection == null) return null;
  const odds = game._odds || {}, total = odds.total || {};
  const line = num(odds.overUnder ?? total.over?.close?.line ?? total.under?.close?.line
    ?? total.over?.current?.line ?? total.under?.current?.line);
  const overPrice = priceFrom(total.over ?? odds.overOdds), underPrice = priceFrom(total.under ?? odds.underOdds);
  if (line == null || overPrice == null || underPrice == null) {
    return { projection, line, side: null, prob: null, price: null, marketProb: null, edge: null };
  }
  const probOver = 1 - normCdf((line - projection) / Math.max(0.01, forecaster.residual_sd));
  const impliedOver = 1 / overPrice, impliedUnder = 1 / underPrice, vig = impliedOver + impliedUnder;
  const marketOver = impliedOver / vig, marketUnder = impliedUnder / vig;
  const side = probOver >= 0.5 ? 'over' : 'under', prob = side === 'over' ? probOver : 1 - probOver;
  const marketProb = side === 'over' ? marketOver : marketUnder;
  return { projection, line, side, prob, price: side === 'over' ? overPrice : underPrice, marketProb, edge: prob - marketProb };
}

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
  const p = join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'fase2', SPORT, `${SPORT}_backtest.json`);
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

async function buildRatings(today, totalForecaster = null) {
  const params = frozenParams();
  const elo = makeElo(params);
  const seasons = loadSeasons(join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'fase2', SPORT));
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
      if (totalForecaster) totalForecaster.update(g);
      prevDate = g.date;
      applied++;
    }
    await sleep(120);
  }
  console.log(`Ratings al día: +${applied} juegos de la temporada en curso`);
  return { elo, prevDate };
}

let unifiedMarketTable = true;
async function insertUnifiedMarket(row) {
  if (!unifiedMarketTable) return false;
  try {
    await d1(`INSERT INTO sport_market_predictions
      (sport,date,event_id,market_key,selection_key,family,player_id,player_name,pick,side,line,price,
       market_prob,prob,edge,projection,combo_json,league,home,away,start_time,feature_as_of,frozen_at,
       status,result,engine_version,gate_version,public_scope,gate_passed,human_approved,invalidated,
       invalidated_reason,source_hash,updated_at)
      VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,'frozen',NULL,?,?,'shadow',0,0,0,NULL,NULL,?)
      ON CONFLICT(sport,date,event_id,market_key,selection_key) DO UPDATE SET
        pick=COALESCE(sport_market_predictions.pick,excluded.pick),
        side=COALESCE(sport_market_predictions.side,excluded.side),
        line=COALESCE(sport_market_predictions.line,excluded.line),
        price=COALESCE(sport_market_predictions.price,excluded.price),
        market_prob=COALESCE(sport_market_predictions.market_prob,excluded.market_prob),
        prob=COALESCE(sport_market_predictions.prob,excluded.prob),
        edge=COALESCE(sport_market_predictions.edge,excluded.edge),
        projection=COALESCE(sport_market_predictions.projection,excluded.projection),
        frozen_at=CASE WHEN sport_market_predictions.price IS NULL AND excluded.price IS NOT NULL
          THEN excluded.frozen_at ELSE sport_market_predictions.frozen_at END,
        updated_at=excluded.updated_at
      WHERE sport_market_predictions.status='frozen'`, [
      SPORT, row.date, row.eventId, row.marketKey, row.selectionKey, row.pick, row.side, row.line, row.price,
      row.marketProb, row.prob, row.edge, row.projection, SPORT.toUpperCase(), row.home, row.away, row.start,
      row.featureAsOf, row.featureAsOf, row.engine, 'wnba-market-gate-v1', row.featureAsOf,
    ]);
    return true;
  } catch (error) {
    unifiedMarketTable = false;
    console.log(`D1 unified market ledger unavailable until migration: ${error.message}`);
    return false;
  }
}

async function gradeUnifiedMarkets(today) {
  if (SPORT !== 'wnba' || !unifiedMarketTable) return;
  let pending = [];
  try {
    pending = await d1(`SELECT date,event_id,market_key,pick,side,line FROM sport_market_predictions
      WHERE sport='wnba' AND result IS NULL AND date <= ? ORDER BY date,event_id LIMIT 200`, [day(today)]);
  } catch (error) {
    unifiedMarketTable = false;
    console.log(`D1 unified grading unavailable until migration: ${error.message}`);
    return;
  }
  const byDate = new Map();
  for (const row of pending) { if (!byDate.has(row.date)) byDate.set(row.date, []); byDate.get(row.date).push(row); }
  for (const [date, rows] of byDate) {
    const data = await espn(`scoreboard?dates=${date.replaceAll('-', '')}`);
    for (const row of rows) {
      const event = (data?.events || []).find((item) => String(item.id) === String(row.event_id));
      if (!event) continue;
      const game = gameFromEvent(event, date);
      if (!String(game._status.name || '').toUpperCase().includes('FINAL') || game.hs == null || game.as == null || game.hs === game.as) continue;
      let result = 'void';
      if (row.market_key === 'winner' && row.pick) result = (game.hs > game.as ? game.home : game.away) === row.pick ? 'win' : 'loss';
      if (row.market_key === 'total' && ['over', 'under'].includes(row.side) && num(row.line) != null) {
        const actual = game.hs + game.as;
        result = actual === Number(row.line) ? 'push' : ((row.side === 'over') === (actual > Number(row.line)) ? 'win' : 'loss');
      }
      await d1(`UPDATE sport_market_predictions SET status='final',result=?,updated_at=?
        WHERE sport='wnba' AND date=? AND event_id=? AND market_key=? AND selection_key IN ('winner:model','total:model')`,
      [result, new Date().toISOString(), date, row.event_id, row.market_key]);
    }
  }
}

/* ── main ────────────────────────────────────────────────────────────────── */
const tierOf = (p) => (p >= 0.7 ? 't70' : p >= 0.65 ? 't65' : p >= 0.6 ? 't60' : p >= 0.55 ? 't55' : 'open');

async function main() {
  const today = new Date();
  const dates = [day(today), day(new Date(today.getTime() + 86400000))];
  await ensureMarketProb();
  const totalForecaster = SPORT === 'wnba' ? createWnbaTotalForecaster() : null;
  await gradeUnifiedMarkets(today);

  /* gradear pendientes (hasta 5 días atrás) */
  const pending = await d1(
    'SELECT date, event_id, home, away, pick FROM predictions WHERE sport = ? AND result IS NULL AND pick IS NOT NULL AND date < ? ORDER BY date DESC LIMIT 80',
    [SPORT, day(today)],
  );
  console.log(`Sombra ${SPORT.toUpperCase()}: ${pending.length} picks por gradear`);
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
      await d1("UPDATE predictions SET result = ?, status = 'final' WHERE sport = ? AND date = ? AND event_id = ?", [result, SPORT, p.date, p.event_id]);
      console.log(`  graded ${p.date} ${p.away}@${p.home}: ${g.as}-${g.hs} → ${p.pick} ${result}`);
    }
    await sleep(150);
  }

  /* ratings al día y registro de picks */
  const { elo } = await buildRatings(today, totalForecaster);
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
         VALUES (?, ?, ?, ?, ?, 'pre', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [SPORT, d, g._id, SPORT, ev.date || d, g.home, g.away, side.code, Math.round(side.p * 1000) / 1000, tierOf(side.p), ENGINE, mktSide != null ? Math.round(mktSide * 1000) / 1000 : null, new Date().toISOString()],
      );
      if (SPORT === 'wnba') {
        const frozenAt = new Date().toISOString();
        const moneyline = g._odds?.moneyline || {};
        const homePrice = priceFrom(g._odds?.homeTeamOdds ?? moneyline.home);
        const awayPrice = priceFrom(g._odds?.awayTeamOdds ?? moneyline.away);
        await insertUnifiedMarket({
          date: d, eventId: g._id, marketKey: 'winner', selectionKey: 'winner:model', pick: side.code,
          side: side.code === g.home ? 'home' : 'away', line: null,
          price: side.code === g.home ? homePrice : awayPrice, marketProb: mktSide,
          prob: side.p, edge: mktSide == null ? null : side.p - mktSide, projection: null,
          home: g.home, away: g.away, start: ev.date || d, featureAsOf: frozenAt, engine: ENGINE,
        });
        const totalOffer = wnbaTotalOffer(g, totalForecaster);
        if (totalOffer) await insertUnifiedMarket({
          date: d, eventId: g._id, marketKey: 'total', selectionKey: 'total:model', pick: totalOffer.side,
          side: totalOffer.side, line: totalOffer.line, price: totalOffer.price, marketProb: totalOffer.marketProb,
          prob: totalOffer.prob, edge: totalOffer.edge, projection: totalOffer.projection,
          home: g.home, away: g.away, start: ev.date || d, featureAsOf: frozenAt, engine: 'wnba-total-shadow-v1',
        });
      }
      logged++;
    }
    if (nEv) console.log(`  ${SPORT} ${d}: ${nEv} eventos, ${nPre} pre (regular/playoffs)`);
    await sleep(150);
  }
  console.log(`Sombra ${SPORT.toUpperCase()}: ${logged} picks registrados (${withMkt} con market_prob) — ${dates.join(', ')}`);

  /* resumen del track record + modelo vs mercado */
  const rec = await d1("SELECT confidence, COUNT(*) n, SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) w FROM predictions WHERE sport = ? AND result IS NOT NULL GROUP BY confidence", [SPORT]);
  console.log('Track record sombra por tier:', JSON.stringify(rec));
  const mvsm = await d1("SELECT COUNT(*) n, AVG(prob - market_prob) avg_edge, AVG(ABS(prob - market_prob)) avg_gap FROM predictions WHERE sport = ? AND market_prob IS NOT NULL", [SPORT]);
  console.log('Modelo vs mercado (picks con odds):', JSON.stringify(mvsm));
}

await main();
