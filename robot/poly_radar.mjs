// 📡 RADAR de wallets de Polymarket — observatorio DESCRIPTIVO (sin dinero,
// sin copiar, sin recomendaciones). Identifica las wallets con mejor edge
// medido en los últimos 30 días (con filtros anti-wash y anti-favoritos),
// perfila CÓMO operan (cuándo entran, a qué precio, cuánto arriesgan, en qué
// mercados, si aguantan o voltean) y publica el blob a KV `poly:radar` para
// la pestaña Radar de aasport.net. Incluye el bloque de honestidad medido
// (persistencia) — el pasado aquí apenas predice el futuro y la UI lo dice.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fetchUniverse, fetchTrades, walletMarketStats, stats, spearman, median, quantile, fmt, pct } from './lib/poly.mjs';

const TAGS = ['mlb', 'nba', 'nfl', 'soccer', 'tennis', 'sports', 'politics', 'crypto', 'pop-culture', 'business', 'science'];
const WINDOW_DAYS = 30, MIN_VOL = 20000, MAX_MARKETS = 400;
const MIN_MARKETS = 8, TOP_K = 25;
const BANDS = [[0, 0.2, '<20¢'], [0.2, 0.4, '20-40¢'], [0.4, 0.6, '40-60¢'], [0.6, 0.85, '60-85¢'], [0.85, 1.01, '>85¢']];

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const KV_NAMESPACE_ID = '683aa2f8846643bf8a6a8b606e5bf0b7';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;

const now = Math.floor(Date.now() / 1000);

console.log('██████ Radar Polymarket — observatorio de wallets ██████');
console.log(`ventana ${WINDOW_DAYS} días · vol≥$${MIN_VOL} · tope ${MAX_MARKETS} mercados · todos los temas\n`);

// ── Universo + tape (con identidades públicas para la UI) ────────────────────
const uni = await fetchUniverse(TAGS, { sinceTs: now - WINDOW_DAYS * 86400, minVol: MIN_VOL, maxMarkets: MAX_MARKETS });
if (uni.length < 40) { console.log('❌ Universo demasiado chico. Fin.'); process.exit(0); }
const { totalTrades, truncated, identities } = await fetchTrades(uni, { keepOutcome: true, identities: true });
console.log(`Trades: ${totalTrades.toLocaleString()} · truncados en 10k: ${truncated} · identidades públicas: ${identities.size.toLocaleString()}`);

// ── Scoring por wallet (ventana completa) ────────────────────────────────────
const wallets = new Map();
for (const m of uni) {
  for (const [w, x] of walletMarketStats(m)) {
    if (x.shares < 1) continue;
    let ww = wallets.get(w);
    if (!ww) { ww = { mkts: [] }; wallets.set(w, ww); }
    const both = x.sideSh[0] > 0 && x.sideSh[1] > 0 ? Math.min(...x.sideSh) / Math.max(...x.sideSh) : 0;
    ww.mkts.push({ end: m.end, edgeSh: x.pnl / x.shares, pnl: x.pnl, cost: x.buyCost, avgP: x.buyShares ? x.wSum / x.buyShares : null, both, buySh: x.buyShares, sellSh: x.sellShares });
  }
}
console.log(`Wallets únicas: ${wallets.size.toLocaleString()}`);

const scored = [];
for (const [w, ww] of wallets) {
  const s = stats(ww.mkts); if (!s || s.n < MIN_MARKETS) continue;
  const buys = ww.mkts.filter((k) => k.avgP != null);
  const avgP = buys.length ? buys.reduce((x, k) => x + k.avgP, 0) / buys.length : null;
  const washy = ww.mkts.filter((k) => k.both > 0.5).length / s.n;
  scored.push({ w, s, avgP, washy, wins: ww.mkts.filter((k) => k.pnl > 0).length, losses: ww.mkts.filter((k) => k.pnl < 0).length, flip: (() => { const b = ww.mkts.reduce((x, k) => x + k.buySh, 0), v = ww.mkts.reduce((x, k) => x + k.sellSh, 0); return b > 0 ? Math.min(1, v / b) : 0; })() });
}
const qualified = scored.filter((r) => r.washy < 0.3 && (r.avgP == null || r.avgP <= 0.85) && r.s.mean > 0 && r.s.t >= 2).sort((a, b) => b.s.t - a.s.t);
const top = qualified.slice(0, TOP_K);
console.log(`Con ≥${MIN_MARKETS} mercados: ${scored.length} · calificadas tras filtros: ${qualified.length} · top: ${top.length}`);

// ── Honestidad medida (walk-forward 60/40, como el estudio) ──────────────────
const cutEnd = uni[Math.floor(uni.length * 0.6)].end;
const rowsWF = [];
for (const [, ww] of wallets) {
  const s = stats(ww.mkts.filter((k) => k.end <= cutEnd)); if (!s || s.n < MIN_MARKETS) continue;
  const e = stats(ww.mkts.filter((k) => k.end > cutEnd)); if (!e || e.n < 5) continue;
  rowsWF.push([s.mean, e.mean]);
}
const rho = rowsWF.length >= 20 ? spearman(rowsWF) : null;
const pos = rowsWF.filter((p) => p[0] > 0);
const stillPos = pos.length ? pos.filter((p) => p[1] > 0).length / pos.length : null;
console.log(`Honestidad: ρ=${fmt(rho, 3)} · ganadoras que repiten: ${pct(stillPos)} (n=${rowsWF.length})`);

// ── Perfiles de patrón (segunda pasada sobre el tape) ────────────────────────
const topSet = new Set(top.map((r) => r.w));
const prof = new Map(top.map((r) => [r.w, { buys: [], sells: 0, trades: [] }]));
for (const m of uni) {
  for (const t of m.trades) {
    if (!topSet.has(t.w)) continue;
    const p = prof.get(t.w);
    const usd = t.p * t.sz;
    if (t.s === 'BUY') p.buys.push({ p: t.p, usd, hrsBefore: Math.max(0, (m.end - t.ts) / 3600), cat: m.cat });
    else p.sells++;
    p.trades.push({ ts: t.ts, q: (m.q || '').slice(0, 90), cat: m.cat, side: t.s, outcome: t.ol || String(t.o), p: t.p, usd: Math.round(usd) });
  }
}
function profileOf(r) {
  const p = prof.get(r.w) || { buys: [], trades: [] };
  const totUsd = p.buys.reduce((s, b) => s + b.usd, 0) || 1;
  const bands = BANDS.map(([lo, hi, label]) => ({ band: label, share: p.buys.filter((b) => b.p >= lo && b.p < hi).reduce((s, b) => s + b.usd, 0) / totUsd }));
  const catAgg = new Map();
  for (const b of p.buys) catAgg.set(b.cat, (catAgg.get(b.cat) || 0) + b.usd);
  const cats = [...catAgg].map(([cat, usd]) => ({ cat, share: usd / totUsd })).sort((a, b) => b.share - a.share);
  const hrs = p.buys.map((b) => b.hrsBefore);
  const usds = p.buys.map((b) => b.usd);
  const id = identities.get(r.w) || {};
  return {
    w: r.w, name: id.name || null, pseudonym: id.pseudonym || null, img: id.img || null,
    n_markets: r.s.n, wins: r.wins, losses: r.losses,
    edge_sh: +r.s.mean.toFixed(4), t: +r.s.t.toFixed(2), pnl_usd: Math.round(r.s.pnl), cost_usd: Math.round(r.s.cost),
    avg_entry: r.avgP != null ? +r.avgP.toFixed(3) : null, washy: +r.washy.toFixed(2),
    timing: { median_hours_before: hrs.length ? +median(hrs).toFixed(1) : null, last24h_share: hrs.length ? +(hrs.filter((h) => h <= 24).length / hrs.length).toFixed(2) : null },
    bands: bands.map((b) => ({ ...b, share: +b.share.toFixed(3) })),
    sizing: { median_usd: usds.length ? Math.round(median(usds)) : null, p90_usd: usds.length ? Math.round(quantile(usds, 0.9)) : null, total_usd: Math.round(totUsd) },
    cats: cats.map((c) => ({ ...c, share: +c.share.toFixed(3) })),
    style: { flip_share: +r.flip.toFixed(2) },
    last_trades: p.trades.sort((a, b) => b.ts - a.ts).slice(0, 10),
  };
}
const profiles = top.map(profileOf);
for (const pr of profiles.slice(0, 5))
  console.log(`  ${(pr.pseudonym || pr.name || pr.w.slice(0, 10))}: ${pr.n_markets} mercados, ${pr.wins}-${pr.losses}, edge ${pr.edge_sh}, entra ~${pr.timing.median_hours_before}h antes, mediana $${pr.sizing.median_usd}/trade, ${pr.cats[0] ? pr.cats[0].cat : '—'}`);

// ── Blob + KV + artifact ─────────────────────────────────────────────────────
const blob = JSON.stringify({
  ran_at: new Date().toISOString(), window_days: WINDOW_DAYS, universe: uni.length,
  trades: totalTrades, wallets_seen: wallets.size, qualified: qualified.length,
  attribution: 'Datos públicos de Polymarket (Gamma/Data API)',
  honesty: { spearman: rho, still_pos: stillPos, n: rowsWF.length },
  wallets: profiles,
});
mkdirSync('data/fase2/polymarket', { recursive: true });
writeFileSync('data/fase2/polymarket/poly_radar.json', blob);
console.log(`\nBlob: ${(blob.length / 1024).toFixed(1)} KB · data/fase2/polymarket/poly_radar.json`);

if (API_TOKEN) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent('poly:radar')}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }, body: blob,
  });
  console.log(res.ok ? '✅ KV poly:radar publicado (REST)' : `❌ KV falló: ${res.status} ${(await res.text()).slice(0, 200)}`);
} else console.log('⚠️  Sin CLOUDFLARE_API_TOKEN — no se publica a KV (solo artifact).');

console.log('████ fin radar Polymarket ████');
