// Sonda-gate de Polymarket (piloto de medición, SIN dinero). Corre en Actions
// (con red), solo lectura, sin secretos. Verifica ANTES de construir el estudio:
//   1) Gamma API: mercados deportivos RESUELTOS recientes (metadata + resolución)
//   2) Data API: /trades por mercado (shape, paginación, límites, rate limits)
//   3) Data API: tape global de trades (¿se puede sin filtrar por mercado?)
//   4) CLOB: /prices-history (serie de precios para simular slippage del copiador)
//   5) Data API: /positions y /activity de una wallet real (PnL por wallet)
// Imprime shapes exactas y límites; con ese log se construye poly_study.mjs.

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const cut = (o, n = 1200) => { try { return JSON.stringify(o).slice(0, n); } catch (e) { return String(o).slice(0, n); } };
const keysOf = (o) => (o && typeof o === 'object') ? Object.keys(o).join(', ') : String(o);

async function get(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'aa-sports-poly-probe/1.0' } });
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    const rl = {};
    for (const [k, v] of r.headers.entries()) if (/rate|limit|retry/i.test(k)) rl[k] = v;
    return { status: r.status, data, txt, ms: Date.now() - t0, rl };
  } catch (e) { return { status: 0, data: null, txt: String(e), ms: Date.now() - t0, rl: {} }; }
}

console.log('██████ Sonda Polymarket — piloto de medición ██████');

// ── 1) Gamma: mercados deportivos resueltos recientes ─────────────────────────
console.log('\n== 1) Gamma /markets (cerrados, recientes) ==');
const mk = await get(`${GAMMA}/markets?closed=true&order=endDate&ascending=false&limit=3&volume_num_min=50000`);
console.log(`status ${mk.status} (${mk.ms}ms)`);
let market = null;
if (Array.isArray(mk.data) && mk.data.length) {
  market = mk.data[0];
  console.log('  claves del mercado:', keysOf(market));
  console.log('  ejemplo:', cut({ question: market.question, conditionId: market.conditionId, endDate: market.endDate, closed: market.closed, outcomes: market.outcomes, outcomePrices: market.outcomePrices, volumeNum: market.volumeNum, clobTokenIds: market.clobTokenIds, umaResolutionStatus: market.umaResolutionStatus }, 900));
} else console.log('  respuesta:', cut(mk.data ?? mk.txt, 400));

// deportes por tag (MLB / deportes en general)
for (const slug of ['mlb', 'sports']) {
  const ev = await get(`${GAMMA}/events?tag_slug=${slug}&closed=true&order=endDate&ascending=false&limit=2`);
  const arr = Array.isArray(ev.data) ? ev.data : [];
  console.log(`\n[events tag_slug=${slug}] status ${ev.status} → ${arr.length} eventos`);
  if (arr[0]) {
    console.log('  claves del evento:', keysOf(arr[0]));
    const m0 = (arr[0].markets || [])[0];
    console.log('  título:', arr[0].title, '| mercados:', (arr[0].markets || []).length);
    if (m0) { console.log('  mercado[0]:', cut({ question: m0.question, conditionId: m0.conditionId, outcomePrices: m0.outcomePrices, volumeNum: m0.volumeNum }, 500)); market = market || m0; }
  }
}

if (!market || !market.conditionId) { console.log('\n❌ Sin mercado de referencia; no puedo sondear /trades. Fin.'); process.exit(0); }
const cid = market.conditionId;

// ── 2) Data API: trades del mercado ───────────────────────────────────────────
console.log(`\n== 2) Data /trades?market=${cid.slice(0, 14)}… ==`);
const tr = await get(`${DATA}/trades?market=${cid}&limit=10`);
console.log(`status ${tr.status} (${tr.ms}ms) | headers rate-limit:`, cut(tr.rl, 300));
if (Array.isArray(tr.data) && tr.data.length) {
  console.log('  claves del trade:', keysOf(tr.data[0]));
  console.log('  ejemplo[0]:', cut(tr.data[0], 700));
  console.log('  ejemplo[1]:', cut(tr.data[1] || {}, 400));
} else console.log('  respuesta:', cut(tr.data ?? tr.txt, 400));

// paginación y límites
for (const q of ['limit=500', 'limit=1000', 'limit=500&offset=2000', 'limit=500&offset=10000', 'limit=10&takerOnly=false']) {
  const r = await get(`${DATA}/trades?market=${cid}&${q}`);
  const n = Array.isArray(r.data) ? r.data.length : -1;
  console.log(`  [${q}] status ${r.status} → ${n} filas (${r.ms}ms)`);
}

// ── 3) tape global (sin market) ───────────────────────────────────────────────
console.log('\n== 3) Data /trades global (sin filtro) ==');
const tg = await get(`${DATA}/trades?limit=5`);
const ng = Array.isArray(tg.data) ? tg.data.length : -1;
console.log(`status ${tg.status} → ${ng} filas; primer trade:`, cut((tg.data || [])[0], 400));

// ── 4) CLOB prices-history (para slippage del copiador) ─────────────────────
console.log('\n== 4) CLOB /prices-history ==');
let tok = null;
try { tok = JSON.parse(market.clobTokenIds || '[]')[0]; } catch (e) {}
if (tok) {
  const ph = await get(`${CLOB}/prices-history?market=${tok}&interval=max&fidelity=60`);
  const hist = ph.data && ph.data.history;
  console.log(`status ${ph.status} → puntos: ${Array.isArray(hist) ? hist.length : 'n/a'}`);
  if (Array.isArray(hist) && hist.length) console.log('  punto[0]:', cut(hist[0], 200), '| último:', cut(hist[hist.length - 1], 200));
} else console.log('  sin clobTokenIds en el mercado de referencia');

// ── 5) wallet real: positions + activity ─────────────────────────────────────
console.log('\n== 5) Data /positions y /activity de una wallet del tape ==');
const w = (Array.isArray(tr.data) && tr.data[0] && (tr.data[0].proxyWallet || tr.data[0].proxy_wallet)) || null;
if (w) {
  const pos = await get(`${DATA}/positions?user=${w}&limit=3`);
  const act = await get(`${DATA}/activity?user=${w}&limit=3`);
  console.log(`wallet ${w.slice(0, 10)}…`);
  const p0 = Array.isArray(pos.data) ? pos.data[0] : null;
  console.log(`  [positions] status ${pos.status} claves:`, p0 ? keysOf(p0) : cut(pos.data ?? pos.txt, 200));
  if (p0) console.log('  ejemplo:', cut(p0, 600));
  const a0 = Array.isArray(act.data) ? act.data[0] : null;
  console.log(`  [activity] status ${act.status} claves:`, a0 ? keysOf(a0) : cut(act.data ?? act.txt, 200));
} else console.log('  sin wallet en el tape — se salta');

console.log('\n████ fin sonda Polymarket ████');
