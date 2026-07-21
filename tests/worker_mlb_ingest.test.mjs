import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  compactMlbIngest,
  mlbIngestSlotId,
  mlbIngestStage,
  mlbPipelineHealthDoc,
  runMlbIngest,
} from '../cloudflare/worker/index.js';

const SCHEDULED_TIME = Date.parse('2026-07-21T17:20:00.000Z');
const CAPTURED_TIME = new Date('2026-07-21T17:20:04.000Z');

const statsFixture = {
  dates: [{
    date: '2026-07-21',
    games: [{
      gamePk: 824409,
      gameType: 'R',
      gameDate: '2026-07-21T22:40:00Z',
      status: { abstractGameState: 'Preview', detailedState: 'Scheduled' },
      teams: {
        away: {
          score: 0,
          team: { id: 109, abbreviation: 'ARI' },
          probablePitcher: { id: 701234, fullName: 'Pitcher Away' },
        },
        home: {
          score: 0,
          team: { id: 145, abbreviation: 'CHW' },
          probablePitcher: { id: 705678, fullName: 'Pitcher Home' },
        },
      },
      linescore: {
        currentInning: 0,
        outs: 0,
        teams: { away: { hits: 0, errors: 0 }, home: { hits: 0, errors: 0 } },
      },
      lineups: {
        awayPlayers: [{ id: 101 }, { id: 102 }, { id: 103 }],
        homePlayers: [{ id: 201 }, { id: 202 }, { id: 203 }],
      },
      seriesGameNumber: 2,
      gamesInSeries: 3,
      venue: { id: 4 },
    }],
  }],
};

const espnFixture = {
  events: [{
    id: '401809001',
    date: '2026-07-21T22:40:00Z',
    competitions: [{
      status: { period: 0, type: { state: 'pre', name: 'STATUS_SCHEDULED', shortDetail: '6:40 PM EDT' } },
      competitors: [
        { homeAway: 'home', score: '0', team: { abbreviation: 'CHW' } },
        { homeAway: 'away', score: '0', team: { abbreviation: 'ARI' } },
      ],
      odds: [{
        provider: { name: 'Public Sportsbook' },
        homeTeamOdds: { favorite: true },
        awayTeamOdds: { underdog: true },
        moneyline: {
          home: { close: { odds: '-135' }, open: { odds: '-130' } },
          away: { close: { odds: '+120' }, open: { odds: '+115' } },
        },
        pointSpread: {
          home: { close: { line: '-1.5', odds: '+145' } },
          away: { close: { line: '+1.5', odds: '-165' } },
        },
        total: {
          over: { close: { line: 'o8.5', odds: '-108' }, open: { line: 'o8', odds: '-105' } },
          under: { close: { line: 'u8.5', odds: '-112' }, open: { line: 'u8', odds: '-115' } },
        },
        overUnder: 8.5,
        spread: -1.5,
      }],
    }],
  }],
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fixtureFetch({ statsStatus = 200, espnStatus = 200 } = {}) {
  return async (url) => {
    const value = String(url);
    if (value.includes('statsapi.mlb.com')) return response(statsFixture, statsStatus);
    if (value.includes('site.api.espn.com')) return response(espnFixture, espnStatus);
    throw new Error(`URL inesperada: ${value}`);
  };
}

class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (!/FROM\s+mlb_ingest_slots/i.test(this.sql)) throw new Error('SELECT inesperado');
    return this.db.latest();
  }

  async execute() {
    if (/^\s*INSERT\s+INTO\s+mlb_ingest_slots/i.test(this.sql)) {
      assert.match(this.sql, /ON\s+CONFLICT\s*\(slot_id\)\s+DO\s+NOTHING/i);
      const [
        slot_id, date, scheduled_at, captured_at, status, stage, source_mask, sources,
        source_hash, n_games, missingness, payload, error,
      ] = this.values;
      const next = {
        slot_id, date, scheduled_at, captured_at, status, stage, source_mask, sources,
        source_hash, n_games, missingness, payload, error,
      };
      const previous = this.db.rows.get(slot_id);
      const shouldWrite = !previous;
      if (shouldWrite) this.db.rows.set(slot_id, next);
      return { success: true, meta: { changes: shouldWrite ? 1 : 0 } };
    }
    if (/^\s*DELETE\s+FROM\s+mlb_ingest_slots/i.test(this.sql)) {
      const cutoff = this.values[0];
      let changes = 0;
      for (const [slot, row] of this.db.rows) {
        if (row.scheduled_at < cutoff) {
          this.db.rows.delete(slot);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    throw new Error('DML inesperado');
  }
}

class MockD1 {
  constructor() {
    this.rows = new Map();
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.execute());
    return results;
  }

  latest() {
    return [...this.rows.values()].sort((a, b) => b.slot_id - a.slot_id)[0] || null;
  }
}

test('compacta y une StatsAPI + ESPN sin filtrar lógica privada', () => {
  const compact = compactMlbIngest(statsFixture, espnFixture, '2026-07-21');
  assert.equal(compact.games.length, 1);
  const game = compact.games[0];
  assert.equal(game.mlb_id, '824409');
  assert.equal(game.espn_id, '401809001');
  assert.equal(game.home.code, 'CWS');
  assert.equal(game.away.code, 'AZ');
  assert.equal(game.home.pitcher_id, 705678);
  assert.deepEqual(game.away.lineup, [101, 102, 103]);
  assert.deepEqual(game.market, {
    provider: 'Public Sportsbook',
    home_ml: -135,
    away_ml: 120,
    home_ml_open: -130,
    away_ml_open: 115,
    total: 8.5,
    spread: -1.5,
    over_price: -108,
    under_price: -112,
    total_open: 8,
    over_price_open: -105,
    under_price_open: -115,
    home_spread: -1.5,
    away_spread: 1.5,
    home_spread_price: 145,
    away_spread_price: -165,
  });
  assert.deepEqual(compact.missingness, {
    games: 1,
    pitchers_missing: 0,
    pitchers_total: 2,
    lineups_missing: 0,
    lineups_total: 2,
    market_missing: 0,
    mlb_unmatched: 0,
    espn_unmatched: 0,
  });
  const serialized = JSON.stringify(compact);
  assert.ok(serialized.length < 3000, `payload dejó de ser compacto: ${serialized.length} bytes`);
  assert.doesNotMatch(serialized, /prediction|prob_v2|formula_version|model_weight/i);

  assert.equal(mlbIngestStage(compact.games, SCHEDULED_TIME), 'early');
  assert.equal(mlbIngestStage(compact.games, Date.parse('2026-07-21T20:00:00Z')), 'pregame');
  assert.equal(mlbIngestStage([{ ...game, status: 'live' }], SCHEDULED_TIME), 'live');
  assert.equal(mlbIngestStage([{ ...game, status: 'final', espn_status: 'final' }], SCHEDULED_TIME), 'final');
});

test('un slot de 20 minutos es idempotente en D1', async () => {
  const DB = new MockD1();
  const options = {
    scheduledTime: SCHEDULED_TIME,
    now: CAPTURED_TIME,
    fetcher: fixtureFetch(),
  };
  const first = await runMlbIngest({ DB }, options);
  const second = await runMlbIngest({ DB }, options);

  assert.equal(mlbIngestSlotId(SCHEDULED_TIME), Math.floor(SCHEDULED_TIME / (20 * 60 * 1000)));
  assert.equal(DB.rows.size, 1);
  assert.equal(first.status, 'ok');
  assert.equal(first.stage, 'early');
  assert.equal(first.source_mask, 3);
  assert.equal(first.inserted_or_updated, 1);
  assert.equal(second.inserted_or_updated, 0);
  assert.equal(first.source_hash, second.source_hash);
  assert.equal(JSON.parse(DB.latest().payload).games.length, 1);
});

test('un retry parcial nunca reemplaza un slot completo', async () => {
  const DB = new MockD1();
  const base = { scheduledTime: SCHEDULED_TIME, now: CAPTURED_TIME };
  const complete = await runMlbIngest({ DB }, { ...base, fetcher: fixtureFetch() });
  const retry = await runMlbIngest({ DB }, {
    ...base,
    now: new Date(CAPTURED_TIME.getTime() + 30_000),
    fetcher: fixtureFetch({ statsStatus: 503 }),
  });

  assert.equal(complete.status, 'ok');
  assert.equal(retry.status, 'partial');
  assert.equal(retry.inserted_or_updated, 0);
  assert.equal(DB.rows.size, 1);
  assert.equal(DB.latest().status, 'ok');
  assert.equal(DB.latest().source_mask, 3);
  assert.equal(DB.latest().source_hash, complete.source_hash);
});

test('un retry completo tampoco reescribe una captura parcial más temprana', async () => {
  const DB = new MockD1();
  const base = { scheduledTime: SCHEDULED_TIME };
  const early = await runMlbIngest({ DB }, {
    ...base,
    now: CAPTURED_TIME,
    fetcher: fixtureFetch({ statsStatus: 503 }),
  });
  const retry = await runMlbIngest({ DB }, {
    ...base,
    now: new Date(CAPTURED_TIME.getTime() + 30_000),
    fetcher: fixtureFetch(),
  });

  assert.equal(early.status, 'partial');
  assert.equal(early.inserted_or_updated, 1);
  assert.equal(retry.status, 'ok');
  assert.equal(retry.inserted_or_updated, 0);
  assert.equal(DB.rows.size, 1);
  assert.equal(DB.latest().captured_at, CAPTURED_TIME.toISOString());
  assert.equal(DB.latest().status, 'partial');
  assert.equal(DB.latest().source_mask, 1);
  assert.equal(DB.latest().source_hash, early.source_hash);
});

test('una fuente caída guarda captura parcial observable y no destruye el slot', async () => {
  const DB = new MockD1();
  const report = await runMlbIngest({ DB }, {
    scheduledTime: SCHEDULED_TIME,
    now: CAPTURED_TIME,
    fetcher: fixtureFetch({ statsStatus: 503 }),
  });

  assert.equal(report.status, 'partial');
  assert.equal(report.source_mask, 1);
  assert.equal(report.n_games, 1);
  assert.equal(DB.rows.size, 1);
  const row = DB.latest();
  assert.equal(row.status, 'partial');
  assert.match(JSON.parse(row.error).mlb, /http_503/);
  assert.equal(JSON.parse(row.payload).games[0].mlb_id, null);
});

test('una caída total se persiste como error sin lanzar', async () => {
  const DB = new MockD1();
  const report = await runMlbIngest({ DB }, {
    scheduledTime: SCHEDULED_TIME,
    now: CAPTURED_TIME,
    fetcher: fixtureFetch({ statsStatus: 503, espnStatus: 502 }),
  });

  assert.equal(report.status, 'error');
  assert.equal(report.source_mask, 0);
  assert.equal(report.n_games, 0);
  assert.equal(DB.rows.size, 1);
  const row = DB.latest();
  assert.equal(row.status, 'error');
  assert.equal(row.stage, 'early');
  assert.deepEqual(JSON.parse(row.error), { mlb: 'http_503', espn: 'http_502' });
});

test('pipeline-health publica frescura y missingness con caché corta', async () => {
  const DB = new MockD1();
  await runMlbIngest({ DB }, {
    scheduledTime: SCHEDULED_TIME,
    now: CAPTURED_TIME,
    fetcher: fixtureFetch(),
  });

  const direct = mlbPipelineHealthDoc(DB.latest(), CAPTURED_TIME.getTime() + 10 * 60 * 1000);
  assert.equal(direct.ok, true);
  assert.equal(direct.fresh, true);
  assert.equal(direct.age_seconds, 600);
  assert.equal(direct.latest.stage, 'early');
  assert.equal(direct.latest.missingness.games, 1);
  const stale = mlbPipelineHealthDoc(DB.latest(), CAPTURED_TIME.getTime() + 46 * 60 * 1000);
  assert.equal(stale.ok, false);
  assert.equal(stale.fresh, false);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.latest.status, 'ok');

  const originalNow = Date.now;
  Date.now = () => CAPTURED_TIME.getTime() + 10 * 60 * 1000;
  try {
    const result = await worker.fetch(
      new Request('https://aa-sports-api.test/v1/mlb/pipeline-health'),
      { DB, ALLOWED_ORIGIN: '*' },
      { waitUntil() {} },
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'public, max-age=30');
    const body = await result.json();
    assert.equal(body.ok, true);
    assert.equal(body.latest.n_games, 1);

    const blocked = await worker.fetch(
      new Request('https://aa-sports-api.test/__scheduled?cron=*/20+*+*+*+*'),
      { DB, ALLOWED_ORIGIN: '*' },
      { waitUntil() {} },
    );
    assert.equal(blocked.status, 404);
  } finally {
    Date.now = originalNow;
  }
});

test('scheduled enruta únicamente el cron de 20 minutos al ingestor MLB', async () => {
  const DB = new MockD1();
  const originalFetch = globalThis.fetch;
  let pending = null;
  globalThis.fetch = fixtureFetch();
  try {
    await worker.scheduled(
      { cron: '*/20 * * * *', scheduledTime: SCHEDULED_TIME },
      { DB },
      { waitUntil(value) { pending = value; } },
    );
    assert.ok(pending instanceof Promise);
    await pending;
    assert.equal(DB.rows.size, 1);
    assert.equal(DB.latest().status, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const etToday = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

test('/v1/mlb/today reemplaza un KV viejo por el calendario real pendiente de hoy', async () => {
  const date = etToday();
  const old = JSON.stringify({
    sport: 'mlb', date: '2000-01-01', record: { wins: 18, losses: 18 },
    events: [{ event_id: 'old-final', status: 'final' }],
  });
  const schedule = structuredClone(statsFixture);
  schedule.dates[0].date = date;
  schedule.dates[0].games[0].gameDate = `${date}T22:40:00Z`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), new RegExp(`date=${date}`));
    return response(schedule);
  };
  try {
    const result = await worker.fetch(
      new Request('https://aa-sports-api.test/v1/mlb/today'),
      { AA_LATEST: { async get(key) { assert.equal(key, 'mlb:today'); return old; } }, ALLOWED_ORIGIN: '*' },
      { waitUntil() {} },
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'public, max-age=120');
    const body = await result.json();
    assert.equal(body.date, date);
    assert.equal(body.source, 'statsapi-fallback');
    assert.equal(body.pending, true);
    assert.deepEqual(body.record, { wins: 18, losses: 18 });
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].event_id, '824409');
    assert.equal(body.events[0].prediction, null);
    assert.equal(body.events[0].pending, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/v1/mlb/today no deja que un KV futuro/manual desplace el calendario de hoy', async () => {
  const date = etToday();
  const future = JSON.stringify({
    sport: 'mlb', date: '2999-12-31', record: { wins: 18, losses: 18 },
    events: [{ event_id: 'future-manual', status: 'pre' }],
  });
  const schedule = structuredClone(statsFixture);
  schedule.dates[0].date = date;
  schedule.dates[0].games[0].gameDate = `${date}T22:40:00Z`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response(schedule);
  try {
    const result = await worker.fetch(
      new Request('https://aa-sports-api.test/v1/mlb/today'),
      { AA_LATEST: { async get() { return future; } }, ALLOWED_ORIGIN: '*' },
      { waitUntil() {} },
    );
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.date, date);
    assert.equal(body.source, 'statsapi-fallback');
    assert.equal(body.events[0].event_id, '824409');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/v1/mlb/today degrada al blob anterior si StatsAPI falla, sin responder 500', async () => {
  const old = JSON.stringify({
    sport: 'mlb', date: '2000-01-01', record: { wins: 18, losses: 18 },
    events: [{ event_id: 'old-final', status: 'final' }],
  });
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = async () => response({ error: 'down' }, 503);
  console.error = () => {};
  try {
    const result = await worker.fetch(
      new Request('https://aa-sports-api.test/v1/mlb/today'),
      { AA_LATEST: { async get() { return old; } }, ALLOWED_ORIGIN: '*' },
      { waitUntil() {} },
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'public, max-age=30');
    assert.deepEqual(await result.json(), JSON.parse(old));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
