// AA Sports — Soccer en MODO SOMBRA (corre en GitHub Actions).
//
// Registra picks diarios de soccer en D1 (sport='soccer') SIN publicarlos:
// es el período de prueba en vivo que exige nuestro estándar de honestidad
// antes de encender las predicciones públicas (igual que se validó MLB).
//
// Qué hace cada corrida:
//   1. GRADEA: partidos sombra de días pasados sin resultado → busca el
//      marcador final en ESPN y marca win/loss en D1.
//   2. REGISTRA: partidos próximos (hoy/mañana) con odds en ESPN → prob
//      des-vigada 3 vías (el blend validado: α=0 ⇒ mercado + tiers
//      calibrados del backtest), pick = lado (H/A) con mayor prob, tier
//      como confianza. Upsert en D1.
//
// Requiere CLOUDFLARE_API_TOKEN (mismo secret del robot MLB).
// Uso: node robot/soccer_shadow.mjs

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const D1_DATABASE_ID = 'ed0969d8-050a-4987-ab98-b047c30f76c9';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
// Mundial ahora; las ligas de clubes entran solas cuando arranquen (agosto).
const LEAGUES = ['fifa.world', 'uefa.champions', 'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'usa.1', 'mex.1'];
const ENGINE = 'soccer-shadow-v1';

if (!API_TOKEN) { console.log('Sin CLOUDFLARE_API_TOKEN; modo sombra omitido.'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const day = (d) => d.toISOString().slice(0, 10);
const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

// odds de ESPN soccer → prob des-vigadas H/D/A (moneyline americano o decimal)
function probsFromOdds(o) {
  if (!o) return null;
  const dec = (side) => {
    const ml = side && (side.moneyLine ?? side.moneyline ?? side.value);
    const n = num(ml);
    if (n == null) return null;
    if (Math.abs(n) < 20) return n > 1 ? n : null;            // ya decimal
    return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);       // americano → decimal
  };
  const dh = dec(o.homeTeamOdds), da = dec(o.awayTeamOdds);
  const dd = dec(o.drawOdds) ?? (o.drawOdds ? null : num(o.draw));
  if (!dh || !da || !dd) return null;
  const ih = 1 / dh, id = 1 / dd, ia = 1 / da, s = ih + id + ia;
  return { pH: ih / s, pD: id / s, pA: ia / s };
}

function tierOf(p) { return p >= 0.7 ? 't70' : p >= 0.65 ? 't65' : p >= 0.6 ? 't60' : p >= 0.55 ? 't55' : 'open'; }

async function main() {
  const today = new Date();
  const dates = [day(today), day(new Date(today.getTime() + 86400000))];

  /* ── 1) gradear pendientes (hasta 5 días atrás) ── */
  const pending = await d1(
    "SELECT date, event_id, league, home, away, pick FROM predictions WHERE sport = 'soccer' AND result IS NULL AND pick IS NOT NULL AND date < ? ORDER BY date DESC LIMIT 80",
    [day(today)],
  );
  console.log(`Sombra: ${pending.length} picks por gradear`);
  const byLeagueDate = new Map();
  for (const p of pending) {
    const k = `${p.league}|${p.date}`;
    if (!byLeagueDate.has(k)) byLeagueDate.set(k, []);
    byLeagueDate.get(k).push(p);
  }
  for (const [k, rows] of byLeagueDate) {
    const [lg, d] = k.split('|');
    const data = await espn(`${lg}/scoreboard?dates=${d.replaceAll('-', '')}`);
    if (!data) continue;
    for (const p of rows) {
      const ev = (data.events || []).find((e) => String(e.id) === String(p.event_id));
      const c = ev && ev.competitions && ev.competitions[0];
      const st = c && c.status && c.status.type;
      if (!st || !String(st.name || '').toUpperCase().includes('FINAL')) continue;
      const home = (c.competitors || []).find((x) => x.homeAway === 'home') || {};
      const away = (c.competitors || []).find((x) => x.homeAway === 'away') || {};
      const hs = num(home.score), as = num(away.score);
      if (hs == null || as == null) continue;
      const winner = hs > as ? p.home : as > hs ? p.away : 'DRAW';
      const result = winner === p.pick ? 'win' : 'loss';
      await d1(
        "UPDATE predictions SET result = ?, status = 'final' WHERE sport = 'soccer' AND date = ? AND event_id = ?",
        [result, p.date, p.event_id],
      );
      console.log(`  graded ${p.date} ${p.away}@${p.home}: ${hs != null ? as + '-' + hs : ''} → ${p.pick} ${result}`);
    }
    await sleep(150);
  }

  /* ── 2) registrar picks de hoy/mañana ── */
  let logged = 0;
  for (const lg of LEAGUES) {
    for (const d of dates) {
      const data = await espn(`${lg}/scoreboard?dates=${d.replaceAll('-', '')}`);
      if (!data || !Array.isArray(data.events)) continue;
      for (const ev of data.events) {
        const c = (ev.competitions && ev.competitions[0]) || {};
        const st = (c.status && c.status.type) || {};
        if (String(st.state || '').toLowerCase() !== 'pre') continue; // solo por jugar
        const o = Array.isArray(c.odds) && c.odds[0] ? c.odds[0] : null;
        const pr = probsFromOdds(o);
        if (!pr) continue;
        const home = (c.competitors || []).find((x) => x.homeAway === 'home') || {};
        const away = (c.competitors || []).find((x) => x.homeAway === 'away') || {};
        const hc = home.team && (home.team.abbreviation || home.team.shortDisplayName);
        const ac = away.team && (away.team.abbreviation || away.team.shortDisplayName);
        if (!hc || !ac) continue;
        // pick = lado con mayor prob (H o A; el empate no se elige como pick)
        const side = pr.pH >= pr.pA ? { code: hc, p: pr.pH } : { code: ac, p: pr.pA };
        const tier = tierOf(side.p);
        await d1(
          `INSERT OR REPLACE INTO predictions
           (sport, date, event_id, league, start_time, status, home, away, pick, prob, confidence, engine_version, result, updated_at)
           VALUES ('soccer', ?, ?, ?, ?, 'pre', ?, ?, ?, ?, ?, ?, NULL, ?)`,
          [d, String(ev.id), lg, ev.date || d, hc, ac, side.code, Math.round(side.p * 1000) / 1000, tier, ENGINE, new Date().toISOString()],
        );
        logged++;
      }
      await sleep(150);
    }
  }
  console.log(`Sombra: ${logged} picks registrados/actualizados (${dates.join(', ')})`);

  /* ── 3) mini-resumen del track record sombra ── */
  const rec = await d1(
    "SELECT confidence, COUNT(*) n, SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) w FROM predictions WHERE sport = 'soccer' AND result IS NOT NULL GROUP BY confidence",
  );
  console.log('Track record sombra por tier:', JSON.stringify(rec));
}

await main();
