// Helpers compartidos del análisis de Polymarket (estudio + radar).
// Solo datos PÚBLICOS (Gamma + Data API), solo lectura, sin dinero.

export const GAMMA = 'https://gamma-api.polymarket.com';
export const DATA = 'https://data-api.polymarket.com';

export const fmt = (x, d = 4) => (x == null || !isFinite(x)) ? 'n/a' : (+x).toFixed(d);
export const pct = (x, d = 1) => (x == null || !isFinite(x)) ? 'n/a' : (100 * x).toFixed(d) + '%';

export async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'aa-sports-poly/1.0' } });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 800 * (i + 1))); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { await new Promise((s) => setTimeout(s, 800 * (i + 1))); }
  }
  return null;
}

export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// categoría legible por tag de Gamma
const CATS = {
  mlb: 'deportes', nba: 'deportes', nfl: 'deportes', soccer: 'deportes', tennis: 'deportes',
  sports: 'deportes', politics: 'política', crypto: 'cripto', 'pop-culture': 'cultura',
  business: 'economía', science: 'ciencia',
};
export const catOf = (tag) => CATS[tag] || 'otros';

// Universo: mercados RESUELTOS recientes por tags (Gamma /events), vol mínimo,
// resolución limpia 0/1. Devuelve [{cid,q,tag,cat,vol,win,end}] ordenado por end asc
// (los MAX_MARKETS de mayor volumen). Loguea el descarte por tope.
export async function fetchUniverse(tags, { sinceTs, minVol, maxMarkets, log = console.log }) {
  const seen = new Set(); const markets = [];
  for (const tag of tags) {
    let got = 0;
    for (let off = 0; off < 900; off += 100) {
      const evs = await get(`${GAMMA}/events?tag_slug=${tag}&closed=true&order=endDate&ascending=false&limit=100&offset=${off}`);
      if (!Array.isArray(evs) || !evs.length) break;
      let stale = 0;
      for (const ev of evs) {
        const end = Date.parse(ev.endDate || ev.closedTime || 0) / 1000;
        if (end && end < sinceTs) { stale++; continue; }
        for (const m of ev.markets || []) {
          if (!m.conditionId || seen.has(m.conditionId)) continue;
          let prices = null; try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch (e) {}
          if (!prices || prices.length < 2 || Math.max(...prices) < 0.99) continue;
          if ((m.volumeNum || 0) < minVol) continue;
          seen.add(m.conditionId);
          // gs = hora de inicio del evento (los mercados deportivos de Gamma la
          // traen como gameStartTime) — permite clasificar trades ANTES/EN VIVO.
          const gs = m.gameStartTime ? Date.parse(m.gameStartTime) / 1000 : null;
          markets.push({ cid: m.conditionId, q: m.question, tag, cat: catOf(tag), vol: m.volumeNum || 0, win: prices.indexOf(Math.max(...prices)), end: end || (Date.now() / 1000), gs: gs && isFinite(gs) ? gs : null });
        }
      }
      got += evs.length;
      if (stale > evs.length * 0.8) break;
    }
    log(`  tag=${tag}: acumulados ${markets.length} mercados (eventos vistos ${got})`);
  }
  markets.sort((a, b) => b.vol - a.vol);
  const uni = markets.slice(0, maxMarkets).sort((a, b) => a.end - b.end);
  log(`Universo final: ${uni.length} mercados resueltos (descartados por tope: ${Math.max(0, markets.length - maxMarkets)})`);
  return uni;
}

// Tape por mercado (Data API /trades, paginación con tope real ~10k → truncado
// LOGUEADO). Muta m.trades = [{w,s,o,p,sz,ts,a[,ol]}] asc. Con identities=true
// devuelve también Map wallet → {name, pseudonym, img} para la UI.
export async function fetchTrades(uni, { page = 1000, maxOffset = 9000, conc = 8, keepOutcome = false, identities = false } = {}) {
  let truncated = 0, totalTrades = 0;
  const ids = identities ? new Map() : null;
  await pool(uni, conc, async (m) => {
    const all = [];
    for (let off = 0; off <= maxOffset; off += page) {
      const rows = await get(`${DATA}/trades?market=${m.cid}&limit=${page}&offset=${off}`);
      if (!Array.isArray(rows) || !rows.length) break;
      all.push(...rows);
      if (rows.length < page) break;
      if (off === maxOffset) truncated++;
    }
    if (ids) for (const t of all) {
      if (t.proxyWallet && !ids.has(t.proxyWallet) && (t.name || t.pseudonym))
        ids.set(t.proxyWallet, { name: t.name || null, pseudonym: t.pseudonym || null, img: t.profileImageOptimized || t.profileImage || null });
    }
    m.trades = all.map((t) => {
      const c = { w: t.proxyWallet, s: t.side, o: t.outcomeIndex, p: +t.price, sz: +t.size, ts: +t.timestamp, a: t.asset };
      if (keepOutcome) c.ol = t.outcome || null;
      return c;
    }).filter((t) => t.w && isFinite(t.p) && isFinite(t.sz) && t.sz > 0).sort((x, y) => x.ts - y.ts);
    totalTrades += m.trades.length;
  });
  return { totalTrades, truncated, identities: ids };
}

// Por mercado: mapa wallet → agregado (edge al precio de entrada; pnl en USD).
export function walletMarketStats(m) {
  const per = new Map();
  for (const t of m.trades) {
    const r = t.o === m.win ? 1 : 0;
    let x = per.get(t.w);
    if (!x) { x = { shares: 0, pnl: 0, buyCost: 0, buyShares: 0, wSum: 0, sideSh: [0, 0], sellShares: 0 }; per.set(t.w, x); }
    const e = t.s === 'BUY' ? (r - t.p) : (t.p - r);
    x.pnl += e * t.sz; x.shares += t.sz;
    if (t.s === 'BUY') { x.buyCost += t.p * t.sz; x.buyShares += t.sz; x.wSum += t.p * t.sz; x.sideSh[t.o === m.win ? 0 : 1] += t.sz; }
    else x.sellShares += t.sz;
  }
  return per;
}

// Estadística sobre la lista de mercados de una wallet [{edgeSh,pnl,cost,...}].
export function stats(mkts) {
  const n = mkts.length; if (!n) return null;
  const mean = mkts.reduce((s, k) => s + k.edgeSh, 0) / n;
  const sd = Math.sqrt(mkts.reduce((s, k) => s + (k.edgeSh - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, pnl: mkts.reduce((s, k) => s + k.pnl, 0), cost: mkts.reduce((s, k) => s + k.cost, 0) };
}

export function spearman(pairs) {
  const rank = (v) => { const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const out = []; idx.forEach(([, i], k) => out[i] = k + 1); return out; };
  const a = rank(pairs.map((p) => p[0])), b = rank(pairs.map((p) => p[1]));
  const n = pairs.length; const d2 = a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0);
  return 1 - 6 * d2 / (n * (n * n - 1));
}

export const median = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const quantile = (v, q) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
