// AA Sports — Worker (API pública de solo-lectura).
//
// Sirve resultados ya calculados desde KV/D1 y hace de proxy con caché para los
// marcadores en vivo (ESPN). El navegador SOLO habla con este Worker; el
// algoritmo nunca sale del cómputo privado.
//
// Rutas:
//   GET /                     -> health / info
//   GET /v1/mlb/today         -> predicciones + métricas del día (KV, cache 60s)
//   GET /v1/mlb/event/:id     -> un evento (desde today; fallback D1)
//   GET /v1/mlb/history?days= -> historial de predicciones (D1)
//   GET /v1/mlb/live          -> marcadores en vivo (proxy ESPN, cache 30s)

const ESPN_SCOREBOARD =
  'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';

// Marcadores en vivo multideporte (mismo patrón proxy+caché que MLB).
// Las predicciones de estos deportes llegarán cuando su modelo pase la
// validación; mientras, AA Sports ya muestra el "en vivo" estilo SofaScore.
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const SOCCER_LEAGUES = {
  'fifa.world': 'Mundial 2026', 'eng.1': 'Premier League', 'esp.1': 'LaLiga',
  'ita.1': 'Serie A', 'ger.1': 'Bundesliga', 'fra.1': 'Ligue 1',
  'usa.1': 'MLS', 'mex.1': 'Liga MX', 'uefa.champions': 'Champions',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = (env && env.ALLOWED_ORIGIN) || '*';

    const path = url.pathname.replace(/\/+$/, '') || '/';
    const isAccount = path.startsWith('/v1/auth') || path.startsWith('/v1/me');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: isAccount ? credCors(request, env) : cors(origin) });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && !isAccount) {
      return json({ error: 'method_not_allowed' }, 405, origin);
    }

    try {
      if (path === '/' || path === '/v1' || path === '/v1/health') {
        return json(
          { service: 'aa-sports-api', ok: true, sports: ['mlb'], routes: ['/v1/mlb/today', '/v1/mlb/event/:id', '/v1/mlb/history', '/v1/mlb/live', '/v1/injuries'] },
          200, origin,
        );
      }

      if (path === '/v1/mlb/today') return await today(env, origin);
      const sm = path.match(/^\/v1\/mlb\/schedule\/(\d{4}-\d{2}-\d{2})$/);
      if (sm) return await schedule(sm[1], origin);
      const dm = path.match(/^\/v1\/mlb\/day\/(\d{4}-\d{2}-\d{2})$/);
      if (dm) return await day(dm[1], env, origin);
      if (path === '/v1/mlb/live') return await live(ctx, origin);
      if (path === '/v1/mlb/history') return await history(url, env, origin);
      if (path === '/v1/nba/live') return await otherLive(ctx, origin, 'nba', `${ESPN_BASE}/basketball/nba/scoreboard`);
      if (path === '/v1/tennis/live') return await tennisLive(ctx, origin);
      if (path === '/v1/soccer/live') {
        const lg = url.searchParams.get('league') || 'fifa.world';
        if (!SOCCER_LEAGUES[lg]) return json({ error: 'unknown_league', leagues: Object.keys(SOCCER_LEAGUES) }, 400, origin);
        return await otherLive(ctx, origin, 'soccer:' + lg, `${ESPN_BASE}/soccer/${lg}/scoreboard`);
      }

      // últimos resultados (fuera de horario / off-season) + tablas de posiciones
      if (path === '/v1/nba/recent') return await recentGames(ctx, origin, 'nba', `${ESPN_BASE}/basketball/nba/scoreboard`);
      if (path === '/v1/tennis/recent') return await tennisRecent(ctx, origin);
      if (path === '/v1/tennis/rankings') return await tennisRankings(ctx, origin);
      if (path === '/v1/soccer/recent') {
        const lg = url.searchParams.get('league') || 'fifa.world';
        if (!SOCCER_LEAGUES[lg]) return json({ error: 'unknown_league' }, 400, origin);
        return await recentGames(ctx, origin, 'soccer:' + lg, `${ESPN_BASE}/soccer/${lg}/scoreboard`);
      }
      if (path === '/v1/mlb/standings') return await standings(ctx, origin, 'mlb-div', 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings?level=3', 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings');
      if (path === '/v1/nba/standings') return await standings(ctx, origin, 'nba', 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings');
      if (path === '/v1/soccer/standings') {
        const lg = url.searchParams.get('league') || 'fifa.world';
        if (!SOCCER_LEAGUES[lg]) return json({ error: 'unknown_league' }, 400, origin);
        return await standings(ctx, origin, 'soccer:' + lg, `https://site.api.espn.com/apis/v2/sports/soccer/${lg}/standings`);
      }
      if (path === '/v1/soccer/leagues') return json({ leagues: SOCCER_LEAGUES }, 200, origin, 3600);
      if (path === '/v1/soccer/today') return await soccerToday(env, origin);

      // Detalle de partido (alineaciones + estadísticas + eventos) — proxy con
      // caché del endpoint summary de ESPN. Descriptivo, sin predicciones.
      if (path === '/v1/soccer/summary' || path === '/v1/nba/summary') {
        const sport = path.split('/')[2];
        const eid = url.searchParams.get('event');
        if (!eid || !/^\d+$/.test(eid)) return json({ error: 'bad_event' }, 400, origin);
        let up;
        if (sport === 'soccer') {
          const lg = url.searchParams.get('league') || 'fifa.world';
          if (!SOCCER_LEAGUES[lg]) return json({ error: 'unknown_league' }, 400, origin);
          up = `${ESPN_BASE}/soccer/${lg}/summary?event=${eid}`;
        } else {
          up = `${ESPN_BASE}/basketball/nba/summary?event=${eid}`;
        }
        return await summary(ctx, origin, sport, eid, up);
      }
      if (path === '/v1/injuries') return await injuries(env, origin);
      if (path === '/v1/poly/radar') return await polyRadar(env, origin);
      if (path === '/v1/mlb/learning') return await mlbLearning(env, origin);
      if (path === '/v1/mlb/simulation') return await mlbSimulation(env, origin);
      if (path === '/v1/poly/alerts') return await polyAlerts(env, origin);
      if (path === '/v1/poly/track') return await polyTrack(env, origin);
      if (path === '/v1/poly/wallet') return await polyWallet(url, ctx, origin);

      // ── cuentas opcionales (Fase 5) ──
      if (path === '/v1/auth/google') return authStart(url, env);
      if (path === '/v1/auth/callback') return await authCallback(url, request, env);
      if (path === '/v1/auth/logout') return authLogout(request, env);
      if (path === '/v1/me') return await me(request, env);
      if (path === '/v1/me/favs') return await meFavs(request, env);
      if (path === '/v1/me/delete') return await meDelete(request, env);

      const ev = path.match(/^\/v1\/mlb\/event\/([^/]+)$/);
      if (ev) return await event(decodeURIComponent(ev[1]), env, origin);

      return json({ error: 'not_found' }, 404, origin);
    } catch (err) {
      return json({ error: 'internal', detail: String(err && err.message || err) }, 500, origin);
    }
  },

  // Crons del Radar:
  //  · "*/5 * * * *"  → vigía: transacciones nuevas de las wallets vigiladas → KV
  //    poly:alerts (+ Telegram si hay secretos).
  //  · "0 13 * * *"   → diario (9am ET): archiva snapshot en D1, mide persistencia
  //    viva + wallets nuevas en el top, publica poly:track y manda el resumen del día.
  // Solo lectura de datos públicos.
  async scheduled(event, env, ctx) {
    if (event && event.cron === '0 13 * * *') ctx.waitUntil(polyDaily(env));
    else ctx.waitUntil(polyWatch(env));
  },
};

// --- rutas ---------------------------------------------------------------

async function today(env, origin) {
  const raw = await env.AA_LATEST.get('mlb:today');
  if (!raw) return json({ sport: 'mlb', events: [], record: null, note: 'sin datos aún' }, 200, origin, 30);
  return new Response(raw, {
    status: 200,
    headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
  });
}

// Alertas del vigía del Radar (las escribe scheduled() cada 5 min).
async function polyAlerts(env, origin) {
  const raw = await env.AA_LATEST.get('poly:alerts');
  if (!raw) return json({ alerts: [], note: 'sin alertas aún' }, 200, origin, 60);
  return new Response(raw, {
    status: 200,
    headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
  });
}

// Buscador de wallet on-demand: consulta la Data API pública en vivo y devuelve
// la actividad reciente + un resumen ligero de CUALQUIER wallet (no solo el top).
// Honesto: datos crudos, sin el filtro anti-trampa del Radar. Caché 2 min/wallet.
async function polyWallet(url, ctx, origin) {
  let addr = (url.searchParams.get('addr') || '').trim().toLowerCase();
  const m = addr.match(/0x[0-9a-f]{40}/); if (m) addr = m[0]; // acepta también una URL de perfil pegada
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return json({ ok: false, error: 'bad_addr' }, 400, origin);
  const cache = caches.default;
  const cacheKey = new Request('https://aa-sports.cache/poly/wallet/' + addr, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(await cached.text(), origin, 120);

  let acts = [], pos = [];
  try {
    // Actividad reciente + posiciones ABIERTAS en paralelo (una sola espera).
    const [ra, rp] = await Promise.all([
      fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=30`, { headers: { Accept: 'application/json' } }),
      fetch(`https://data-api.polymarket.com/positions?user=${addr}&sizeThreshold=1&limit=200`, { headers: { Accept: 'application/json' } }),
    ]);
    if (ra.ok) acts = await ra.json();
    if (rp.ok) pos = await rp.json();
  } catch (e) { /* wallet sin actividad o API caída → lista vacía */ }
  const rows = (Array.isArray(acts) ? acts : []).filter((a) => !a.type || a.type === 'TRADE').slice(0, 20).map((a) => ({
    ts: isFinite(+a.timestamp) ? +a.timestamp : null,
    title: String(a.title || '').slice(0, 90),
    side: a.side || null,
    outcome: a.outcome != null ? String(a.outcome) : null,
    price: isFinite(+a.price) ? +a.price : null,
    usd: a.usdcSize != null && isFinite(+a.usdcSize) ? Math.round(+a.usdcSize)
      : (isFinite(+a.price) && isFinite(+a.size) ? Math.round(+a.price * +a.size) : null),
    pseudonym: a.pseudonym || a.name || null,
  }));
  const buys = rows.filter((r) => r.side === 'BUY').length;
  const usd = rows.reduce((s, r) => s + (r.usd || 0), 0);
  const markets = new Set(rows.map((r) => r.title).filter(Boolean)).size;
  const name = (rows.find((r) => r.pseudonym) || {}).pseudonym || null;
  const payload = JSON.stringify({ ok: true, addr, name, summary: { n: rows.length, buys, sells: rows.length - buys, markets, usd: Math.round(usd) }, open: polyOpen(pos), trades: rows, updated_at: new Date().toISOString() });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=120' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin, 120);
}

// Resumen de posiciones ABIERTAS (mismo cálculo que robot/poly_radar.mjs): la
// cartera actual + el lado honesto que el récord de ganancias oculta (bolsas que
// van perdiendo o valen ~$0 y no ha vendido). Exportado para tests. null si vacío.
export function polyOpen(pos) {
  if (!Array.isArray(pos) || !pos.length) return null;
  const mtm = (p) => { const v = (+p.size || 0) * (+p.curPrice || 0); return v > 0 ? v : (+p.currentValue || 0); };
  const costOf = (p) => { const c = +p.initialValue; return isFinite(c) && c > 0 ? c : (+p.size || 0) * (+p.avgPrice || 0); };
  const items = pos.map((p) => {
    const cost = costOf(p), now = mtm(p);
    const pnl = (p.cashPnl != null && isFinite(+p.cashPnl)) ? +p.cashPnl : (now - cost);
    const cur = +p.curPrice;
    return {
      q: String(p.title || '').slice(0, 90), outcome: p.outcome != null ? String(p.outcome) : null,
      cost: Math.round(cost), now: Math.round(now), pnl: Math.round(pnl), pct: cost > 0 ? +(pnl / cost).toFixed(2) : 0,
      dead: isFinite(cur) && cur <= 0.05 && cost >= 5 && !p.redeemable,
    };
  }).filter((it) => it.cost >= 1);
  if (!items.length) return null;
  const losers = items.filter((it) => it.pnl < 0);
  return {
    value: Math.round(items.reduce((s, it) => s + it.now, 0)),
    cost: Math.round(items.reduce((s, it) => s + it.cost, 0)),
    unrealized: Math.round(items.reduce((s, it) => s + it.pnl, 0)),
    n: items.length, winners: items.filter((it) => it.pnl > 0).length, losers: losers.length,
    dead: items.filter((it) => it.dead).length,
    worst: losers.sort((a, b) => a.pnl - b.pnl).slice(0, 4),
  };
}

// Persistencia viva + wallets nuevas en el top (lo calcula el cron diario a KV
// poly:track). Sin historial aún → { ok:false } y la UI muestra "acumulando".
async function polyTrack(env, origin) {
  const raw = await env.AA_LATEST.get('poly:track');
  if (!raw) return json({ ok: false, note: 'acumulando historial' }, 200, origin, 300);
  return new Response(raw, {
    status: 200,
    headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=1800' },
  });
}

// ── Vigía del Radar (cron) ───────────────────────────────────────────────────
// Lee la watchlist de poly:radar, pide la actividad reciente de cada wallet a la
// Data API pública y detecta trades NUEVOS vs poly:lastseen. La primera vez que
// ve una wallet solo fija la línea base (sin inundar de alertas viejas).
async function polyWatch(env) {
  const raw = await env.AA_LATEST.get('poly:radar');
  if (!raw) return;
  let doc; try { doc = JSON.parse(raw); } catch (e) { return; }
  const watch = (doc.watchlist || []).slice(0, 25);
  if (!watch.length) return;
  const lsRaw = await env.AA_LATEST.get('poly:lastseen');
  let lastseen; try { lastseen = lsRaw ? JSON.parse(lsRaw) : {}; } catch (e) { lastseen = {}; }
  const found = [];
  for (const w of watch) {
    try {
      const r = await fetch(`https://data-api.polymarket.com/activity?user=${encodeURIComponent(w.w)}&limit=15&type=TRADE`, { headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const acts = await r.json();
      const bootstrap = lastseen[w.w] == null;
      const { fresh, maxTs } = polyFreshTrades(acts, bootstrap ? Infinity : lastseen[w.w]);
      const seenMax = maxTs != null ? maxTs : polyMaxTs(acts);
      if (seenMax != null) lastseen[w.w] = seenMax;
      else if (bootstrap) lastseen[w.w] = 0;
      if (!bootstrap) for (const a of fresh) found.push({ ...a, wallet: w.w, pseudonym: w.pseudonym || w.name || null, score: w.insider_score ?? null });
    } catch (e) { /* una wallet fallida no tumba la ronda */ }
  }
  // Escribe SIEMPRE checked_at (aunque no haya nuevas): así la UI puede mostrar
  // "revisado hace X min · cada 5 min" y se prueba que el vigía está vivo.
  const nowIso = new Date().toISOString();
  const oldRaw = await env.AA_LATEST.get('poly:alerts');
  let ad; try { ad = oldRaw ? JSON.parse(oldRaw) : { alerts: [] }; } catch (e) { ad = { alerts: [] }; }
  if (!Array.isArray(ad.alerts)) ad.alerts = [];
  if (found.length) {
    const seen = new Set(ad.alerts.map((a) => a.tx).filter(Boolean));
    const fresh = found.filter((a) => polyAlertWorthy(a) && (!a.tx || !seen.has(a.tx))).sort((a, b) => b.ts - a.ts);
    if (fresh.length) {
      ad.alerts = [...fresh, ...ad.alerts].slice(0, 100);
      ad.updated_at = nowIso;
      if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) await tgNotify(env, fresh.slice(0, 5));
    }
  }
  ad.checked_at = nowIso;
  ad.watching = watch.length;
  await env.AA_LATEST.put('poly:alerts', JSON.stringify(ad));
  await env.AA_LATEST.put('poly:lastseen', JSON.stringify(lastseen));
}

// Helper puro (exportado para tests): filtra la actividad a trades más nuevos
// que sinceTs y los normaliza al shape de alerta.
export function polyFreshTrades(acts, sinceTs) {
  const rows = (Array.isArray(acts) ? acts : [])
    .filter((a) => (!a.type || a.type === 'TRADE') && isFinite(+a.timestamp) && +a.timestamp > sinceTs);
  const maxTs = rows.length ? Math.max(...rows.map((a) => +a.timestamp)) : null;
  return {
    maxTs,
    fresh: rows.map((a) => ({
      ts: +a.timestamp,
      tx: a.transactionHash || null,
      title: String(a.title || '').slice(0, 90),
      side: a.side || null,
      outcome: a.outcome != null ? String(a.outcome) : null,
      price: isFinite(+a.price) ? +a.price : null,
      usd: a.usdcSize != null && isFinite(+a.usdcSize) ? Math.round(+a.usdcSize)
        : (isFinite(+a.price) && isFinite(+a.size) ? Math.round(+a.price * +a.size) : null),
    })),
  };
}
// anti-ruido (exportado para tests): las compras de centavos (< $50) no son
// señal de nada — no ameritan alerta.
export const polyAlertWorthy = (a) => a.usd == null || a.usd >= 50;
export function polyMaxTs(acts) {
  const ts = (Array.isArray(acts) ? acts : []).map((a) => +a.timestamp).filter(isFinite);
  return ts.length ? Math.max(...ts) : null;
}

// Telegram (opcional): agrupa hasta 5 alertas en un mensaje. Sin secretos → no-op.
async function tgNotify(env, alerts) {
  const line = (a) => `🚨 ${a.pseudonym || a.wallet.slice(0, 8)}${a.score != null ? ` (score ${a.score})` : ''}: ${a.side === 'BUY' ? 'COMPRA' : 'VENDE'} "${a.outcome}" a ${a.price != null ? (100 * a.price).toFixed(0) : '?'}¢${a.usd != null ? ` ($${a.usd})` : ''} — ${a.title}`;
  const text = `📡 Radar AA — movimiento de wallets vigiladas:\n\n${alerts.map(line).join('\n\n')}\n\nDescriptivo, no recomendación. aasport.net → Radar`;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text }),
    });
  } catch (e) { /* Telegram caído no afecta las alertas de la página */ }
}

// Radar de wallets de Polymarket (observatorio descriptivo) — lo publica
// robot/poly_radar.mjs 2×/día a KV poly:radar.
async function polyRadar(env, origin) {
  const raw = await env.AA_LATEST.get('poly:radar');
  if (!raw) return json({ wallets: [], note: 'radar en preparación' }, 200, origin, 120);
  return new Response(raw, {
    status: 200,
    headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=600' },
  });
}

// 🧠 Cerebro AA: diario de aprendizaje del modelo MLB (KV mlb:learning), lo
// publica robot/learning_journal.mjs en la corrida diaria.
async function mlbLearning(env, origin) {
  const raw = await env.AA_LATEST.get('mlb:learning');
  if (!raw) return json({ note: 'aún sin diario de aprendizaje' }, 200, origin, 300);
  return new Response(raw, {
    status: 200,
    headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=600' },
  });
}

// ⚽ Predicciones públicas de soccer (KV soccer:today) — pick calibrado + récord
// en vivo + evidencia del backtest. Publicado por robot/soccer_shadow.mjs.
async function soccerToday(env, origin) {
  const raw = await env.AA_LATEST.get('soccer:today');
  if (!raw) return json({ by_id: {}, note: 'pronto' }, 200, origin, 300);
  return new Response(raw, {
    status: 200,
    headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=600' },
  });
}

// 🔬 Validación out-of-sample del modelo MLB (KV mlb:simulation), la publica
// robot/simulate.mjs semanalmente (walk-forward sobre todo el histórico).
async function mlbSimulation(env, origin) {
  const raw = await env.AA_LATEST.get('mlb:simulation');
  if (!raw) return json({ note: 'aún sin simulación publicada' }, 200, origin, 300);
  return new Response(raw, {
    status: 200,
    headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}

// ── Automatizaciones diarias del Radar (cron "0 13 * * *" ≈ 9am ET) ──────────
// Fecha calendario ET (YYYY-MM-DD). etDate() (definida más abajo) convierte un
// timestamp/Date a día del Este; hoy = etDate(new Date()), N días atrás = resta ms.
const etDaysAgo = (n) => etDate(new Date(Date.now() - n * 86400000));

// Helper puro (exportado para tests): a partir del doc del Radar + los snapshots
// previos de D1, calcula la persistencia viva (vigiladas de hace ~7 días que siguen
// hoy) y las wallets nuevas en el top. No toca red ni D1 — se le pasan los datos.
export function polyTrackCompute(doc, { thenDate, thenWatched, seenPrev }) {
  const top = (doc.wallets || []).slice(0, 40);
  const nowWatched = new Set(top.filter((w) => w.watch).map((w) => w.w));
  let persistence = null;
  if (thenDate && Array.isArray(thenWatched) && thenWatched.length) {
    const stayed = thenWatched.filter((w) => nowWatched.has(w)).length;
    persistence = { then_date: thenDate, then_n: thenWatched.length, now_n: nowWatched.size, stayed, overlap: stayed / thenWatched.length };
  }
  let newWallets = [];
  const seen = new Set(seenPrev || []);
  if (seen.size) newWallets = top.slice(0, 10).filter((w) => !seen.has(w.w))
    .map((w) => ({ w: w.w, name: w.pseudonym || w.name || null, pnl: Math.round(+w.pnl_usd || 0) }));
  return { persistence, new_wallets: newWallets };
}

async function polyDaily(env) {
  const raw = await env.AA_LATEST.get('poly:radar');
  if (!raw || !env.DB) return;
  let doc; try { doc = JSON.parse(raw); } catch (e) { return; }
  const top = (doc.wallets || []).slice(0, 40);
  if (!top.length) return;
  const date = etDate(new Date());

  // 1. Tabla (creación perezosa e idempotente) + snapshot de hoy (top 40 por dinero).
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS poly_snapshots (date TEXT NOT NULL, wallet TEXT NOT NULL, name TEXT, pnl REAL, win_rate REAL, watch INTEGER, PRIMARY KEY (date, wallet))'
  ).run();
  await env.DB.batch(top.map((w) => env.DB.prepare(
    'INSERT OR REPLACE INTO poly_snapshots (date, wallet, name, pnl, win_rate, watch) VALUES (?,?,?,?,?,?)'
  ).bind(date, w.w, w.pseudonym || w.name || null, Math.round(+w.pnl_usd || 0), w.win_rate ?? null, w.watch ? 1 : 0)));

  // 2. Datos históricos para el cálculo (snapshot ≈ hace 7 días + wallets de los 7 días previos).
  let thenDate = null, thenWatched = [], seenPrev = [], history = [];
  try {
    const tr = await env.DB.prepare(
      'SELECT date FROM poly_snapshots WHERE date <= ? ORDER BY date DESC LIMIT 1'
    ).bind(etDaysAgo(7)).first();
    if (tr && tr.date) {
      thenDate = tr.date;
      const { results } = await env.DB.prepare('SELECT wallet FROM poly_snapshots WHERE date = ? AND watch = 1').bind(thenDate).all();
      thenWatched = (results || []).map((r) => r.wallet);
    }
    const sp = await env.DB.prepare('SELECT DISTINCT wallet FROM poly_snapshots WHERE date < ? AND date >= ?').bind(date, etDaysAgo(8)).all();
    seenPrev = (sp.results || []).map((r) => r.wallet);
    const hs = await env.DB.prepare('SELECT date, SUM(watch) AS w FROM poly_snapshots GROUP BY date ORDER BY date DESC LIMIT 14').all();
    history = (hs.results || []).map((r) => ({ date: r.date, watched: +r.w || 0 })).reverse();
  } catch (e) { /* primer día: sin historial */ }

  const { persistence, new_wallets } = polyTrackCompute(doc, { thenDate, thenWatched, seenPrev });
  await env.AA_LATEST.put('poly:track', JSON.stringify({ updated_at: new Date().toISOString(), date, persistence, new_wallets, history }));

  // 3. Resumen diario por Telegram (opcional).
  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) await tgDaily(env, doc, new_wallets, persistence);
}

// Resumen diario del Radar por Telegram: Top 3 por dinero + 1 nueva + mejor jugada
// + persistencia viva, en un solo mensaje. Sin secretos → no se llama.
async function tgDaily(env, doc, newWallets, persistence) {
  const money = (x) => '$' + Math.round(+x || 0).toLocaleString('en-US');
  const nm = (w) => w.pseudonym || w.name || String(w.w || '').slice(0, 8);
  const top3 = (doc.wallets || []).slice(0, 3).map((w, i) => `${i + 1}. ${nm(w)} +${money(w.pnl_usd)}`).join('\n');
  const bt = (doc.top_trades || [])[0];
  const lines = ['🏆 Radar AA — resumen del día', '', 'Top 3 por dinero ganado:', top3];
  if (newWallets && newWallets.length) lines.push('', `🆕 Nueva en el top: ${newWallets[0].name || String(newWallets[0].w).slice(0, 8)} (+${money(newWallets[0].pnl)})`);
  if (bt) lines.push('', `🎯 Mejor jugada: "${String(bt.q || '').slice(0, 60)}" +${money(bt.profit)}`);
  if (persistence) lines.push('', `📈 Persistencia viva: de ${persistence.then_n} vigiladas hace ~7 días, ${persistence.stayed} siguen hoy (${Math.round(100 * persistence.overlap)}%).`);
  lines.push('', 'Descriptivo, no recomendación. aasport.net → Radar');
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: lines.join('\n') }),
    });
  } catch (e) { /* Telegram caído no afecta nada */ }
}

// Bajas (lesionados/suspendidos) por equipo — las publica robot/injuries.mjs cada hora.
async function injuries(env, origin) {
  const raw = await env.AA_LATEST.get('injuries:latest');
  if (!raw) return json({ mlb: {}, nba: {}, note: 'sin reporte de bajas aún' }, 200, origin, 120);
  return new Response(raw, {
    status: 200,
    headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=600' },
  });
}

// Día archivado: KV mlb:day:<fecha> (doc completo); fallback D1 (versión ligera).
async function day(date, env, origin) {
  const raw = await env.AA_LATEST.get('mlb:day:' + date);
  if (raw) {
    return new Response(raw, {
      status: 200,
      headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  }
  if (env.DB) {
    const { results } = await env.DB.prepare(
      'SELECT event_id, home, away, pick, prob, confidence, status, result FROM predictions WHERE sport = ? AND date = ? ORDER BY prob DESC',
    ).bind('mlb', date).all();
    if (results && results.length) {
      const events = results.map((r) => ({
        sport: 'mlb', league: 'MLB', event_id: String(r.event_id),
        matchup: `${r.away} @ ${r.home}`, start: date, status: r.status || 'final',
        home: { code: r.home, name: r.home }, away: { code: r.away, name: r.away },
        prediction: {
          pick: r.pick, prob: r.prob,
          prob_pct: r.prob != null ? Math.round(r.prob * 1000) / 10 : null,
          confidence: r.confidence, engine_version: null,
        },
        metrics: [], summary_es: null, snapshot: null, risk: null, odds: null,
        badges: [], result: r.result || null, final: null, live: null, updated_at: null,
      }));
      return json({ sport: 'mlb', league: 'MLB', date, source: 'd1', record: null, events }, 200, origin, 300);
    }
  }
  return json({ sport: 'mlb', date, events: [], note: 'sin datos para esa fecha' }, 200, origin, 120);
}

// 📅 Calendario a FUTURO: quién juega contra quién en un día venidero (sin
// predicción — el modelo corre el día del juego). Proxy de MLB StatsAPI, que el
// Worker sí alcanza; caché 30 min. Devuelve el MISMO shape que day() pero ligero.
async function schedule(date, origin) {
  let events = [];
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team`,
      { headers: { 'user-agent': 'aa-sports/1.0' }, cf: { cacheTtl: 1800 } },
    );
    if (res.ok) {
      const data = await res.json();
      const games = (data.dates && data.dates[0] && data.dates[0].games) || [];
      const teamOf = (t) => {
        const team = (t && t.team) || {};
        return { code: team.abbreviation || team.teamName || team.name || '?', name: team.shortName || team.teamName || team.name || '' };
      };
      const nameOf = (pp) => (pp && (pp.fullName || pp.lastName)) || null;
      events = games.map((g) => {
        const away = teamOf(g.teams && g.teams.away), home = teamOf(g.teams && g.teams.home);
        const app = g.teams && g.teams.away && g.teams.away.probablePitcher;
        const hpp = g.teams && g.teams.home && g.teams.home.probablePitcher;
        return {
          sport: 'mlb', league: 'MLB', event_id: String(g.gamePk),
          matchup: `${away.code} @ ${home.code}`, start: g.gameDate || date, status: 'pre',
          home, away,
          prediction: null, metrics: [], summary_es: null,
          snapshot: (app || hpp) ? { pitchers: { away: nameOf(app) ? { name: nameOf(app) } : null, home: nameOf(hpp) ? { name: nameOf(hpp) } : null } } : null,
          risk: null, odds: null, badges: [], result: null, final: null, live: null, updated_at: null,
        };
      });
    }
  } catch (e) { /* upstream caído → lista vacía */ }

  return json({ sport: 'mlb', league: 'MLB', date, source: 'statsapi', future: true, record: null, events }, 200, origin, 1800);
}

async function event(id, env, origin) {
  const raw = await env.AA_LATEST.get('mlb:today');
  if (raw) {
    const doc = JSON.parse(raw);
    const hit = (doc.events || []).find((e) => e.event_id === id);
    if (hit) return json(hit, 200, origin, 60);
  }
  // Fallback: fila mínima desde D1 (historial).
  if (env.DB) {
    const row = await env.DB.prepare(
      'SELECT * FROM predictions WHERE sport = ? AND event_id = ? ORDER BY date DESC LIMIT 1',
    ).bind('mlb', id).first();
    if (row) return json(row, 200, origin, 60);
  }
  return json({ error: 'event_not_found', event_id: id }, 404, origin);
}

async function history(url, env, origin) {
  if (!env.DB) return json({ error: 'no_db' }, 503, origin);
  const days = Math.min(60, Math.max(1, parseInt(url.searchParams.get('days') || '14', 10) || 14));
  const { results } = await env.DB.prepare(
    'SELECT date, event_id, home, away, pick, prob, confidence, status, result, engine_version ' +
    'FROM predictions WHERE sport = ? ORDER BY date DESC, prob DESC LIMIT ?',
  ).bind('mlb', days * 40).all();
  return json({ sport: 'mlb', days, count: results.length, predictions: results }, 200, origin, 120);
}

// Marcadores en vivo: proxy a ESPN con caché de borde (30s) para no golpear la
// API y sentirse SofaScore sin recalcular el modelo.
async function live(ctx, origin) {
  const cache = caches.default;
  const cacheKey = new Request('https://aa-sports.cache/mlb/live', { method: 'GET' });
  let cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return withCors(body, origin);
  }

  const res = await fetch(ESPN_SCOREBOARD, { headers: { 'user-agent': 'aa-sports/1.0' }, cf: { cacheTtl: 30 } });
  if (!res.ok) return json({ sport: 'mlb', games: [], note: 'live upstream ' + res.status }, 200, origin, 15);
  const data = await res.json();

  const games = (data.events || []).map((ev) => {
    const c = (ev.competitions && ev.competitions[0]) || {};
    const comp = c.competitors || [];
    const home = comp.find((x) => x.homeAway === 'home') || {};
    const away = comp.find((x) => x.homeAway === 'away') || {};
    const st = (c.status && c.status.type) || (ev.status && ev.status.type) || {};
    const sit = c.situation || null;
    const recOf = (t) => {
      const r = Array.isArray(t.records) && t.records.find((x) => x.type === 'total' || x.name === 'overall');
      return (r && r.summary) || (t.records && t.records[0] && t.records[0].summary) || null;
    };
    // batter/pitcher del situation de ESPN: id de athlete de ESPN (no MLBAM),
    // por eso el headshot sale de athlete.headshot.href y no de mlbstatic.
    const athOf = (x) => (x && x.athlete) ? {
      name: x.athlete.shortName || x.athlete.displayName || null,
      id: x.athlete.id || null,
      headshot: (x.athlete.headshot && x.athlete.headshot.href)
        || (typeof x.athlete.headshot === 'string' ? x.athlete.headshot : null),
      summary: (typeof x.summary === 'string' && x.summary) || null,
    } : null;
    return {
      espn_id: ev.id,
      start: ev.date || null,
      date: etDate(ev.date), // día del juego en horario del Este (para el candado de mismo día)
      status: mapEspnStatus(st.name),
      status_detail: st.shortDetail || st.detail || null,
      home: { code: home.team && home.team.abbreviation, score: numOrNull(home.score), rec: recOf(home) },
      away: { code: away.team && away.team.abbreviation, score: numOrNull(away.score), rec: recOf(away) },
      period: (c.status && c.status.period) || null,
      situation: sit ? {
        balls: numOrNull(sit.balls), strikes: numOrNull(sit.strikes), outs: numOrNull(sit.outs),
        onFirst: !!sit.onFirst, onSecond: !!sit.onSecond, onThird: !!sit.onThird,
        batter: athOf(sit.batter),
        pitcher: athOf(sit.pitcher),
        lastPlay: (sit.lastPlay && typeof sit.lastPlay.text === 'string' && sit.lastPlay.text)
          ? sit.lastPlay.text.slice(0, 140) : null,
      } : null,
    };
  });

  // Probabilidad de victoria EN VIVO (ESPN summary) solo para juegos en curso —
  // número honesto que se mueve con el marcador (un blowout baja a ~0), en vez de
  // dejar congelado el % de antes del juego. Acotado a los live; cacheado con el
  // resto (30s). homeWinPercentage viene 0-1 (a veces 0-100).
  const liveIds = games.filter((g) => g.status === 'live').map((g) => g.espn_id).filter(Boolean);
  if (liveIds.length) {
    const wps = await Promise.all(liveIds.map(async (id) => {
      try {
        const r = await fetch(`${ESPN_BASE}/baseball/mlb/summary?event=${id}`, { headers: { 'user-agent': 'aa-sports/1.0' }, cf: { cacheTtl: 30 } });
        if (!r.ok) return [id, null];
        const d = await r.json();
        const arr = d && d.winprobability;
        if (!Array.isArray(arr) || !arr.length) return [id, null];
        let wp = numOrNull(arr[arr.length - 1].homeWinPercentage);
        if (wp == null) return [id, null];
        if (wp > 1) wp = wp / 100;
        return [id, Math.max(0, Math.min(1, wp))];
      } catch (e) { return [id, null]; }
    }));
    const wpMap = new Map(wps);
    for (const g of games) { const v = wpMap.get(g.espn_id); if (v != null) g.win_prob_home = v; }
  }

  const payload = JSON.stringify({ sport: 'mlb', updated_at: new Date().toISOString(), games });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin);
}

// Live genérico (NBA y soccer): mismo esquema que MLB live, sin situation.
async function otherLive(ctx, origin, cacheTag, upstream) {
  const cache = caches.default;
  const cacheKey = new Request('https://aa-sports.cache/' + cacheTag + '/live', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(await cached.text(), origin);

  const res = await fetch(upstream, { headers: { 'user-agent': 'aa-sports/1.0' }, cf: { cacheTtl: 30 } });
  if (!res.ok) return json({ games: [], note: 'live upstream ' + res.status }, 200, origin, 15);
  const data = await res.json();

  const games = (data.events || []).map((ev) => {
    const c = (ev.competitions && ev.competitions[0]) || {};
    const comp = c.competitors || [];
    const home = comp.find((x) => x.homeAway === 'home') || comp[0] || {};
    const away = comp.find((x) => x.homeAway === 'away') || comp[1] || {};
    const st = (c.status && c.status.type) || (ev.status && ev.status.type) || {};
    // leaders (NBA: Pts/Reb/Ast) y form ("WWDLW" en soccer), ambos opcionales.
    const leadersOf = (t) => Array.isArray(t.leaders) ? t.leaders.slice(0, 3).map((L) => {
      const top = Array.isArray(L.leaders) && L.leaders[0];
      return (top && top.athlete && (top.athlete.shortName || top.athlete.displayName)) ? {
        cat: L.shortDisplayName || L.abbreviation || L.name || null,
        name: top.athlete.shortName || top.athlete.displayName,
        value: top.displayValue ?? numOrNull(top.value),
        headshot: (typeof top.athlete.headshot === 'string' && top.athlete.headshot)
          || (top.athlete.headshot && top.athlete.headshot.href) || null,
      } : null;
    }).filter(Boolean) : null;
    const side = (t) => ({
      code: (t.team && (t.team.abbreviation || t.team.shortDisplayName)) || null,
      name: (t.team && (t.team.shortDisplayName || t.team.displayName)) || null,
      logo: (t.team && (t.team.logo || (t.team.logos && t.team.logos[0] && t.team.logos[0].href))) || null,
      score: numOrNull(t.score),
      rec: (Array.isArray(t.records) && t.records[0] && t.records[0].summary) || null,
      form: (typeof t.form === 'string' && t.form) ? t.form.slice(0, 6) : null,
      leaders: (() => { const l = leadersOf(t); return l && l.length ? l : null; })(),
    });
    return {
      espn_id: ev.id,
      start: ev.date || null,
      league: (ev.league && ev.league.abbreviation) || null,
      status: mapEspnStatus(st.name),
      status_detail: st.shortDetail || st.detail || ((c.status && c.status.displayClock) || null),
      clock: (c.status && c.status.displayClock) || null,
      period: (c.status && c.status.period) || null,
      home: side(home), away: side(away),
    };
  });

  const payload = JSON.stringify({ updated_at: new Date().toISOString(), games });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin);
}

// Detalle de un partido (alineaciones/formación + estadísticas + eventos para
// soccer; box score por jugador + estadísticas de equipo para NBA). Proxy con
// caché del endpoint summary de ESPN. Todo descriptivo (datos reales), sin
// predicciones — respeta el ADN honesto de los deportes aún no validados.
async function summary(ctx, origin, sport, eid, upstream) {
  const cache = caches.default;
  const cacheKey = new Request('https://aa-sports.cache/' + sport + '/summary/' + eid, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(await cached.text(), origin, 60);

  const res = await fetch(upstream, { headers: { 'user-agent': 'aa-sports/1.0' }, cf: { cacheTtl: 60 } });
  if (!res.ok) return json({ ok: false, note: 'summary upstream ' + res.status }, 200, origin, 30);
  let data;
  try { data = await res.json(); } catch (e) { return json({ ok: false, note: 'summary non-json' }, 200, origin, 30); }

  const payloadObj = sport === 'soccer' ? soccerSummary(data) : nbaSummary(data);
  const payload = JSON.stringify({ ok: true, updated_at: new Date().toISOString(), ...payloadObj });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin, 60);
}

// Elige el bloque home/away de un array cuyos elementos traen homeAway (o cae
// al orden: índice 0 = local por convención de ESPN cuando falta la etiqueta).
function pickSides(arr) {
  const list = Array.isArray(arr) ? arr : [];
  const home = list.find((x) => x && x.homeAway === 'home') || list[0] || null;
  const away = list.find((x) => x && x.homeAway === 'away') || list[1] || null;
  return { home, away };
}

// Estadísticas de soccer que mostramos, traducidas (name de ESPN → etiqueta ES).
const SOCCER_STAT_LABELS = [
  ['possessionPct', 'Posesión %'], ['totalShots', 'Tiros'],
  ['shotsOnTarget', 'Tiros al arco'], ['wonCorners', 'Tiros de esquina'],
  ['foulsCommitted', 'Faltas'], ['yellowCards', 'Amarillas'],
  ['redCards', 'Rojas'], ['offsides', 'Fuera de juego'],
  ['saves', 'Atajadas'], ['accuratePasses', 'Pases completados'],
  ['totalPasses', 'Pases totales'], ['passPct', '% de pases'],
];

function soccerSummary(data) {
  const rosterSides = pickSides(data.rosters);
  const lineupOf = (block) => {
    if (!block) return null;
    const list = Array.isArray(block.roster) ? block.roster : [];
    const mapP = (p) => ({
      name: (p.athlete && (p.athlete.shortName || p.athlete.displayName)) || null,
      id: (p.athlete && p.athlete.id) || null,
      pos: (p.position && (p.position.abbreviation || p.position.name)) || null,
      jersey: p.jersey || null,
    });
    const starters = list.filter((p) => p.starter).map(mapP).filter((p) => p.name);
    const subs = list.filter((p) => !p.starter).map(mapP).filter((p) => p.name);
    return { code: (block.team && block.team.abbreviation) || null, formation: block.formation || null, starters, subs };
  };
  const lineups = (rosterSides.home || rosterSides.away)
    ? { home: lineupOf(rosterSides.home), away: lineupOf(rosterSides.away) } : null;

  const teamSides = pickSides((data.boxscore && data.boxscore.teams) || []);
  const statMap = (block) => {
    const m = {};
    for (const s of ((block && block.statistics) || [])) if (s && s.name != null) m[s.name] = s.displayValue;
    return m;
  };
  const hs = statMap(teamSides.home), as = statMap(teamSides.away);
  const stats = SOCCER_STAT_LABELS
    .filter(([k]) => hs[k] != null || as[k] != null)
    .map(([k, label]) => ({ label, home: hs[k] ?? null, away: as[k] ?? null }));

  const homeAbbr = (teamSides.home && teamSides.home.team && teamSides.home.team.abbreviation) || (lineups && lineups.home && lineups.home.code) || null;
  const events = (Array.isArray(data.keyEvents) ? data.keyEvents : [])
    .filter((e) => e && (e.type || e.text))
    .slice(0, 40)
    .map((e) => {
      const teamAbbr = (e.team && e.team.abbreviation) || null;
      return {
        clock: (e.clock && e.clock.displayValue) || null,
        type: (e.type && (e.type.text || e.type.type)) || null,
        text: e.text || null,
        side: teamAbbr ? (teamAbbr === homeAbbr ? 'home' : 'away') : null,
        scoring: !!e.scoringPlay,
      };
    });

  return { sport: 'soccer', lineups, stats: stats.length ? stats : null, events: events.length ? events : null };
}

// Estadísticas de equipo de NBA que mostramos (label de ESPN → etiqueta ES).
const NBA_TEAM_STAT_LABELS = {
  'FG': 'Tiros de campo', 'Field Goal %': '% Tiros de campo', '3PT': 'Triples',
  'Three Point %': '% Triples', 'FT': 'Tiros libres', 'Rebounds': 'Rebotes',
  'Assists': 'Asistencias', 'Steals': 'Robos', 'Blocks': 'Tapones',
  'Turnovers': 'Pérdidas', 'Fast Break Points': 'Puntos al contragolpe',
  'Points in Paint': 'Puntos en la pintura',
};

function nbaSummary(data) {
  const teamSides = pickSides((data.boxscore && data.boxscore.players) || []);
  const rowsOf = (block) => {
    if (!block) return null;
    const s = (Array.isArray(block.statistics) && block.statistics[0]) || {};
    const labels = (s.labels || s.names || []).map((x) => String(x).toUpperCase());
    const idx = (n) => labels.indexOf(n);
    const iMin = idx('MIN'), iPts = idx('PTS'), iReb = idx('REB'), iAst = idx('AST'),
      iFg = idx('FG'), i3 = idx('3PT'), iPm = labels.findIndex((l) => l.includes('+/-') || l === '+/-');
    const list = (s.athletes || []).map((a) => {
      const st = a.stats || [];
      const g = (i) => (i >= 0 && st[i] != null ? st[i] : null);
      return {
        name: (a.athlete && (a.athlete.shortName || a.athlete.displayName)) || null,
        id: (a.athlete && a.athlete.id) || null,
        starter: !!a.starter,
        min: g(iMin), pts: g(iPts), reb: g(iReb), ast: g(iAst), fg: g(iFg), tpt: g(i3), pm: g(iPm),
      };
    }).filter((r) => r.name && r.min != null && r.min !== '0' && r.min !== '--');
    return { code: (block.team && block.team.abbreviation) || null, list };
  };
  const players = (teamSides.home || teamSides.away)
    ? { home: rowsOf(teamSides.home), away: rowsOf(teamSides.away) } : null;

  const tSides = pickSides((data.boxscore && data.boxscore.teams) || []);
  const statMap = (block) => {
    const m = {};
    for (const s of ((block && block.statistics) || [])) if (s && s.label != null) m[s.label] = s.displayValue;
    return m;
  };
  const hs = statMap(tSides.home), as = statMap(tSides.away);
  const stats = Object.entries(NBA_TEAM_STAT_LABELS)
    .filter(([k]) => hs[k] != null || as[k] != null)
    .map(([k, label]) => ({ label, home: hs[k] ?? null, away: as[k] ?? null }));

  return { sport: 'nba', players, stats: stats.length ? stats : null };
}

// Tenis: los "events" de ESPN son torneos con partidos adentro; cada
// competitor es un atleta (no team). Aplanamos a lista de partidos.
// Últimos resultados: rango de fechas hacia atrás en un solo request de ESPN
// (?dates=YYYYMMDD-YYYYMMDD). Cubre off-season: aunque el último juego sea de
// hace semanas (p. ej. las Finales de junio), aparece.
const ymd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');

async function recentGames(ctx, origin, cacheTag, upstream) {
  const cache = caches.default;
  const cacheKey = new Request('https://aa-sports.cache/' + cacheTag + '/recent', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(await cached.text(), origin, 300);

  const to = new Date(), from = new Date(Date.now() - 60 * 86400000);
  const res = await fetch(`${upstream}?dates=${ymd(from)}-${ymd(to)}&limit=350`, { headers: { 'user-agent': 'aa-sports/1.0' } });
  if (!res.ok) return json({ games: [], note: 'recent upstream ' + res.status }, 200, origin, 60);
  const data = await res.json();

  const games = (data.events || []).map((ev) => {
    const c = (ev.competitions && ev.competitions[0]) || {};
    const comp = c.competitors || [];
    const home = comp.find((x) => x.homeAway === 'home') || comp[0] || {};
    const away = comp.find((x) => x.homeAway === 'away') || comp[1] || {};
    const st = (c.status && c.status.type) || (ev.status && ev.status.type) || {};
    const side = (t) => ({
      code: (t.team && (t.team.abbreviation || t.team.shortDisplayName)) || null,
      name: (t.team && (t.team.shortDisplayName || t.team.displayName)) || null,
      logo: (t.team && (t.team.logo || (t.team.logos && t.team.logos[0] && t.team.logos[0].href))) || null,
      score: numOrNull(t.score),
      rec: (Array.isArray(t.records) && t.records[0] && t.records[0].summary) || null,
      winner: !!t.winner,
      form: (typeof t.form === 'string' && t.form) ? t.form.slice(0, 6) : null,
    });
    return {
      espn_id: ev.id, start: ev.date || null, date: ev.date ? String(ev.date).slice(0, 10) : null,
      league: (ev.league && ev.league.abbreviation) || null,
      status: mapEspnStatus(st.name), status_detail: st.shortDetail || st.detail || null,
      home: side(home), away: side(away),
    };
  }).filter((g) => g.status === 'final')
    .sort((a, b) => String(b.start).localeCompare(String(a.start)))
    .slice(0, 30);

  const payload = JSON.stringify({ updated_at: new Date().toISOString(), games });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin, 300);
}

// Tenis: finales de los últimos días (ATP+WTA aplanados como en tennisLive)
async function tennisRecent(ctx, origin) {
  const cache = caches.default;
  const cacheKey = new Request('https://aa-sports.cache/tennis/recent', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(await cached.text(), origin, 300);

  const to = new Date(), from = new Date(Date.now() - 7 * 86400000);
  const out = [];
  for (const tour of ['atp', 'wta']) {
    try {
      const res = await fetch(`${ESPN_BASE}/tennis/${tour}/scoreboard?dates=${ymd(from)}-${ymd(to)}&limit=150`, { headers: { 'user-agent': 'aa-sports/1.0' } });
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of (data.events || [])) {
        const comps = ev.competitions || (ev.groupings || []).flatMap((g) => g.competitions || []);
        for (const c of comps) {
          const players = c.competitors || [];
          if (players.length < 2) continue;
          const st = (c.status && c.status.type) || {};
          if (mapEspnStatus(st.name) !== 'final') continue;
          const p = (x) => {
            const ls = Array.isArray(x.linescores) ? x.linescores : [];
            return {
              id: (x.athlete && x.athlete.id) || x.id || null,
              code: (x.athlete && (x.athlete.shortName || x.athlete.displayName)) || null,
              name: (x.athlete && x.athlete.displayName) || null,
              logo: (x.athlete && x.athlete.flag && x.athlete.flag.href) || null,
              score: numOrNull(x.score),
              sets: ls.map((l) => numOrNull(l.value)).filter((v) => v != null),
              setscore: ls.length ? ls.map((l) => ({ g: numOrNull(l.value), tb: numOrNull(l.tiebreak) })) : null,
              winner: !!x.winner,
            };
          };
          out.push({
            espn_id: c.id || ev.id, start: c.date || ev.date || null,
            date: String(c.date || ev.date || '').slice(0, 10) || null,
            league: tour.toUpperCase() + (ev.name ? ' · ' + ev.name : ''),
            status: 'final', status_detail: st.shortDetail || st.detail || 'Final',
            home: p(players[0]), away: p(players[1]),
          });
        }
      }
    } catch (e) { /* un tour caído no tumba el otro */ }
  }
  out.sort((a, b) => String(b.start).localeCompare(String(a.start)));
  const payload = JSON.stringify({ updated_at: new Date().toISOString(), games: out.slice(0, 30) });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin, 300);
}

// Ranking mundial ATP/WTA (semanal → caché larga). El id del athlete es el
// mismo del competitor del scoreboard, así el frontend une rank ↔ partido.
async function tennisRankings(ctx, origin) {
  const cache = caches.default;
  const cacheKey = new Request('https://aa-sports.cache/tennis/rankings', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(await cached.text(), origin, 3600);

  const sections = [];
  for (const tour of ['atp', 'wta']) {
    try {
      const res = await fetch(`${ESPN_BASE}/tennis/${tour}/rankings`, { headers: { 'user-agent': 'aa-sports/1.0' } });
      if (!res.ok) continue;
      const data = await res.json();
      const rk = (data.rankings || []).find((r) => Array.isArray(r.ranks) && r.ranks.length) || null;
      if (!rk) continue;
      const rows = rk.ranks.slice(0, 50).map((r) => {
        const a = r.athlete || {};
        const rank = numOrNull(r.current);
        return (rank == null || rank <= 0 || !a.displayName) ? null : {
          rank,
          prev: numOrNull(r.previous),
          trend: (typeof r.trend === 'string' && r.trend) || null,
          points: numOrNull(r.points),
          id: a.id || null,
          name: a.displayName,
          short: a.shortname || a.shortName || null,
          flag: (a.flag && a.flag.href) || null,
        };
      }).filter(Boolean);
      if (rows.length) sections.push({ name: tour.toUpperCase(), rows });
    } catch (e) { /* un tour caído no tumba el otro */ }
  }

  const payload = JSON.stringify({ updated_at: new Date().toISOString(), sections });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=21600' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin, 3600);
}

// Tabla de posiciones (NBA por conferencia; soccer tabla de liga o grupos).
// En off-season ESPN devuelve la última temporada — justo lo que queremos.
async function standings(ctx, origin, cacheTag, upstream, altUpstream) {
  const cache = caches.default;
  const cacheKey = new Request('https://aa-sports.cache/' + cacheTag + '/standings', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(await cached.text(), origin, 600);

  const mapEntries = (entries) => (entries || []).map((e) => {
    const stat = (n) => { const x = (e.stats || []).find((t) => t.name === n || t.type === n); return x ? (x.displayValue ?? x.value ?? null) : null; };
    return {
      code: (e.team && e.team.abbreviation) || null,
      name: (e.team && (e.team.shortDisplayName || e.team.displayName)) || null,
      logo: (e.team && e.team.logos && e.team.logos[0] && e.team.logos[0].href) || null,
      rank: numOrNull(stat('rank')),
      gp: stat('gamesPlayed'), w: stat('wins'), d: stat('ties'), l: stat('losses'),
      pct: stat('winPercent'), gb: stat('gamesBehind'),
      gd: stat('pointDifferential') ?? stat('goalDifferential') ?? stat('pointsDiff'),
      pts: stat('points'),
    };
  });
  // Recolecta secciones de forma recursiva: NBA/soccer traen las entradas en el
  // primer nivel de children; si un nodo no tiene entradas propias, baja a sus hijos.
  const collect = (node) => (node.standings && node.standings.entries && node.standings.entries.length)
    ? [{ name: node.name || node.abbreviation || '', rows: mapEntries(node.standings.entries) }]
    : (node.children || []).flatMap(collect);
  const parse = (data) => {
    let sections = (data.children || []).flatMap(collect).filter((s) => s.rows.length);
    if (!sections.length && data.standings && data.standings.entries) {
      sections = [{ name: data.name || '', rows: mapEntries(data.standings.entries) }];
    }
    for (const s of sections) s.rows.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    return { season: (data.season && (data.season.displayName || data.season.year)) || null, sections };
  };
  const grab = async (url) => {
    try { const r = await fetch(url, { headers: { 'user-agent': 'aa-sports/1.0' } }); if (!r.ok) return null; return parse(await r.json()); }
    catch (e) { return null; }
  };

  // Se prefiere el desglose con MÁS secciones (p.ej. las divisiones de MLB con
  // ?level=3) y se cae al principal si el alterno falla o trae menos → cero regresión.
  let best = await grab(upstream);
  if (altUpstream) { const alt = await grab(altUpstream); if (alt && (!best || alt.sections.length > best.sections.length)) best = alt; }
  if (!best) return json({ sections: [], note: 'standings upstream' }, 200, origin, 120);

  const payload = JSON.stringify({ updated_at: new Date().toISOString(), season: best.season, sections: best.sections });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin, 600);
}

async function tennisLive(ctx, origin) {
  const cache = caches.default;
  const cacheKey = new Request('https://aa-sports.cache/tennis/live', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(await cached.text(), origin);

  const out = [];
  for (const tour of ['atp', 'wta']) {
    try {
      const res = await fetch(`${ESPN_BASE}/tennis/${tour}/scoreboard`, { headers: { 'user-agent': 'aa-sports/1.0' }, cf: { cacheTtl: 45 } });
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of (data.events || [])) {
        const comps = ev.competitions || (ev.groupings || []).flatMap((g) => g.competitions || []);
        for (const c of comps) {
          const players = c.competitors || [];
          if (players.length < 2) continue;
          const st = (c.status && c.status.type) || {};
          const p = (x) => {
            const ls = Array.isArray(x.linescores) ? x.linescores : [];
            return {
              id: (x.athlete && x.athlete.id) || x.id || null,
              code: (x.athlete && (x.athlete.shortName || x.athlete.displayName)) || (x.team && x.team.shortDisplayName) || null,
              name: (x.athlete && x.athlete.displayName) || null,
              logo: (x.athlete && x.athlete.flag && x.athlete.flag.href) || null,
              score: numOrNull(x.score),
              sets: ls.map((l) => numOrNull(l.value)).filter((v) => v != null),
              setscore: ls.length ? ls.map((l) => ({ g: numOrNull(l.value), tb: numOrNull(l.tiebreak) })) : null,
              winner: !!x.winner,
            };
          };
          out.push({
            espn_id: c.id || ev.id,
            start: c.date || ev.date || null,
            league: (tour.toUpperCase()) + (ev.name ? ' · ' + ev.name : ''),
            status: mapEspnStatus(st.name),
            status_detail: st.shortDetail || st.detail || null,
            home: p(players[0]), away: p(players[1]),
          });
          if (out.length >= 40) break;
        }
        if (out.length >= 40) break;
      }
    } catch (e) { /* torneo caído: seguimos con el otro tour */ }
  }

  const payload = JSON.stringify({ updated_at: new Date().toISOString(), games: out });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=45' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin);
}

// --- helpers -------------------------------------------------------------

function mapEspnStatus(name) {
  const s = String(name || '').toUpperCase();
  if (s.includes('FINAL') || s.includes('COMPLETED')) return 'final';
  if (s.includes('IN_PROGRESS') || s.includes('IN ') || s.includes('DELAY') || s.includes('RAIN')) return 'live';
  return 'pre';
}

function numOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Día del juego en horario del Este (US). ESPN da la fecha en UTC; un juego
// nocturno cae en el día UTC siguiente, así que el corte UTC engañaría al
// candado de "mismo día". en-CA da YYYY-MM-DD.
function etDate(iso) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
  } catch (e) { return String(iso).slice(0, 10); }
}

function cors(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

function withCors(body, origin, maxAge = 30) {
  return new Response(body, {
    status: 200,
    headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` },
  });
}

function json(obj, status, origin, maxAge) {
  const headers = { ...cors(origin), 'content-type': 'application/json; charset=utf-8' };
  if (maxAge) headers['cache-control'] = `public, max-age=${maxAge}`;
  return new Response(JSON.stringify(obj), { status, headers });
}

/* ══ Fase 5 — cuentas OPCIONALES (login con Google, favoritos sync) ═══════
   Principios: opt-in total, datos mínimos (nombre/email/foto de Google),
   el usuario puede borrar su cuenta, y NADA del sitio requiere login.
   Sesión: cookie HttpOnly firmada con HMAC-SHA256 (AUTH_SECRET), 30 días.
   Config (si falta, /v1/me responde enabled:false y la app oculta el botón):
     - var SITE_ORIGIN (wrangler.toml) — a dónde volver tras el login
     - secrets GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET          */

const SESSION_DAYS = 30;

function authEnabled(env) {
  return !!(env && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.AUTH_SECRET);
}
function siteOrigin(env) { return (env && env.SITE_ORIGIN) || 'https://aasport.net'; }
// la URL vieja de pages.dev sigue funcionando durante la transición al dominio
const LEGACY_HOST = 'aa-sports-5ap.pages.dev';

// CORS con credenciales: exige origen EXACTO de la app (o www/previews)
function allowedOrigin(request, env) {
  const o = request.headers.get('origin') || '';
  if (!o) return null;
  if (o === siteOrigin(env)) return o;
  try {
    const host = new URL(o).host;
    const siteHost = new URL(siteOrigin(env)).host;
    if (host.endsWith('.' + siteHost)) return o;                       // www.aasport.net
    if (host === LEGACY_HOST || host.endsWith('.' + LEGACY_HOST)) return o;
    if (host === 'localhost' || host.startsWith('localhost:')) return o; // dev local
  } catch (e) { /* origen inválido */ }
  return null;
}
function credCors(request, env) {
  const o = allowedOrigin(request, env);
  return {
    'access-control-allow-origin': o || siteOrigin(env),
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-credentials': 'true',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}
function credJson(obj, status, request, env, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...credCors(request, env), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

// — firma HMAC (Web Crypto) —
const te = new TextEncoder();
function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToStr(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, te.encode(msg)));
}
async function makeToken(env, payload) {
  const body = b64url(te.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(env.AUTH_SECRET, body)}`;
}
async function readToken(env, token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (sig !== await hmac(env.AUTH_SECRET, body)) return null;
  try {
    const p = JSON.parse(b64urlToStr(body));
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch (e) { return null; }
}
function getCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
function sessionCookie(value, maxAge) {
  return `aa_sess=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=None`;
}
async function sessionUser(request, env) {
  if (!authEnabled(env)) return null;
  return await readToken(env, getCookie(request, 'aa_sess'));
}

// — flujo OAuth de Google —
function authStart(url, env) {
  if (!authEnabled(env)) return new Response('auth no configurado', { status: 503 });
  const redirect = `${url.origin}/v1/auth/callback`;
  const state = crypto.randomUUID();
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', redirect);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'openid email profile');
  auth.searchParams.set('state', state);
  auth.searchParams.set('prompt', 'select_account');
  return new Response(null, {
    status: 302,
    headers: {
      location: auth.toString(),
      // cookie corta anti-CSRF para validar el state al volver
      'set-cookie': `aa_state=${state}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=None`,
    },
  });
}

async function authCallback(url, request, env) {
  if (!authEnabled(env)) return new Response('auth no configurado', { status: 503 });
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== getCookie(request, 'aa_state')) {
    return new Response('login inválido (state)', { status: 400 });
  }
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/v1/auth/callback`, grant_type: 'authorization_code',
    }),
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tokRes.ok || !tok.id_token) return new Response('login falló (token)', { status: 502 });
  // id_token llega directo de Google por TLS en el canal servidor-a-servidor
  let claims;
  try { claims = JSON.parse(b64urlToStr(tok.id_token.split('.')[1])); }
  catch (e) { return new Response('login falló (claims)', { status: 502 }); }
  if (!claims.sub) return new Response('login falló (sub)', { status: 502 });

  await env.DB.prepare(
    `INSERT INTO users (provider, provider_id, email, name, picture, created_at)
     VALUES ('google', ?, ?, ?, ?, ?)
     ON CONFLICT (provider, provider_id) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`,
  ).bind(claims.sub, claims.email || null, claims.name || null, claims.picture || null, new Date().toISOString()).run();
  const row = await env.DB.prepare("SELECT id FROM users WHERE provider = 'google' AND provider_id = ?").bind(claims.sub).first();

  const token = await makeToken(env, {
    uid: row.id, name: claims.name || null, pic: claims.picture || null, email: claims.email || null,
    exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400,
  });
  const headers = new Headers({ location: siteOrigin(env) });
  headers.append('set-cookie', sessionCookie(token, SESSION_DAYS * 86400));
  headers.append('set-cookie', 'aa_state=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=None');
  return new Response(null, { status: 302, headers });
}

function authLogout(request, env) {
  return credJson({ ok: true }, 200, request, env, { 'set-cookie': sessionCookie('', 0) });
}

async function me(request, env) {
  if (!authEnabled(env)) return credJson({ enabled: false, user: null }, 200, request, env);
  const s = await sessionUser(request, env);
  return credJson({ enabled: true, user: s ? { name: s.name, email: s.email, pic: s.pic } : null }, 200, request, env);
}

async function meFavs(request, env) {
  const s = await sessionUser(request, env);
  if (!s) return credJson({ error: 'no_session' }, 401, request, env);
  if (request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT sport, code FROM user_favs WHERE user_id = ?').bind(s.uid).all();
    return credJson({ favs: results || [] }, 200, request, env);
  }
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch (e) { return credJson({ error: 'bad_json' }, 400, request, env); }
    const favs = Array.isArray(body && body.favs) ? body.favs.slice(0, 500) : [];
    const stmts = [env.DB.prepare('DELETE FROM user_favs WHERE user_id = ?').bind(s.uid)];
    for (const f of favs) {
      if (!f || typeof f.code !== 'string' || typeof f.sport !== 'string') continue;
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO user_favs (user_id, sport, code) VALUES (?, ?, ?)')
        .bind(s.uid, f.sport.slice(0, 16), f.code.slice(0, 40)));
    }
    await env.DB.batch(stmts);
    return credJson({ ok: true, n: favs.length }, 200, request, env);
  }
  return credJson({ error: 'method_not_allowed' }, 405, request, env);
}

async function meDelete(request, env) {
  if (request.method !== 'POST') return credJson({ error: 'method_not_allowed' }, 405, request, env);
  const s = await sessionUser(request, env);
  if (!s) return credJson({ error: 'no_session' }, 401, request, env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_favs WHERE user_id = ?').bind(s.uid),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(s.uid),
  ]);
  return credJson({ ok: true, deleted: true }, 200, request, env, { 'set-cookie': sessionCookie('', 0) });
}
