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

// A model output is public only after the robot has sealed an immutable,
// pre-first-pitch feature snapshot. Provisional rows are useful internally for
// refreshes, but publishing their pick/probability would create a prediction
// that can silently change before the official slate is frozen.
function isCausalFrozen(g) {
  const capturedAt = g && (g.decision_captured_at || g.feature_as_of);
  const firstPitch = g && (g.first_pitch || g.game_datetime);
  const capturedMs = Date.parse(capturedAt || '');
  const firstPitchMs = Date.parse(firstPitch || '');
  return !!g
    && /^[a-f0-9]{64}$/i.test(String(g.feature_hash || ''))
    && g.feature_scope === 'pregame_immutable'
    && g.integrity && g.integrity.training_eligible === true
    && Number.isFinite(capturedMs) && Number.isFinite(firstPitchMs)
    && capturedMs < firstPitchMs;
}

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
// Ventaja HONESTA vs mercado = prob CALIBRADA del pick − prob implícita del
// mercado del mismo lado. Antes se usaba g.value.best_edge (escala clásica
// inflada), que exageraba el "valor" — el modelo apenas iguala al mercado.
function honestEdge(g, prob) {
  const o = g.odds;
  if (!o || prob == null || !g.ml_pick) return null;
  const pHomeMkt = typeof o.p_home_mkt === 'number' ? o.p_home_mkt
    : (o.consensus && typeof o.consensus.p_home === 'number' ? o.consensus.p_home : null);
  if (pHomeMkt == null) return null;
  const mktForPick = g.ml_pick === g.home ? pHomeMkt : 1 - pHomeMkt;
  return prob - mktForPick;
}
function metricsFor(g, prob) {
  const out = [];
  const pp = pickProb(g);
  if (pp != null) out.push({ label: 'Prob. modelo', value: `${PCT(pp)}%`, kind: 'pct' });
  const ap = adrianForPick(g);
  if (ap != null) out.push({ label: 'Adrián', value: `${PCT(ap)}%`, kind: 'pct' });
  if (typeof g.agree === 'number') out.push({ label: 'Acuerdo', value: `${g.agree}/6`, kind: 'agree' });
  if (g.risk && g.risk.level) out.push({ label: 'Riesgo', value: g.risk.level, kind: 'risk', score: g.risk.score ?? null });
  const edge = honestEdge(g, prob);
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

/* ── SNAPSHOT DE APUESTAS ────────────────────────────────────────────────────
   Información derivada y legible para decidir: forma reciente, duelo de
   señales (categórico, sin floats del modelo), abridores, contexto, total y
   comparación vs mercado. */

// Índice de forma: equipo -> juegos terminados más recientes (de días previos).
// `final` viene como "away-home" (verificado contra home_win).
export function buildFormIndex(prevGamesDocs) {
  const byTeam = new Map();
  for (const doc of prevGamesDocs || []) {
    const date = doc && doc.date;
    for (const g of (doc && doc.games) || []) {
      if (!g || g.final == null || g.home_win == null) continue;
      const [as, hs] = String(g.final).split('-').map(Number);
      if (!Number.isFinite(as) || !Number.isFinite(hs)) continue;
      const homeWin = !!g.home_win;
      const push = (team, opp, isHome) => {
        if (!byTeam.has(team)) byTeam.set(team, []);
        const mine = isHome ? hs : as, theirs = isHome ? as : hs;
        byTeam.get(team).push({
          date: g.game_date || g.date || date || null,
          opp, home: isHome, w: isHome ? homeWin : !homeWin,
          score: `${mine}-${theirs}`,
        });
      };
      push(g.home, g.away, true);
      push(g.away, g.home, false);
    }
  }
  for (const [, arr] of byTeam) arr.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return byTeam;
}

const FACTOR_LABELS = {
  momentum: 'Momentum (últimos 10)',
  pitching: 'Picheo (abridor + bullpen)',
  bats: 'Bates (contacto + poder)',
  f5: 'Primeras 5 entradas',
  schedule: 'Calendario y descanso',
  manager: 'Banquillo',
};

// Duelo de señales: signo>0 favorece a HOME, <0 a AWAY (verificado con model_p).
// Solo publicamos dirección + fuerza 1-3, nunca los valores crudos del modelo.
function edgesFor(g) {
  const fl = g.factor_leans;
  if (!fl) return null;
  const out = [];
  for (const [k, label] of Object.entries(FACTOR_LABELS)) {
    const v = fl[k];
    if (typeof v !== 'number') continue;
    const a = Math.abs(v);
    out.push({
      factor: label,
      favors: a < 0.08 ? 'even' : (v > 0 ? 'home' : 'away'),
      strength: a < 0.08 ? 0 : a < 0.35 ? 1 : a < 0.8 ? 2 : 3,
    });
  }
  return out.length ? out : null;
}

function pitchersFor(g, pitcherNames) {
  const names = pitcherNames || {};
  const rec = g.pitcher_recent || {};
  const bp = (g.brief && g.brief.pitchers) || {};
  const aux2 = g.aux2 || {};
  const side = (name, id, r, b, handFallback) => (name || id || r || b) ? {
    name: name || (b && b.name) || null,
    id: id ?? null, // MLBAM id -> headshot en midfield.mlbstatic.com (CDN oficial, gratis)
    era_recent: r && typeof r.era === 'number' ? Math.round(r.era * 100) / 100 : null,
    starts: r && r.n != null ? r.n : (b && b.n != null ? b.n : null),
    fatigue: (r && r.fatigue) || (b && b.fatigue) || null,
    fip: b && typeof b.fip === 'number' ? Math.round(b.fip * 100) / 100 : null, // FIP de temporada del abridor
    hand: (b && b.hand) || handFallback || null, // L/R
    k9: b && typeof b.k9 === 'number' ? b.k9 : null, // ponches por 9 entradas (props de ponches, descriptivo)
  } : null;
  const home = side(names.hn, names.h, rec.home, bp.home, aux2.home_sp_hand);
  const away = side(names.an, names.a, rec.away, bp.away, aux2.away_sp_hand);
  return (home || away) ? { home, away } : null;
}

function contextFor(g) {
  const w = g.weather, wf = g.weather_forecast, aux = g.aux || {}, aux2 = g.aux2 || {};
  // clima observado si existe; si no (pre-juegos), cae al pronóstico + precip%
  const wx = w
    ? { condition: w.condition || null, temp_f: w.temp ?? null, wind: w.wind || null, precip_pct: null, forecast: false }
    : wf
    ? { condition: wf.condition || null, temp_f: wf.temp ?? null, wind: wf.wind || null, precip_pct: wf.precip_pct ?? null, forecast: true }
    : null;
  const ctx = {
    elo_diff: typeof g.elo_diff === 'number' ? Math.round(g.elo_diff) : null,
    sp_fip_diff: typeof g.sp_fip_diff === 'number' ? Math.round(g.sp_fip_diff * 100) / 100 : null,
    park_factor: typeof g.park_factor === 'number' ? g.park_factor : null,
    streak_home: typeof g.streak_home === 'number' ? g.streak_home : null,
    streak_away: typeof g.streak_away === 'number' ? g.streak_away : null,
    rest_home: typeof aux.rest_h === 'number' ? aux.rest_h : null,
    rest_away: typeof aux.rest_a === 'number' ? aux.rest_a : null,
    day_night: aux2.day_night || null,
    series: (aux2.series_game != null || aux2.series_len != null || aux2.series_home_wins != null || aux2.series_away_wins != null)
      ? {
          game: aux2.series_game ?? null, len: aux2.series_len ?? null,
          home_wins: aux2.series_home_wins ?? null, away_wins: aux2.series_away_wins ?? null,
        } : null,
    weather: wx,
  };
  return Object.values(ctx).some((v) => v != null) ? ctx : null;
}

function totalFor(g) {
  if (g.line == null || !g.side) return null;
  const p = typeof g.p_over === 'number' ? (g.side === 'over' ? g.p_over : 1 - g.p_over) : null;
  return {
    line: g.line, lean: g.side, prob_pct: PCT(p),
    aa_total: typeof g.adj_total === 'number' ? Math.round(g.adj_total * 10) / 10 : null,
  };
}

// Valor por lado: modelo vs mercado vs precio, con EV — lo que un apostador
// necesita para ver DÓNDE está el valor. Son salidas del modelo, no internals.
function valueFor(g) {
  const v = g.value;
  if (!v || !v.home || !v.away) return null;
  const side = (s) => ({
    model_pct: PCT(s.model), market_pct: PCT(s.market),
    price: s.price ?? null,
    edge_pct: PCT(s.edge), ev_pct: PCT(s.ev),
  });
  return { home: side(v.home), away: side(v.away), best_side: v.best_side || null };
}

// Libros individuales (multi-casa) + bandera de discrepancia entre casas.
function booksFor(g) {
  const o = g.odds;
  if (!o || !Array.isArray(o.books) || !o.books.length) return null;
  return {
    rows: o.books.slice(0, 8).map((b) => ({
      provider: b.provider || '?',
      ml_home: b.ml_home ?? null, ml_away: b.ml_away ?? null,
      over_under: b.over_under ?? null,
    })),
    disagree: typeof o.book_disagreement === 'number' ? o.book_disagreement >= 0.04 : false,
  };
}

// Razones completas del brief ("Por qué esta jugada").
function reasonsFor(g) {
  const r = g.brief && Array.isArray(g.brief.reasons) ? g.brief.reasons : null;
  if (!r || !r.length) return null;
  return r.slice(0, 6).map((x) => (typeof x === 'string' ? x : x.text)).filter(Boolean);
}

// Curva de win-probability del juego (marcador + WP por media entrada).
// Fuente: snapshots en vivo del robot; fallback a la curva del mercado (odds).
function wpFor(g, liveGame) {
  let pts = null;
  if (liveGame && Array.isArray(liveGame.snapshots) && liveGame.snapshots.length) {
    pts = liveGame.snapshots
      .filter((s) => typeof s.wp === 'number')
      .map((s) => ({ inn: s.inn ?? null, half: s.half ?? null, wp: Math.round(s.wp * 1000) / 1000, hs: s.hs ?? null, as: s.as ?? null }));
  } else if (g.odds && Array.isArray(g.odds.wp_curve) && g.odds.wp_curve.length) {
    pts = g.odds.wp_curve
      .filter((s) => typeof s.home_wp === 'number')
      .map((s) => ({ inn: s.inn ?? null, half: s.half ?? null, wp: Math.round(s.home_wp * 1000) / 1000, hs: s.home_score ?? null, as: s.away_score ?? null }));
  }
  if (!pts || pts.length < 2) return null;
  // Máx ~40 puntos para mantener el payload liviano.
  if (pts.length > 40) {
    const step = pts.length / 40;
    pts = Array.from({ length: 40 }, (_, i) => pts[Math.min(pts.length - 1, Math.floor(i * step))]);
  }
  return pts;
}

function marketFor(g) {
  const o = g.odds;
  if (!o || typeof o.p_home_mkt !== 'number') return null;
  return {
    p_home_pct: PCT(o.p_home_mkt), p_away_pct: PCT(o.p_away_mkt),
    line_move: typeof o.line_move === 'number' ? o.line_move : null, // movimiento vs apertura
    p_home_open_pct: PCT(typeof o.p_home_open === 'number' ? o.p_home_open : null),
    spread: o.spread ?? null, // run line
  };
}

// Recomendación honesta en una frase, a partir de pick + edge + riesgo.
function verdictFor(g, prob) {
  const pick = g.ml_pick;
  if (!pick || prob == null) return 'El algoritmo no publica un pick para este juego: las señales no son concluyentes.';
  const edge = honestEdge(g, prob);
  const risk = (g.risk && g.risk.level) || null;
  const p = PCT(prob);
  let s = `El algoritmo da ${p}% a ${pick}`;
  s += edge != null ? `, ${edge >= 0 ? '+' : ''}${PCT(edge)}% frente al precio del mercado` : '';
  s += risk ? ` y clasifica el riesgo como ${risk}.` : '.';
  if (edge != null && edge >= 0.04 && prob >= 0.6 && risk !== 'alto') s += ' Candidato sólido según los datos.';
  else if (edge != null && edge < 0) s += ' Ojo: el mercado paga menos de lo que vale → sin valor real, considera pasar.';
  else if (risk === 'alto') s += ' Riesgo alto: si juegas, que sea con unidad reducida.';
  else s += ' Ventaja moderada: decide con el cuadro completo de abajo.';
  return s;
}

// Ofensiva de temporada del brief (OPS + carreras/juego), sanitizada.
function offenseFor(g) {
  const o = g.brief && g.brief.offense;
  if (!o) return null;
  const side = (s) => (s && (s.ops != null || s.runs != null)) ? { ops: s.ops ?? null, runs: s.runs ?? null } : null;
  const home = side(o.home), away = side(o.away);
  return (home || away) ? { home, away } : null;
}

// Top-3 bateadores del brief (nombre + OPS/HR/AVG); sin ids MLBAM.
function hittersFor(g) {
  const h = g.brief && g.brief.hitters;
  if (!h) return null;
  const side = (arr) => Array.isArray(arr)
    ? arr.slice(0, 3).map((x) => x && x.name ? { name: x.name, ops: x.ops ?? null, hr: x.hr ?? null, avg: x.avg ?? null } : null).filter(Boolean)
    : [];
  const home = side(h.home), away = side(h.away);
  return (home.length || away.length) ? { home, away } : null;
}

// Alineación al bate (orden 1..9 con stats por jugador). Conserva el id
// para el headshot. Null si no hay lineup publicado en ningún lado.
function lineupsFor(g) {
  const l = g.brief && g.brief.lineups;
  if (!l) return null;
  const side = (arr) => Array.isArray(arr)
    ? arr.slice(0, 9).map((x) => x && (x.name || x.id != null) ? {
        order: x.order ?? null, id: x.id ?? null, name: x.name ?? null,
        ops: x.ops ?? null, hr: x.hr ?? null, avg: x.avg ?? null, pos: x.pos ?? null,
      } : null).filter(Boolean)
    : [];
  const home = side(l.home), away = side(l.away);
  return (home.length || away.length) ? { home, away } : null;
}

// ¿Bates calientes o fríos? Carreras anotadas en los últimos 5 (del form,
// score "mías-suyas") vs el promedio de temporada del brief.
function batsFor(formArr, seasonRpg) {
  const runs = (formArr || []).slice(0, 5)
    .map((f) => Number(String(f && f.score).split('-')[0]))
    .filter(Number.isFinite);
  if (runs.length < 3) return null;
  const l5 = runs.reduce((a, b) => a + b, 0) / runs.length;
  const season = (typeof seasonRpg === 'number' && Number.isFinite(seasonRpg)) ? seasonRpg : null;
  const delta = season != null ? l5 - season : null;
  const label = delta == null ? null : delta >= 0.7 ? 'hot' : delta <= -0.7 ? 'cold' : 'normal';
  return {
    l5_rpg: Math.round(l5 * 10) / 10,
    season_rpg: season != null ? Math.round(season * 10) / 10 : null,
    delta: delta != null ? Math.round(delta * 10) / 10 : null,
    label,
  };
}

// Fuerza del bullpen (FIP, menor = mejor). brief.bullpen.
function bullpenFor(g) {
  const b = g.brief && g.brief.bullpen;
  if (!b) return null;
  const n = (x) => typeof x === 'number' ? Math.round(x * 100) / 100 : null;
  const home = n(b.home_fip), away = n(b.away_fip);
  return (home != null || away != null) ? { home_fip: home, away_fip: away } : null;
}

// Mercado de primeras 5 entradas / NRFI. brief.f5 (probs 0..1); el empate es
// el resto (home_lead + away_lead no suman 1).
function f5For(g) {
  const f = g.brief && g.brief.f5;
  if (!f) return null;
  const h = typeof f.home_lead === 'number' ? f.home_lead : null;
  const a = typeof f.away_lead === 'number' ? f.away_lead : null;
  const tie = (h != null && a != null) ? Math.max(0, 1 - h - a) : null;
  return {
    home_pct: PCT(h), away_pct: PCT(a), tie_pct: PCT(tie),
    nrfi_pct: PCT(typeof f.nrfi === 'number' ? f.nrfi : null),
  };
}

// Ventaja de platoon por lado (aux2.platoon_h/a): número pequeño con signo,
// + favorece a ese equipo (bates vs la mano del abridor rival, vs la liga).
function platoonFor(g) {
  const a = g.aux2 || {};
  const h = typeof a.platoon_h === 'number' ? Math.round(a.platoon_h * 1000) / 1000 : null;
  const v = typeof a.platoon_a === 'number' ? Math.round(a.platoon_a * 1000) / 1000 : null;
  return (h != null || v != null) ? { home: h, away: v } : null;
}

function snapshotFor(g, formIdx, pitcherNames, prob, liveGame) {
  const formOf = (team) => {
    const arr = (formIdx && formIdx.get(team)) || [];
    return arr.slice(0, 5);
  };
  const off = offenseFor(g);
  const batsSide = (side) => formIdx ? batsFor(formOf(g[side]), off && off[side] && off[side].runs) : null;
  const batsHome = batsSide('home'), batsAway = batsSide('away');
  const snap = {
    form: formIdx ? { home: formOf(g.home), away: formOf(g.away) } : null,
    offense: off,
    hitters: hittersFor(g),
    lineups: lineupsFor(g),
    bats: (batsHome || batsAway) ? { home: batsHome, away: batsAway } : null,
    fielding: (g.brief && g.brief.fielding) || null,
    edges: edgesFor(g),
    pitchers: pitchersFor(g, pitcherNames),
    bullpen: bullpenFor(g),
    f5: f5For(g),
    platoon: platoonFor(g),
    context: contextFor(g),
    total: totalFor(g),
    market: marketFor(g),
    value: valueFor(g),
    books: booksFor(g),
    reasons: reasonsFor(g),
    wp: wpFor(g, liveGame),
    verdict_es: verdictFor(g, prob),
  };
  return Object.values(snap).some((v) => v != null) ? snap : null;
}

// Construye un evento normalizado a partir de un juego + su pick del daily (si existe).
function toEvent(g, pickInfo, formIdx, pitcherNames, liveGame) {
  const observed = g.observed && typeof g.observed === 'object' ? g.observed : null;
  const status = normStatus(observed?.status ?? g.status);
  const currentGame = observed?.odds ? { ...g, odds: observed.odds } : g;
  const publicReady = isCausalFrozen(g);
  const invalidated = publicReady && pickInfo?.scratch_warning === true;
  const observedHomeRaw = observed?.scores?.home, observedAwayRaw = observed?.scores?.away;
  const observedHome = observedHomeRaw == null ? null : Number(observedHomeRaw);
  const observedAway = observedAwayRaw == null ? null : Number(observedAwayRaw);
  const observedFinal = status === 'final' && Number.isFinite(observedHome) && Number.isFinite(observedAway)
    ? `${observedAway}-${observedHome}` : null;

  // Keep a pending event shape compatible with the Worker's live schedule
  // fallback, but expose no model-derived value until the causal seal exists.
  if (!publicReady) {
    return {
      sport: 'mlb', league: 'MLB', event_id: String(g.game_pk),
      matchup: g.matchup || `${g.away} @ ${g.home}`,
      start: g.game_datetime || g.game_date || g.date || null,
      status,
      home: { code: g.home, name: g.home }, away: { code: g.away, name: g.away },
      prediction: { pick: null, prob: null, prob_pct: null, confidence: null, engine_version: null },
      metrics: [], summary_es: null, snapshot: null, risk: null,
      odds: oddsFor(currentGame), badges: [], result: null,
      final: g.final || observedFinal,
      live: null, pending: true,
      updated_at: observed?.captured_at || g.date || null,
    };
  }

  const pp = pickProb(g);
  // Prob CALIBRADA del lado del pick (honestidad — ver calibratedProb). Antes se
  // mostraba la clásica sobre-confiada; ahora se prefiere prob_v2 / p_final.
  const prob = calibratedProb(pickInfo, pp);
  const confidence = pickInfo && pickInfo.confidence ? pickInfo.confidence : confFromProb(prob);
  const badges = [];
  if (!invalidated && pickInfo && pickInfo.badge) badges.push(pickInfo.badge);
  if (!invalidated && pickInfo && pickInfo.tier) badges.push(pickInfo.tier);

  let snapshot = invalidated ? null : snapshotFor(g, formIdx, pitcherNames, prob, liveGame);
  if (!invalidated && observed?.odds) {
    const overlay = {
      market: marketFor(currentGame),
      books: booksFor(currentGame),
      wp: wpFor(currentGame, liveGame),
    };
    snapshot = { ...(snapshot || {}), ...Object.fromEntries(Object.entries(overlay).filter(([, value]) => value != null)) };
  }
  return {
    sport: 'mlb',
    league: 'MLB',
    event_id: String(g.game_pk),
    matchup: g.matchup || `${g.away} @ ${g.home}`,
    start: g.game_datetime || g.game_date || g.date || null, // hora real si existe, si no la fecha
    status,
    home: { code: g.home, name: g.home },
    away: { code: g.away, name: g.away },
    prediction: {
      pick: g.ml_pick || (pickInfo && pickInfo.pick) || null,
      prob: prob == null ? null : Math.round(prob * 1000) / 1000,
      prob_pct: PCT(prob),
      confidence: confidence || null,
      engine_version: g.formula_version || g.engine || 'v2',
      invalidated,
      invalidated_reason: invalidated ? 'probable_starter_changed' : null,
    },
    metrics: invalidated ? [] : metricsFor(g, prob),
    summary_es: invalidated ? null : summarize(g),
    snapshot,
    risk: !invalidated && g.risk ? { level: g.risk.level || null, score: g.risk.score ?? null } : null,
    odds: oddsFor(currentGame),
    badges,
    result: g.ml_result || null, // win|loss del pick cuando el juego ya se calificó
    final: g.final || observedFinal, // marcador factual "away-home" si terminó
    live: null, // los marcadores en vivo los inyecta el Worker (/v1/mlb/live) a 30-60s.
    pending: false,
    updated_at: observed?.captured_at || g.date || null,
  };
}

function confFromProb(p) {
  if (p == null) return null;
  // Umbrales en la escala CALIBRADA (los picks calibrados rara vez pasan de ~0.65).
  if (p >= 0.62) return 'alta';
  if (p >= 0.55) return 'media';
  return 'baja';
}

// Probabilidad CALIBRADA del lado del pick para mostrar (honestidad: el número
// que el sitio enseña debe cumplirse). El repo mide que la prob "clásica" está
// sobre-confiada (~70% mostrado → ~57% real, ECE 0.108 en learning.json). Orden:
//   1) prob_v2 = prob calibrada del cerebro v2 (p_final + Platt) — la buena.
//   2) gema: su `prob` YA es p_final (calibrada) — se usa tal cual.
//   3) fallback (sin prob_v2 y no-gema): encoger la clásica hacia 0.5 para quitar
//      la sobre-confianza medida (pendiente ~0.35 de la curva de calibración).
//   4) sin pick: pickProb es la MISMA prob clásica sobre-confiada (ECE 0.108 en
//      learning.json: ~70% mostrado → ~57% real). Como los juegos se ordenan por
//      prob desc, estos no-pick encabezan la lista, así que TAMBIÉN hay que
//      encogerlos hacia 0.5 — si no, se muestra el número inflado (bug de honestidad).
const CAL_SHRINK = 0.35;
const calShrink = (p) => (p == null ? null : 0.5 + (p - 0.5) * CAL_SHRINK);
function calibratedProb(pickInfo, pp) {
  if (pickInfo) {
    if (typeof pickInfo.prob_v2 === 'number') return pickInfo.prob_v2;
    if (pickInfo.badge === 'gema' && typeof pickInfo.prob === 'number') return pickInfo.prob;
    if (typeof pickInfo.prob === 'number') return calShrink(pickInfo.prob);
  }
  return calShrink(pp);
}

// Indexa plays/locks/gems del daily por game_pk para enriquecer cada juego.
function indexDaily(daily) {
  const map = new Map();
  // Slates migrados preservan su track record público, pero no existe un hash
  // que vincule su probabilidad/badge con la fila de features inmutable. En ese
  // caso la predicción general sale de la fila causal y el daily no la pisa.
  if (!daily || daily.selection_snapshot_verified !== true) return map;
  const add = (arr, badge) => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) {
      if (p.game_pk == null) continue;
      // El ledger v2 conserva backtests y picks tardíos para auditoría, pero
      // nunca los presenta como selecciones públicas ni les asigna badge.
      if (p.eligible_public_record === false) continue;
      if (p.record_scope && p.record_scope !== 'public_live') continue;
      const prev = map.get(p.game_pk) || {};
      map.set(p.game_pk, {
        pick: p.pick ?? prev.pick,
        prob: typeof p.prob === 'number' ? p.prob : prev.prob,
        prob_v2: typeof p.prob_v2 === 'number' ? p.prob_v2 : prev.prob_v2,
        confidence: p.confidence ?? prev.confidence,
        badge: badge || prev.badge,
        tier: p.tier ?? prev.tier,
        scratch_warning: p.scratch_warning === true || prev.scratch_warning === true,
        scratch_note: p.scratch_note ?? prev.scratch_note,
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
 * @param {object[]} [prevGamesDocs]  games docs de días ANTERIORES (para la forma reciente)
 * @param {object|null} [liveDoc]  data/history/live/{date}.json (snapshots WP en vivo)
 * @returns {{sport,league,date,updated_at,record,events}}
 */
export function normalizeDay(date, gamesDoc, dailyDoc, indexDoc, prevGamesDocs, liveDoc) {
  const games = (gamesDoc && Array.isArray(gamesDoc.games)) ? gamesDoc.games : [];
  const dailyIdx = indexDaily(dailyDoc);
  const formIdx = prevGamesDocs && prevGamesDocs.length ? buildFormIndex(prevGamesDocs) : null;
  const pitcherIdx = (dailyDoc && dailyDoc.pitchers) || {};
  const liveIdx = (liveDoc && liveDoc.games) || {};
  const events = games.map((g) => toEvent(g, dailyIdx.get(g.game_pk) || null, formIdx,
    pitcherIdx[String(g.game_pk)] || null, liveIdx[String(g.game_pk)] || null));

  // Orden: primero live, luego pre por hora, luego final; dentro, por prob desc.
  const rank = { live: 0, pre: 1, final: 2 };
  events.sort((a, b) => {
    const r = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    if (r !== 0) return r;
    return (b.prediction.prob ?? 0) - (a.prediction.prob ?? 0);
  });

  // Récord general + por nivel (fijos/gemas) — honestidad: se ven tal cual,
  // incluidas las unidades en rojo. Datos de data/history/index.json.
  const tierRec = (r) => r ? {
    wins: r.wins ?? null, losses: r.losses ?? null,
    win_rate: r.win_rate ?? null, units: r.units ?? null,
    priced_n: r.priced_n ?? null,
  } : null;
  const record = indexDoc && indexDoc.record ? {
    wins: indexDoc.record.wins ?? null,
    losses: indexDoc.record.losses ?? null,
    win_rate: indexDoc.record.win_rate ?? null,
    locks: tierRec(indexDoc.locks_record),
    gems: tierRec(indexDoc.gems_record),
    scope: indexDoc.record_scope || 'legacy_unscoped',
    sample_n: (indexDoc.record.wins ?? 0) + (indexDoc.record.losses ?? 0),
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
    result: e.result || null,
    updated_at: normalized.updated_at,
  }));
}
