import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  MARKET_KINDS,
  US_SPORTS,
  compactUsSportsIngest,
  fallbackSportBrain,
  fetchUsSportsScoreboard,
  learningFreshnessDoc,
  sanitizeMarketBlock,
  sanitizeSportsSimulation,
  sanitizeUsSportsToday,
} from '../cloudflare/worker/index.js';

const espnEvent = (id = '42') => ({
  id,
  date: '2026-09-09T20:20:00Z',
  competitions: [{
    neutralSite: false,
    status: { period: 0, type: { state: 'pre', name: 'STATUS_SCHEDULED', shortDetail: '9/9 - 4:20 PM' } },
    competitors: [
      { homeAway: 'home', team: { id: '1', abbreviation: 'PHI', displayName: 'Philadelphia Eagles' }, records: [{ summary: '0-0' }] },
      { homeAway: 'away', team: { id: '2', abbreviation: 'DAL', displayName: 'Dallas Cowboys' }, records: [{ summary: '0-0' }] },
    ],
    odds: [{
      provider: { name: 'Example book' }, overUnder: 47.5,
      homeTeamOdds: { moneyLine: -130 }, awayTeamOdds: { moneyLine: 110 },
    }],
  }],
});

test('the four supported sports have complete public feed contracts', () => {
  assert.deepEqual(Object.keys(US_SPORTS).sort(), ['ncaaf', 'ncaam', 'nfl', 'nhl']);
  for (const config of Object.values(US_SPORTS)) {
    assert.ok(config.scoreboard);
    assert.match(config.standings, /^https:\/\//);
    assert.ok(config.summary);
  }
});

test('public ingestion keeps factual teams, schedule and real market only', () => {
  const result = compactUsSportsIngest({ events: [espnEvent()] }, 'nfl', '2026-09-09');
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].home.code, 'PHI');
  assert.equal(result.games[0].away.code, 'DAL');
  assert.equal(result.games[0].market.total, 47.5);
  assert.equal(result.games[0].market.home_ml, -130);
  assert.equal('prob' in result.games[0], false);
  assert.equal('prediction' in result.games[0], false);
  assert.equal(result.missingness.market_missing, 0);
});

test('ingestion rejects unsupported sports and off-date events', () => {
  assert.throws(() => compactUsSportsIngest({ events: [] }, 'fcs', '2026-09-09'));
  const result = compactUsSportsIngest({ events: [espnEvent()] }, 'nfl', '2026-09-10');
  assert.equal(result.games.length, 0);
});

test('US sports ingestion falls back after a transient ESPN 403', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    if (String(url).includes('site.api.espn.com')) return new Response('{}', { status: 403 });
    return new Response(JSON.stringify({ events: [espnEvent()] }), { status: 200 });
  };
  const result = await fetchUsSportsScoreboard(US_SPORTS.nfl, '2026-09-09', fetcher, 1000);
  assert.equal(result.source, 'espn_web');
  assert.equal(result.data.events.length, 1);
  assert.equal(calls.length, 2);
});

test('US sports ingestion reports both ESPN failures', async () => {
  const fetcher = async () => new Response('{}', { status: 403 });
  await assert.rejects(
    fetchUsSportsScoreboard(US_SPORTS.nfl, '2026-09-09', fetcher, 1000),
    /espn_site:http_403;espn_web:http_403/,
  );
});

test('US sports live route retries the alternate ESPN host', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const calls = [];
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('site.api.espn.com')) return new Response('{}', { status: 403 });
    return new Response(JSON.stringify({ events: [] }), { status: 200 });
  };
  try {
    const response = await worker.fetch(
      new Request('https://aa-sports-api.test/v1/nfl/live'),
      { ALLOWED_ORIGIN: '*' }, { waitUntil() {} },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.games, []);
    assert.equal(body.note, undefined);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /site\.web\.api\.espn\.com/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test('today projection fails closed until all three gate flags are true', () => {
  const premature = sanitizeUsSportsToday({
    gate: { passed: true, approved: false, public: false },
    events: [{ event_id: '42', prediction: { pick: 'PHI', prob: 0.91 } }],
    top2: [{ pick: 'PHI', prob: 0.91 }],
    record: { wins: 10, losses: 0 },
  }, 'nfl', [], '2026-09-09');
  assert.equal(premature.events[0].prediction, null);
  assert.deepEqual(premature.top2, []);
  assert.equal(premature.record, null);
  assert.equal(premature.training, true);

  const publicDoc = sanitizeUsSportsToday({
    gate: { passed: true, approved: true, public: true },
    events: [{ event_id: '42', prediction: { pick: 'PHI', prob: 0.61 } }],
    top2: [{ pick: 'PHI', prob: 0.61 }, { pick: 'under', line: 47.5, prob: 0.58 }, { pick: 'extra', prob: 0.99 }],
  }, 'nfl', [], '2026-09-09');
  assert.equal(publicDoc.events[0].prediction.prob, 0.61);
  assert.equal(publicDoc.top2.length, 2);
  assert.equal(publicDoc.training, false);
});

test('all four markets sanitize independently and never leak private model fields', () => {
  assert.deepEqual(MARKET_KINDS, ['winner', 'total', 'players', 'combos']);
  const safe = sanitizeUsSportsToday({
    gate: { passed: false, approved: false, public: false, reason: 'forward_sample_pending' },
    samples: { winner: { n: 12, dates: 6, min_forward: 50 }, total: { n: 7, min_forward: 200 } },
    events: [{
      event_id: '99', home: { code: 'PHI' }, away: { code: 'DAL' },
      features: [1, 2, 3], weights: { secret: 9 }, prediction: { pick: 'PHI', prob: 0.92 },
      markets: {
        total: { gate: { passed: true, approved: false, public: false }, pick: 'over', line: 47.5, prob: 0.71 },
        players: { gate: { passed: false, approved: false, public: false }, items: [{ player_name: 'Private', line: 250.5, prob: 0.9 }] },
      },
    }],
  }, 'nfl', [], '2026-09-09');
  const event = safe.events[0];
  assert.equal(event.prediction, null);
  assert.equal('features' in event, false);
  assert.equal('weights' in event, false);
  for (const kind of MARKET_KINDS) assert.equal(event.markets[kind].state, 'closed');
  assert.equal(event.markets.total.line, undefined);
  assert.equal(event.markets.players.items, undefined);
  assert.equal(event.markets.winner.sample.n, 12);
});

test('factual scoreboard remains authoritative while private market envelopes merge by event id', () => {
  const safe = sanitizeUsSportsToday({
    gate: { passed: false, approved: false, public: false, reason: 'forward_sample_pending' },
    events: [{ event_id: '42', home: { code: 'SECRET' }, markets: {
      total: { state: 'closed', gate: { passed: false, approved: false, public: false, reason: 'market_lines_unavailable' }, sample: { n: 9, min_forward: 200 }, projection: 51.2 },
    } }],
  }, 'nfl', [{
    espn_id: '42', status: 'live', home: { code: 'PHI', score: 21 }, away: { code: 'DAL', score: 17 },
  }], '2026-09-09');
  assert.equal(safe.events[0].home.code, 'PHI');
  assert.equal(safe.events[0].home.score, 21);
  assert.equal(safe.events[0].markets.total.sample.n, 9);
  assert.equal(safe.events[0].markets.total.projection, undefined);
});

test('today never serves a stale private slate as the current ET date', () => {
  const safe = sanitizeUsSportsToday({
    sport: 'wnba', date: '2026-09-08', updated_at: '2026-09-08T12:00:00Z',
    gate: { passed: true, approved: true, public: true },
    events: [{ event_id: 'old', start: '2026-09-08T20:00:00Z', prediction: { pick: 'OLD', prob: 0.99 } }],
    top2: [{ pick: 'OLD', prob: 0.99 }],
  }, 'wnba', [], '2026-09-09');
  assert.equal(safe.date, '2026-09-09');
  assert.deepEqual(safe.events, []);
  assert.deepEqual(safe.top2, []);
  assert.equal(safe.training, true);
});

test('a market is public only with passed, approved and public together', () => {
  const closed = sanitizeMarketBlock({
    gate: { passed: true, approved: false, public: true }, pick: 'over', line: 161.5, prob: 0.61,
  }, null, { n: 199 }, 'total');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.pick, undefined);
  assert.equal(closed.line, undefined);

  const open = sanitizeMarketBlock({
    gate: { passed: true, approved: true, public: true },
    items: [{ selection_key: 'pts:7', player_name: 'Measured Player', pick: 'over', line: 19.5, prob: 0.57 }],
  }, null, { n: 212, dates: 44 }, 'players');
  assert.equal(open.state, 'public');
  assert.equal(open.items[0].player_name, 'Measured Player');
  assert.equal(open.items[0].line, 19.5);
});

test('simulation sanitizer exposes metrics and strips model parameters and projections', () => {
  const doc = sanitizeSportsSimulation({
    generated_at: '2026-08-13T12:00:00Z', seasons: ['2022', '2023', '2024', '2025', '2026'],
    total: {
      model: 'private', selected_lambda: 30, coefficients: [1, 2],
      historical: { n: 1091, mae: 14.559, secret_loss: 99 }, forward: { n: 0, dates: 0 },
      gate: { passed: false, approved: false, public: false, reason: 'market_lines_unavailable' },
    },
    players: { completions: { historical: { n: 1910, mae: 5.51 }, selected_lambda: 3, forward: { n: 0 } } },
  }, 'wnba');
  assert.equal(doc.total.historical.n, 1091);
  assert.equal(doc.total.historical.mae, 14.559);
  assert.equal('model' in doc.total, false);
  assert.equal('selected_lambda' in doc.total, false);
  assert.equal('coefficients' in doc.total, false);
  assert.equal('secret_loss' in doc.total.historical, false);
  assert.equal(doc.players.completions.historical.n, 1910);
  assert.equal('selected_lambda' in doc.players.completions, false);
});

test('WNBA exposes today/history/simulation/pipeline-health routes fail-closed', async () => {
  const originalFetch = globalThis.fetch;
  const currentEvent = espnEvent('77'); currentEvent.date = new Date().toISOString();
  globalThis.fetch = async () => new Response(JSON.stringify({ events: [currentEvent] }), { status: 200 });
  const env = {
    ALLOWED_ORIGIN: '*',
    AA_LATEST: { async get(key) { return key === 'wnba:simulation' ? JSON.stringify({ sport: 'wnba', state: 'training' }) : null; } },
    DB: {
      prepare(sql) {
        return {
          bind() {
            if (/sport_market_predictions/.test(sql)) return { async all() { return { results: [] }; } };
            if (/FROM predictions/.test(sql)) return { async first() { return { n: 0, graded: 0, updated_at: null }; } };
            throw new Error(`unexpected SQL: ${sql}`);
          },
        };
      },
    },
  };
  try {
    const today = await worker.fetch(new Request('https://aa-sports-api.test/v1/wnba/today'), env, { waitUntil() {} });
    const todayDoc = await today.json();
    assert.equal(today.status, 200);
    assert.equal(todayDoc.events.length, 1);
    assert.equal(todayDoc.events[0].prediction, null);
    assert.equal(todayDoc.events[0].markets.players.state, 'closed');

    for (const route of ['history', 'simulation', 'pipeline-health']) {
      const response = await worker.fetch(new Request(`https://aa-sports-api.test/v1/wnba/${route}`), env, { waitUntil() {} });
      assert.equal(response.status, 200, route);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('fallback Cerebro exposes only measured aggregate and keeps the gate closed', () => {
  const doc = fallbackSportBrain('wnba', { n: 12, dates: 6, wins: 7, losses: 5, market_n: 4, updated_at: '2026-08-13T20:00:00Z' });
  assert.equal(doc.forward.n, 12);
  assert.equal(doc.forward.accuracy, 7 / 12);
  assert.equal(doc.gate.public, false);
  assert.equal(doc.gate.min_forward, 200);
  assert.equal('predictions' in doc, false);
});

test('learning freshness detects a green-but-stale snapshot', () => {
  const now = Date.parse('2026-08-14T12:00:00Z');
  assert.equal(learningFreshnessDoc({ updated_at: '2026-08-14T01:00:00Z' }, now).fresh, true);
  const stale = learningFreshnessDoc({ updated_at: '2026-07-21T21:04:38Z', last_date: '2026-07-04' }, now);
  assert.equal(stale.fresh, false);
  assert.equal(stale.last_date, '2026-07-04');
});

test('WNBA learning route works before the first KV publication and stays fail-closed', async () => {
  const env = {
    ALLOWED_ORIGIN: '*',
    AA_LATEST: { async get() { return null; } },
    DB: {
      prepare(sql) {
        assert.match(sql, /FROM predictions/);
        return { bind(sport) { assert.equal(sport, 'wnba'); return { async first() { return { n: 0, dates: 0, wins: 0, losses: 0, market_n: 0, updated_at: null }; } }; } };
      },
    },
  };
  const response = await worker.fetch(new Request('https://aa-sports-api.test/v1/wnba/learning'), env, { waitUntil() {} });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.sport, 'wnba');
  assert.equal(body.state, 'training');
  assert.equal(body.gate.public, false);
});

test('every public sport exposes a Cerebro route without exposing picks', async () => {
  const sports = ['soccer', 'nba', 'wnba', 'tennis', 'nfl', 'ncaaf', 'nhl', 'ncaam'];
  for (const sport of sports) {
    const env = {
      ALLOWED_ORIGIN: '*',
      AA_LATEST: {
        async get(key) {
          assert.equal(key, `${sport}:learning`);
          return JSON.stringify({ schema: 'aa_sport_learning_v1', sport, state: 'training', gate: { public: false } });
        },
      },
      DB: { prepare() { throw new Error('D1 fallback should not run when KV exists'); } },
    };
    const response = await worker.fetch(new Request(`https://aa-sports-api.test/v1/${sport}/learning`), env, { waitUntil() {} });
    const body = await response.json();
    assert.equal(response.status, 200, sport);
    assert.equal(body.sport, sport);
    assert.equal(body.gate.public, false);
    assert.equal('predictions' in body, false);
  }
});
