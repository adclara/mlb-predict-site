// AA Sports — Worker (API pública de solo-lectura).
//
// Sirve resultados ya calculados desde KV/D1 y hace de proxy con caché para los
// marcadores en vivo (ESPN). El navegador SOLO habla con este Worker; el
// algoritmo nunca sale del cómputo privado.
// La única escritura HTTP es un puente interno OIDC, cerrado al workflow
// horario del repo privado en main; acepta evidencia sanitizada y fuerza todas
// las filas nuevas a shadow sin aprobación humana.
//
// Rutas:
//   GET /                     -> health / info
//   GET /v1/mlb/today         -> predicciones + métricas del día (KV, cache 60s)
//   GET /v1/mlb/event/:id     -> un evento (desde today; fallback D1)
//   GET /v1/mlb/history?days= -> historial de predicciones (D1)
//   GET /v1/mlb/live          -> marcadores en vivo (proxy ESPN, cache 30s)

const ESPN_SCOREBOARD =
  'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';
const MLB_ABBR_FIX = { ATH: 'OAK', CHW: 'CWS', ARI: 'AZ' };
const MLB_INGEST_CRON = '*/20 * * * *';
const MLB_INGEST_INTERVAL_MS = 20 * 60 * 1000;
const MLB_INGEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MLB_INGEST_STALE_SECONDS = 45 * 60;
const MLB_INGEST_TIMEOUT_MS = 8000;
const MLB_PREGAME_WINDOW_MS = 3 * 60 * 60 * 1000;
const POLY_RADAR_PAUSED = Object.freeze({
  ok: false,
  paused: true,
  state: 'paused',
  reason: 'operator_paused',
});

// Public, keyless score feeds for the four new US sports. These identifiers
// are also the only sport values accepted by the generic routes and D1 tables.
export const US_SPORTS = Object.freeze({
  nfl: {
    label: 'NFL', scoreboard: 'football/nfl/scoreboard',
    standings: 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings',
    summary: 'football/nfl/summary', season: 'NFL',
  },
  ncaaf: {
    label: 'NCAAF · FBS', scoreboard: 'football/college-football/scoreboard',
    standings: 'https://site.api.espn.com/apis/v2/sports/football/college-football/standings',
    summary: 'football/college-football/summary', season: 'FBS',
  },
  nhl: {
    label: 'NHL', scoreboard: 'hockey/nhl/scoreboard',
    standings: 'https://site.api.espn.com/apis/v2/sports/hockey/nhl/standings',
    summary: 'hockey/nhl/summary', season: 'NHL',
  },
  ncaam: {
    label: 'NCAAM · D-I', scoreboard: 'basketball/mens-college-basketball/scoreboard',
    standings: 'https://site.api.espn.com/apis/v2/sports/basketball/mens-college-basketball/standings',
    summary: 'basketball/mens-college-basketball/summary', season: 'NCAA D-I',
  },
});

const MODEL_PUBLISH_PATH = '/v1/internal/model-publish';
const MODEL_PUBLISH_AUDIENCE = 'aa-sports-model-publisher';
const MODEL_PUBLISH_REPOSITORY = 'adclara/aa-sports-models-private';
const MODEL_PUBLISH_REPOSITORY_ID = '1309365177';
const MODEL_PUBLISH_OWNER_ID = '71529366';
const MODEL_PUBLISH_WORKFLOW =
  'adclara/aa-sports-models-private/.github/workflows/hourly-shadow.yml@refs/heads/main';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_JWKS = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const GOOGLE_OIDC_DISCOVERY = 'https://accounts.google.com/.well-known/openid-configuration';
const GOOGLE_OIDC_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const MODEL_PUBLISH_MAX_BYTES = 512 * 1024;
const MODEL_PUBLISH_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch']);

// ESPN, antes de que empiece la jornada, deja su scoreboard sin parámetros en
// el último día completado. Siempre fijamos el día calendario ET que AA Sports
// está mostrando y filtramos la respuesta: un resultado de ayer nunca debe
// poder entrar al feed de hoy.
export function mlbScoreboardUrl(date) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : etDate(new Date());
  return `${ESPN_SCOREBOARD}?dates=${day.replace(/-/g, '')}&limit=100`;
}

export function mlbLiveEventsForDate(data, date) {
  const events = Array.isArray(data && data.events) ? data.events : [];
  return events.filter((ev) => etDate(ev && ev.date) === date);
}

// ── Captura MLB de hechos públicos cada 20 minutos ─────────────────────────
// Este bloque NO calcula predicciones ni contiene pesos del modelo. Conserva
// solamente calendario, abridores, lineups, marcador y la línea primaria que
// las dos APIs públicas ya exponen. El robot privado decide después qué medir.
const ingestAbbr = (code) => {
  const value = String(code || '').toUpperCase();
  return MLB_ABBR_FIX[value] || value || null;
};
const ingestText = (value, max = 80) => value == null ? null : String(value).slice(0, max);
const ingestNumber = (value) => {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
};
const ingestMarketLine = (value) => {
  const direct = ingestNumber(value);
  if (direct != null) return direct;
  const match = String(value || '').match(/[-+]?\d+(?:\.\d+)?/);
  return match ? ingestNumber(match[0]) : null;
};
const ingestStatus = (value) => {
  const status = String(value || '').toLowerCase();
  if (status.includes('final') || status.includes('completed') || status.includes('game over') || status === 'post') return 'final';
  if (status.includes('progress') || status.includes('live') || status.includes('delay') || status.includes('rain') || status === 'in') return 'live';
  return 'pre';
};
const ingestLineup = (players) => (Array.isArray(players) ? players : [])
  .map((player) => Number(player && player.id))
  .filter(Number.isFinite)
  .slice(0, 12);
const ingestMoneyline = (side) => ingestNumber(side && (
  side.moneyLine ?? side.moneyline ?? side.odds ??
  side.current?.moneyLine?.american ?? side.current?.moneyLine ??
  side.close?.moneyLine?.american ?? side.close?.moneyLine ?? side.close?.odds ??
  side.open?.moneyLine?.american ?? side.open?.moneyLine ?? side.open?.odds
));
const ingestMoneylineAt = (side, stage) => ingestNumber(side && (
  side[stage]?.moneyLine?.american ?? side[stage]?.moneyLine ?? side[stage]?.odds
));

function compactStatsGame(game) {
  const teams = game && game.teams || {};
  const linescore = game && game.linescore || {};
  const home = teams.home || {}, away = teams.away || {};
  const homeTeam = home.team || {}, awayTeam = away.team || {};
  const homePitcher = home.probablePitcher || {}, awayPitcher = away.probablePitcher || {};
  const lineups = game && game.lineups || {};
  const homeLine = linescore.teams && linescore.teams.home || {};
  const awayLine = linescore.teams && linescore.teams.away || {};
  const statusDetail = game && game.status && (game.status.detailedState || game.status.abstractGameState);
  return {
    id: String(game.gamePk), mlb_id: String(game.gamePk), espn_id: null,
    start: game.gameDate || null, status: ingestStatus(statusDetail), detail: ingestText(statusDetail, 48),
    home: {
      id: homeTeam.id ?? null, code: ingestAbbr(homeTeam.abbreviation), score: ingestNumber(home.score),
      hits: ingestNumber(homeLine.hits), errors: ingestNumber(homeLine.errors),
      pitcher_id: homePitcher.id ?? null, pitcher: ingestText(homePitcher.fullName),
      lineup: ingestLineup(lineups.homePlayers),
    },
    away: {
      id: awayTeam.id ?? null, code: ingestAbbr(awayTeam.abbreviation), score: ingestNumber(away.score),
      hits: ingestNumber(awayLine.hits), errors: ingestNumber(awayLine.errors),
      pitcher_id: awayPitcher.id ?? null, pitcher: ingestText(awayPitcher.fullName),
      lineup: ingestLineup(lineups.awayPlayers),
    },
    inning: ingestNumber(linescore.currentInning), half: ingestText(linescore.inningState, 12),
    outs: ingestNumber(linescore.outs), series_game: ingestNumber(game.seriesGameNumber),
    series_len: ingestNumber(game.gamesInSeries), venue_id: game.venue && game.venue.id || null,
    espn_status: null, espn_period: null, market: null,
  };
}

function compactEspnGame(event) {
  const competition = event && event.competitions && event.competitions[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find((team) => team.homeAway === 'home') || {};
  const away = competitors.find((team) => team.homeAway === 'away') || {};
  const statusType = competition.status?.type || event?.status?.type || {};
  const oddsList = Array.isArray(competition.odds) ? competition.odds : [];
  const odds = oddsList.find((item) => item && (item.homeTeamOdds || item.awayTeamOdds || item.overUnder != null)) || oddsList[0] || null;
  const moneyline = odds && odds.moneyline || {};
  const pointSpread = odds && odds.pointSpread || {};
  const totalMarket = odds && odds.total || {};
  const market = odds ? {
    provider: ingestText(odds.provider && odds.provider.name, 40),
    home_ml: ingestMoneyline(odds.homeTeamOdds) ?? ingestMoneyline(moneyline.home),
    away_ml: ingestMoneyline(odds.awayTeamOdds) ?? ingestMoneyline(moneyline.away),
    home_ml_open: ingestMoneylineAt(odds.homeTeamOdds, 'open') ?? ingestMoneylineAt(moneyline.home, 'open'),
    away_ml_open: ingestMoneylineAt(odds.awayTeamOdds, 'open') ?? ingestMoneylineAt(moneyline.away, 'open'),
    total: ingestNumber(odds.overUnder) ?? ingestMarketLine(totalMarket.over?.close?.line ?? totalMarket.under?.close?.line),
    spread: ingestNumber(odds.spread),
    over_price: ingestMoneylineAt(totalMarket.over, 'close'),
    under_price: ingestMoneylineAt(totalMarket.under, 'close'),
    total_open: ingestMarketLine(totalMarket.over?.open?.line ?? totalMarket.under?.open?.line),
    over_price_open: ingestMoneylineAt(totalMarket.over, 'open'),
    under_price_open: ingestMoneylineAt(totalMarket.under, 'open'),
    home_spread: ingestMarketLine(pointSpread.home?.close?.line),
    away_spread: ingestMarketLine(pointSpread.away?.close?.line),
    home_spread_price: ingestMoneylineAt(pointSpread.home, 'close'),
    away_spread_price: ingestMoneylineAt(pointSpread.away, 'close'),
  } : null;
  return {
    espn_id: event && event.id != null ? String(event.id) : null,
    start: event && event.date || null,
    status: ingestStatus(statusType.name || statusType.state || statusType.description),
    detail: ingestText(statusType.shortDetail || statusType.detail, 48),
    period: ingestNumber(competition.status && competition.status.period),
    home: { code: ingestAbbr(home.team && home.team.abbreviation), score: ingestNumber(home.score) },
    away: { code: ingestAbbr(away.team && away.team.abbreviation), score: ingestNumber(away.score) },
    market,
  };
}

function closestEspnGame(candidates, start, claimed) {
  const target = Date.parse(start || '');
  let best = null, bestDistance = Infinity;
  for (const candidate of candidates || []) {
    if (!candidate.espn_id || claimed.has(candidate.espn_id)) continue;
    const candidateTime = Date.parse(candidate.start || '');
    const distance = Number.isFinite(target) && Number.isFinite(candidateTime) ? Math.abs(candidateTime - target) : 0;
    if (!best || distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best;
}

// Normalizador puro, exportado para regresión. Une por matchup y, en una doble
// cartelera, por la hora más cercana. Si una fuente cae conserva la otra.
export function compactMlbIngest(statsData, espnData, date) {
  const statsGames = (Array.isArray(statsData && statsData.dates) ? statsData.dates : [])
    .flatMap((day) => Array.isArray(day && day.games) ? day.games : [])
    .filter((game) => (game.gameType || 'R') === 'R')
    .map(compactStatsGame);
  const espnGames = mlbLiveEventsForDate(espnData, date).map(compactEspnGame);
  const byMatchup = new Map();
  for (const game of espnGames) {
    const key = `${game.away.code || '?'}@${game.home.code || '?'}`;
    if (!byMatchup.has(key)) byMatchup.set(key, []);
    byMatchup.get(key).push(game);
  }
  const claimed = new Set();
  for (const game of statsGames) {
    const key = `${game.away.code || '?'}@${game.home.code || '?'}`;
    const espn = closestEspnGame(byMatchup.get(key), game.start, claimed);
    if (!espn) continue;
    claimed.add(espn.espn_id);
    game.espn_id = espn.espn_id;
    game.espn_status = espn.status;
    game.espn_period = espn.period;
    game.market = espn.market;
    if (game.home.score == null) game.home.score = espn.home.score;
    if (game.away.score == null) game.away.score = espn.away.score;
  }
  for (const espn of espnGames) {
    if (espn.espn_id && claimed.has(espn.espn_id)) continue;
    statsGames.push({
      id: `espn:${espn.espn_id || 'unknown'}`, mlb_id: null, espn_id: espn.espn_id,
      start: espn.start, status: espn.status, detail: espn.detail,
      home: { id: null, code: espn.home.code, score: espn.home.score, hits: null, errors: null, pitcher_id: null, pitcher: null, lineup: [] },
      away: { id: null, code: espn.away.code, score: espn.away.score, hits: null, errors: null, pitcher_id: null, pitcher: null, lineup: [] },
      inning: espn.period, half: null, outs: null, series_game: null, series_len: null, venue_id: null,
      espn_status: espn.status, espn_period: espn.period, market: espn.market,
    });
  }
  statsGames.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')) || String(a.id).localeCompare(String(b.id)));
  const sides = statsGames.length * 2;
  const missingness = {
    games: statsGames.length,
    pitchers_missing: statsGames.reduce((n, game) => n + (!game.home.pitcher_id ? 1 : 0) + (!game.away.pitcher_id ? 1 : 0), 0),
    pitchers_total: sides,
    lineups_missing: statsGames.reduce((n, game) => n + (!game.home.lineup.length ? 1 : 0) + (!game.away.lineup.length ? 1 : 0), 0),
    lineups_total: sides,
    market_missing: statsGames.filter((game) => !game.market || (
      game.market.home_ml == null && game.market.away_ml == null &&
      game.market.total == null && game.market.spread == null
    )).length,
    mlb_unmatched: statsGames.filter((game) => !game.mlb_id).length,
    espn_unmatched: statsGames.filter((game) => !game.espn_id).length,
  };
  return { games: statsGames, missingness };
}

export function mlbIngestSlotId(scheduledTime) {
  const value = Number(scheduledTime);
  if (!Number.isFinite(value)) throw new Error('scheduledTime inválido');
  return Math.floor(value / MLB_INGEST_INTERVAL_MS);
}

// Etapa de la cartelera, no del modelo. Los estados públicos mandan; cuando
// todos siguen por jugar, la hora del primer lanzamiento separa early de la
// ventana operacional pregame (3 h). Una cartelera con al menos un juego ya
// iniciado/terminado se considera live hasta que todos sean final. Nunca
// inferimos que un juego empezó si las fuentes aún dicen pre.
export function mlbIngestStage(games, scheduledTime) {
  const rows = Array.isArray(games) ? games : [];
  const effectiveStatus = (game) => {
    const statuses = [game && game.status, game && game.espn_status];
    if (statuses.includes('live')) return 'live';
    if (statuses.includes('final')) return 'final';
    return 'pre';
  };
  if (rows.length && rows.every((game) => effectiveStatus(game) === 'final')) return 'final';
  if (rows.some((game) => effectiveStatus(game) !== 'pre')) return 'live';
  const now = Number(scheduledTime);
  const starts = rows.map((game) => Date.parse(game && game.start || '')).filter(Number.isFinite);
  if (Number.isFinite(now) && starts.length && Math.min(...starts) - now <= MLB_PREGAME_WINDOW_MS) return 'pregame';
  return 'early';
}

export async function mlbIngestSourceHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchMlbIngestJson(url, fetcher, timeoutMs, valid) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'aa-sports/1.0' },
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const data = await response.json();
    if (valid && !valid(data)) throw new Error('invalid_shape');
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

const ingestError = (reason) => ingestText(reason && reason.message || reason || 'unknown', 180);

// ESPN exposes the same public, keyless payloads through two site hosts. Some
// Cloudflare egress ranges intermittently receive 403 from the primary even
// while the alternate remains healthy. Normal traffic still makes one fetch;
// the second host is used only after a network/non-2xx failure.
export async function fetchEspnPublicResponse(upstream, {
  fetcher = fetch, fallbackUpstream = null, timeoutMs = MLB_INGEST_TIMEOUT_MS, init = {},
} = {}) {
  const derivedFallback = String(upstream).replace('https://site.api.espn.com', 'https://site.web.api.espn.com');
  const candidates = [
    { source: 'espn_site', url: String(upstream) },
    { source: 'espn_web', url: fallbackUpstream || (derivedFallback !== String(upstream) ? derivedFallback : null) },
  ].filter((candidate, index, all) => candidate.url && all.findIndex((item) => item.url === candidate.url) === index);
  const errors = [];
  for (const candidate of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
      const headers = new Headers(init.headers);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      if (!headers.has('user-agent')) headers.set('user-agent', 'aa-sports/1.0');
      const response = await fetcher(candidate.url, { ...init, headers, signal: controller.signal });
      if (response.ok) return { response, source: candidate.source };
      errors.push(`${candidate.source}:http_${response.status}`);
    } catch (error) {
      errors.push(`${candidate.source}:${ingestError(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(errors.join(';') || 'espn_no_candidate');
}

export async function fetchUsSportsScoreboard(config, date, fetcher = fetch, timeoutMs = MLB_INGEST_TIMEOUT_MS) {
  const path = `/apis/site/v2/sports/${config.scoreboard}?dates=${date.replaceAll('-', '')}&limit=400`;
  const candidates = [
    { source: 'espn_site', url: `https://site.api.espn.com${path}` },
    { source: 'espn_web', url: `https://site.web.api.espn.com${path}` },
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const data = await fetchMlbIngestJson(
        candidate.url, fetcher, timeoutMs, (body) => body && Array.isArray(body.events),
      );
      return { data, source: candidate.source };
    } catch (error) {
      errors.push(`${candidate.source}:${ingestError(error)}`);
    }
  }
  throw new Error(errors.join(';'));
}

export async function fetchMlbEspnScoreboard(date, fetcher = fetch, timeoutMs = MLB_INGEST_TIMEOUT_MS) {
  const primary = mlbScoreboardUrl(date);
  const candidates = [
    { source: 'espn_site', url: primary },
    { source: 'espn_web', url: primary.replace('https://site.api.espn.com', 'https://site.web.api.espn.com') },
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const data = await fetchMlbIngestJson(
        candidate.url, fetcher, timeoutMs, (body) => body && Array.isArray(body.events),
      );
      return { data, source: candidate.source };
    } catch (error) {
      errors.push(`${candidate.source}:${ingestError(error)}`);
    }
  }
  throw new Error(errors.join(';'));
}

export async function runMlbIngest(env, {
  scheduledTime = Date.now(), now = new Date(), fetcher = fetch, timeoutMs = MLB_INGEST_TIMEOUT_MS,
} = {}) {
  const scheduledMs = Number(scheduledTime);
  const scheduledAt = new Date(scheduledMs).toISOString();
  const capturedAt = new Date(now).toISOString();
  const date = etDate(new Date(scheduledMs));
  const statsUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,linescore,lineups,venue`;
  const results = await Promise.allSettled([
    fetchMlbIngestJson(statsUrl, fetcher, timeoutMs, (data) => data && Array.isArray(data.dates)),
    fetchMlbEspnScoreboard(date, fetcher, timeoutMs),
  ]);
  const statsOk = results[0].status === 'fulfilled';
  const espnOk = results[1].status === 'fulfilled';
  const sourceMask = (statsOk ? 2 : 0) | (espnOk ? 1 : 0);
  const sources = {
    mlb: { status: statsOk ? 'ok' : 'error', error: statsOk ? null : ingestError(results[0].reason) },
    espn: {
      status: espnOk ? 'ok' : 'error',
      source: espnOk ? results[1].value.source : null,
      error: espnOk ? null : ingestError(results[1].reason),
    },
  };
  const compact = compactMlbIngest(
    statsOk ? results[0].value : null,
    espnOk ? results[1].value.data : null,
    date,
  );
  const status = sourceMask === 3 ? 'ok' : sourceMask ? 'partial' : 'error';
  const stage = mlbIngestStage(compact.games, Date.parse(capturedAt));
  const slotId = mlbIngestSlotId(scheduledMs);
  const hashInput = { date, stage, source_mask: sourceMask, games: compact.games };
  const sourceHash = await mlbIngestSourceHash(hashInput);
  const errors = Object.fromEntries(Object.entries(sources).filter(([, value]) => value.error).map(([key, value]) => [key, value.error]));
  const payload = {
    schema: 'mlb_ingest_v1', slot_id: slotId, date, scheduled_at: scheduledAt,
    captured_at: capturedAt, status, stage, sources, games: compact.games,
  };
  // First write wins. Un retry del mismo cron puede observar lineups/mercado
  // más tarde y no debe reescribir retrospectivamente la captura causal del
  // slot, aunque llegue con más fuentes o un payload distinto.
  const upsert = env.DB.prepare(`
    INSERT INTO mlb_ingest_slots
      (slot_id, date, scheduled_at, captured_at, status, stage, source_mask, sources, source_hash, n_games, missingness, payload, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot_id) DO NOTHING
  `).bind(
    slotId, date, scheduledAt, capturedAt, status, stage, sourceMask, JSON.stringify(sources), sourceHash,
    compact.games.length, JSON.stringify(compact.missingness), JSON.stringify(payload),
    Object.keys(errors).length ? JSON.stringify(errors) : null,
  );
  const cutoff = new Date(scheduledMs - MLB_INGEST_RETENTION_MS).toISOString();
  const cleanup = env.DB.prepare('DELETE FROM mlb_ingest_slots WHERE scheduled_at < ?').bind(cutoff);
  const dbResults = await env.DB.batch([upsert, cleanup]);
  const report = {
    slot_id: slotId, date, status, stage, source_mask: sourceMask, source_hash: sourceHash,
    n_games: compact.games.length, missingness: compact.missingness,
    inserted_or_updated: Number(dbResults?.[0]?.meta?.changes || 0),
    pruned: Number(dbResults?.[1]?.meta?.changes || 0), sources,
  };
  console.log(JSON.stringify({ message: 'mlb ingest complete', ...report }));
  return report;
}

// Normalized public facts for NFL/NCAAF/NHL/NCAAM. This is deliberately a
// data contract, not a model: no feature weights, probability or pick exists
// in this payload. Keeping it pure makes the causal timestamp testable.
export function compactUsSportsIngest(data, sport, date) {
  if (!US_SPORTS[sport]) throw new Error(`unsupported sport: ${sport}`);
  const events = Array.isArray(data?.events) ? data.events : [];
  const games = events
    .filter((event) => !event?.date || etDate(event.date) === date)
    .map((event) => {
      const competition = event?.competitions?.[0] || {};
      const competitors = competition.competitors || [];
      const home = competitors.find((team) => team.homeAway === 'home') || competitors[0] || {};
      const away = competitors.find((team) => team.homeAway === 'away') || competitors[1] || {};
      const statusType = competition.status?.type || event?.status?.type || {};
      const oddsList = Array.isArray(competition.odds) ? competition.odds : [];
      const odds = oddsList.find((item) => item && (item.homeTeamOdds || item.awayTeamOdds || item.overUnder != null)) || oddsList[0] || null;
      const market = odds ? compactEspnGame(event).market : null;
      const side = (team) => ({
        id: team?.team?.id ?? null,
        code: ingestText(team?.team?.abbreviation || team?.team?.shortDisplayName, 16),
        name: ingestText(team?.team?.displayName || team?.team?.shortDisplayName, 80),
        score: ingestNumber(team?.score),
        record: ingestText(team?.records?.[0]?.summary, 24),
      });
      return {
        id: String(event?.id || ''), start: event?.date || null,
        status: ingestStatus(statusType.name || statusType.state || statusType.description),
        detail: ingestText(statusType.shortDetail || statusType.detail, 64),
        period: ingestNumber(competition.status?.period), neutral: !!competition.neutralSite,
        conference_competition: !!competition.conferenceCompetition,
        home: side(home), away: side(away), market,
      };
    })
    .filter((game) => game.id && game.home.code && game.away.code)
    .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')) || a.id.localeCompare(b.id));
  const missingness = {
    games: games.length,
    market_missing: games.filter((game) => !game.market || (
      game.market.home_ml == null && game.market.away_ml == null && game.market.total == null
    )).length,
    team_code_missing: games.reduce((count, game) => count + (!game.home.code ? 1 : 0) + (!game.away.code ? 1 : 0), 0),
  };
  return { games, missingness };
}

export async function runUsSportsIngest(env, {
  scheduledTime = Date.now(), now = new Date(), fetcher = fetch, timeoutMs = MLB_INGEST_TIMEOUT_MS,
} = {}) {
  const scheduledMs = Number(scheduledTime);
  const scheduledAt = new Date(scheduledMs).toISOString();
  const capturedAt = new Date(now).toISOString();
  const date = etDate(new Date(scheduledMs));
  const slotId = mlbIngestSlotId(scheduledMs);
  const reports = [];
  for (const [sport, config] of Object.entries(US_SPORTS)) {
    let compact = { games: [], missingness: { games: 0, market_missing: 0, team_code_missing: 0 } };
    let status = 'ok', error = null, source = 'espn_site';
    try {
      const fetched = await fetchUsSportsScoreboard(config, date, fetcher, timeoutMs);
      source = fetched.source;
      compact = compactUsSportsIngest(fetched.data, sport, date);
    } catch (caught) {
      status = 'error'; error = ingestError(caught);
    }
    const sourceHash = await mlbIngestSourceHash({ sport, date, games: compact.games });
    const payload = {
      schema: 'us_sports_ingest_v1', sport, slot_id: slotId, date,
      scheduled_at: scheduledAt, captured_at: capturedAt, status,
      source, games: compact.games,
    };
    const result = await env.DB.prepare(`
      INSERT INTO sports_ingest_slots
        (sport, slot_id, date, scheduled_at, captured_at, status, source, source_hash, n_games, missingness, payload, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sport, slot_id) DO NOTHING
    `).bind(
      sport, slotId, date, scheduledAt, capturedAt, status, source, sourceHash,
      compact.games.length, JSON.stringify(compact.missingness), JSON.stringify(payload), error,
    ).run();
    reports.push({ sport, status, source, slot_id: slotId, n_games: compact.games.length, source_hash: sourceHash, inserted: Number(result?.meta?.changes || 0), error });
  }
  const cutoff = new Date(scheduledMs - MLB_INGEST_RETENTION_MS).toISOString();
  await env.DB.prepare('DELETE FROM sports_ingest_slots WHERE scheduled_at < ?').bind(cutoff).run();
  console.log(JSON.stringify({ message: 'us sports ingest complete', date, reports }));
  return reports;
}

const parseHealthJson = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; } catch (e) { return fallback; }
};

export function mlbPipelineHealthDoc(row, now = Date.now()) {
  if (!row) {
    return {
      ok: false, pipeline: 'mlb_ingest_20m', state: 'empty', interval_minutes: 20,
      stale_after_minutes: MLB_INGEST_STALE_SECONDS / 60, latest: null,
    };
  }
  const capturedMs = Date.parse(row.captured_at || '');
  const ageSeconds = Number.isFinite(capturedMs) ? Math.max(0, Math.floor((Number(now) - capturedMs) / 1000)) : null;
  const fresh = ageSeconds != null && ageSeconds <= MLB_INGEST_STALE_SECONDS;
  const sources = parseHealthJson(row.sources, {});
  const missingness = parseHealthJson(row.missingness, {});
  const errors = parseHealthJson(row.error, null);
  return {
    ok: fresh && row.status === 'ok', pipeline: 'mlb_ingest_20m',
    state: fresh ? (row.status || 'unknown') : 'stale',
    interval_minutes: 20, stale_after_minutes: MLB_INGEST_STALE_SECONDS / 60,
    fresh, age_seconds: ageSeconds,
    latest: {
      slot_id: Number(row.slot_id), date: row.date || null, scheduled_at: row.scheduled_at || null,
      captured_at: row.captured_at || null, status: row.status || null, stage: row.stage || null,
      source_hash: row.source_hash || null,
      n_games: Number(row.n_games || 0), sources, missingness, errors,
    },
  };
}

const LEARNING_STALE_SECONDS = 36 * 60 * 60;
export function learningFreshnessDoc(doc, now = Date.now()) {
  const updatedMs = Date.parse(doc?.updated_at || '');
  const ageSeconds = Number.isFinite(updatedMs) ? Math.max(0, Math.floor((Number(now) - updatedMs) / 1000)) : null;
  return {
    fresh: ageSeconds != null && ageSeconds <= LEARNING_STALE_SECONDS,
    stale_after_hours: LEARNING_STALE_SECONDS / 3600,
    age_seconds: ageSeconds,
    updated_at: doc?.updated_at || null,
    last_date: doc?.last_date || null,
    n_graded: Number.isFinite(Number(doc?.n_graded)) ? Number(doc.n_graded) : null,
  };
}

async function mlbPipelineHealth(env, origin) {
  try {
    const [row, learningRaw] = await Promise.all([
      env.DB.prepare(`
        SELECT slot_id, date, scheduled_at, captured_at, status, stage, source_hash,
               n_games, sources, missingness, error
        FROM mlb_ingest_slots ORDER BY slot_id DESC LIMIT 1
      `).first(),
      env.AA_LATEST?.get ? env.AA_LATEST.get('mlb:learning') : Promise.resolve(null),
    ]);
    let learning = null;
    try { learning = learningRaw ? JSON.parse(learningRaw) : null; } catch (e) { /* malformed KV is stale */ }
    return json({ ...mlbPipelineHealthDoc(row), learning: learningFreshnessDoc(learning) }, 200, origin, 30);
  } catch (error) {
    console.error(JSON.stringify({ message: 'mlb pipeline health unavailable', error: ingestError(error) }));
    return json({
      ok: false, pipeline: 'mlb_ingest_20m', state: 'unavailable',
      interval_minutes: 20, stale_after_minutes: MLB_INGEST_STALE_SECONDS / 60,
      error: 'storage_unavailable',
    }, 200, origin, 15);
  }
}

// Marcadores en vivo multideporte (mismo patrón proxy+caché que MLB).
// Las predicciones de estos deportes llegarán cuando su modelo pase la
// validación; mientras, AA Sports ya muestra el "en vivo" estilo SofaScore.
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const BASKETBALL_LEAGUES = Object.freeze(['nba', 'wnba']);
const SOCCER_LEAGUES = {
  'eng.1': 'Premier League', 'esp.1': 'LaLiga',
  'ita.1': 'Serie A', 'ger.1': 'Bundesliga', 'fra.1': 'Ligue 1',
  'usa.1': 'MLS', 'mex.1': 'Liga MX', 'uefa.champions': 'Champions',
};
const DEFAULT_SOCCER_LEAGUE = 'eng.1';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = (env && env.ALLOWED_ORIGIN) || '*';

    const path = url.pathname.replace(/\/+$/, '') || '/';
    const isAccount = path.startsWith('/v1/auth') || path.startsWith('/v1/me');
    const isQa = path.startsWith('/v1/qa/');
    const isModelPublish = path === MODEL_PUBLISH_PATH;

    // Wrangler puede exponer esta ruta al simular scheduled() en desarrollo.
    // En producción no aceptamos disparos HTTP del cron.
    if (path === '/__scheduled') return json({ error: 'not_found' }, 404, origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: (isAccount || isQa) ? credCors(request, env) : cors(origin) });
    }
    if (isModelPublish && request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, origin);
    }
    if (isQa && request.method !== 'GET' && request.method !== 'HEAD') {
      return credJson({ error: 'method_not_allowed' }, 405, request, env);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && !isAccount && !isQa && !isModelPublish) {
      return json({ error: 'method_not_allowed' }, 405, origin);
    }

    try {
      if (isModelPublish) return await internalModelPublish(request, env, origin);
      if (path === '/v1/qa/intelligence/today') return await qaIntelligenceToday(request, env);
      const qaRoute = path.match(/^\/v1\/qa\/(wnba|nfl|ncaaf|nhl|ncaam)\/(today|history|learning|simulation|pipeline-health)$/);
      if (qaRoute) return await qaSportRoute(url, request, env, qaRoute[1], qaRoute[2]);
      if (path === '/' || path === '/v1' || path === '/v1/health') {
        return json(
          { service: 'aa-sports-api', ok: true, sports: ['mlb', 'soccer', 'nba', 'wnba', 'tennis', ...Object.keys(US_SPORTS)], routes: ['/v1/intelligence/today', '/v1/intelligence/history', '/v1/mlb/today', '/v1/mlb/event/:id', '/v1/mlb/history', '/v1/mlb/live', '/v1/mlb/pipeline-health', '/v1/:sport/today', '/v1/:sport/live', '/v1/:sport/recent', '/v1/:sport/standings', '/v1/:sport/summary', '/v1/:sport/history', '/v1/:sport/learning', '/v1/:sport/simulation', '/v1/:sport/pipeline-health', '/v1/qa/:sport/:view (authenticated)', '/v1/qa/intelligence/today (authenticated)', '/v1/injuries'] },
          200, origin,
        );
      }

      if (path === '/v1/mlb/today') return await today(env, origin);
      if (path === '/v1/intelligence/today') return await intelligenceToday(env, origin);
      if (path === '/v1/intelligence/history') return await intelligenceHistory(url, env, origin);
      if (path === '/v1/mlb/pipeline-health') return await mlbPipelineHealth(env, origin);
      const sm = path.match(/^\/v1\/mlb\/schedule\/(\d{4}-\d{2}-\d{2})$/);
      if (sm) return await schedule(sm[1], origin);
      const dm = path.match(/^\/v1\/mlb\/day\/(\d{4}-\d{2}-\d{2})$/);
      if (dm) return await day(dm[1], env, origin);
      if (path === '/v1/mlb/live') return await live(ctx, origin);
      if (path === '/v1/mlb/history') return await history(url, env, origin);
      const usRoute = path.match(/^\/v1\/(nfl|ncaaf|nhl|ncaam)\/(today|live|recent|standings|summary|history|learning|simulation|pipeline-health)$/);
      if (usRoute) {
        const [, sport, action] = usRoute;
        const config = US_SPORTS[sport];
        const upstream = `${ESPN_BASE}/${config.scoreboard}`;
        if (action === 'today') return await usSportsToday(env, sport, origin);
        if (action === 'live') {
          const today = etDate(new Date()).replaceAll('-', '');
          const primary = `${upstream}?dates=${today}&limit=400`;
          const fallback = primary.replace('https://site.api.espn.com', 'https://site.web.api.espn.com');
          return await otherLive(ctx, origin, sport, primary, fallback);
        }
        if (action === 'recent') return await recentGames(ctx, origin, sport, upstream);
        if (action === 'standings') return await standings(ctx, origin, sport, config.standings);
        if (action === 'history') return await usSportsHistory(url, env, sport, origin);
        if (action === 'learning') return await sportLearning(env, sport, origin);
        if (action === 'simulation') return await usSportsKv(env, sport, action, origin);
        if (action === 'pipeline-health') return await usSportsPipelineHealth(env, sport, origin);
        if (action === 'summary') {
          const eid = url.searchParams.get('event');
          if (!eid || !/^\d+$/.test(eid)) return json({ error: 'bad_event' }, 400, origin);
          return await summary(ctx, origin, sport, eid, `${ESPN_BASE}/${config.summary}?event=${eid}`);
        }
      }
      const basketballRoute = path.match(/^\/v1\/(nba|wnba)\/(today|live|recent|standings|summary|history|learning|simulation|pipeline-health)$/);
      if (basketballRoute) {
        const [, league, action] = basketballRoute;
        if (!BASKETBALL_LEAGUES.includes(league)) return json({ error: 'unknown_league' }, 400, origin);
        const scoreboard = `${ESPN_BASE}/basketball/${league}/scoreboard`;
        if (action === 'learning') return await sportLearning(env, league, origin);
        if (action === 'history') return await usSportsHistory(url, env, league, origin);
        if (action === 'simulation') return await usSportsKv(env, league, action, origin);
        if (action === 'pipeline-health') return await usSportsPipelineHealth(env, league, origin);
        if (action === 'today') {
          const todayEt = etDate(new Date());
          const today = todayEt.replaceAll('-', '');
          let fallbackGames = [];
          try {
            const fetched = await fetchEspnPublicResponse(`${scoreboard}?dates=${today}&limit=100`, { init: { cf: { cacheTtl: 30 } } });
            fallbackGames = compactOtherLiveGames(await fetched.response.json())
              .filter((game) => game.start && etDate(new Date(game.start)) === todayEt);
          } catch (e) { /* a KV shadow doc can still be served fail-closed */ }
          return await usSportsToday(env, league, origin, fallbackGames);
        }
        if (action === 'live') {
          // Fijar el día ET evita que ESPN entregue el último slate completado
          // cuando una liga está libre u off-season.
          const today = etDate(new Date()).replaceAll('-', '');
          return await otherLive(ctx, origin, league, `${scoreboard}?dates=${today}&limit=100`);
        }
        if (action === 'recent') return await recentGames(ctx, origin, league, scoreboard);
        if (action === 'standings') {
          return await standings(ctx, origin, league, `https://site.api.espn.com/apis/v2/sports/basketball/${league}/standings`);
        }
        const eid = url.searchParams.get('event');
        if (!eid || !/^\d+$/.test(eid)) return json({ error: 'bad_event' }, 400, origin);
        return await summary(ctx, origin, league, eid, `${ESPN_BASE}/basketball/${league}/summary?event=${eid}`);
      }
      if (path === '/v1/tennis/live') return await tennisLive(ctx, origin);
      if (path === '/v1/tennis/learning') return await sportLearning(env, 'tennis', origin);
      if (path === '/v1/soccer/learning') return await sportLearning(env, 'soccer', origin);
      if (path === '/v1/soccer/live') {
        const lg = url.searchParams.get('league') || DEFAULT_SOCCER_LEAGUE;
        if (!SOCCER_LEAGUES[lg]) return json({ error: 'unknown_league', leagues: Object.keys(SOCCER_LEAGUES) }, 400, origin);
        return await otherLive(ctx, origin, 'soccer:' + lg, `${ESPN_BASE}/soccer/${lg}/scoreboard`);
      }

      // últimos resultados (fuera de horario / off-season) + tablas de posiciones
      if (path === '/v1/tennis/recent') return await tennisRecent(ctx, origin);
      if (path === '/v1/tennis/rankings') return await tennisRankings(ctx, origin);
      if (path === '/v1/soccer/recent') {
        const lg = url.searchParams.get('league') || DEFAULT_SOCCER_LEAGUE;
        if (!SOCCER_LEAGUES[lg]) return json({ error: 'unknown_league' }, 400, origin);
        return await recentGames(ctx, origin, 'soccer:' + lg, `${ESPN_BASE}/soccer/${lg}/scoreboard`);
      }
      if (path === '/v1/mlb/standings') return await standings(ctx, origin, 'mlb-div', 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings?level=3', 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings');
      if (path === '/v1/soccer/standings') {
        const lg = url.searchParams.get('league') || DEFAULT_SOCCER_LEAGUE;
        if (!SOCCER_LEAGUES[lg]) return json({ error: 'unknown_league' }, 400, origin);
        return await standings(ctx, origin, 'soccer:' + lg, `https://site.api.espn.com/apis/v2/sports/soccer/${lg}/standings`);
      }
      if (path === '/v1/soccer/leagues') return json({ leagues: SOCCER_LEAGUES }, 200, origin, 3600);
      if (path === '/v1/soccer/today') return await soccerToday(env, origin);

      // Detalle de partido (alineaciones + estadísticas + eventos) — proxy con
      // caché del endpoint summary de ESPN. Descriptivo, sin predicciones.
      if (path === '/v1/soccer/summary') {
        const sport = path.split('/')[2];
        const eid = url.searchParams.get('event');
        if (!eid || !/^\d+$/.test(eid)) return json({ error: 'bad_event' }, 400, origin);
        const lg = url.searchParams.get('league') || DEFAULT_SOCCER_LEAGUE;
        if (!SOCCER_LEAGUES[lg]) return json({ error: 'unknown_league' }, 400, origin);
        const up = `${ESPN_BASE}/soccer/${lg}/summary?event=${eid}`;
        return await summary(ctx, origin, sport, eid, up);
      }
      if (path === '/v1/injuries') return await injuries(env, origin);
      if (/^\/v1\/poly\/(radar|alerts|track|wallet)$/.test(path)) {
        return json(POLY_RADAR_PAUSED, 200, origin, 300);
      }
      if (path === '/v1/mlb/learning') return await mlbLearning(env, origin);
      if (path === '/v1/mlb/simulation') return await mlbSimulation(env, origin);

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

  // Cron del Worker:
  //  · "*/20 * * * *" → captura hechos públicos MLB en D1. No calcula ni
  //    publica predicciones y no contiene pesos privados del modelo.
  // Radar de Polymarket queda pausado: no se ejecutan polyWatch/polyDaily.
  async scheduled(controller, env, ctx) {
    if (controller && controller.cron === MLB_INGEST_CRON) {
      ctx.waitUntil(Promise.all([
        runMlbIngest(env, { scheduledTime: controller.scheduledTime }),
        runUsSportsIngest(env, { scheduledTime: controller.scheduledTime }),
      ]));
    } else {
      console.warn(JSON.stringify({ message: 'scheduled cron ignored', cron: controller && controller.cron || null }));
    }
  },
};

// --- rutas ---------------------------------------------------------------

async function today(env, origin) {
  const raw = await env.AA_LATEST.get('mlb:today');
  let stored = null;
  try { stored = raw ? JSON.parse(raw) : null; } catch (e) { /* blob inválido: intenta el fallback */ }
  const date = etDate(new Date());
  if (raw && stored && stored.date === date) {
    return new Response(raw, {
      status: 200,
      headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
    });
  }

  // GitHub Actions puede retrasar el cron horario. Si el blob aún es de ayer,
  // muestra el calendario real de HOY desde StatsAPI y deja la predicción AA
  // explícitamente pendiente. El subrequest se cachea 120 s en el edge ($0).
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,linescore`,
      { headers: { 'user-agent': 'aa-sports/1.0', accept: 'application/json' }, cf: { cacheTtl: 120, cacheEverything: true } },
    );
    if (!res.ok) throw new Error('statsapi ' + res.status);
    const doc = mlbPendingDoc(await res.json(), date, stored && stored.record, new Date().toISOString());
    return json(doc, 200, origin, 120);
  } catch (err) {
    console.error(JSON.stringify({ message: 'mlb today fallback failed', error: String(err && err.message || err), date }));
    // Ante una caída solo degradamos a un blob realmente anterior. Un blob
    // futuro/manual no debe presentarse como si fuera la cartelera de hoy.
    if (raw && stored && stored.date && stored.date < date) {
      return new Response(raw, {
        status: 200,
        headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30' },
      });
    }
    return json({ sport: 'mlb', date, events: [], record: null, note: 'sin datos aún' }, 200, origin, 30);
  }
}

// Provider-neutral, already-calculated intelligence. The Worker only applies
// a strict public allowlist and freshness policy; it never ranks or models.
const intelligenceNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const intelligenceText = (value, max = 120) => typeof value === 'string' ? value.slice(0, max) : null;

function safeIntelligenceProvider(source) {
  if (!source || typeof source !== 'object') return null;
  const out = {};
  for (const key of ['matched', 'fresh', 'usable']) if (typeof source[key] === 'boolean') out[key] = source[key];
  for (const key of ['prob', 'bid', 'ask', 'mid', 'spread', 'indicative', 'volume_24h', 'liquidity', 'n', 'disagreement']) {
    const value = intelligenceNumber(source[key]); if (value != null) out[key] = value;
  }
  for (const key of ['as_of', 'market_id', 'ticker']) {
    const value = intelligenceText(source[key]); if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export function sanitizeIntelligenceDoc(source, nowMs = Date.now()) {
  const doc = source && typeof source === 'object' ? source : {};
  const asOf = intelligenceText(doc.as_of, 40);
  const stale = !asOf || !Number.isFinite(Date.parse(asOf)) || nowMs - Date.parse(asOf) > 75 * 60 * 1000;
  const slate = (Array.isArray(doc.slate) ? doc.slate : []).slice(0, 7).map((item) => {
    const prob = intelligenceNumber(item?.aa?.prob);
    if (!item?.id || !item?.event_id || !item?.pick || prob == null || item?.aa?.public_gate !== true) return null;
    const consensus = item.consensus && typeof item.consensus === 'object' ? {
      state: stale ? 'insufficient' : ['agree', 'conflict', 'insufficient'].includes(item.consensus.state) ? item.consensus.state : 'insufficient',
      market_prob: stale ? null : intelligenceNumber(item.consensus.market_prob),
      divergence: stale ? null : intelligenceNumber(item.consensus.divergence),
      anomalies: stale ? [] : (Array.isArray(item.consensus.anomalies) ? item.consensus.anomalies : []).slice(0, 6).map((a) => ({
        code: intelligenceText(a?.code, 50), value: intelligenceNumber(a?.value),
      })).filter((a) => a.code),
    } : { state: 'insufficient', market_prob: null, divergence: null, anomalies: [] };
    const walletSignal = !stale && item.wallet_signal && ['support', 'oppose', 'mixed'].includes(item.wallet_signal.side) ? {
      side: item.wallet_signal.side, qualified_wallets: Math.min(25, Math.max(0, intelligenceNumber(item.wallet_signal.qualified_wallets) || 0)),
      usd: Math.max(0, intelligenceNumber(item.wallet_signal.usd) || 0), label: 'possible_informed_pattern',
      profiles: (Array.isArray(item.wallet_signal.profiles) ? item.wallet_signal.profiles : []).slice(0, 5).map((profile) => ({
        wallet: intelligenceText(profile?.wallet, 42), usd: Math.max(0, intelligenceNumber(profile?.usd) || 0),
        n: Math.max(0, intelligenceNumber(profile?.n) || 0), win_rate: intelligenceNumber(profile?.win_rate),
        wr_lb: intelligenceNumber(profile?.wr_lb), pnl: intelligenceNumber(profile?.pnl),
      })).filter((profile) => /^0x[0-9a-f]{40}$/i.test(profile.wallet || '')),
    } : null;
    return {
      id: intelligenceText(item.id), sport: intelligenceText(item.sport, 20), event_id: intelligenceText(item.event_id),
      start: intelligenceText(item.start, 40), home: safeSportSide(item.home), away: safeSportSide(item.away),
      market: intelligenceText(item.market, 30), pick: intelligenceText(item.pick),
      aa: { prob, engine: intelligenceText(item.aa.engine, 60), public_gate: true },
      books: stale ? null : safeIntelligenceProvider(item.books),
      polymarket: stale ? null : safeIntelligenceProvider(item.polymarket),
      kalshi: stale ? null : safeIntelligenceProvider(item.kalshi),
      wallet_signal: walletSignal, consensus,
      reasons: (Array.isArray(item.reasons) ? item.reasons : []).slice(0, 5).map((reason) => typeof reason === 'string'
        ? { code: 'measured_reason', text: reason.slice(0, 160) }
        : { code: intelligenceText(reason?.code, 60), value: intelligenceNumber(reason?.value) }).filter((reason) => reason.code),
    };
  }).filter(Boolean);
  const comboSample = safeMarketSample(doc?.combos?.sample) || { n: 0, dates: 0, min_forward: 100, min_dates: 30 };
  return {
    version: 'intelligence_v1', date: intelligenceText(doc.date, 10), state: stale ? 'stale' : (slate.length ? 'fresh' : 'degraded'),
    as_of: asOf, next_refresh: intelligenceText(doc.next_refresh, 40), cadence: '30m_active_2h_calm',
    sources: {
      aa: { ok: doc?.sources?.aa?.ok === true }, books: { ok: doc?.sources?.books?.ok === true },
      polymarket: { ok: doc?.sources?.polymarket?.ok === true, markets: Math.max(0, intelligenceNumber(doc?.sources?.polymarket?.markets) || 0) },
      kalshi: { ok: doc?.sources?.kalshi?.ok === true, markets: Math.max(0, intelligenceNumber(doc?.sources?.kalshi?.markets) || 0) },
    }, slate,
    combos: { state: 'closed', gate: { passed: false, approved: false, public: false, reason: 'combos_forward_validation_pending' }, sample: comboSample },
    budget: { kv_writes: Math.min(120, Math.max(0, intelligenceNumber(doc?.budget?.kv_writes) || 0)),
      d1_rows: Math.min(5000, Math.max(0, intelligenceNumber(doc?.budget?.d1_rows) || 0)), max_kv_writes_day: 120, max_d1_rows_day: 5000 },
    alerts: false, telegram: false,
  };
}

async function intelligenceToday(env, origin) {
  const raw = await env.AA_LATEST.get('intelligence:today');
  if (!raw) return json(sanitizeIntelligenceDoc({ state: 'degraded', slate: [] }), 200, origin, 30);
  let parsed; try { parsed = JSON.parse(raw); } catch (error) { parsed = {}; }
  return json(sanitizeIntelligenceDoc(parsed), 200, origin, 60);
}

async function intelligenceHistory(url, env, origin) {
  const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10) || 7));
  const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - days);
  let snapshots = [];
  try {
    const result = await env.DB.prepare(
      'SELECT payload FROM market_intelligence_snapshots WHERE date >= ? ORDER BY slot_at DESC LIMIT 336',
    ).bind(cutoff.toISOString().slice(0, 10)).all();
    snapshots = (result?.results || []).map((row) => { try { return sanitizeIntelligenceDoc(JSON.parse(row.payload)); } catch (error) { return null; } }).filter(Boolean);
  } catch (error) { /* migration/storage unavailable -> explicit empty history */ }
  return json({ version: 'intelligence_history_v1', days, count: snapshots.length, snapshots }, 200, origin, 300);
}

async function qaIntelligenceToday(request, env) {
  const session = await sessionUser(request, env);
  if (!session) return credJson({ error: 'qa_auth_required' }, 401, request, env);
  if (!qaSessionAllowed(session, env)) return credJson({ error: 'qa_forbidden' }, 403, request, env);
  const raw = await env.AA_LATEST.get('intelligence:today');
  let parsed; try { parsed = raw ? JSON.parse(raw) : {}; } catch (error) { parsed = {}; }
  const shadowCombos = (Array.isArray(parsed?.combos?.items) ? parsed.combos.items : []).slice(0, 3).map((combo) => ({
    combo_id: intelligenceText(combo?.combo_id), state: 'shadow', joint_prob: null,
    independence_prob: intelligenceNumber(combo?.independence_prob), reason: 'correlation_forward_sample_pending',
    legs: (Array.isArray(combo?.legs) ? combo.legs : []).slice(0, 3).map((leg) => ({
      id: intelligenceText(leg?.id), sport: intelligenceText(leg?.sport, 20), event_id: intelligenceText(leg?.event_id),
      pick: intelligenceText(leg?.pick), prob: intelligenceNumber(leg?.prob), start: intelligenceText(leg?.start, 40),
    })).filter((leg) => leg.id && leg.pick),
  })).filter((combo) => combo.combo_id && combo.legs.length >= 2);
  return credJson({ ...sanitizeIntelligenceDoc(parsed), qa: true, public: false, shadow_combos: shadowCombos }, 200, request, env);
}

// Normalización pura del schedule mínimo de respaldo (exportada para tests).
// No calcula ni infiere una predicción: solo publica hechos del calendario.
export function mlbPendingDoc(data, date, record = null, updatedAt = null) {
  const games = (Array.isArray(data && data.dates) ? data.dates : [])
    .flatMap((d) => Array.isArray(d && d.games) ? d.games : [])
    .filter((g) => (g.gameType || 'R') === 'R');
  const fixAbbr = (abbr) => MLB_ABBR_FIX[abbr] || abbr;
  const teamOf = (side) => {
    const team = (side && side.team) || {};
    const rawCode = team.abbreviation || team.teamName || team.name || '?';
    return { code: fixAbbr(rawCode), name: team.name || team.shortName || team.teamName || rawCode };
  };
  const statusOf = (g) => {
    const s = String((g.status && (g.status.detailedState || g.status.abstractGameState)) || '').toLowerCase();
    if (s.includes('final') || s.includes('completed') || s.includes('game over')) return 'final';
    if (s.includes('progress') || s.includes('live') || s.includes('delayed')) return 'live';
    return 'pre';
  };
  const pitcherName = (p) => (p && (p.fullName || p.lastName)) || null;
  const events = games.map((g) => {
    const sides = g.teams || {};
    const away = teamOf(sides.away), home = teamOf(sides.home);
    const awayPitcher = pitcherName(sides.away && sides.away.probablePitcher);
    const homePitcher = pitcherName(sides.home && sides.home.probablePitcher);
    return {
      sport: 'mlb', league: 'MLB', event_id: String(g.gamePk),
      matchup: `${away.code} @ ${home.code}`, start: g.gameDate || date, status: statusOf(g),
      home, away, prediction: null, pending: true,
      metrics: [], summary_es: null,
      snapshot: (awayPitcher || homePitcher) ? { pitchers: {
        away: awayPitcher ? { name: awayPitcher } : null,
        home: homePitcher ? { name: homePitcher } : null,
      } } : null,
      risk: null, odds: null, badges: [], result: null, final: null, live: null, updated_at: null,
    };
  });
  return {
    sport: 'mlb', league: 'MLB', date, source: 'statsapi-fallback',
    updated_at: updatedAt, record: record || null, pending: true, events,
  };
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
  const found = [], recentBuys = [];
  // El panel de señales debe reflejar actividad reciente y con tamaño medido,
  // no una coincidencia que lleva una semana flotando.
  const nowSec = Math.floor(Date.now() / 1000), CONS_WIN = 48 * 3600;
  for (const w of watch) {
    try {
      const r = await fetch(`https://data-api.polymarket.com/activity?user=${encodeURIComponent(w.w)}&limit=25&type=TRADE`, { headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const acts = await r.json();
      // Consenso de vigiladas: compras recientes de al menos $50 medidos.
      for (const a of (Array.isArray(acts) ? acts : [])) {
        if (a.side !== 'BUY' || !isFinite(+a.timestamp) || (nowSec - +a.timestamp) > CONS_WIN) continue;
        const usd = a.usdcSize != null && isFinite(+a.usdcSize) ? Math.round(+a.usdcSize)
          : (isFinite(+a.price) && isFinite(+a.size) ? Math.round(+a.price * +a.size) : null);
        if (!Number.isFinite(usd) || usd < 50) continue;
        recentBuys.push({ wallet: w.w, name: w.pseudonym || w.name || null, score: w.insider_score ?? null, title: String(a.title || '').slice(0, 90), outcome: a.outcome != null ? String(a.outcome) : null, ts: +a.timestamp, price: isFinite(+a.price) ? +a.price : null, usd });
      }
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
    }
  }
  ad.checked_at = nowIso;
  ad.watching = watch.length;
  const cons = polyConsensus(recentBuys);
  ad.consensus = cons;
  // 🎯 Señales del día: cruza el consenso con los perfiles completos (poly:radar)
  // para leer "informado vs sigue tendencia", fuerza y probabilidad del mercado.
  const byWallet = new Map((Array.isArray(doc.wallets) ? doc.wallets : []).map((p) => [p.w, p]));
  ad.signals = polySignals(cons, byWallet, nowSec);
  // 🤝 Push del consenso: el estado de "ya avisado" vive DENTRO de poly:alerts (que ya
  // se escribe cada ronda) → CERO escrituras KV extra (antes gastaba un poly:consnotified
  // aparte = +288 writes/día). Avisa cuando un consenso se FORMA o se REFUERZA; el primer
  // arranque solo siembra. Telegram se manda DESPUÉS de persistir (si falla, no toca KV).
  let consPush = [];
  try {
    const prevCons = (ad.cons_notified && typeof ad.cons_notified === 'object') ? ad.cons_notified : null;
    const r = polyConsensusToPush(cons, prevCons);
    ad.cons_notified = r.notified;
    consPush = r.push;
  } catch (e) { /* el push del consenso nunca debe tumbar la ronda del vigía */ }
  // Telegram NO replica el tape crudo ni el resumen diario. Solo puede salir una
  // observación excepcional que supere todos los filtros de calidad y el tope
  // diario. D1 owns the atomic two-slot quota; KV is only a UI projection.
  let tgItems = [];
  let tgReservations = [];
  const tgDate = etDate(new Date(nowSec * 1000));
  try {
    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID && consPush.length) {
      const sigByKey = new Map();
      for (const s of [...((ad.signals && ad.signals.strong) || []), ...((ad.signals && ad.signals.likely) || [])]) sigByKey.set(s.title + '|' + s.outcome, s);
      const enriched = consPush.map((c) => ({ ...c, sig: sigByKey.get(c.title + '|' + c.outcome) || null }));
      const legacySlots = polyTelegramLegacySlots(ad.telegram, tgDate);
      const gated = polyTelegramGate(enriched, ad.telegram, { nowSec, date: tgDate });
      const reserved = await reservePolyTelegram(env.DB, gated.items, { date: tgDate, nowSec, usedBefore: legacySlots });
      ad.telegram = polyTelegramStateAfterReservations(gated, reserved.items, { legacySlots });
      tgItems = reserved.items;
      tgReservations = reserved.reservations;
    }
  } catch (e) {
    // Fail closed: an unavailable quota authority can suppress a message, but
    // can never let an unreserved message escape.
    console.error(JSON.stringify({ message: 'telegram reservation failed closed', error: ingestError(e) }));
  }
  await env.AA_LATEST.put('poly:alerts', JSON.stringify(ad));
  // lastseen: solo se reescribe si CAMBIÓ (en ventanas tranquilas no hay actividad
  // nueva) → ahorra escrituras KV para quedarnos holgados en el free tier ($0 infra).
  const lsAfter = JSON.stringify(lastseen);
  if (lsAfter !== (lsRaw || '')) await env.AA_LATEST.put('poly:lastseen', lsAfter);
  // Telegram se manda DESPUÉS de persistir el dedupe/tope. Si Cloudflare reintenta
  // el cron (entrega at-least-once), no duplica el aviso.
  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID && tgItems.length) {
    try {
      const receipt = await tgSignal(env, tgItems);
      // A failed status update remains `reserved`, which still occupies its
      // physical slot and is safer than releasing a message already delivered.
      try {
        await completePolyTelegramReservations(env.DB, tgReservations, {
          sentAt: new Date().toISOString(), messageId: receipt?.message_id ?? null,
        });
      } catch (completeError) {
        console.error(JSON.stringify({ message: 'telegram delivery finalization failed safe', error: ingestError(completeError) }));
      }
    } catch (e) {
      const definitive = e?.telegramDefinitive === true;
      console.error(JSON.stringify({ message: 'telegram exceptional alert failed', definitive, error: ingestError(e) }));
      try {
        await failPolyTelegramReservations(env.DB, tgReservations, {
          failedAt: new Date().toISOString(), error: ingestError(e), definitive,
        });
      } catch (quotaError) {
        console.error(JSON.stringify({ message: 'telegram D1 failure state failed safe', error: ingestError(quotaError) }));
      }
      if (definitive) {
        // Telegram explicitly answered ok:false, so no message was delivered;
        // release only our own reservations and allow a measured retry.
        const rollback = polyTelegramRollback(ad.telegram, ad.cons_notified, tgItems, nowIso, e);
        ad.telegram = rollback.telegram;
        ad.cons_notified = rollback.cons_notified;
      } else {
        // Timeout/network/ambiguous response: keep both D1 slots and KV dedupe.
        // Under-sending is preferable to a duplicate or a third daily alert.
        ad.telegram = { ...(ad.telegram || {}), last_error_at: nowIso, last_error: ingestError(e) };
      }
      try { await env.AA_LATEST.put('poly:alerts', JSON.stringify(ad)); }
      catch (persistError) { console.error(JSON.stringify({ message: 'telegram failure projection failed', error: ingestError(persistError) })); }
    }
  }
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

// 🤝 Consenso de sharps (exportado para tests): agrupa las compras recientes de las
// vigiladas por mercado+lado; devuelve donde COINCIDEN ≥2 wallets DISTINTAS. Es la
// señal más fuerte del Radar (smart money convergiendo) — descriptivo, no recomienda.
export function polyConsensus(recentBuys, minWallets = 2, cap = 10) {
  const groups = new Map();
  for (const b of (Array.isArray(recentBuys) ? recentBuys : [])) {
    if (!b || !b.title || !b.outcome) continue;
    const key = b.title + '|' + b.outcome;
    let g = groups.get(key);
    if (!g) { g = { title: b.title, outcome: b.outcome, byWallet: new Map(), last_ts: 0, last_price: null }; groups.set(key, g); }
    const prev = g.byWallet.get(b.wallet); // una entrada por wallet (la más reciente)
    if (!prev || (b.ts || 0) > (prev.ts || 0)) g.byWallet.set(b.wallet, { w: b.wallet, name: b.name, score: b.score, usd: b.usd, ts: b.ts, price: b.price != null ? b.price : null });
    if ((b.ts || 0) >= g.last_ts) { g.last_ts = b.ts || 0; if (b.price != null) g.last_price = b.price; } // precio de referencia ≈ el más reciente
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.byWallet.size < minWallets) continue;
    const wallets = [...g.byWallet.values()].sort((a, b) => (b.score || 0) - (a.score || 0) || (b.ts || 0) - (a.ts || 0));
    out.push({ title: g.title, outcome: g.outcome, n: g.byWallet.size, usd: wallets.reduce((s, w) => s + (w.usd || 0), 0), last_ts: g.last_ts, price: g.last_price, wallets });
  }
  out.sort((a, b) => (b.n - a.n) || (b.last_ts - a.last_ts));
  return out.slice(0, cap);
}

// Decide qué consensos ameritan un push (exportado para tests). Devuelve:
//  · push: los grupos NUEVOS (recién llegan a minWallets) o REFORZADOS (ahora hay
//    más vigiladas que la última vez que avisamos) — cada uno con prevN (cuántas
//    había antes, 0 si es nuevo).
//  · notified: el estado a persistir (key → n actual) para la próxima ronda.
// prevNotified == null significa "primer arranque": se siembra el estado y NO se
// avisa nada, para no soltar de golpe los consensos que ya venían de días atrás.
export function polyConsensusToPush(cons, prevNotified, minWallets = 2) {
  const firstRun = !prevNotified || typeof prevNotified !== 'object';
  const prev = firstRun ? {} : prevNotified;
  const notified = {}, push = [];
  for (const c of (Array.isArray(cons) ? cons : [])) {
    if (!c || (c.n || 0) < minWallets || !c.title || !c.outcome) continue;
    const key = c.title + '|' + c.outcome;
    notified[key] = c.n;
    const before = +prev[key] || 0;
    if (!firstRun && c.n > before) push.push({ ...c, prevN: before });
  }
  // los más fuertes primero (más vigiladas), y a igualdad los más recientes
  push.sort((a, b) => (b.n - a.n) || ((b.last_ts || 0) - (a.last_ts || 0)));
  return { push, notified, firstRun };
}

// 🧠 ¿Esta wallet "sabe algo" o solo "sigue el mercado"? Lectura por TRANSACCIÓN
// (exportada para tests). Cruza el historial de la wallet (récord sólido con piso
// Wilson, si gana entrando ANTES, longshots, convicción) con ESTE trade (entró
// barato/temprano y por debajo del precio actual = lideró · vs · pagó caro/reactivo
// = siguió). Devuelve {info:'informed'|'trend'|'mixed', score 0-100, reasons:[{k,t}]}.
// Es un PATRÓN estadístico — nunca una acusación de información privilegiada.
export function polyWalletInfo(p, entryPrice, refPrice) {
  p = p || {};
  const reasons = [];
  let inf = 0, tr = 0;
  const add = (cond, pts, k, t) => { if (!cond) return; if (t === 'bad') tr += pts; else inf += pts; reasons.push({ k, t: t || 'good' }); };
  const pre = p.pre_win_share;
  const hrs = p.timing ? p.timing.median_hours_before : null;
  const r24 = p.timing ? p.timing.last24h_share : null;
  const wrLB = p.win_rate_lb, ins = p.insider_score, ls = p.longshot_wins || 0, conv = p.conviction || 0;
  const flip = p.style ? (p.style.flip_share || 0) : 0, washy = p.washy || 0;
  // — señales de "sabe algo" (informado) —
  add(pre != null && pre >= 0.6, 26, 'early', 'good');
  add((pre == null || pre < 0.6) && hrs != null && hrs >= 24, 12, 'early', 'good');
  add(wrLB != null && wrLB >= 0.60, 16, 'record', 'good');
  add(wrLB != null && wrLB >= 0.52 && wrLB < 0.60, 8, 'record', 'good');
  add(ins != null && ins >= 60, 14, 'insider', 'good');
  add(ins != null && ins >= 45 && ins < 60, 7, 'insider', 'good');
  add(ls >= 2, 12, 'longshot', 'good');
  add(conv >= 0.05, 10, 'conviction', 'good');
  add(entryPrice != null && entryPrice <= 0.45, 12, 'cheap', 'good');
  add(entryPrice != null && refPrice != null && entryPrice <= refPrice - 0.05, 14, 'led', 'good'); // entró por debajo del precio de hoy
  // — señales de "sigue el mercado / noticias y tendencias" —
  add(r24 != null && r24 >= 0.6, 18, 'reactive', 'bad');
  add(entryPrice != null && entryPrice >= 0.70, 16, 'chase', 'bad');
  add(entryPrice != null && refPrice != null && entryPrice >= refPrice + 0.04, 10, 'chase', 'bad');
  add(pre != null && pre <= 0.25, 12, 'late', 'bad');
  add(flip >= 0.5 || washy >= 0.3, 8, 'churn', 'bad');
  add(ins != null && ins < 35, 8, 'late', 'bad');
  const score = Math.max(0, Math.min(100, Math.round(50 + inf - tr)));
  const info = score >= 62 ? 'informed' : (score <= 42 ? 'trend' : 'mixed');
  const seen = new Set(), top = [];
  for (const rr of reasons) { if (!seen.has(rr.k)) { seen.add(rr.k); top.push(rr); } } // dedup, mayor peso primero
  return { info, score, reasons: top };
}

// Fuerza de la señal (0-100, exportada para tests): cuánto "dinero listo" hay detrás.
// Consenso (cuántas vigiladas coinciden), calidad (piso Wilson), qué tan informado,
// tamaño y recencia. NO es probabilidad de ganar — esa la pone el mercado (el precio).
export function polySignalStrength({ n = 1, avgWrLB = null, avgInfoScore = 50, usd = 0, info = 'mixed', last_ts = null, nowSec = 0 } = {}) {
  let s = 0;
  s += Math.min(35, Math.max(0, n - 1) * 18);                                            // consenso: 2→18, 3+→35
  s += 30 * Math.max(0, Math.min(1, ((avgWrLB == null ? 0.5 : avgWrLB) - 0.5) / 0.35));  // calidad Wilson
  s += 0.22 * Math.max(0, Math.min(100, avgInfoScore == null ? 50 : avgInfoScore));      // informado (0-22)
  s += info === 'informed' ? 8 : (info === 'trend' ? -8 : 0);
  s += Math.min(7, Math.log10(Math.max(1, usd || 0)) * 2);                               // tamaño (suave)
  const ageH = (last_ts && nowSec) ? Math.max(0, (nowSec - last_ts) / 3600) : 36;
  s *= Math.max(0.5, Math.min(1, Math.exp(-ageH / 96)));                                 // recencia (media vida ~4d), hasta −50%
  return Math.max(0, Math.min(100, Math.round(s)));
}

// 🎯 Señales del día (exportada para tests): convierte el consenso en "fichas" con
// lectura informado/tendencia + fuerza + probabilidad del mercado. Dos rankings:
//  · strong → las más fuertes dentro del rango no-extremo y con tamaño medido
//  · likely → las más probables SEGÚN EL MERCADO (precio ≥ likelyMin), pagan poco
export function polySignals(consensus, byWallet, nowSec = 0, opts = {}) {
  const likelyMin = opts.likelyMin != null ? opts.likelyMin : 0.70;
  const cap = opts.cap != null ? opts.cap : 8;
  const minUsd = opts.minUsd != null ? opts.minUsd : 100;
  const minPrice = opts.minPrice != null ? opts.minPrice : 0.05;
  const maxPrice = opts.maxPrice != null ? opts.maxPrice : 0.95;
  const maxAgeSec = opts.maxAgeSec != null ? opts.maxAgeSec : 48 * 3600;
  const bw = byWallet instanceof Map ? byWallet
    : new Map(Object.entries(byWallet && typeof byWallet === 'object' ? byWallet : {}));
  const avg = (xs) => { const v = xs.filter((x) => x != null && isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const out = [];
  for (const c of (Array.isArray(consensus) ? consensus : [])) {
    if (!c || !c.title || !c.outcome) continue;
    const ref = c.price != null ? c.price : null;
    const usd = Number(c.usd);
    const age = nowSec ? (Number.isFinite(Number(c.last_ts)) ? Math.max(0, nowSec - Number(c.last_ts)) : Infinity) : 0;
    if (!Number.isFinite(usd) || usd < minUsd || !Number.isFinite(Number(ref)) || Number(ref) < minPrice || Number(ref) > maxPrice || age > maxAgeSec) continue;
    const wl = (c.wallets || []).map((w) => {
      const prof = bw.get(w.w) || {};
      const read = polyWalletInfo(prof, w.price != null ? w.price : null, ref);
      return {
        w: w.w, name: w.name, score: w.score, usd: w.usd, ts: w.ts, price: w.price != null ? w.price : null,
        wr: prof.win_rate != null ? prof.win_rate : null, wrLB: prof.win_rate_lb != null ? prof.win_rate_lb : null,
        wins: prof.wins != null ? prof.wins : null, losses: prof.losses != null ? prof.losses : null,
        info: read.info, info_score: read.score, reasons: read.reasons,
      };
    });
    const nInf = wl.filter((x) => x.info === 'informed').length;
    const nTr = wl.filter((x) => x.info === 'trend').length;
    const info = nInf > nTr ? 'informed' : (nTr > nInf ? 'trend' : 'mixed');
    const avgWrLB = avg(wl.map((x) => x.wrLB));
    const avgInfo = avg(wl.map((x) => x.info_score));
    const strength = polySignalStrength({ n: c.n, avgWrLB, avgInfoScore: avgInfo, usd: c.usd, info, last_ts: c.last_ts, nowSec });
    const why = [];
    if ((c.n || 0) >= 2) why.push({ k: 'consensus', t: 'good', n: c.n });
    const rc = new Map();
    for (const x of wl) for (const rr of (x.reasons || [])) if (rr.t === 'good') rc.set(rr.k, (rc.get(rr.k) || 0) + 1);
    for (const [k, cnt] of [...rc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) why.push({ k, t: 'good', n: cnt });
    out.push({
      title: c.title, outcome: c.outcome, n: c.n, usd: c.usd, last_ts: c.last_ts,
      price: ref, implied: ref != null ? Math.round(100 * ref) : null,
      info, info_score: avgInfo != null ? Math.round(avgInfo) : null, strength,
      avg_wr_lb: avgWrLB != null ? +avgWrLB.toFixed(3) : null,
      wallets: wl.slice(0, 6), why,
    });
  }
  const strong = [...out].sort((a, b) => (b.strength - a.strength) || (b.n - a.n) || ((b.last_ts || 0) - (a.last_ts || 0))).slice(0, cap);
  const likely = out.filter((s) => s.price != null && s.price >= likelyMin)
    .sort((a, b) => (b.price - a.price) || (b.strength - a.strength)).slice(0, cap);
  return { strong, likely, min_prob: likelyMin, filters: { min_usd: minUsd, min_price: minPrice, max_price: maxPrice, max_age_hours: maxAgeSec / 3600 } };
}

// Gate extraordinariamente selectivo para Telegram (puro/exportado para tests).
// No estima probabilidad de ganar: elimina ruido evidente antes del push. Requiere
// 3+ wallets, 2 con lectura informada y $100+ cada una, $500 agregados, precio no
// extremo, piso Wilson alto, fuerza 80+, señal reciente y dedupe por 7 días.
// Máximo DOS señales por día ET; puede devolver cero (lo normal).
export function polyTelegramGate(items, state, opts = {}) {
  const nowSec = Number(opts.nowSec) || 0;
  const date = String(opts.date || '');
  const maxPerDay = opts.maxPerDay ?? 2;
  const minWallets = opts.minWallets ?? 3;
  const minFundedWallets = opts.minFundedWallets ?? 2;
  const minWalletUsd = opts.minWalletUsd ?? 100;
  const minUsd = opts.minUsd ?? 500;
  const minStrength = opts.minStrength ?? 80;
  const minWrLB = opts.minWrLB ?? 0.60;
  const minPrice = opts.minPrice ?? 0.10;
  const maxPrice = opts.maxPrice ?? 0.90;
  const maxAgeSec = opts.maxAgeSec ?? 6 * 3600;
  const dedupeSec = opts.dedupeSec ?? 7 * 86400;
  const prev = state && typeof state === 'object' ? state : {};
  const notified = {};
  for (const [key, ts] of Object.entries(prev.notified || {})) {
    if (Number.isFinite(+ts) && (!nowSec || nowSec - +ts <= dedupeSec)) notified[key] = +ts;
  }
  const sent = prev.date === date ? Math.max(0, Number(prev.sent) || 0) : 0;
  let room = Math.max(0, maxPerDay - sent);
  const eligible = [];
  for (const c of Array.isArray(items) ? items : []) {
    const s = c && c.sig;
    if (!c || !s || !c.title || !c.outcome || room <= 0) continue;
    const key = c.title + '|' + c.outcome;
    const wallets = Array.isArray(s.wallets) ? s.wallets : [];
    const informed = wallets.filter((w) => w.info === 'informed');
    const funded = informed.filter((w) => Number(w.usd) >= minWalletUsd);
    const usd = Number(c.usd), strength = Number(s.strength), wrLB = Number(s.avg_wr_lb);
    const age = nowSec && Number.isFinite(Number(c.last_ts)) ? Math.max(0, nowSec - Number(c.last_ts)) : Infinity;
    if (notified[key] != null) continue;
    if ((c.n || 0) < minWallets || informed.length < minFundedWallets || funded.length < minFundedWallets) continue;
    if (!Number.isFinite(usd) || usd < minUsd || s.info !== 'informed' || !Number.isFinite(strength) || strength < minStrength) continue;
    if (!Number.isFinite(wrLB) || wrLB < minWrLB || !Number.isFinite(Number(s.price)) || Number(s.price) < minPrice || Number(s.price) > maxPrice) continue;
    if (age > maxAgeSec) continue;
    eligible.push(c);
  }
  eligible.sort((a, b) => (b.sig.strength - a.sig.strength) || ((b.n || 0) - (a.n || 0)) || ((b.usd || 0) - (a.usd || 0)));
  const selected = eligible.slice(0, room);
  for (const c of selected) notified[c.title + '|' + c.outcome] = nowSec;
  room -= selected.length;
  return {
    items: selected,
    state: { date, sent: sent + selected.length, max_per_day: maxPerDay, notified, policy: 'rare_v1' },
  };
}

const polyTelegramKey = (item) => `${item?.title || ''}|${item?.outcome || ''}`;
const requireD1Write = (result, operation) => {
  if (result?.success !== true) throw new Error(`D1 ${operation} failed`);
  return Number(result?.meta?.changes || 0);
};

// During the deployment day, messages already sent by the legacy KV-only gate
// consume the lower physical slots. Persisting this offset for the whole ET day
// also keeps concurrent transition runs from turning a lost KV write into a
// third real notification.
export function polyTelegramLegacySlots(telegram, date) {
  if (!telegram || telegram.date !== date) return 0;
  const carried = Number(telegram.legacy_slots);
  if (Number.isFinite(carried)) return Math.min(2, Math.max(0, Math.trunc(carried)));
  if (telegram.policy === 'rare_v2_d1_atomic') return 0;
  return Math.min(2, Math.max(0, Math.trunc(Number(telegram.sent) || 0)));
}

// D1 is the quota authority. One atomic INSERT chooses a free physical slot
// (1 or 2) and checks the seven-day signal dedupe. SQLite serializes writes and
// the partial UNIQUE index is the final invariant under concurrent cron runs.
export async function reservePolyTelegram(DB, items, opts = {}) {
  if (!DB) throw new Error('D1 unavailable for Telegram quota');
  const date = String(opts.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid ET date for Telegram quota');
  const nowMs = Number(opts.nowSec) > 0 ? Number(opts.nowSec) * 1000 : Date.now();
  const usedBefore = Math.min(2, Math.max(0, Math.trunc(Number(opts.usedBefore) || 0)));
  const reservedAt = opts.reservedAt || new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - (opts.dedupeSec ?? 7 * 86400) * 1000).toISOString();
  const reservations = [];
  try {
    for (const item of Array.isArray(items) ? items : []) {
      const rawKey = polyTelegramKey(item);
      if (rawKey === '|') continue;
      const dedupeKey = await mlbIngestSourceHash({ signal: rawKey });
      const payloadHash = await mlbIngestSourceHash({
        title: item.title, outcome: item.outcome, n: item.n ?? null, usd: item.usd ?? null,
        price: item.sig?.price ?? null, strength: item.sig?.strength ?? null,
      });
      const reservationId = crypto.randomUUID();
      const result = await DB.prepare(`
        INSERT OR IGNORE INTO poly_telegram_deliveries
          (reservation_id, et_date, slot, dedupe_key, status, reserved_at, payload_hash)
        SELECT ?, ?, free.slot, ?, 'reserved', ?, ?
        FROM (SELECT 1 AS slot UNION ALL SELECT 2 AS slot) AS free
        WHERE free.slot > ?
        AND NOT EXISTS (
          SELECT 1 FROM poly_telegram_policy rollout
          WHERE rollout.id = 1
            AND julianday(?) < julianday(rollout.cutover_at, '+24 hours')
        )
        AND NOT EXISTS (
          SELECT 1 FROM poly_telegram_deliveries x
          WHERE x.et_date = ? AND x.slot = free.slot
            AND x.status IN ('reserved', 'sent', 'unknown')
        )
        AND NOT EXISTS (
          SELECT 1 FROM poly_telegram_deliveries x
          WHERE x.dedupe_key = ?
            AND (x.status IN ('reserved', 'unknown') OR (x.status = 'sent' AND x.sent_at >= ?))
        )
        ORDER BY free.slot
        LIMIT 1
      `).bind(reservationId, date, dedupeKey, reservedAt, payloadHash, usedBefore, reservedAt, date, dedupeKey, cutoff).run();
      if (requireD1Write(result, 'Telegram reserve') === 1) {
        reservations.push({ reservation_id: reservationId, et_date: date, dedupe_key: dedupeKey, item });
      }
    }
  } catch (error) {
    if (reservations.length) {
      try {
        await failPolyTelegramReservations(DB, reservations, {
          failedAt: new Date().toISOString(), error: `reservation_batch_rollback: ${ingestError(error)}`, definitive: true,
        });
      } catch { /* the UNIQUE slots remain fail-closed if cleanup also fails */ }
    }
    throw error;
  }
  return { items: reservations.map((row) => row.item), reservations };
}

export function polyTelegramStateAfterReservations(gated, admittedItems, opts = {}) {
  const state = { ...((gated && gated.state) || {}), notified: { ...((gated?.state?.notified) || {}) } };
  const admitted = new Set((admittedItems || []).map(polyTelegramKey));
  let rejected = 0;
  for (const item of (gated?.items || [])) {
    const key = polyTelegramKey(item);
    if (admitted.has(key)) continue;
    delete state.notified[key];
    rejected++;
  }
  state.sent = Math.max(0, (Number(state.sent) || 0) - rejected);
  state.legacy_slots = Math.min(2, Math.max(0, Math.trunc(Number(opts.legacySlots) || 0)));
  state.policy = 'rare_v2_d1_atomic';
  return state;
}

export async function completePolyTelegramReservations(DB, reservations, opts = {}) {
  if (!DB) throw new Error('D1 unavailable for Telegram completion');
  const sentAt = opts.sentAt || new Date().toISOString();
  let changes = 0;
  for (const row of Array.isArray(reservations) ? reservations : []) {
    const result = await DB.prepare(`
      UPDATE poly_telegram_deliveries
      SET status = 'sent', sent_at = ?, telegram_message_id = ?, error = NULL
      WHERE reservation_id = ? AND status = 'reserved'
    `).bind(sentAt, opts.messageId ?? null, row.reservation_id).run();
    changes += requireD1Write(result, 'Telegram complete');
  }
  return changes;
}

export async function failPolyTelegramReservations(DB, reservations, opts = {}) {
  if (!DB) throw new Error('D1 unavailable for Telegram failure state');
  const failedAt = opts.failedAt || new Date().toISOString();
  const definitive = opts.definitive === true;
  let changes = 0;
  for (const row of Array.isArray(reservations) ? reservations : []) {
    const result = definitive
      ? await DB.prepare(`
          UPDATE poly_telegram_deliveries
          SET status = 'failed', slot = NULL, failed_at = ?, error = ?
          WHERE reservation_id = ? AND status = 'reserved'
        `).bind(failedAt, String(opts.error || '').slice(0, 300), row.reservation_id).run()
      : await DB.prepare(`
          UPDATE poly_telegram_deliveries
          SET status = 'unknown', failed_at = ?, error = ?
          WHERE reservation_id = ? AND status = 'reserved'
        `).bind(failedAt, String(opts.error || '').slice(0, 300), row.reservation_id).run();
    changes += requireD1Write(result, definitive ? 'Telegram release' : 'Telegram unknown');
  }
  return changes;
}

export function polyTelegramRollback(telegram, consNotified, items, failedAt = null, error = null) {
  const state = { ...(telegram || {}), notified: { ...((telegram && telegram.notified) || {}) } };
  const consensus = { ...(consNotified || {}) };
  let released = 0;
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.title || !item?.outcome) continue;
    const key = item.title + '|' + item.outcome;
    if (seen.has(key)) continue;
    seen.add(key);
    if (Object.prototype.hasOwnProperty.call(state.notified, key)) {
      delete state.notified[key];
      released++;
    }
    if (Number(item.prevN) > 0) consensus[key] = Number(item.prevN);
    else delete consensus[key];
  }
  state.sent = Math.max(0, (Number(state.sent) || 0) - released);
  state.last_error_at = failedAt || null;
  state.last_error = ingestError(error);
  return { telegram: state, cons_notified: consensus };
}

// Telegram de observación excepcional: varias vigiladas con patrón estadístico
// compatible con información en el mismo lado. Mensaje rico: mercado %, fuerza, y
// wallets con su win rate. Un bloque por señal nueva/reforzada. Sin secretos → no
// se llega aquí. Cada item lleva {n, prevN, outcome, title, usd, sig} donde sig es
// la lectura de polySignals (info, strength, implied, why, wallets con wr).
const TG_REASONS = { consensus: 'coinciden', early: 'entra antes', led: 'entró barato', cheap: 'compra barata', record: 'récord sólido', insider: 'perfil informado', longshot: 'gana baratas', conviction: 'sube en aciertos', reactive: 'compra reactiva', chase: 'paga caro', late: 'entra tarde', churn: 'voltea mucho' };
async function tgSignal(env, items) {
  const block = (c) => {
    const s = c.sig || {};
    const mkt = s.implied != null ? ` · mercado ${s.implied}%` : '';
    const fz = s.strength != null ? ` · fuerza ${s.strength}/100` : '';
    const why = Array.isArray(s.why) ? s.why.filter((r) => r.t === 'good' && r.k !== 'consensus').slice(0, 3).map((r) => TG_REASONS[r.k] || r.k).join(' · ') : '';
    const wl = ((Array.isArray(s.wallets) && s.wallets.length ? s.wallets : (c.wallets || [])).slice(0, 5))
      .map((w) => `• ${w.name || (w.w || '').slice(0, 8) || '0x…'}${w.score != null ? ` 🎯${w.score}` : ''}${w.wr != null ? ` (${Math.round(100 * w.wr)}%)` : ''}`).join('\n');
    return `🎯 Posible informado${c.prevN ? ` (refuerzo · antes ${c.prevN})` : ''}\n“${c.outcome}” · ${c.title}\n🤝 ${c.n} vigiladas${mkt}${fz}${why ? `\nPor qué: ${why}` : ''}\n${wl}`;
  };
  const text = `🎯 Observación excepcional — Radar AA\n\n${items.map(block).join('\n\n')}\n\nPasó el filtro anti-ruido (3+ vigiladas, $500+ y precio no extremo), pero NO es una jugada segura ni una recomendación. La fuerza no es probabilidad de ganar; el % es el precio del mercado. «Posible informado» describe un patrón estadístico, nunca una acusación. aasport.net → Radar`;
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) {
    const error = new Error(`Telegram ${res.status}: ${JSON.stringify(body).slice(0, 180)}`);
    // ok:false is an explicit rejection: Telegram says it did not deliver.
    // Network/timeouts or an unreadable body remain ambiguous and keep slots.
    error.telegramDefinitive = body && body.ok === false;
    throw error;
  }
  return { message_id: body?.result?.message_id ?? null };
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
  try {
    const doc = JSON.parse(raw);
    return json({ ...doc, freshness: learningFreshnessDoc(doc) }, 200, origin, 300);
  } catch (error) {
    console.error(JSON.stringify({ message: 'mlb learning malformed', error: ingestError(error) }));
    return json({ note: 'diario de aprendizaje inválido', freshness: learningFreshnessDoc(null) }, 200, origin, 60);
  }
}

const SPORT_BRAIN_SOURCES = Object.freeze({
  soccer: 'predictions', nba: 'predictions', wnba: 'predictions', tennis: 'predictions',
  nfl: 'sports_predictions', ncaaf: 'sports_predictions', nhl: 'sports_predictions', ncaam: 'sports_predictions',
});

export function fallbackSportBrain(sport, row = null) {
  const n = Number(row?.n || 0), wins = Number(row?.wins || 0), losses = Number(row?.losses || Math.max(0, n - wins));
  const dates = Number(row?.dates || 0);
  return {
    schema: 'aa_sport_learning_v1', sport, updated_at: row?.updated_at || null,
    state: 'training', model_scope: 'shadow',
    gate: {
      passed: false, approved: false, public: false, reason: 'learning_snapshot_pending',
      historical_passed: null, min_forward: sport === 'wnba' ? 200 : 300, min_dates: 30,
      requires_ece_lte: 0.05, requires_market_benchmark: true,
    },
    historical: { n: 0, accuracy: null, brier: null, logloss: null, ece: null },
    forward: {
      n, dates, wins, losses, accuracy: n ? wins / n : null,
      ci: { lo: null, hi: null }, brier: null, logloss: null, ece: null,
      market_n: Number(row?.market_n || 0), market_accuracy: null, market_brier: null, market_logloss: null,
    },
    learning_es: [
      n ? `Validación forward en sombra: ${wins}-${losses} en ${dates} fechas.` : 'El Cerebro está capturando decisiones pregame; todavía no hay resultados forward calificados.',
      'El gate permanece cerrado. No se publican picks ni porcentajes hasta validar calibración, mercado y muestra.',
    ],
    learning_en: [
      n ? `Shadow forward validation: ${wins}-${losses} across ${dates} dates.` : 'The Brain is capturing pregame decisions; no forward results are graded yet.',
      'The gate remains closed. No picks or probabilities are published until calibration, market and sample are validated.',
    ],
    attribution_es: 'Estado medido del entrenamiento privado; no es garantía de resultados.',
    attribution_en: 'Measured private-training status; not a guarantee of results.',
  };
}

// Cerebro multideporte: primero sirve el snapshot compacto que publica Actions.
// Si todavía no existe, D1 aporta solo el tamaño/record agregado de la sombra;
// nunca se devuelven features, pesos, picks o probabilidades individuales.
async function sportLearning(env, sport, origin) {
  if (!Object.hasOwn(SPORT_BRAIN_SOURCES, sport)) return json({ error: 'unknown_sport' }, 400, origin);
  const raw = await env.AA_LATEST.get(`${sport}:learning`);
  if (raw) {
    try { return json(JSON.parse(raw), 200, origin, 300); }
    catch (error) { console.error(JSON.stringify({ message: 'sport learning malformed', sport, error: ingestError(error) })); }
  }
  let row = null;
  try {
    const table = SPORT_BRAIN_SOURCES[sport]; // cerrado sobre allowlist; nunca viene del request libre
    row = await env.DB.prepare(`
      SELECT COUNT(*) AS n, COUNT(DISTINCT date) AS dates,
             SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
             SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
             SUM(CASE WHEN market_prob IS NOT NULL THEN 1 ELSE 0 END) AS market_n,
             MAX(updated_at) AS updated_at
      FROM ${table} WHERE sport = ? AND result IN ('win','loss')
    `).bind(sport).first();
  } catch (error) {
    console.error(JSON.stringify({ message: 'sport learning fallback unavailable', sport, error: ingestError(error) }));
  }
  return json(fallbackSportBrain(sport, row), 200, origin, 120);
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

  // El resumen diario permanece en /v1/poly/track y en la app. No se empuja a
  // Telegram: el canal queda reservado para el gate excepcional rare_v1.
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
      'SELECT event_id, home, away, pick, prob, price, confidence, status, result FROM predictions WHERE sport = ? AND date = ? ORDER BY prob DESC',
    ).bind('mlb', date).all();
    if (results && results.length) {
      const events = results.map((r) => ({
        sport: 'mlb', league: 'MLB', event_id: String(r.event_id),
        matchup: `${r.away} @ ${r.home}`, start: date, status: r.status || 'final',
        home: { code: r.home, name: r.home }, away: { code: r.away, name: r.away },
        prediction: {
          pick: r.pick, prob: r.prob,
          prob_pct: r.prob != null ? Math.round(r.prob * 1000) / 10 : null,
          price: Number.isFinite(Number(r.price)) && Math.abs(Number(r.price)) >= 100 ? Number(r.price) : null,
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
  const cutoffDate = new Date(`${etDate(new Date())}T12:00:00Z`);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - (days - 1));
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    'SELECT date, event_id, selection_key, market, pick, side, line, home, away, prob, price, ' +
    'public_play, public_lock, public_gem, confidence, result, posted_at, start_time, engine_version, source_scope ' +
    'FROM mlb_public_picks WHERE invalidated = 0 AND date >= ? ' +
    'ORDER BY date DESC, start_time DESC, selection_key ASC LIMIT ?',
  ).bind(cutoff, days * 40).all();
  return json({ sport: 'mlb', days, cutoff, count: results.length, predictions: results }, 200, origin, 120);
}

// Marcadores en vivo: proxy a ESPN con caché de borde (30s) para no golpear la
// API y sentirse SofaScore sin recalcular el modelo.
async function live(ctx, origin) {
  const date = etDate(new Date());
  const cache = caches.default;
  // La fecha forma parte de la llave para que el caché de medianoche tampoco
  // pueda servir, ni durante sus 30 s de vida, la jornada anterior.
  const cacheKey = new Request(`https://aa-sports.cache/mlb/live/${date}`, { method: 'GET' });
  let cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return withCors(body, origin);
  }

  let fetched;
  try {
    fetched = await fetchEspnPublicResponse(mlbScoreboardUrl(date), { init: { cf: { cacheTtl: 30 } } });
  } catch (error) {
    return json({ sport: 'mlb', games: [], note: 'live upstream ' + ingestError(error) }, 200, origin, 15);
  }
  const data = await fetched.response.json();

  const games = mlbLiveEventsForDate(data, date).map((ev) => {
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
        const { response: r } = await fetchEspnPublicResponse(`${ESPN_BASE}/baseball/mlb/summary?event=${id}`, {
          init: { cf: { cacheTtl: 30 } },
        });
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

  const payload = JSON.stringify({ sport: 'mlb', date, updated_at: new Date().toISOString(), source: fetched.source, games });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin);
}

// Live genérico (NBA y soccer): mismo esquema que MLB live, sin situation.
async function otherLive(ctx, origin, cacheTag, upstream, fallbackUpstream = null) {
  const cache = caches.default;
  // Cuando el upstream está fijado a un día, la fecha también pertenece a la
  // llave. Así ni siquiera los 30 s de caché pueden cruzar la medianoche ET.
  let cacheVariant = 'current', requestedDate = null;
  try {
    const dates = new URL(upstream).searchParams.get('dates');
    if (/^\d{8}$/.test(dates || '')) {
      cacheVariant = dates;
      requestedDate = `${dates.slice(0, 4)}-${dates.slice(4, 6)}-${dates.slice(6, 8)}`;
    }
  } catch (e) { /* upstream interno constante; current es un fallback seguro */ }
  const cacheKey = new Request(`https://aa-sports.cache/${cacheTag}/live/${cacheVariant}`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(await cached.text(), origin);

  let fetched;
  try {
    fetched = await fetchEspnPublicResponse(upstream, {
      fallbackUpstream, init: { cf: { cacheTtl: 30 } },
    });
  } catch (error) {
    return json({ games: [], note: 'live upstream ' + ingestError(error) }, 200, origin, 15);
  }
  const data = await fetched.response.json();

  const games = compactOtherLiveGames(data).filter((game) => !requestedDate
    || (game.start && etDate(new Date(game.start)) === requestedDate));

  const payload = JSON.stringify({ updated_at: new Date().toISOString(), source: fetched.source, games });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin);
}

export function compactOtherLiveGames(data) {
  return (data?.events || []).map((ev) => {
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
    const rawMarket = compactEspnGame(ev).market;
    const deVigged = rawMarket && devigAmericanMoneyline(rawMarket.home_ml, rawMarket.away_ml);
    const market = deVigged ? {
      ...rawMarket,
      home_prob: Math.round(deVigged.home * 10000) / 10000,
      away_prob: Math.round(deVigged.away * 10000) / 10000,
      probability_source: 'market_devigged',
    } : rawMarket;
    return {
      espn_id: ev.id,
      start: ev.date || null,
      league: (ev.league && ev.league.abbreviation) || null,
      status: mapEspnStatus(st.name),
      status_detail: st.shortDetail || st.detail || ((c.status && c.status.displayClock) || null),
      clock: (c.status && c.status.displayClock) || null,
      period: (c.status && c.status.period) || null,
      home: side(home), away: side(away),
      market,
    };
  });
}

function publicGateOpen(doc) {
  return doc?.gate?.public === true && doc?.gate?.approved === true && doc?.gate?.passed === true;
}

export const MARKET_KINDS = Object.freeze(['winner', 'total', 'players', 'combos']);

const finiteMarketNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function safeMarketSample(sample) {
  const source = sample && typeof sample === 'object' ? sample : {};
  const out = {};
  for (const key of ['n', 'graded', 'dates', 'wins', 'losses', 'market_n', 'min_n', 'min_forward', 'min_dates']) {
    const value = finiteMarketNumber(source[key]);
    if (value != null && value >= 0) out[key] = value;
  }
  for (const key of ['accuracy', 'brier', 'logloss', 'ece', 'market_brier', 'market_logloss', 'progress']) {
    const value = finiteMarketNumber(source[key]);
    if (value != null) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function safeMarketGate(gate, kind) {
  const source = gate && typeof gate === 'object' ? gate : {};
  const passed = source.passed === true;
  const approved = source.approved === true;
  const isPublic = source.public === true;
  return {
    passed, approved, public: isPublic,
    state: passed && approved && isPublic ? 'public' : 'closed',
    reason: typeof source.reason === 'string' && source.reason ? source.reason.slice(0, 80) : `${kind}_forward_validation_pending`,
  };
}

// This is the sole public projection boundary for winner, total, player props
// and combos. A closed or malformed market retains only measured gate/sample
// evidence; selection-level numbers are rebuilt from an allowlist only when all
// three publication flags are true.
export function sanitizeMarketBlock(block, fallbackGate, fallbackSample, kind = 'winner') {
  const source = block && typeof block === 'object' ? block : {};
  const gate = safeMarketGate(source.gate || fallbackGate, kind);
  const sample = safeMarketSample(source.sample || fallbackSample);
  if (!(gate.passed && gate.approved && gate.public)) return { state: 'closed', gate, sample };

  const safe = { state: 'public', gate, sample };
  for (const key of ['pick', 'side', 'family', 'player_id', 'player_name', 'confidence', 'engine_version']) {
    if (typeof source[key] === 'string' && source[key]) safe[key] = source[key].slice(0, 100);
  }
  for (const key of ['prob', 'prob_pct', 'line', 'price', 'edge', 'projection', 'market_prob']) {
    const value = finiteMarketNumber(source[key]);
    if (value != null) safe[key] = value;
  }
  if (Array.isArray(source.items)) {
    safe.items = source.items.slice(0, kind === 'combos' ? 2 : 12).map((item) => {
      const row = {};
      for (const key of ['selection_key', 'pick', 'side', 'family', 'player_id', 'player_name', 'confidence']) {
        if (typeof item?.[key] === 'string' && item[key]) row[key] = item[key].slice(0, 100);
      }
      for (const key of ['prob', 'prob_pct', 'line', 'price', 'edge', 'projection', 'market_prob']) {
        const value = finiteMarketNumber(item?.[key]);
        if (value != null) row[key] = value;
      }
      return row;
    }).filter((row) => Object.keys(row).length);
  }
  return safe;
}

function marketBlocksForEvent(event, source) {
  const blocks = {};
  const eventMarkets = event?.markets && typeof event.markets === 'object' ? event.markets : {};
  const documentMarkets = source?.markets && typeof source.markets === 'object' ? source.markets : {};
  const gates = source?.gates && typeof source.gates === 'object' ? source.gates : {};
  const samples = source?.samples && typeof source.samples === 'object' ? source.samples : {};
  for (const kind of MARKET_KINDS) {
    let block = eventMarkets[kind] || null;
    if (!block && kind === 'winner' && event?.prediction) block = event.prediction;
    blocks[kind] = sanitizeMarketBlock(
      block,
      gates[kind] || documentMarkets[kind]?.gate || (kind === 'winner' ? source?.gate : null),
      block?.sample || samples[kind] || documentMarkets[kind]?.sample || (kind === 'winner' ? source?.sample : null),
      kind,
    );
  }
  return blocks;
}

function safeSportSide(side) {
  const source = side && typeof side === 'object' ? side : {};
  const out = {};
  for (const key of ['id', 'code', 'name', 'logo', 'rec', 'form']) {
    if (typeof source[key] === 'string' && source[key]) out[key] = source[key].slice(0, 160);
    else if (key === 'id' && finiteMarketNumber(source[key]) != null) out[key] = finiteMarketNumber(source[key]);
  }
  for (const key of ['score', 'rank']) {
    const value = finiteMarketNumber(source[key]);
    if (value != null) out[key] = value;
  }
  if (source.winner === true) out.winner = true;
  if (Array.isArray(source.leaders)) out.leaders = source.leaders.slice(0, 5).map((leader) => ({
    cat: typeof leader?.cat === 'string' ? leader.cat.slice(0, 40) : null,
    name: typeof leader?.name === 'string' ? leader.name.slice(0, 100) : null,
    value: typeof leader?.value === 'string' || finiteMarketNumber(leader?.value) != null ? leader.value : null,
    headshot: typeof leader?.headshot === 'string' ? leader.headshot.slice(0, 300) : null,
  })).filter((leader) => leader.name);
  return out;
}

export function devigAmericanMoneyline(homePrice, awayPrice) {
  const implied = (price) => {
    const value = finiteMarketNumber(price);
    if (value == null || value === 0) return null;
    return value < 0 ? (-value) / ((-value) + 100) : 100 / (value + 100);
  };
  const home = implied(homePrice), away = implied(awayPrice);
  if (home == null || away == null || home + away <= 0) return null;
  return { home: home / (home + away), away: away / (home + away) };
}

function safeSportEventFacts(event) {
  const source = event && typeof event === 'object' ? event : {};
  const out = {};
  for (const key of ['event_id', 'espn_id', 'id', 'start', 'start_time', 'date', 'league', 'status', 'status_detail', 'clock']) {
    if (typeof source[key] === 'string' && source[key]) out[key] = source[key].slice(0, 180);
    else if (['event_id', 'espn_id', 'id'].includes(key) && finiteMarketNumber(source[key]) != null) out[key] = String(source[key]);
  }
  for (const key of ['period']) {
    const value = finiteMarketNumber(source[key]);
    if (value != null) out[key] = value;
  }
  out.home = safeSportSide(source.home);
  out.away = safeSportSide(source.away);
  if (source.market && typeof source.market === 'object') {
    const market = {};
    for (const key of ['total', 'home_ml', 'away_ml', 'spread', 'home_prob', 'away_prob', 'provider', 'probability_source']) {
      if (key === 'provider' && typeof source.market[key] === 'string') market[key] = source.market[key].slice(0, 80);
      else if (key === 'probability_source' && typeof source.market[key] === 'string') market[key] = source.market[key].slice(0, 40);
      else { const value = finiteMarketNumber(source.market[key]); if (value != null) market[key] = value; }
    }
    const deVigged = devigAmericanMoneyline(market.home_ml, market.away_ml);
    if (deVigged) {
      market.home_prob = Math.round(deVigged.home * 10000) / 10000;
      market.away_prob = Math.round(deVigged.away * 10000) / 10000;
      market.probability_source = 'market_devigged';
    }
    if (Object.keys(market).length) out.market = market;
  }
  return out;
}

function safePublicRecord(record) {
  const source = record && typeof record === 'object' ? record : {};
  const out = {};
  for (const key of ['n', 'wins', 'losses', 'pushes', 'voids', 'dates']) {
    const value = finiteMarketNumber(source[key]);
    if (value != null && value >= 0) out[key] = value;
  }
  for (const key of ['accuracy', 'brier', 'logloss', 'ece']) {
    const value = finiteMarketNumber(source[key]);
    if (value != null) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

// Public projection for a new sport. A malformed or premature private blob is
// fail-closed: scores remain visible, but picks and probabilities are removed.
export function sanitizeUsSportsToday(doc, sport, fallbackGames = [], date = etDate(new Date())) {
  const source = doc && typeof doc === 'object' ? doc : {};
  const sourceCurrent = typeof source.date !== 'string' || source.date === date;
  const open = publicGateOpen(source) && sourceCurrent;
  const privateEvents = (Array.isArray(source.events) ? source.events : []).filter((event) => {
    const explicit = typeof event?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.date) ? event.date : null;
    const fromStart = !explicit && event?.start && Number.isFinite(Date.parse(event.start)) ? etDate(new Date(event.start)) : null;
    return explicit || fromStart ? (explicit || fromStart) === date : sourceCurrent;
  });
  const identity = (event) => String(event?.espn_id || event?.event_id || event?.id || '');
  const privateById = new Map();
  for (const event of privateEvents) {
    for (const key of [event?.espn_id, event?.event_id, event?.id].filter((value) => value != null)) {
      privateById.set(String(key), event);
    }
  }
  // Public scoreboard facts are authoritative for status/scores. The private
  // document may only overlay its already-sanitized market envelope.
  const events = fallbackGames.length
    ? fallbackGames.map((facts) => {
        const model = privateById.get(identity(facts));
        return model ? { ...facts, markets: model.markets, prediction: model.prediction } : facts;
      })
    : privateEvents;
  const safeEvents = events.map((event) => {
    const markets = marketBlocksForEvent(event, source);
    const winner = markets.winner;
    const prediction = winner.state === 'public' ? {
      pick: winner.pick || null, side: winner.side || null, prob: winner.prob ?? null,
      line: winner.line ?? null, price: winner.price ?? null, edge: winner.edge ?? null,
      confidence: winner.confidence || null, engine_version: winner.engine_version || null,
    } : null;
    // Never forward arbitrary model fields from a private blob. Factual event
    // fields and public markets are rebuilt from explicit allowlists.
    return { ...safeSportEventFacts(event), prediction, markets };
  });
  const marketStatus = Object.fromEntries(MARKET_KINDS.map((kind) => [kind, sanitizeMarketBlock(
    source.markets?.[kind], source.gates?.[kind] || (kind === 'winner' ? source.gate : null),
    source.samples?.[kind] || source.markets?.[kind]?.sample || (kind === 'winner' ? source.sample : null), kind,
  )]));
  return {
    sport, date, updated_at: source.updated_at || null,
    gate: safeMarketGate(source.gate, 'winner'),
    sample: safeMarketSample(source.sample), record: open ? safePublicRecord(source.record) : null,
    markets: marketStatus, events: safeEvents,
    top2: open && Array.isArray(source.top2)
      ? source.top2.slice(0, 2).map((item) => sanitizeMarketBlock(item, source.gate, source.sample, item?.market === 'total' ? 'total' : 'winner')).filter((item) => item.state === 'public') : [],
    training: !open,
  };
}

async function usSportsToday(env, sport, origin, fallbackOverride = null) {
  const date = etDate(new Date());
  let doc = null, fallbackGames = Array.isArray(fallbackOverride) ? fallbackOverride : [];
  try { const raw = await env.AA_LATEST.get(`${sport}:today`); if (raw) doc = JSON.parse(raw); } catch (e) { /* fail closed */ }
  if (!fallbackGames.length && Object.hasOwn(US_SPORTS, sport)) try {
    const row = await env.DB.prepare(
      'SELECT payload FROM sports_ingest_slots WHERE sport = ? AND date = ? ORDER BY slot_id DESC LIMIT 1',
    ).bind(sport, date).first();
    if (row?.payload) fallbackGames = JSON.parse(row.payload)?.games || [];
  } catch (e) { /* first deploy before migration or storage outage */ }
  return json(sanitizeUsSportsToday(doc, sport, fallbackGames, date), 200, origin, 60);
}

async function usSportsHistory(url, env, sport, origin) {
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10) || 30));
  const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - days);
  try {
    const { results } = await env.DB.prepare(
      `SELECT date, event_id, selection_key, market_key AS market, pick, side, line, price, market_prob, prob,
              home, away, start_time, result, engine_version, gate_version, updated_at
       FROM sport_market_predictions
       WHERE sport = ? AND public_scope = 'public' AND gate_passed = 1 AND human_approved = 1
         AND invalidated = 0 AND date >= ?
       ORDER BY date DESC, start_time DESC, market_key ASC, selection_key ASC LIMIT 1000`,
    ).bind(sport, cutoff.toISOString().slice(0, 10)).all();
    if (results?.length) return json({ sport, days, count: results.length, predictions: results }, 200, origin, 120);
  } catch (e) { /* migration may not be applied yet; use the legacy ledgers */ }
  // NBA/WNBA's legacy table is shadow-only and has no per-market/public-scope
  // columns. Returning it would leak private rows, so an empty public history
  // is the only safe fallback before migration 0007 has public data.
  if (['nba', 'wnba'].includes(sport)) {
    return json({ sport, days, count: 0, predictions: [], note: 'public_history_empty' }, 200, origin, 60);
  }
  try {
    const { results } = await env.DB.prepare(
      `SELECT date, event_id, selection_key, market, pick, side, line, price, market_prob, prob,
              confidence, home, away, start_time, result, engine_version, gate_version, updated_at
       FROM sports_predictions
       WHERE sport = ? AND public_scope = 'public' AND invalidated = 0 AND date >= ?
       ORDER BY date DESC, start_time DESC, selection_key ASC LIMIT 1000`,
    ).bind(sport, cutoff.toISOString().slice(0, 10)).all();
    return json({ sport, days, count: results?.length || 0, predictions: results || [] }, 200, origin, 120);
  } catch (e) {
    return json({ sport, days, count: 0, predictions: [], note: 'history_not_initialized' }, 200, origin, 60);
  }
}

async function usSportsKv(env, sport, kind, origin) {
  const raw = await env.AA_LATEST.get(`${sport}:${kind}`);
  if (!raw) return json({ sport, state: 'training', note: 'not_published_yet' }, 200, origin, 300);
  if (kind === 'simulation') {
    try { return json(sanitizeSportsSimulation(JSON.parse(raw), sport), 200, origin, 300); }
    catch (e) { return json({ sport, state: 'training', note: 'simulation_invalid' }, 200, origin, 60); }
  }
  return new Response(raw, { status: 200, headers: { ...cors(origin), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}

function safeSimulationMetrics(metrics) {
  const source = metrics && typeof metrics === 'object' ? metrics : {};
  const out = {};
  for (const key of ['n', 'accuracy', 'acc', 'brier', 'logloss', 'ece', 'mae', 'rmse', 'bias', 'baseline_mae', 'interval80_coverage', 'market_line_coverage']) {
    const value = finiteMarketNumber(source[key]);
    if (value != null) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export function sanitizeSportsSimulation(doc, sport) {
  const source = doc && typeof doc === 'object' ? doc : {};
  const market = (kind) => {
    const block = source[kind] && typeof source[kind] === 'object' ? source[kind] : {};
    return {
      historical: safeSimulationMetrics(block.historical),
      forward: safeMarketSample(block.forward),
      market_line_coverage: finiteMarketNumber(block.market_line_coverage),
      gate: safeMarketGate(block.gate, kind),
    };
  };
  const players = {};
  for (const family of ['pts', 'reb', 'ast', 'passing_yards', 'completions', 'rushing_yards', 'receptions', 'receiving_yards', 'td']) {
    const block = source.players?.[family];
    if (!block) continue;
    players[family] = {
      historical: safeSimulationMetrics(block.historical || { n: block.historical_observations }),
      forward: safeMarketSample(block.forward),
      market_line_coverage: finiteMarketNumber(block.market_line_coverage),
      gate: safeMarketGate(block.gate, 'players'),
    };
  }
  return {
    schema: 'aa_multisport_simulation_public_v1', sport,
    generated_at: typeof source.generated_at === 'string' ? source.generated_at : null,
    seasons: Array.isArray(source.seasons) ? source.seasons.slice(-8).map(String) : [],
    burn_in: Array.isArray(source.burn_in) ? source.burn_in.slice(-4).map(String) : [],
    winner: market('winner'), total: market('total'), players,
    combos: market('combos'), state: 'training',
  };
}

// ── QA privado: inspección de predicciones shadow ──────────────────────────
// D1 conserva la selección medida para validación causal. La API pública la
// elimina; esta segunda frontera solo la reconstruye para una sesión Google
// verificada cuyo email figure explícitamente en QA_ALLOWED_EMAILS.
const QA_SPORTS = new Set(['wnba', 'nfl', 'ncaaf', 'nhl', 'ncaam']);

function qaAllowedEmails(env) {
  return new Set(String(env?.QA_ALLOWED_EMAILS || '').split(',')
    .map((email) => email.trim().toLowerCase()).filter(Boolean));
}

function qaSessionAllowed(session, env) {
  const allowed = qaAllowedEmails(env);
  return allowed.size > 0 && session?.email_verified === true
    && typeof session?.email === 'string' && allowed.has(session.email.toLowerCase());
}

const qaText = (value, max = 160) => typeof value === 'string' && value ? value.slice(0, max) : null;

export function sanitizeQaMarketRow(row) {
  const source = row && typeof row === 'object' ? row : {};
  const out = {};
  for (const key of ['date', 'event_id', 'market_key', 'selection_key', 'family', 'player_id', 'player_name',
    'pick', 'side', 'league', 'home', 'away', 'start_time', 'feature_as_of', 'frozen_at', 'status', 'result',
    'engine_version', 'gate_version', 'updated_at']) {
    const value = qaText(source[key], key === 'selection_key' ? 140 : 160);
    if (value != null) out[key] = value;
  }
  for (const key of ['line', 'price', 'market_prob', 'prob', 'edge', 'projection']) {
    const value = finiteMarketNumber(source[key]);
    if (value != null) out[key] = value;
  }
  return out;
}

function qaEvidenceFor(kind, todayDoc, simulationDoc, learningDoc, rows) {
  const simulationBlock = kind === 'players'
    ? Object.values(simulationDoc?.players || {})[0]
    : simulationDoc?.[kind];
  const gate = safeMarketGate(
    todayDoc?.gates?.[kind] || todayDoc?.markets?.[kind]?.gate || simulationBlock?.gate
      || (kind === 'winner' ? learningDoc?.gate : null), kind,
  );
  const sample = safeMarketSample(
    todayDoc?.samples?.[kind] || todayDoc?.markets?.[kind]?.sample || simulationBlock?.forward
      || (kind === 'winner' ? learningDoc?.forward : null),
  ) || { n: rows.length };
  return { gate: { ...gate, public: false, approved: false, state: 'closed' }, sample };
}

function qaMarketItem(row, event) {
  const item = sanitizeQaMarketRow(row);
  if (row?.market_key === 'winner' && (item.side === 'home' || item.side === 'away')) {
    const team = event?.[item.side];
    if (team?.code) item.pick = team.code;
  }
  return item;
}

function qaMarketBlock(kind, rows, evidence, event) {
  const items = rows.map((row) => qaMarketItem(row, event));
  if (!items.length) return { state: 'closed', qa: true, ...evidence };
  return { state: 'qa', qa: true, public: false, ...evidence, ...items[0], items };
}

async function qaRawDocs(env, sport) {
  const [todayRaw, learningRaw, simulationRaw] = await Promise.all([
    env.AA_LATEST.get(`${sport}:today`), env.AA_LATEST.get(`${sport}:learning`), env.AA_LATEST.get(`${sport}:simulation`),
  ]);
  const parse = (raw) => { try { return raw ? JSON.parse(raw) : {}; } catch (error) { return {}; } };
  return { today: parse(todayRaw), learning: parse(learningRaw), simulation: parse(simulationRaw) };
}

async function qaTodayFacts(env, sport, date, todayDoc) {
  let facts = (Array.isArray(todayDoc?.events) ? todayDoc.events : [])
    .filter((event) => !event?.date || event.date === date).map(safeSportEventFacts);
  if (!facts.length && Object.hasOwn(US_SPORTS, sport)) {
    try {
      const row = await env.DB.prepare(
        'SELECT payload FROM sports_ingest_slots WHERE sport = ? AND date = ? ORDER BY slot_id DESC LIMIT 1',
      ).bind(sport, date).first();
      if (row?.payload) facts = (JSON.parse(row.payload)?.games || []).map(safeSportEventFacts);
    } catch (error) { /* facts are optional; measured D1 rows still remain auditable */ }
  }
  return facts;
}

async function qaToday(env, sport, request) {
  const date = etDate(new Date());
  const docs = await qaRawDocs(env, sport);
  let rows = [];
  try {
    const result = await env.DB.prepare(
      `SELECT date,event_id,market_key,selection_key,family,player_id,player_name,pick,side,line,price,
              market_prob,prob,edge,projection,league,home,away,start_time,feature_as_of,frozen_at,
              status,result,engine_version,gate_version,updated_at
       FROM sport_market_predictions
       WHERE sport = ? AND date = ? AND public_scope = 'shadow' AND human_approved = 0 AND invalidated = 0
       ORDER BY start_time ASC, event_id ASC, market_key ASC, selection_key ASC LIMIT 1000`,
    ).bind(sport, date).all();
    rows = result?.results || [];
  } catch (error) { /* migration/storage outage: return a measured empty state */ }

  const facts = await qaTodayFacts(env, sport, date, docs.today);
  const byId = new Map(facts.map((event) => [String(event.espn_id || event.event_id || event.id || ''), event]));
  for (const row of rows) {
    const key = String(row.event_id || '');
    if (!byId.has(key)) byId.set(key, safeSportEventFacts({
      event_id: key, espn_id: key, date: row.date, start: row.start_time, status: row.status,
      home: { code: row.home, name: row.home }, away: { code: row.away, name: row.away },
    }));
  }
  const events = [...byId.values()].map((event) => {
    const id = String(event.espn_id || event.event_id || event.id || '');
    const eventRows = rows.filter((row) => String(row.event_id) === id);
    const grouped = {
      winner: eventRows.filter((row) => row.market_key === 'winner'),
      total: eventRows.filter((row) => row.market_key === 'total'),
      players: eventRows.filter((row) => row.market_key === 'player_prop'),
      combos: eventRows.filter((row) => row.market_key === 'combo'),
    };
    const markets = Object.fromEntries(MARKET_KINDS.map((kind) => [kind, qaMarketBlock(
      kind, grouped[kind], qaEvidenceFor(kind, docs.today, docs.simulation, docs.learning, grouped[kind]), event,
    )]));
    const winner = markets.winner.state === 'qa' ? markets.winner : null;
    return { ...event, markets, prediction: winner ? {
      pick: winner.pick || null, side: winner.side || null, prob: winner.prob ?? null,
      line: winner.line ?? null, price: winner.price ?? null, edge: winner.edge ?? null,
      engine_version: winner.engine_version || null, qa: true,
    } : null };
  });
  const markets = Object.fromEntries(MARKET_KINDS.map((kind) => {
    const kindRows = rows.filter((row) => row.market_key === (kind === 'players' ? 'player_prop' : kind === 'combos' ? 'combo' : kind));
    return [kind, qaMarketBlock(kind, kindRows, qaEvidenceFor(kind, docs.today, docs.simulation, docs.learning, kindRows), null)];
  }));
  return credJson({
    schema: 'aa_qa_shadow_today_v1', qa: true, public: false, scope: 'shadow', sport, date,
    updated_at: docs.today?.updated_at || rows[0]?.updated_at || null, row_count: rows.length,
    markets, events, top2: [], training: true,
  }, 200, request, env);
}

async function qaHistory(url, env, sport, request) {
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10) || 30));
  const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - days);
  let rows = [];
  try {
    const result = await env.DB.prepare(
      `SELECT date,event_id,market_key,selection_key,family,player_id,player_name,pick,side,line,price,
              market_prob,prob,edge,projection,league,home,away,start_time,feature_as_of,frozen_at,
              status,result,engine_version,gate_version,updated_at
       FROM sport_market_predictions
       WHERE sport = ? AND date >= ? AND public_scope = 'shadow' AND human_approved = 0 AND invalidated = 0
       ORDER BY date DESC,start_time DESC,market_key ASC,selection_key ASC LIMIT 1000`,
    ).bind(sport, cutoff.toISOString().slice(0, 10)).all();
    rows = (result?.results || []).map(sanitizeQaMarketRow);
  } catch (error) { /* explicit empty state below */ }
  return credJson({ schema: 'aa_qa_shadow_history_v1', qa: true, public: false, scope: 'shadow', sport, days, count: rows.length, predictions: rows }, 200, request, env);
}

async function qaSportRoute(url, request, env, sport, action) {
  if (!QA_SPORTS.has(sport)) return credJson({ error: 'not_found' }, 404, request, env);
  const session = await sessionUser(request, env);
  if (!session) return credJson({ error: 'qa_auth_required' }, 401, request, env);
  if (!qaSessionAllowed(session, env)) return credJson({ error: 'qa_forbidden' }, 403, request, env);
  if (action === 'today') return qaToday(env, sport, request);
  if (action === 'history') return qaHistory(url, env, sport, request);
  const docs = await qaRawDocs(env, sport);
  if (action === 'learning') return credJson({ ...sanitizeModelPublisherLearning(docs.learning, sport), qa: true, public: false }, 200, request, env);
  if (action === 'simulation') return credJson({ ...sanitizeSportsSimulation(docs.simulation, sport), qa: true, public: false }, 200, request, env);
  if (action === 'pipeline-health') {
    const latest = [docs.today?.updated_at, docs.learning?.updated_at, docs.simulation?.generated_at].filter(Boolean).sort().at(-1) || null;
    const ageSeconds = latest && Number.isFinite(Date.parse(latest)) ? Math.max(0, Math.floor((Date.now() - Date.parse(latest)) / 1000)) : null;
    return credJson({ qa: true, public: false, sport, state: latest ? 'available' : 'empty', latest_at: latest, age_seconds: ageSeconds }, 200, request, env);
  }
  return credJson({ error: 'not_found' }, 404, request, env);
}

function base64UrlBytes(value) {
  const source = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = source + '='.repeat((4 - (source.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function jwtJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));
}

const oidcFailure = (reason) => new Error(`oidc_${reason}`);

// GitHub issues a short-lived RS256 JWT to the running job. The Worker trusts
// only the immutable repository id, main, and this one workflow. No Cloudflare
// token or shared signing secret crosses repository boundaries.
export async function verifyGithubModelPublisher(token, fetcher = fetch, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length < 100 || token.length > 12000) throw oidcFailure('token_shape');
  const parts = token.split('.');
  if (parts.length !== 3) throw oidcFailure('token_shape');
  let header, claims;
  try { header = jwtJson(parts[0]); claims = jwtJson(parts[1]); }
  catch (error) { throw oidcFailure('token_json'); }
  if (header?.alg !== 'RS256' || typeof header?.kid !== 'string' || !header.kid) throw oidcFailure('header');

  const jwksResponse = await fetcher(GITHUB_OIDC_JWKS, {
    headers: { accept: 'application/json', 'user-agent': 'aa-sports-worker/oidc' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!jwksResponse?.ok) throw oidcFailure('jwks_http');
  const jwks = await jwksResponse.json();
  const jwk = Array.isArray(jwks?.keys)
    ? jwks.keys.find((key) => key?.kid === header.kid && key?.kty === 'RSA' && (!key.use || key.use === 'sig'))
    : null;
  if (!jwk) throw oidcFailure('key');
  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
  } catch (error) { throw oidcFailure('key_import'); }
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', cryptoKey, base64UrlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) throw oidcFailure('signature');

  const now = Math.floor(nowMs / 1000);
  const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  if (claims?.iss !== GITHUB_OIDC_ISSUER || !audience.includes(MODEL_PUBLISH_AUDIENCE)) throw oidcFailure('issuer_audience');
  if (!Number.isFinite(claims?.exp) || claims.exp <= now - 30) throw oidcFailure('expired');
  if (!Number.isFinite(claims?.nbf) || claims.nbf > now + 30) throw oidcFailure('not_yet_valid');
  if (!Number.isFinite(claims?.iat) || claims.iat > now + 30 || claims.iat < now - 600) throw oidcFailure('issued_at');
  if (claims?.repository !== MODEL_PUBLISH_REPOSITORY
      || String(claims?.repository_id || '') !== MODEL_PUBLISH_REPOSITORY_ID
      || String(claims?.repository_owner_id || '') !== MODEL_PUBLISH_OWNER_ID) throw oidcFailure('repository');
  if (claims?.repository_visibility !== 'private' || claims?.runner_environment !== 'github-hosted') throw oidcFailure('runner');
  if (claims?.ref !== 'refs/heads/main' || claims?.ref_type !== 'branch') throw oidcFailure('ref');
  if (claims?.workflow_ref !== MODEL_PUBLISH_WORKFLOW) throw oidcFailure('workflow');
  if (!MODEL_PUBLISH_EVENTS.has(claims?.event_name)) throw oidcFailure('event');
  if (typeof claims?.jti !== 'string' || claims.jti.length < 8 || !/^[0-9a-f]{40}$/i.test(String(claims?.sha || ''))) {
    throw oidcFailure('identity');
  }
  return claims;
}

// Google ID tokens protect both the optional account and the privileged QA
// view. Verifying only the decoded payload would let an attacker forge a JWT;
// this follows Google's discovery/JWKS flow and validates the OIDC claims.
export async function verifyGoogleIdToken(token, clientId, expectedNonce, fetcher = fetch, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length < 100 || token.length > 16000) throw oidcFailure('google_token_shape');
  const parts = token.split('.');
  if (parts.length !== 3) throw oidcFailure('google_token_shape');
  let header, claims;
  try { header = jwtJson(parts[0]); claims = jwtJson(parts[1]); }
  catch (error) { throw oidcFailure('google_token_json'); }
  if (header?.alg !== 'RS256' || typeof header?.kid !== 'string' || !header.kid) throw oidcFailure('google_header');

  const discoveryResponse = await fetcher(GOOGLE_OIDC_DISCOVERY, {
    headers: { accept: 'application/json', 'user-agent': 'aa-sports-worker/google-oidc' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!discoveryResponse?.ok) throw oidcFailure('google_discovery_http');
  const discovery = await discoveryResponse.json();
  if (!GOOGLE_OIDC_ISSUERS.has(discovery?.issuer) || typeof discovery?.jwks_uri !== 'string') {
    throw oidcFailure('google_discovery');
  }
  let jwksUrl;
  try { jwksUrl = new URL(discovery.jwks_uri); } catch (error) { throw oidcFailure('google_jwks_url'); }
  if (jwksUrl.protocol !== 'https:' || !['www.googleapis.com', 'accounts.google.com'].includes(jwksUrl.hostname)) {
    throw oidcFailure('google_jwks_url');
  }
  const jwksResponse = await fetcher(jwksUrl.toString(), {
    headers: { accept: 'application/json', 'user-agent': 'aa-sports-worker/google-oidc' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!jwksResponse?.ok) throw oidcFailure('google_jwks_http');
  const jwks = await jwksResponse.json();
  const jwk = Array.isArray(jwks?.keys)
    ? jwks.keys.find((key) => key?.kid === header.kid && key?.kty === 'RSA' && (!key.use || key.use === 'sig'))
    : null;
  if (!jwk) throw oidcFailure('google_key');
  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch (error) { throw oidcFailure('google_key_import'); }
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', cryptoKey, base64UrlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) throw oidcFailure('google_signature');

  const now = Math.floor(nowMs / 1000);
  const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  if (!GOOGLE_OIDC_ISSUERS.has(claims?.iss) || !audience.includes(clientId)) throw oidcFailure('google_issuer_audience');
  if (claims?.azp && claims.azp !== clientId) throw oidcFailure('google_azp');
  if (!Number.isFinite(claims?.exp) || claims.exp <= now - 30) throw oidcFailure('google_expired');
  if (!Number.isFinite(claims?.iat) || claims.iat > now + 60 || claims.iat < now - 7200) throw oidcFailure('google_issued_at');
  if (typeof claims?.sub !== 'string' || !claims.sub) throw oidcFailure('google_sub');
  if (typeof expectedNonce !== 'string' || !expectedNonce || claims?.nonce !== expectedNonce) throw oidcFailure('google_nonce');
  if (claims?.email && claims.email_verified !== true) throw oidcFailure('google_email_unverified');
  return claims;
}

function forceClosedGate(gate) {
  const source = gate && typeof gate === 'object' ? gate : {};
  return { ...source, approved: false, public: false, state: 'closed' };
}

function forceTodayMarketsClosed(doc) {
  const source = doc && typeof doc === 'object' ? doc : {};
  const gates = Object.fromEntries(MARKET_KINDS.map((kind) => [kind, forceClosedGate(
    source.gates?.[kind] || source.markets?.[kind]?.gate || (kind === 'winner' ? source.gate : null),
  )]));
  const markets = Object.fromEntries(MARKET_KINDS.map((kind) => [kind, {
    ...(source.markets?.[kind] && typeof source.markets[kind] === 'object' ? source.markets[kind] : {}),
    gate: gates[kind],
  }]));
  const events = (Array.isArray(source.events) ? source.events : []).map((event) => ({
    ...(event && typeof event === 'object' ? event : {}), prediction: null,
    markets: Object.fromEntries(MARKET_KINDS.map((kind) => [kind, {
      ...(event?.markets?.[kind] && typeof event.markets[kind] === 'object' ? event.markets[kind] : {}),
      gate: forceClosedGate(event?.markets?.[kind]?.gate || gates[kind]),
    }])),
  }));
  return { ...source, gate: gates.winner, gates, markets, events, top2: [], record: null };
}

function forceSimulationMarketsClosed(doc) {
  const source = doc && typeof doc === 'object' ? doc : {};
  const closeBlock = (block) => ({
    ...(block && typeof block === 'object' ? block : {}),
    gate: forceClosedGate(block?.gate),
  });
  const players = Object.fromEntries(Object.entries(source.players || {}).map(([family, block]) => [family, closeBlock(block)]));
  return { ...source, winner: closeBlock(source.winner), total: closeBlock(source.total), players, combos: closeBlock(source.combos) };
}

export function sanitizeModelPublisherLearning(doc, sport) {
  const source = doc && typeof doc === 'object' ? doc : {};
  const rawGate = forceClosedGate(source.gate);
  const gate = { ...safeMarketGate(rawGate, 'winner') };
  for (const key of ['min_forward', 'min_dates']) {
    const value = finiteMarketNumber(rawGate[key]);
    if (value != null && value >= 0) gate[key] = value;
  }
  const historical = safeSimulationMetrics(source.historical) || {};
  const forward = {
    ...(safeMarketSample(source.forward || source.sample) || {}),
    ...(safeSimulationMetrics(source.forward) || {}),
  };
  const safeLines = (value) => (Array.isArray(value) ? value : [])
    .filter((line) => typeof line === 'string' && line.trim()).slice(0, 6).map((line) => line.slice(0, 280));
  return {
    schema: 'aa_sport_learning_v1', sport,
    updated_at: typeof source.updated_at === 'string' ? source.updated_at.slice(0, 40) : null,
    state: 'training', model_scope: 'shadow', gate, historical, forward,
    learning_es: safeLines(source.learning_es), learning_en: safeLines(source.learning_en),
    attribution_es: typeof source.attribution_es === 'string' ? source.attribution_es.slice(0, 280) : '',
    attribution_en: typeof source.attribution_en === 'string' ? source.attribution_en.slice(0, 280) : '',
    public_picks_enabled: false,
  };
}

const publishText = (value, max, required = false) => {
  if (value == null || value === '') {
    if (required) throw new Error('publish_row_missing_text');
    return null;
  }
  const text = String(value);
  if (text.length > max) throw new Error('publish_row_text_too_long');
  return text;
};

const publishNumber = (value, minimum = -1e9, maximum = 1e9) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error('publish_row_bad_number');
  return number;
};

function sanitizeModelMarketRow(row, sport, now = new Date()) {
  const source = row && typeof row === 'object' ? row : {};
  const date = publishText(source.date, 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('publish_row_bad_date');
  const distance = Math.abs(Date.parse(`${date}T12:00:00Z`) - Date.parse(`${etDate(now)}T12:00:00Z`));
  if (!Number.isFinite(distance) || distance > 8 * 24 * 60 * 60 * 1000) throw new Error('publish_row_date_window');
  const marketKey = publishText(source.market_key, 24, true);
  if (!['winner', 'total', 'player_prop', 'combo'].includes(marketKey)) throw new Error('publish_row_bad_market');
  const startTime = publishText(source.start_time, 40);
  const featureAsOf = publishText(source.feature_as_of, 40);
  const frozenAt = publishText(source.frozen_at, 40);
  const updatedAt = publishText(source.updated_at, 40, true);
  for (const stamp of [startTime, featureAsOf, frozenAt, updatedAt].filter(Boolean)) {
    if (!Number.isFinite(Date.parse(stamp))) throw new Error('publish_row_bad_timestamp');
  }
  if (startTime && featureAsOf && Date.parse(featureAsOf) > Date.parse(startTime)) throw new Error('publish_row_late_features');
  const result = publishText(source.result, 12);
  if (result && !['win', 'loss', 'push', 'void'].includes(result)) throw new Error('publish_row_bad_result');
  let comboJson = null;
  if (source.combo_json != null && source.combo_json !== '') {
    comboJson = typeof source.combo_json === 'string' ? source.combo_json : JSON.stringify(source.combo_json);
    if (comboJson.length > 4000) throw new Error('publish_row_combo_too_large');
    try { JSON.parse(comboJson); } catch (error) { throw new Error('publish_row_bad_combo'); }
  }
  return {
    sport, date,
    event_id: publishText(source.event_id, 100, true), market_key: marketKey,
    selection_key: publishText(source.selection_key, 140, true), family: publishText(source.family, 60),
    player_id: publishText(source.player_id, 100), player_name: publishText(source.player_name, 160),
    pick: publishText(source.pick, 160), side: publishText(source.side, 40),
    line: publishNumber(source.line), price: publishNumber(source.price, -100000, 100000),
    market_prob: publishNumber(source.market_prob, 0, 1), prob: publishNumber(source.prob, 0, 1),
    edge: publishNumber(source.edge, -1, 1), projection: publishNumber(source.projection), combo_json: comboJson,
    league: publishText(source.league, 40), home: publishText(source.home, 100), away: publishText(source.away, 100),
    start_time: startTime, feature_as_of: featureAsOf, frozen_at: frozenAt,
    status: publishText(source.status, 24), result,
    engine_version: publishText(source.engine_version || 'aa-us-sports-challenger-v2', 80, true),
    gate_version: publishText(source.gate_version || 'us-sports-gate-v1', 80, true),
    public_scope: 'shadow', gate_passed: 0, human_approved: 0, invalidated: source.invalidated ? 1 : 0,
    invalidated_reason: publishText(source.invalidated_reason, 160), source_hash: publishText(source.source_hash, 128),
    updated_at: updatedAt,
  };
}

export function sanitizeModelPublishEnvelope(payload, now = new Date()) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const sport = String(source.sport || '').toLowerCase();
  if (!Object.hasOwn(US_SPORTS, sport)) throw new Error('publish_bad_sport');
  const rows = Array.isArray(source.market_rows) ? source.market_rows : [];
  if (rows.length > 1000) throw new Error('publish_too_many_rows');
  const today = sanitizeUsSportsToday(forceTodayMarketsClosed(source.today), sport, [], etDate(now));
  const simulation = sanitizeSportsSimulation(forceSimulationMarketsClosed(source.simulation), sport);
  const learning = sanitizeModelPublisherLearning({ ...(source.learning || {}), gate: forceClosedGate(source.learning?.gate) }, sport);
  return { sport, today, simulation, learning, market_rows: rows.map((row) => sanitizeModelMarketRow(row, sport, now)) };
}

const MODEL_MARKET_COLUMNS = Object.freeze([
  'sport', 'date', 'event_id', 'market_key', 'selection_key', 'family', 'player_id', 'player_name',
  'pick', 'side', 'line', 'price', 'market_prob', 'prob', 'edge', 'projection', 'combo_json',
  'league', 'home', 'away', 'start_time', 'feature_as_of', 'frozen_at', 'status', 'result',
  'engine_version', 'gate_version', 'public_scope', 'gate_passed', 'human_approved', 'invalidated',
  'invalidated_reason', 'source_hash', 'updated_at',
]);

async function upsertModelMarketRows(db, rows) {
  if (!rows.length) return;
  const placeholders = `(${MODEL_MARKET_COLUMNS.map(() => '?').join(',')})`;
  const updates = MODEL_MARKET_COLUMNS
    .filter((column) => !['sport', 'date', 'event_id', 'market_key', 'selection_key', 'public_scope', 'gate_passed', 'human_approved'].includes(column))
    .map((column) => `${column}=excluded.${column}`).join(',');
  const sql = `INSERT INTO sport_market_predictions (${MODEL_MARKET_COLUMNS.join(',')}) VALUES ${placeholders}
    ON CONFLICT(sport,date,event_id,market_key,selection_key) DO UPDATE SET ${updates}
    WHERE sport_market_predictions.public_scope = 'shadow' AND sport_market_predictions.human_approved = 0`;
  for (let offset = 0; offset < rows.length; offset += 50) {
    const statements = rows.slice(offset, offset + 50).map((row) => db.prepare(sql).bind(
      ...MODEL_MARKET_COLUMNS.map((column) => row[column] ?? null),
    ));
    if (typeof db.batch === 'function') await db.batch(statements);
    else for (const statement of statements) await statement.run();
  }
}

async function internalModelPublish(request, env, origin) {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) return json({ error: 'forbidden' }, 403, origin);
  let claims;
  try { claims = await verifyGithubModelPublisher(authorization.slice(7)); }
  catch (error) {
    console.warn(JSON.stringify({ message: 'model publisher rejected', reason: String(error?.message || error) }));
    return json({ error: 'forbidden' }, 403, origin);
  }
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MODEL_PUBLISH_MAX_BYTES) return json({ error: 'payload_too_large' }, 413, origin);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MODEL_PUBLISH_MAX_BYTES) return json({ error: 'payload_too_large' }, 413, origin);
  let envelope;
  try { envelope = sanitizeModelPublishEnvelope(JSON.parse(text)); }
  catch (error) {
    console.warn(JSON.stringify({ message: 'model publisher payload rejected', reason: String(error?.message || error) }));
    return json({ error: 'invalid_payload' }, 400, origin);
  }
  // GitHub may return the same short-lived JWT more than once inside one job;
  // each token may publish every supported sport exactly once.
  const replayKey = `oidc:model-publish:${claims.jti}:${envelope.sport}`;
  if (await env.AA_LATEST.get(replayKey)) return json({ error: 'replayed_token' }, 409, origin);
  await upsertModelMarketRows(env.DB, envelope.market_rows);
  await Promise.all([
    env.AA_LATEST.put(`${envelope.sport}:learning`, JSON.stringify(envelope.learning)),
    env.AA_LATEST.put(`${envelope.sport}:simulation`, JSON.stringify(envelope.simulation)),
    env.AA_LATEST.put(`${envelope.sport}:today`, JSON.stringify(envelope.today)),
    env.AA_LATEST.put(replayKey, String(claims.run_id || 'used'), { expirationTtl: 600 }),
  ]);
  return json({ ok: true, sport: envelope.sport, kv: 3, market_rows: envelope.market_rows.length, public: false }, 200, origin);
}

async function usSportsPipelineHealth(env, sport, origin) {
  if (['nba', 'wnba'].includes(sport)) {
    try {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n, MAX(updated_at) AS updated_at,
                SUM(CASE WHEN result IN ('win','loss','push','void') THEN 1 ELSE 0 END) AS graded
         FROM predictions WHERE sport = ?`,
      ).bind(sport).first();
      const ageSeconds = row?.updated_at ? Math.max(0, Math.floor((Date.now() - Date.parse(row.updated_at)) / 1000)) : null;
      return json({
        sport, ok: ageSeconds != null && ageSeconds <= 2 * 60 * 60,
        state: ageSeconds == null ? 'empty' : ageSeconds > 2 * 60 * 60 ? 'stale' : 'ok',
        interval_minutes: 60, age_seconds: ageSeconds,
        latest: { captured_at: row?.updated_at || null, n: Number(row?.n || 0), graded: Number(row?.graded || 0) },
      }, 200, origin, 30);
    } catch (e) {
      return json({ sport, ok: false, state: 'unavailable', interval_minutes: 60 }, 200, origin, 15);
    }
  }
  try {
    const row = await env.DB.prepare(
      `SELECT sport, slot_id, date, scheduled_at, captured_at, status, source_hash, n_games, missingness, error
       FROM sports_ingest_slots WHERE sport = ? ORDER BY slot_id DESC LIMIT 1`,
    ).bind(sport).first();
    if (!row) return json({ sport, ok: false, state: 'empty', interval_minutes: 20 }, 200, origin, 30);
    const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(row.captured_at)) / 1000));
    return json({
      sport, ok: row.status === 'ok' && ageSeconds <= MLB_INGEST_STALE_SECONDS,
      state: ageSeconds > MLB_INGEST_STALE_SECONDS ? 'stale' : row.status,
      interval_minutes: 20, age_seconds: ageSeconds,
      latest: { ...row, missingness: parseHealthJson(row.missingness, {}), error: parseHealthJson(row.error, row.error || null) },
    }, 200, origin, 30);
  } catch (e) {
    return json({ sport, ok: false, state: 'unavailable', interval_minutes: 20 }, 200, origin, 15);
  }
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

  let fetched;
  try {
    fetched = await fetchEspnPublicResponse(upstream, { init: { cf: { cacheTtl: 60 } } });
  } catch (error) {
    return json({ ok: false, note: 'summary upstream ' + ingestError(error) }, 200, origin, 30);
  }
  let data;
  try { data = await fetched.response.json(); } catch (e) { return json({ ok: false, note: 'summary non-json' }, 200, origin, 30); }

  const payloadObj = sport === 'soccer' ? soccerSummary(data)
    : BASKETBALL_LEAGUES.includes(sport) ? nbaSummary(data, sport)
      : genericTeamSummary(data, sport);
  const payload = JSON.stringify({ ok: true, updated_at: new Date().toISOString(), source: fetched.source, ...payloadObj });
  const toCache = new Response(payload, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return withCors(payload, origin, 60);
}

function genericTeamSummary(data, sport) {
  const teams = data?.boxscore?.teams || [];
  const home = teams.find((team) => team.homeAway === 'home') || teams[0] || {};
  const away = teams.find((team) => team.homeAway === 'away') || teams[1] || {};
  const statsOf = (team) => new Map((team.statistics || []).map((stat) => [stat.name || stat.label, stat.displayValue ?? stat.value ?? null]));
  const hs = statsOf(home), as = statsOf(away);
  const labels = new Map();
  for (const team of teams) for (const stat of (team.statistics || [])) labels.set(stat.name || stat.label, stat.label || stat.abbreviation || stat.name);
  const nflStats = new Map([
    ['firstDowns', ['stat_nfl_first_downs', '1st Downs']], ['totalYards', ['stat_nfl_total_yards', 'Total Yards']],
    ['netPassingYards', ['stat_nfl_passing_yards', 'Passing Yards']], ['rushingYards', ['stat_nfl_rushing_yards', 'Rushing Yards']],
    ['turnovers', ['stat_nfl_turnovers', 'Turnovers']], ['sacksYardsLost', ['stat_nfl_sacks', 'Sacks-Yards']],
    ['thirdDownEff', ['stat_nfl_third_down', '3rd Down']], ['possessionTime', ['stat_nfl_possession', 'Possession']],
    ['totalPenaltiesYards', ['stat_nfl_penalties', 'Penalties-Yards']],
  ]);
  const sourceStats = sport === 'nfl'
    ? [...nflStats].filter(([key]) => hs.has(key) || as.has(key)).map(([key, [i18n, label]]) => [key, label, i18n])
    : [...labels.entries()].filter(([key]) => hs.has(key) || as.has(key)).slice(0, 18).map(([key, label]) => [key, label, null]);
  const stats = sourceStats.map(([key, label, i18n]) => ({ key: i18n, label, home: hs.get(key) ?? null, away: as.get(key) ?? null }));
  const playerSides = playerSidesByTeams(data);
  const groupsOf = (block) => {
    if (!block) return null;
    const wanted = sport === 'nfl'
      ? new Set(['passing', 'rushing', 'receiving', 'defensive'])
      : new Set(['skaters', 'goalies']);
    const groups = (block.statistics || []).filter((group) => wanted.has(group.name)).map((group) => {
      const labels = (group.labels || group.names || []).map((label) => String(label));
      const rows = (group.athletes || []).map((entry) => ({
        name: entry?.athlete?.shortName || entry?.athlete?.displayName || null,
        id: entry?.athlete?.id || null,
        headshot: entry?.athlete?.headshot?.href || (typeof entry?.athlete?.headshot === 'string' ? entry.athlete.headshot : null),
        starter: entry?.starter === true,
        stats: Array.isArray(entry?.stats) ? entry.stats.slice(0, labels.length) : [],
      })).filter((row) => row.name && row.stats.length).slice(0, 12);
      return rows.length ? { key: group.name, labels, rows } : null;
    }).filter(Boolean);
    return groups.length ? { code: block.team?.abbreviation || null, groups } : null;
  };
  const players = (playerSides.home || playerSides.away)
    ? { home: groupsOf(playerSides.home), away: groupsOf(playerSides.away) } : null;
  return { sport, stats: stats.length ? stats : null, players };
}

// Elige el bloque home/away de un array cuyos elementos traen homeAway (o cae
// al orden: índice 0 = local por convención de ESPN cuando falta la etiqueta).
function pickSides(arr) {
  const list = Array.isArray(arr) ? arr : [];
  const home = list.find((x) => x && x.homeAway === 'home') || list[0] || null;
  const away = list.find((x) => x && x.homeAway === 'away') || list[1] || null;
  return { home, away };
}

function playerSidesByTeams(data) {
  const players = Array.isArray(data?.boxscore?.players) ? data.boxscore.players : [];
  const teams = pickSides(data?.boxscore?.teams || []);
  const code = (block) => block?.team?.abbreviation || block?.team?.id || null;
  const find = (team) => players.find((block) => code(block) != null && String(code(block)) === String(code(team))) || null;
  return { home: find(teams.home) || players[1] || players[0] || null, away: find(teams.away) || players[0] || players[1] || null };
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
  'FG': ['stat_fg', 'Tiros de campo'], 'Field Goal %': ['stat_fg_pct', '% Tiros de campo'],
  '3PT': ['stat_3pt', 'Triples'], 'Three Point %': ['stat_3pt_pct', '% Triples'],
  'FT': ['stat_ft', 'Tiros libres'], 'Rebounds': ['stat_rebounds', 'Rebotes'],
  'Assists': ['stat_assists', 'Asistencias'], 'Steals': ['stat_steals', 'Robos'],
  'Blocks': ['stat_blocks', 'Tapones'], 'Turnovers': ['stat_turnovers', 'Pérdidas'],
  'Fast Break Points': ['stat_fast_break', 'Puntos al contragolpe'],
  'Points in Paint': ['stat_paint', 'Puntos en la pintura'],
};

function nbaSummary(data, sport = 'nba') {
  const teamSides = playerSidesByTeams(data);
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
    .map(([k, [key, label]]) => ({ key, label, home: hs[k] ?? null, away: as[k] ?? null }));

  return { sport, players, stats: stats.length ? stats : null };
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
  let fetched;
  try {
    fetched = await fetchEspnPublicResponse(`${upstream}?dates=${ymd(from)}-${ymd(to)}&limit=350`);
  } catch (error) {
    return json({ games: [], note: 'recent upstream ' + ingestError(error) }, 200, origin, 60);
  }
  const data = await fetched.response.json();

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

  const payload = JSON.stringify({ updated_at: new Date().toISOString(), source: fetched.source, games });
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
  let successfulTours = 0;
  for (const tour of ['atp', 'wta']) {
    try {
      const fetched = await fetchEspnPublicResponse(`${ESPN_BASE}/tennis/${tour}/scoreboard?dates=${ymd(from)}-${ymd(to)}&limit=150`);
      const data = await fetched.response.json();
      successfulTours++;
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
  if (!successfulTours) return json({ games: [], note: 'tennis recent upstream' }, 200, origin, 60);
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
  let successfulTours = 0;
  for (const tour of ['atp', 'wta']) {
    try {
      const fetched = await fetchEspnPublicResponse(`${ESPN_BASE}/tennis/${tour}/rankings`);
      const data = await fetched.response.json();
      successfulTours++;
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

  if (!successfulTours) return json({ sections: [], note: 'tennis rankings upstream' }, 200, origin, 300);

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
      rank: (() => { const value = numOrNull(stat('rank')); return value != null && value > 0 ? value : null; })(),
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
    for (const s of sections) {
      s.rows.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
      s.rows = s.rows.map((row, index) => ({ ...row, rank: row.rank != null && row.rank > 0 ? row.rank : index + 1 }));
    }
    return { season: (data.season && (data.season.displayName || data.season.year)) || null, sections };
  };
  const grab = async (url) => {
    try {
      const fetched = await fetchEspnPublicResponse(url);
      return { ...parse(await fetched.response.json()), source: fetched.source };
    } catch (e) { return null; }
  };

  // Se prefiere el desglose con MÁS secciones (p.ej. las divisiones de MLB con
  // ?level=3) y se cae al principal si el alterno falla o trae menos → cero regresión.
  let best = await grab(upstream);
  if (altUpstream) { const alt = await grab(altUpstream); if (alt && (!best || alt.sections.length > best.sections.length)) best = alt; }
  if (!best) return json({ sections: [], note: 'standings upstream' }, 200, origin, 120);

  const payload = JSON.stringify({ updated_at: new Date().toISOString(), source: best.source, season: best.season, sections: best.sections });
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
  let successfulTours = 0;
  for (const tour of ['atp', 'wta']) {
    try {
      const fetched = await fetchEspnPublicResponse(`${ESPN_BASE}/tennis/${tour}/scoreboard`, {
        init: { cf: { cacheTtl: 45 } },
      });
      const data = await fetched.response.json();
      successfulTours++;
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

  if (!successfulTours) return json({ games: [], note: 'tennis live upstream' }, 200, origin, 15);

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
function safeReturnTo(value, env) {
  const fallback = siteOrigin(env);
  if (!value) return fallback;
  try {
    const candidate = new URL(value);
    const base = new URL(fallback);
    const legacy = candidate.host === LEGACY_HOST || candidate.host.endsWith(`.${LEGACY_HOST}`);
    const own = candidate.host === base.host || candidate.host.endsWith(`.${base.host}`);
    const local = candidate.protocol === 'http:' && (candidate.hostname === 'localhost' || candidate.hostname === '127.0.0.1');
    return ((candidate.protocol === 'https:' && (own || legacy)) || local) ? candidate.toString() : fallback;
  } catch (error) { return fallback; }
}

function authStart(url, env) {
  if (!authEnabled(env)) return new Response('auth no configurado', { status: 503 });
  const redirect = `${url.origin}/v1/auth/callback`;
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const returnTo = safeReturnTo(url.searchParams.get('return_to'), env);
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', redirect);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'openid email profile');
  auth.searchParams.set('state', state);
  auth.searchParams.set('nonce', nonce);
  auth.searchParams.set('prompt', 'select_account');
  const headers = new Headers({ location: auth.toString() });
  headers.append('set-cookie', `aa_state=${state}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=None`);
  headers.append('set-cookie', `aa_nonce=${nonce}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=None`);
  headers.append('set-cookie', `aa_return=${encodeURIComponent(returnTo)}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=None`);
  return new Response(null, {
    status: 302,
    headers,
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
  let claims;
  try { claims = await verifyGoogleIdToken(tok.id_token, env.GOOGLE_CLIENT_ID, getCookie(request, 'aa_nonce')); }
  catch (error) {
    console.warn(JSON.stringify({ message: 'google oidc rejected', reason: String(error?.message || error) }));
    return new Response('login falló (verificación)', { status: 502 });
  }

  await env.DB.prepare(
    `INSERT INTO users (provider, provider_id, email, name, picture, created_at)
     VALUES ('google', ?, ?, ?, ?, ?)
     ON CONFLICT (provider, provider_id) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`,
  ).bind(claims.sub, claims.email || null, claims.name || null, claims.picture || null, new Date().toISOString()).run();
  const row = await env.DB.prepare("SELECT id FROM users WHERE provider = 'google' AND provider_id = ?").bind(claims.sub).first();

  const token = await makeToken(env, {
    uid: row.id, name: claims.name || null, pic: claims.picture || null, email: claims.email || null,
    email_verified: claims.email_verified === true,
    exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400,
  });
  let returnTo = siteOrigin(env);
  try { returnTo = safeReturnTo(decodeURIComponent(getCookie(request, 'aa_return') || ''), env); } catch (error) { /* fallback */ }
  const headers = new Headers({ location: returnTo });
  headers.append('set-cookie', sessionCookie(token, SESSION_DAYS * 86400));
  headers.append('set-cookie', 'aa_state=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=None');
  headers.append('set-cookie', 'aa_nonce=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=None');
  headers.append('set-cookie', 'aa_return=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=None');
  return new Response(null, { status: 302, headers });
}

function authLogout(request, env) {
  return credJson({ ok: true }, 200, request, env, { 'set-cookie': sessionCookie('', 0) });
}

async function me(request, env) {
  if (!authEnabled(env)) return credJson({ enabled: false, user: null }, 200, request, env);
  const s = await sessionUser(request, env);
  return credJson({
    enabled: true, user: s ? { name: s.name, email: s.email, pic: s.pic } : null,
    qa: qaSessionAllowed(s, env), qa_configured: qaAllowedEmails(env).size > 0,
  }, 200, request, env);
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
