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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = (env && env.ALLOWED_ORIGIN) || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed' }, 405, origin);
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/' || path === '/v1' || path === '/v1/health') {
        return json(
          { service: 'aa-sports-api', ok: true, sports: ['mlb'], routes: ['/v1/mlb/today', '/v1/mlb/event/:id', '/v1/mlb/history', '/v1/mlb/live'] },
          200, origin,
        );
      }

      if (path === '/v1/mlb/today') return await today(env, origin);
      if (path === '/v1/mlb/live') return await live(ctx, origin);
      if (path === '/v1/mlb/history') return await history(url, env, origin);

      const ev = path.match(/^\/v1\/mlb\/event\/([^/]+)$/);
      if (ev) return await event(decodeURIComponent(ev[1]), env, origin);

      return json({ error: 'not_found' }, 404, origin);
    } catch (err) {
      return json({ error: 'internal', detail: String(err && err.message || err) }, 500, origin);
    }
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
    return {
      espn_id: ev.id,
      status: mapEspnStatus(st.name),
      status_detail: st.shortDetail || st.detail || null,
      home: { code: home.team && home.team.abbreviation, score: numOrNull(home.score) },
      away: { code: away.team && away.team.abbreviation, score: numOrNull(away.score) },
      period: (c.status && c.status.period) || null,
    };
  });

  const payload = JSON.stringify({ sport: 'mlb', updated_at: new Date().toISOString(), games });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } });
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
