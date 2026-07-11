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
      if (path === '/v1/soccer/leagues') return json({ leagues: SOCCER_LEAGUES }, 200, origin, 3600);

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
    return {
      espn_id: ev.id,
      start: ev.date || null,
      status: mapEspnStatus(st.name),
      status_detail: st.shortDetail || st.detail || null,
      home: { code: home.team && home.team.abbreviation, score: numOrNull(home.score), rec: recOf(home) },
      away: { code: away.team && away.team.abbreviation, score: numOrNull(away.score), rec: recOf(away) },
      period: (c.status && c.status.period) || null,
      situation: sit ? {
        balls: numOrNull(sit.balls), strikes: numOrNull(sit.strikes), outs: numOrNull(sit.outs),
        onFirst: !!sit.onFirst, onSecond: !!sit.onSecond, onThird: !!sit.onThird,
      } : null,
    };
  });

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
    const side = (t) => ({
      code: (t.team && (t.team.abbreviation || t.team.shortDisplayName)) || null,
      name: (t.team && (t.team.shortDisplayName || t.team.displayName)) || null,
      logo: (t.team && (t.team.logo || (t.team.logos && t.team.logos[0] && t.team.logos[0].href))) || null,
      score: numOrNull(t.score),
      rec: (Array.isArray(t.records) && t.records[0] && t.records[0].summary) || null,
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

// Tenis: los "events" de ESPN son torneos con partidos adentro; cada
// competitor es un atleta (no team). Aplanamos a lista de partidos.
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
          const p = (x) => ({
            code: (x.athlete && (x.athlete.shortName || x.athlete.displayName)) || (x.team && x.team.shortDisplayName) || null,
            name: (x.athlete && x.athlete.displayName) || null,
            logo: (x.athlete && x.athlete.flag && x.athlete.flag.href) || null,
            score: numOrNull(x.score),
            sets: Array.isArray(x.linescores) ? x.linescores.map((l) => numOrNull(l.value)).filter((v) => v != null) : null,
            winner: !!x.winner,
          });
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
