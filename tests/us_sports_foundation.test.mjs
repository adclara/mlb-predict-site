import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, {
  MARKET_KINDS,
  US_SPORTS,
  compactOtherLiveGames,
  compactUsSportsIngest,
  devigAmericanMoneyline,
  fallbackSportBrain,
  fetchUsSportsScoreboard,
  learningFreshnessDoc,
  sanitizeMarketBlock,
  sanitizeQaMarketRow,
  sanitizeModelPublishEnvelope,
  sanitizeModelPublisherLearning,
  sanitizeSportsSimulation,
  sanitizeUsSportsToday,
  verifyGithubModelPublisher,
  verifyGoogleIdToken,
} from '../cloudflare/worker/index.js';

const base64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

async function signedOidc(overrides = {}) {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  Object.assign(jwk, { kid: 'aa-test-key', alg: 'RS256', use: 'sig' });
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://token.actions.githubusercontent.com', aud: 'aa-sports-model-publisher',
    exp: now + 300, nbf: now - 5, iat: now - 5, jti: 'test-jti-12345678',
    repository: 'adclara/aa-sports-models-private', repository_id: '1309365177',
    repository_owner_id: '71529366', repository_visibility: 'private',
    runner_environment: 'github-hosted', ref: 'refs/heads/main', ref_type: 'branch',
    workflow_ref: 'adclara/aa-sports-models-private/.github/workflows/hourly-shadow.yml@refs/heads/main',
    event_name: 'schedule', sha: 'a'.repeat(40), run_id: '12345', ...overrides,
  };
  const encoded = `${base64url({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })}.${base64url(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(encoded));
  return {
    token: `${encoded}.${Buffer.from(signature).toString('base64url')}`, claims, now,
    fetcher: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }),
  };
}

async function signedGoogle(overrides = {}) {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  Object.assign(jwk, { kid: 'google-test-key', alg: 'RS256', use: 'sig' });
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com', aud: 'google-client-test', azp: 'google-client-test',
    exp: now + 300, iat: now - 5, sub: 'google-user-1', nonce: 'nonce-test',
    email: 'qa@example.com', email_verified: true, ...overrides,
  };
  const encoded = `${base64url({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })}.${base64url(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(encoded));
  return {
    token: `${encoded}.${Buffer.from(signature).toString('base64url')}`, now,
    fetcher: async (url) => String(url).includes('openid-configuration')
      ? new Response(JSON.stringify({ issuer: 'https://accounts.google.com', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs' }), { status: 200 })
      : new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }),
  };
}

async function sessionToken(secret, payload) {
  const body = base64url(payload);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(signature).toString('base64url')}`;
}

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

test('GitHub OIDC publisher verifies signature and immutable workflow identity', async () => {
  const valid = await signedOidc();
  const claims = await verifyGithubModelPublisher(valid.token, valid.fetcher, valid.now * 1000);
  assert.equal(claims.repository_id, '1309365177');
  assert.equal(claims.ref, 'refs/heads/main');

  const wrongRepo = await signedOidc({ repository_id: '999' });
  await assert.rejects(
    verifyGithubModelPublisher(wrongRepo.token, wrongRepo.fetcher, wrongRepo.now * 1000),
    /oidc_repository/,
  );
  const wrongWorkflow = await signedOidc({ workflow_ref: 'adclara/aa-sports-models-private/.github/workflows/weekly-retrain.yml@refs/heads/main' });
  await assert.rejects(
    verifyGithubModelPublisher(wrongWorkflow.token, wrongWorkflow.fetcher, wrongWorkflow.now * 1000),
    /oidc_workflow/,
  );
});

test('Google OIDC verifies signature, audience, nonce and verified email', async () => {
  const valid = await signedGoogle();
  const claims = await verifyGoogleIdToken(valid.token, 'google-client-test', 'nonce-test', valid.fetcher, valid.now * 1000);
  assert.equal(claims.email, 'qa@example.com');
  const wrongAudience = await signedGoogle({ aud: 'attacker-client', azp: 'attacker-client' });
  await assert.rejects(
    verifyGoogleIdToken(wrongAudience.token, 'google-client-test', 'nonce-test', wrongAudience.fetcher, wrongAudience.now * 1000),
    /google_issuer_audience/,
  );
  await assert.rejects(
    verifyGoogleIdToken(valid.token, 'google-client-test', 'wrong-nonce', valid.fetcher, valid.now * 1000),
    /google_nonce/,
  );
});

test('QA row sanitizer exposes measured selections but never storage approval controls', () => {
  const row = sanitizeQaMarketRow({
    date: '2026-08-14', event_id: '401', market_key: 'winner', selection_key: 'winner:model',
    pick: 'PHI', side: 'home', prob: .641, edge: .031, price: -120,
    public_scope: 'public', gate_passed: 1, human_approved: 1, invalidated: 0, coefficients: [1, 2],
  });
  assert.equal(row.prob, .641);
  assert.equal(row.pick, 'PHI');
  assert.equal('public_scope' in row, false);
  assert.equal('human_approved' in row, false);
  assert.equal('coefficients' in row, false);
});

test('OIDC publish envelope can never self-approve a market or a D1 row', () => {
  const openGate = { passed: true, approved: true, public: true, reason: 'passed' };
  const payload = sanitizeModelPublishEnvelope({
    sport: 'nfl',
    learning: {
      gate: openGate, historical: { n: 284, accuracy: .634, brier: .2258 },
      forward: { n: 2, dates: 1, wins: 1, losses: 1, accuracy: .5 },
      learning_es: ['medido'], learning_en: ['measured'], weights: [1, 2, 3],
    },
    simulation: {
      winner: { gate: openGate, forward: { n: 2, dates: 1, accuracy: .5 }, coefficients: [9] },
      total: { gate: openGate, forward: { n: 2, dates: 1 }, projection: 44.1 },
      players: {}, combos: { gate: openGate, forward: { n: 0 } },
    },
    today: {
      date: '2026-09-09', gate: openGate,
      gates: { winner: openGate, total: openGate, players: openGate, combos: openGate },
      samples: { winner: { n: 2, min_forward: 50 } },
      events: [{ event_id: '42', date: '2026-09-09', start: '2026-09-09T20:00:00Z',
        home: { code: 'PHI' }, away: { code: 'DAL' }, prediction: { pick: 'PHI', prob: .91 },
        markets: { winner: { gate: openGate, pick: 'PHI', prob: .91 } } }],
      top2: [{ pick: 'PHI', prob: .91 }],
    },
    market_rows: [{
      date: '2026-09-09', event_id: '42', market_key: 'winner', selection_key: 'winner:model',
      pick: '1', side: 'home', price: -120, market_prob: .53, prob: .64, edge: .11,
      home: 'PHI', away: 'DAL', start_time: '2026-09-09T20:00:00Z',
      feature_as_of: '2026-09-09T18:00:00Z', frozen_at: '2026-09-09T18:00:00Z',
      status: 'frozen', engine_version: 'v2', gate_version: 'g1', updated_at: '2026-09-09T18:01:00Z',
      public_scope: 'public', gate_passed: 1, human_approved: 1,
    }],
  }, new Date('2026-09-09T16:00:00Z'));
  assert.equal(payload.today.markets.winner.state, 'closed');
  assert.equal(payload.today.events[0].prediction, null);
  assert.deepEqual(payload.today.top2, []);
  assert.equal(payload.simulation.winner.gate.public, false);
  assert.equal(payload.learning.gate.approved, false);
  assert.equal('weights' in payload.learning, false);
  assert.equal(payload.market_rows[0].public_scope, 'shadow');
  assert.equal(payload.market_rows[0].gate_passed, 0);
  assert.equal(payload.market_rows[0].human_approved, 0);
});

test('internal publisher is POST-only and rejects missing OIDC before touching storage', async () => {
  const get = await worker.fetch(new Request('https://aa-sports-api.test/v1/internal/model-publish'), {}, { waitUntil() {} });
  assert.equal(get.status, 405);
  const post = await worker.fetch(new Request('https://aa-sports-api.test/v1/internal/model-publish', { method: 'POST', body: '{}' }), {}, { waitUntil() {} });
  assert.equal(post.status, 403);
});

test('internal OIDC publisher writes only sanitized KV and shadow D1 rows', async () => {
  const fixture = await signedOidc();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fixture.fetcher;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const store = new Map(), batches = [];
  const env = {
    ALLOWED_ORIGIN: '*',
    AA_LATEST: {
      async get(key) { return store.get(key) || null; },
      async put(key, value) { store.set(key, value); },
    },
    DB: {
      prepare(sql) { return { bind(...values) { return { sql, values, async run() { return {}; } }; } }; },
      async batch(statements) { batches.push(statements); return []; },
    },
  };
  const openGate = { passed: true, approved: true, public: true };
  const payload = {
    sport: 'nfl',
    learning: { gate: openGate, historical: { n: 284, brier: .2258 }, forward: { n: 2 }, weights: [7] },
    simulation: { winner: { gate: openGate, historical: { n: 284, brier: .2258 }, coefficients: [7] } },
    today: { date: day, gate: openGate, gates: { winner: openGate }, events: [{
      event_id: '401', date: day, start: `${day}T20:00:00Z`, home: { code: 'PHI' }, away: { code: 'DAL' },
      prediction: { pick: 'PHI', prob: .9 }, markets: { winner: { gate: openGate, pick: 'PHI', prob: .9 } },
    }] },
    market_rows: [{
      date: day, event_id: '401', market_key: 'winner', selection_key: 'winner:model',
      pick: '1', side: 'home', prob: .64, market_prob: .53, edge: .11,
      start_time: `${day}T20:00:00Z`, feature_as_of: `${day}T18:00:00Z`, frozen_at: `${day}T18:00:00Z`,
      updated_at: `${day}T18:01:00Z`, engine_version: 'v2', gate_version: 'g1',
      public_scope: 'public', gate_passed: 1, human_approved: 1,
    }],
  };
  const request = () => new Request('https://aa-sports-api.test/v1/internal/model-publish', {
    method: 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  try {
    const response = await worker.fetch(request(), env, { waitUntil() {} });
    assert.equal(response.status, 200, await response.text());
    assert.equal(batches.length, 1);
    assert.ok(batches[0][0].values.includes('shadow'));
    const today = JSON.parse(store.get('nfl:today'));
    assert.equal(today.markets.winner.state, 'closed');
    assert.equal(today.events[0].prediction, null);
    assert.equal('weights' in JSON.parse(store.get('nfl:learning')), false);
    assert.equal('coefficients' in JSON.parse(store.get('nfl:simulation')).winner, false);
    const replay = await worker.fetch(request(), env, { waitUntil() {} });
    assert.equal(replay.status, 409);
  } finally { globalThis.fetch = originalFetch; }
});

test('QA route requires an allowlisted verified session and public route stays fail-closed', async () => {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const today = {
    date: day, updated_at: now.toISOString(), gate: { passed: false, approved: false, public: false },
    samples: { winner: { n: 2, dates: 1, min_forward: 50 } },
    events: [{ event_id: '401', espn_id: '401', date: day, start: `${day}T20:00:00Z`, status: 'pre',
      home: { code: 'PHI', name: 'Philadelphia' }, away: { code: 'DAL', name: 'Dallas' } }],
  };
  const shadowRows = [{
    date: day, event_id: '401', market_key: 'winner', selection_key: 'winner:model',
    pick: '1', side: 'home', prob: .641, market_prob: .61, edge: .031, price: -120,
    home: 'PHI', away: 'DAL', start_time: `${day}T20:00:00Z`, feature_as_of: `${day}T18:00:00Z`,
    frozen_at: `${day}T18:00:00Z`, status: 'frozen', engine_version: 'v2', gate_version: 'g1',
    updated_at: now.toISOString(),
  }];
  const store = new Map([
    ['nfl:today', JSON.stringify(today)],
    ['nfl:learning', JSON.stringify({ sport: 'nfl', gate: { passed: false }, forward: { n: 2, dates: 1 } })],
    ['nfl:simulation', JSON.stringify({ winner: { forward: { n: 2, dates: 1 }, gate: { passed: false } } })],
  ]);
  const env = {
    ALLOWED_ORIGIN: '*', SITE_ORIGIN: 'https://aasport.net',
    GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', AUTH_SECRET: 'auth-secret',
    QA_ALLOWED_EMAILS: 'qa@example.com',
    AA_LATEST: { async get(key) { return store.get(key) || null; } },
    DB: { prepare() { return { bind() { return {
      async all() { return { results: shadowRows }; }, async first() { return null; },
    }; } }; } },
  };
  const unauthenticated = await worker.fetch(new Request('https://api.test/v1/qa/nfl/today'), env, { waitUntil() {} });
  assert.equal(unauthenticated.status, 401);
  const wrongMethod = await worker.fetch(new Request('https://api.test/v1/qa/nfl/today', { method: 'POST' }), env, { waitUntil() {} });
  assert.equal(wrongMethod.status, 405);

  const deniedToken = await sessionToken(env.AUTH_SECRET, {
    uid: 1, email: 'other@example.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 60,
  });
  const denied = await worker.fetch(new Request('https://api.test/v1/qa/nfl/today', {
    headers: { cookie: `aa_sess=${deniedToken}`, origin: 'https://qa.aasport.net' },
  }), env, { waitUntil() {} });
  assert.equal(denied.status, 403);

  const allowedToken = await sessionToken(env.AUTH_SECRET, {
    uid: 1, email: 'qa@example.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 60,
  });
  const qa = await worker.fetch(new Request('https://api.test/v1/qa/nfl/today', {
    headers: { cookie: `aa_sess=${allowedToken}`, origin: 'https://qa.aasport.net' },
  }), env, { waitUntil() {} });
  assert.equal(qa.status, 200);
  const qaBody = await qa.json();
  assert.equal(qaBody.public, false);
  assert.equal(qaBody.events[0].markets.winner.state, 'qa');
  assert.equal(qaBody.events[0].prediction.pick, 'PHI');
  assert.equal(qaBody.events[0].prediction.prob, .641);

  const publicResponse = await worker.fetch(new Request('https://api.test/v1/nfl/today'), env, { waitUntil() {} });
  const publicBody = await publicResponse.json();
  assert.equal(publicBody.events[0].prediction, null);
  assert.equal(publicBody.events[0].markets.winner.state, 'closed');
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

test('WNBA/NFL scoreboard moneylines become factual de-vigged win probabilities while AA stays closed', () => {
  const data = { events: [{
    ...espnEvent('wnba-1'),
    competitions: [{
      ...espnEvent('wnba-1').competitions[0],
      odds: [{
        provider: { name: 'DraftKings' }, overUnder: 186.5,
        moneyline: {
          home: { close: { odds: -325 } },
          away: { close: { odds: 260 } },
        },
      }],
    }],
  }] };
  const games = compactOtherLiveGames(data);
  assert.equal(games[0].market.home_ml, -325);
  assert.equal(games[0].market.away_ml, 260);
  assert.equal(games[0].market.probability_source, 'market_devigged');
  assert.ok(games[0].market.home_prob > .73 && games[0].market.home_prob < .74);
  const probabilities = devigAmericanMoneyline(-325, 260);
  assert.ok(Math.abs(probabilities.home + probabilities.away - 1) < 1e-12);
  assert.ok(probabilities.home > .73 && probabilities.home < .74);
  const publicDoc = sanitizeUsSportsToday(null, 'wnba', games, '2026-09-09');
  assert.equal(publicDoc.events[0].prediction, null);
  assert.equal(publicDoc.events[0].markets.winner.state, 'closed');
  assert.equal(publicDoc.events[0].market.probability_source, 'market_devigged');
  assert.ok(publicDoc.events[0].market.home_prob > .73 && publicDoc.events[0].market.home_prob < .74);
  assert.equal(publicDoc.events[0].market.home_prob + publicDoc.events[0].market.away_prob, 1);
});

test('WNBA player-aware winner uses the D1-supported winner market family', () => {
  const shadow = readFileSync(new URL('../robot/nba_shadow.mjs', import.meta.url), 'utf8');
  const publish = readFileSync(new URL('../robot/wnba_publish_simulation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(shadow, /marketKey:\s*['"]winner_challenger['"]/);
  assert.match(shadow, /marketKey:\s*['"]winner['"],\s*selectionKey:\s*['"]winner:player-aware['"]/);
  assert.match(publish, /market_key='winner' AND selection_key='winner:player-aware'/);
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
