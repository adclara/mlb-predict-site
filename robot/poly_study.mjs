// Piloto de MEDICIÓN de Polymarket — sin dinero, sin copiar, solo estudio.
// Pregunta central (gate): ¿copiar a las wallets "consistentemente ganadoras"
// deja edge NETO positivo después de retraso + slippage? Si no, se reporta y
// no se construye nada más.
//
// Método (honesto, walk-forward):
//   1. Universo: mercados DEPORTIVOS resueltos recientes (Gamma, por tag),
//      con volumen mínimo. Resolución = outcomePrices 0/1.
//   2. Tape: /trades por mercado (Data API, taker; paginación con tope ~10k —
//      truncamientos LOGUEADOS, nunca silenciosos).
//   3. Scoring por wallet: edge al precio de entrada vs resolución, agregado
//      por mercado (los trades del mismo mercado no son independientes),
//      t-stat entre mercados, filtros anti-wash (ambos lados, compra-favoritos).
//   4. Walk-forward: selección de "ganadores" SOLO con la primera ventana;
//      evaluación en la segunda. Persistencia = correlación entre ventanas.
//   5. Simulación de copiado: para cada trade del seleccionado en la ventana
//      de evaluación, el copiador entra al precio del PRIMER trade posterior
//      (mismo token) tras un retraso (5 min / 60 min) + 1¢ de slippage adverso.
// Salida: log legible + data/fase2/polymarket/poly_study.json (artifact).

import { mkdirSync, writeFileSync } from 'node:fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com';
const TAGS = ['mlb', 'nba', 'nfl', 'soccer', 'tennis', 'sports'];
const WINDOW_DAYS = 30;          // mercados resueltos en los últimos N días
const MIN_VOL = 20000;           // USD mínimos por mercado
const MAX_MARKETS = 320;         // tope de mercados (los de más volumen)
const PAGE = 1000, MAX_OFFSET = 9000; // tope real de la Data API (400 en 10k)
const MIN_SEL_MARKETS = 8;       // mínimo de mercados por wallet para rankear
const TOP_K = 20;                // wallets seleccionadas para el copiado
const DELAYS = [{ label: '5 min', s: 300 }, { label: '60 min', s: 3600 }];
const SLIP = 0.01;               // slippage adverso del copiador (1¢)
const CONC = 8;                  // requests concurrentes

const now = Math.floor(Date.now() / 1000);
const since = now - WINDOW_DAYS * 86400;
const fmt = (x, d = 4) => (x == null || !isFinite(x)) ? 'n/a' : (+x).toFixed(d);
const pct = (x, d = 1) => (x == null || !isFinite(x)) ? 'n/a' : (100 * x).toFixed(d) + '%';

async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'aa-sports-poly-study/1.0' } });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 800 * (i + 1))); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { await new Promise((s) => setTimeout(s, 800 * (i + 1))); }
  }
  return null;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ── 1) Universo: mercados deportivos resueltos ───────────────────────────────
console.log(`██████ Estudio Polymarket (piloto de medición) ██████`);
console.log(`ventana: últimos ${WINDOW_DAYS} días · vol mínimo $${MIN_VOL} · tope ${MAX_MARKETS} mercados\n`);

const seen = new Set(); const markets = [];
for (const tag of TAGS) {
  let got = 0;
  for (let off = 0; off < 900; off += 100) {
    const evs = await get(`${GAMMA}/events?tag_slug=${tag}&closed=true&order=endDate&ascending=false&limit=100&offset=${off}`);
    if (!Array.isArray(evs) || !evs.length) break;
    let stale = 0;
    for (const ev of evs) {
      const end = Date.parse(ev.endDate || ev.closedTime || 0) / 1000;
      if (end && end < since) { stale++; continue; }
      for (const m of ev.markets || []) {
        if (!m.conditionId || seen.has(m.conditionId)) continue;
        let prices = null; try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch (e) {}
        if (!prices || prices.length < 2 || Math.max(...prices) < 0.99) continue; // sin resolución limpia
        if ((m.volumeNum || 0) < MIN_VOL) continue;
        seen.add(m.conditionId);
        markets.push({ cid: m.conditionId, q: m.question, tag, vol: m.volumeNum || 0, win: prices.indexOf(Math.max(...prices)), end: end || now });
      }
    }
    got += evs.length;
    if (stale > evs.length * 0.8) break; // ya pasamos la ventana
  }
  console.log(`  tag=${tag}: acumulados ${markets.length} mercados (eventos vistos ${got})`);
}
markets.sort((a, b) => b.vol - a.vol);
const uni = markets.slice(0, MAX_MARKETS).sort((a, b) => a.end - b.end);
console.log(`\nUniverso final: ${uni.length} mercados resueltos (descartados por tope: ${Math.max(0, markets.length - MAX_MARKETS)})`);
if (uni.length < 40) { console.log('❌ Universo demasiado chico para conclusiones. Fin.'); process.exit(0); }

// ── 2) Tape de trades por mercado ────────────────────────────────────────────
let truncated = 0, totalTrades = 0;
await pool(uni, CONC, async (m) => {
  const all = [];
  for (let off = 0; off <= MAX_OFFSET; off += PAGE) {
    const rows = await get(`${DATA}/trades?market=${m.cid}&limit=${PAGE}&offset=${off}`);
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
    if (off === MAX_OFFSET) truncated++;
  }
  // solo campos necesarios, orden temporal ascendente
  m.trades = all.map((t) => ({ w: t.proxyWallet, s: t.side, o: t.outcomeIndex, p: +t.price, sz: +t.size, ts: +t.timestamp, a: t.asset }))
    .filter((t) => t.w && isFinite(t.p) && isFinite(t.sz) && t.sz > 0)
    .sort((x, y) => x.ts - y.ts);
  totalTrades += m.trades.length;
});
console.log(`Trades bajados: ${totalTrades.toLocaleString()} · mercados truncados en 10k: ${truncated} (${pct(truncated / uni.length)}) — sesgo conocido, se reporta`);

// ── 3) Scoring por wallet (edge al precio de entrada, por mercado) ───────────
// edge de un BUY del outcome o a precio p: (r_o − p) por acción; SELL: (p − r_o).
function walletMarketStats(m) {
  const per = new Map(); // wallet → {shares, cost, pnl, buyShares, buyCost, sideShares:[por outcome]}
  for (const t of m.trades) {
    const r = t.o === m.win ? 1 : 0;
    let x = per.get(t.w);
    if (!x) { x = { shares: 0, pnl: 0, buyCost: 0, buyShares: 0, wSum: 0, sideSh: [0, 0] }; per.set(t.w, x); }
    const e = t.s === 'BUY' ? (r - t.p) : (t.p - r);
    x.pnl += e * t.sz; x.shares += t.sz;
    if (t.s === 'BUY') { x.buyCost += t.p * t.sz; x.buyShares += t.sz; x.wSum += t.p * t.sz; x.sideSh[t.o === m.win ? 0 : 1] += t.sz; }
  }
  return per;
}
const wallets = new Map(); // w → {mkts:[{end, edgeSh, pnl, cost, avgP, both}]}
for (const m of uni) {
  for (const [w, x] of walletMarketStats(m)) {
    if (x.shares < 1) continue;
    let ww = wallets.get(w);
    if (!ww) { ww = { mkts: [] }; wallets.set(w, ww); }
    const both = x.sideSh[0] > 0 && x.sideSh[1] > 0 ? Math.min(...x.sideSh) / Math.max(...x.sideSh) : 0;
    ww.mkts.push({ end: m.end, cid: m.cid, edgeSh: x.pnl / x.shares, pnl: x.pnl, cost: x.buyCost, avgP: x.buyShares ? x.wSum / x.buyShares : null, both });
  }
}
console.log(`Wallets únicas en el universo: ${wallets.size.toLocaleString()}`);

// ── 4) Walk-forward: selección (60%) vs evaluación (40%) ────────────────────
const cutIdx = Math.floor(uni.length * 0.6);
const cutEnd = uni[cutIdx].end;
const stats = (mkts) => {
  const n = mkts.length; if (!n) return null;
  const mean = mkts.reduce((s, k) => s + k.edgeSh, 0) / n;
  const sd = Math.sqrt(mkts.reduce((s, k) => s + (k.edgeSh - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, pnl: mkts.reduce((s, k) => s + k.pnl, 0), cost: mkts.reduce((s, k) => s + k.cost, 0) };
};
const rows = [];
for (const [w, ww] of wallets) {
  const sel = ww.mkts.filter((k) => k.end <= cutEnd), ev = ww.mkts.filter((k) => k.end > cutEnd);
  const s = stats(sel); if (!s || s.n < MIN_SEL_MARKETS) continue;
  const buys = sel.filter((k) => k.avgP != null);
  const avgP = buys.length ? buys.reduce((x, k) => x + k.avgP, 0) / buys.length : null;
  const washy = sel.filter((k) => k.both > 0.5).length / s.n; // ambos lados parejos
  rows.push({ w, s, e: stats(ev), avgP, washy });
}
console.log(`Wallets con ≥${MIN_SEL_MARKETS} mercados en la ventana de selección: ${rows.length}`);

// persistencia: ¿el edge pasado predice el futuro? (Spearman sel vs eval)
const both = rows.filter((r) => r.e && r.e.n >= 5);
function spearman(pairs) {
  const rank = (v) => { const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const out = []; idx.forEach(([, i], k) => out[i] = k + 1); return out; };
  const a = rank(pairs.map((p) => p[0])), b = rank(pairs.map((p) => p[1]));
  const n = pairs.length; const d2 = a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0);
  return 1 - 6 * d2 / (n * (n * n - 1));
}
const rho = both.length >= 20 ? spearman(both.map((r) => [r.s.mean, r.e.mean])) : null;
const posSel = both.filter((r) => r.s.mean > 0);
const stillPos = posSel.length ? posSel.filter((r) => r.e.mean > 0).length / posSel.length : null;
console.log(`\n== Persistencia (la pregunta clave) ==`);
console.log(`  wallets medibles en ambas ventanas: ${both.length}`);
console.log(`  Spearman(edge selección, edge evaluación): ${fmt(rho, 3)}  (0 = el pasado no predice nada)`);
console.log(`  de las ganadoras en selección, siguen ganando en evaluación: ${pct(stillPos)}`);

// selección honesta: t-stat alto + filtros anti-trampa
const qualified = rows
  .filter((r) => r.washy < 0.3 && (r.avgP == null || r.avgP <= 0.85) && r.s.t >= 2 && r.s.mean > 0)
  .sort((a, b) => b.s.t - a.s.t);
const top = qualified.slice(0, TOP_K);
console.log(`\n== Selección walk-forward ==`);
console.log(`  candidatas tras filtros (t≥2, sin wash>30%, avgP≤0.85): ${qualified.length} · seleccionadas: ${top.length}`);
for (const r of top.slice(0, 10)) console.log(`   ${r.w.slice(0, 10)}… selMercados=${r.s.n} edge/acción=${fmt(r.s.mean)} t=${fmt(r.s.t, 2)} | eval: ${r.e ? `n=${r.e.n} edge=${fmt(r.e.mean)}` : 'sin actividad'}`);

// ── 5) Simulación de copiado (ventana de evaluación) ────────────────────────
const topSet = new Set(top.map((r) => r.w));
const evalMkts = uni.filter((m) => m.end > cutEnd);
const sim = DELAYS.map((d) => ({ ...d, n: 0, fills: 0, edge: 0, leaderEdge: 0 }));
for (const m of evalMkts) {
  const byAsset = new Map();
  for (const t of m.trades) { let arr = byAsset.get(t.a); if (!arr) { arr = []; byAsset.set(t.a, arr); } arr.push(t); }
  for (const t of m.trades) {
    if (!topSet.has(t.w) || t.s !== 'BUY') continue;
    const r = t.o === m.win ? 1 : 0;
    const tape = byAsset.get(t.a) || [];
    for (const d of sim) {
      d.n++;
      const nxt = tape.find((x) => x.ts >= t.ts + d.s);
      if (!nxt) continue; // sin precio posterior → el copiador no llena
      d.fills++;
      const entry = Math.min(0.999, nxt.p + SLIP);
      d.edge += (r - entry);
      d.leaderEdge += (r - t.p);
    }
  }
}
console.log(`\n== Simulación de copiado (${evalMkts.length} mercados de evaluación, ${TOP_K} wallets top) ==`);
for (const d of sim) {
  const fillRate = d.n ? d.fills / d.n : 0;
  console.log(`  retraso ${d.label}: señales=${d.n} · llenadas=${pct(fillRate)} · edge/acción del LÍDER=${fmt(d.n ? d.leaderEdge / Math.max(1, d.fills) : null)} · edge/acción del COPIADOR (neto ${SLIP * 100}¢)=${fmt(d.fills ? d.edge / d.fills : null)}`);
}

// ── Veredicto del gate ───────────────────────────────────────────────────────
const cop5 = sim[0].fills ? sim[0].edge / sim[0].fills : null;
const cop60 = sim[1].fills ? sim[1].edge / sim[1].fills : null;
console.log(`\n══ VEREDICTO (gate) ══`);
const passes = cop5 != null && cop5 > 0.005 && rho != null && rho > 0.1;
console.log(passes
  ? `🔶 Señal presente: el copiador retiene edge (+${fmt(cop5)}/acción a 5 min) y hay persistencia (ρ=${fmt(rho, 2)}). Requiere confirmación con más semanas antes de cualquier paso.`
  : `❌ Sin edge replicable: copiador a 5 min = ${fmt(cop5)}/acción, a 60 min = ${fmt(cop60)}/acción, persistencia ρ=${fmt(rho, 2)}. Según el gate acordado: se reporta y NO se construye más.`);

// ── Persistir JSON (artifact) ────────────────────────────────────────────────
mkdirSync('data/fase2/polymarket', { recursive: true });
writeFileSync('data/fase2/polymarket/poly_study.json', JSON.stringify({
  ran_at: new Date().toISOString(), window_days: WINDOW_DAYS, min_vol: MIN_VOL,
  universe: uni.length, trades: totalTrades, truncated, wallets: wallets.size,
  rated: rows.length, measurable_both: both.length, spearman: rho, still_pos: stillPos,
  qualified: qualified.length, top: top.map((r) => ({ w: r.w, sel: r.s, eval: r.e, avgP: r.avgP, washy: r.washy })),
  copy_sim: sim.map((d) => ({ delay: d.label, signals: d.n, fill_rate: d.n ? d.fills / d.n : null, leader_edge: d.fills ? d.leaderEdge / d.fills : null, copier_edge: d.fills ? d.edge / d.fills : null })),
  gate_passes: passes,
}, null, 2));
console.log('\nJSON: data/fase2/polymarket/poly_study.json');
console.log('████ fin estudio Polymarket ████');
