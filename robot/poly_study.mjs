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
// Resultado 2026-07-16: gate NO pasa (ver docs/POLY_STUDY.md).

import { mkdirSync, writeFileSync } from 'node:fs';
import { fetchUniverse, fetchTrades, walletMarketStats, stats, spearman, fmt, pct } from './lib/poly.mjs';

const TAGS = ['mlb', 'nba', 'nfl', 'soccer', 'tennis', 'sports'];
const WINDOW_DAYS = 30;          // mercados resueltos en los últimos N días
const MIN_VOL = 20000;           // USD mínimos por mercado
const MAX_MARKETS = 320;         // tope de mercados (los de más volumen)
const MIN_SEL_MARKETS = 8;       // mínimo de mercados por wallet para rankear
const TOP_K = 20;                // wallets seleccionadas para el copiado
const DELAYS = [{ label: '5 min', s: 300 }, { label: '60 min', s: 3600 }];
const SLIP = 0.01;               // slippage adverso del copiador (1¢)

const now = Math.floor(Date.now() / 1000);

// ── 1) Universo ──────────────────────────────────────────────────────────────
console.log(`██████ Estudio Polymarket (piloto de medición) ██████`);
console.log(`ventana: últimos ${WINDOW_DAYS} días · vol mínimo $${MIN_VOL} · tope ${MAX_MARKETS} mercados\n`);
const uni = await fetchUniverse(TAGS, { sinceTs: now - WINDOW_DAYS * 86400, minVol: MIN_VOL, maxMarkets: MAX_MARKETS });
if (uni.length < 40) { console.log('❌ Universo demasiado chico para conclusiones. Fin.'); process.exit(0); }

// ── 2) Tape ──────────────────────────────────────────────────────────────────
const { totalTrades, truncated } = await fetchTrades(uni);
console.log(`Trades bajados: ${totalTrades.toLocaleString()} · mercados truncados en 10k: ${truncated} (${pct(truncated / uni.length)}) — sesgo conocido, se reporta`);

// ── 3) Scoring por wallet ────────────────────────────────────────────────────
const wallets = new Map();
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
const rows = [];
for (const [w, ww] of wallets) {
  const sel = ww.mkts.filter((k) => k.end <= cutEnd), ev = ww.mkts.filter((k) => k.end > cutEnd);
  const s = stats(sel); if (!s || s.n < MIN_SEL_MARKETS) continue;
  const buys = sel.filter((k) => k.avgP != null);
  const avgP = buys.length ? buys.reduce((x, k) => x + k.avgP, 0) / buys.length : null;
  const washy = sel.filter((k) => k.both > 0.5).length / s.n;
  rows.push({ w, s, e: stats(ev), avgP, washy });
}
console.log(`Wallets con ≥${MIN_SEL_MARKETS} mercados en la ventana de selección: ${rows.length}`);

const both = rows.filter((r) => r.e && r.e.n >= 5);
const rho = both.length >= 20 ? spearman(both.map((r) => [r.s.mean, r.e.mean])) : null;
const posSel = both.filter((r) => r.s.mean > 0);
const stillPos = posSel.length ? posSel.filter((r) => r.e.mean > 0).length / posSel.length : null;
console.log(`\n== Persistencia (la pregunta clave) ==`);
console.log(`  wallets medibles en ambas ventanas: ${both.length}`);
console.log(`  Spearman(edge selección, edge evaluación): ${fmt(rho, 3)}  (0 = el pasado no predice nada)`);
console.log(`  de las ganadoras en selección, siguen ganando en evaluación: ${pct(stillPos)}`);

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
      if (!nxt) continue;
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
