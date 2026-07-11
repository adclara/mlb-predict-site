// AA Sports — normalizador de datos MLB al esquema común multideporte.
//
// Toma los archivos que ya produce el robot (data/history/{date}.json con
// plays/locks/gems, y data/history/games/{date}.json con el detalle por juego)
// y emite el "evento normalizado" del esquema AA (ver PLAN_MAESTRO §3).
//
// SOLO RESULTADOS: pick, prob, métricas, resumen. Nada del algoritmo interno
// (factores crudos, componentes del modelo) sale al esquema público.
//
// Este módulo no toca red ni disco: recibe objetos ya parseados y devuelve un
// objeto plano. Lo usan tanto el uploader (Node) como, si hiciera falta, el
// Worker (Cloudflare) sin cambios.

const PCT = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 1000) / 10);

// "Final" | "In Progress" | "Pre-Game" | (cualquier otra) -> pre|live|final
function normStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('final') || s.includes('game over') || s.includes('completed')) return 'final';
  if (s.includes('progress') || s.includes('in ') || s.includes('live') || s.includes('delayed')) return 'live';
  return 'pre';
}

// Probabilidad del pick (equipo elegido) a partir del bloque `value` del juego,
// que ya trae el prob del modelo por lado (home/away). Fallback a model_p/1-model_p.
function pickProb(g) {
  const side = g.ml_pick && g.ml_pick === g.home ? 'home' : 'away';
  const v = g.value && g.value[side];
  if (v && typeof v.model === 'number') return v.model;
  if (typeof g.model_p === 'number') return side === 'home' ? g.model_p : 1 - g.model_p;
  return null;
}

// Prob de Adrián (heurístico) para el lado del pick. adrian_p es prob de HOME.
function adrianForPick(g) {
  if (typeof g.adrian_p !== 'number') return null;
  const side = g.ml_pick && g.ml_pick === g.home ? 'home' : 'away';
  return side === 'home' ? g.adrian_p : 1 - g.adrian_p;
}

// Resumen en español a partir del brief del robot (máx 3 razones, tono humano).
function summarize(g) {
  const reasons = g.brief && Array.isArray(g.brief.reasons) ? g.brief.reasons.slice(0, 3) : [];
  if (!reasons.length) return null;
  return reasons.join(' · ');
}

// Métricas clave (3-5) — honestas y legibles, sin exponer internals del modelo.
function metricsFor(g) {
  const out = [];
  const pp = pickProb(g);
  if (pp != null) out.push({ label: 'Prob. modelo', value: `${PCT(pp)}%`, kind: 'pct' });
  const ap = adrianForPick(g);
  if (ap != null) out.push({ label: 'Adrián', value: `${PCT(ap)}%`, kind: 'pct' });
  if (typeof g.agree === 'number') out.push({ label: 'Acuerdo', value: `${g.agree}/6`, kind: 'agree' });
  if (g.risk && g.risk.level) out.push({ label: 'Riesgo', value: g.risk.level, kind: 'risk', score: g.risk.score ?? null });
  const edge = g.value && typeof g.value.best_edge === 'number' ? g.value.best_edge : null;
  if (edge != null) out.push({ label: 'Ventaja vs mercado', value: `${edge >= 0 ? '+' : ''}${PCT(edge)}%`, kind: 'edge' });
  return out;
}

// Odds sanitizadas para mostrar (proveedor, línea, O/U) — sin curvas internas.
function oddsFor(g) {
  const o = g.odds;
  if (!o) return null;
  return {
    provider: o.provider || null,
    ml_home: o.ml_home ?? null,
    ml_away: o.ml_away ?? null,
    over_under: o.over_under ?? null,
    n_books: o.consensus && o.consensus.n_books ? o.consensus.n_books : (o.books ? o.books.length : null),
  };
}

// Construye un evento normalizado a partir de un juego + su pick del daily (si existe).
function toEvent(g, pickInfo) {
  const status = normStatus(g.status);
  const pp = pickProb(g);
  // Prefiere el prob/label del daily (lo que el sitio muestra como pick), si lo hay.
  const prob = pickInfo && typeof pickInfo.prob === 'number' ? pickInfo.prob : pp;
  const confidence = pickInfo && pickInfo.confidence ? pickInfo.confidence : confFromProb(prob);
  const badges = [];
  if (pickInfo && pickInfo.badge) badges.push(pickInfo.badge);
  if (pickInfo && pickInfo.tier) badges.push(pickInfo.tier);

  return {
    sport: 'mlb',
    league: 'MLB',
    event_id: String(g.game_pk),
    matchup: g.matchup || `${g.away} @ ${g.home}`,
    start: g.game_date || g.date || null,
    status,
    home: { code: g.home, name: g.home },
    away: { code: g.away, name: g.away },
    prediction: {
      pick: g.ml_pick || (pickInfo && pickInfo.pick) || null,
      prob: prob == null ? null : Math.round(prob * 1000) / 1000,
      prob_pct: PCT(prob),
      confidence: confidence || null,
      engine_version: g.formula_version || g.engine || 'v2',
    },
    metrics: metricsFor(g),
    summary_es: summarize(g),
    risk: g.risk ? { level: g.risk.level || null, score: g.risk.score ?? null } : null,
    odds: oddsFor(g),
    badges,
    live: null, // los marcadores en vivo los inyecta el Worker (/v1/mlb/live) a 30-60s.
    updated_at: g.date || null,
  };
}

function confFromProb(p) {
  if (p == null) return null;
  if (p >= 0.7) return 'alta';
  if (p >= 0.58) return 'media';
  return 'baja';
}

// Indexa plays/locks/gems del daily por game_pk para enriquecer cada juego.
function indexDaily(daily) {
  const map = new Map();
  const add = (arr, badge) => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) {
      if (p.game_pk == null) continue;
      const prev = map.get(p.game_pk) || {};
      map.set(p.game_pk, {
        pick: p.pick ?? prev.pick,
        prob: typeof p.prob === 'number' ? p.prob : prev.prob,
        confidence: p.confidence ?? prev.confidence,
        badge: badge || prev.badge,
        tier: p.tier ?? prev.tier,
      });
    }
  };
  if (daily) {
    add(daily.plays, null);
    add(daily.gems, 'gema');
    add(daily.locks, 'fijo'); // locks gana prioridad (se agrega al final).
  }
  return map;
}

/**
 * Normaliza un día completo al esquema AA.
 * @param {string} date  YYYY-MM-DD
 * @param {object} gamesDoc  data/history/games/{date}.json
 * @param {object|null} dailyDoc  data/history/{date}.json (plays/locks/gems)
 * @param {object|null} indexDoc  data/history/index.json (record)
 * @returns {{sport,league,date,updated_at,record,events}}
 */
export function normalizeDay(date, gamesDoc, dailyDoc, indexDoc) {
  const games = (gamesDoc && Array.isArray(gamesDoc.games)) ? gamesDoc.games : [];
  const dailyIdx = indexDaily(dailyDoc);
  const events = games.map((g) => toEvent(g, dailyIdx.get(g.game_pk) || null));

  // Orden: primero live, luego pre por hora, luego final; dentro, por prob desc.
  const rank = { live: 0, pre: 1, final: 2 };
  events.sort((a, b) => {
    const r = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    if (r !== 0) return r;
    return (b.prediction.prob ?? 0) - (a.prediction.prob ?? 0);
  });

  const record = indexDoc && indexDoc.record ? {
    wins: indexDoc.record.wins ?? null,
    losses: indexDoc.record.losses ?? null,
    win_rate: indexDoc.record.win_rate ?? null,
  } : null;

  return {
    sport: 'mlb',
    league: 'MLB',
    date,
    updated_at: (gamesDoc && gamesDoc.generated_at) || (dailyDoc && dailyDoc.generated_at) || null,
    record,
    events,
  };
}

// Filas para D1 (historial consultable). Una por evento.
export function toD1Rows(normalized) {
  return normalized.events.map((e) => ({
    sport: e.sport,
    date: normalized.date,
    event_id: e.event_id,
    league: e.league,
    start_time: e.start,
    status: e.status,
    home: e.home.code,
    away: e.away.code,
    pick: e.prediction.pick,
    prob: e.prediction.prob,
    confidence: e.prediction.confidence,
    engine_version: e.prediction.engine_version,
    result: null,
    updated_at: normalized.updated_at,
  }));
}
