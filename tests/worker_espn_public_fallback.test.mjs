import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { fetchEspnPublicResponse } from '../cloudflare/worker/index.js';

const etToday = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const scoreboard = (sport = 'mlb') => ({
  events: [{
    id: `${sport}-1`, date: `${etToday()}T16:00:00Z`,
    competitions: [{
      status: { period: 1, type: { name: 'STATUS_IN_PROGRESS', shortDetail: 'Top 1st' } },
      competitors: [
        { homeAway: 'home', score: '1', team: { abbreviation: 'HME', shortDisplayName: 'Home' }, records: [{ summary: '1-0' }] },
        { homeAway: 'away', score: '0', team: { abbreviation: 'AWY', shortDisplayName: 'Away' }, records: [{ summary: '0-1' }] },
      ],
    }],
  }],
});

const standingsFixture = {
  season: { displayName: '2026' },
  children: [{
    name: 'East',
    standings: {
      entries: [{
        team: { abbreviation: 'HME', shortDisplayName: 'Home' },
        stats: [
          { name: 'rank', value: 1 }, { name: 'gamesPlayed', value: 10 },
          { name: 'wins', value: 7 }, { name: 'losses', value: 3 },
        ],
      }],
    },
  }],
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withWorkerMocks(fetcher, callback) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cacheWrites = [];
  globalThis.fetch = fetcher;
  globalThis.caches = {
    default: {
      async match() { return null; },
      async put(key, value) { cacheWrites.push({ key, value }); },
    },
  };
  try {
    return await callback(cacheWrites);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
}

test('public ESPN fetch retries the alternate host after a 403', async () => {
  const calls = [];
  const fetched = await fetchEspnPublicResponse('https://site.api.espn.com/example', {
    fetcher: async (url) => {
      calls.push(String(url));
      return String(url).includes('site.web.api') ? response({ ok: true }) : response({}, 403);
    },
  });
  assert.equal(fetched.source, 'espn_web');
  assert.deepEqual(await fetched.response.json(), { ok: true });
  assert.equal(calls.length, 2);
});

test('MLB live uses the alternate host and caches only the valid payload', async () => {
  const calls = [];
  await withWorkerMocks(async (url) => {
    calls.push(String(url));
    if (String(url).includes('site.api.espn.com')) return response({}, 403);
    if (String(url).includes('/summary?')) return response({ winprobability: [] });
    return response(scoreboard());
  }, async (cacheWrites) => {
    const result = await worker.fetch(
      new Request('https://aa-sports-api.test/v1/mlb/live'), {}, { waitUntil(value) { return value; } },
    );
    const body = await result.json();
    assert.equal(body.note, undefined);
    assert.equal(body.source, 'espn_web');
    assert.equal(body.games.length, 1);
    assert.equal(cacheWrites.length, 1);
    assert.match(calls[1], /site\.web\.api\.espn\.com/);
  });
});

test('generic live routes derive the alternate host automatically', async () => {
  await withWorkerMocks(async (url) => (
    String(url).includes('site.web.api') ? response(scoreboard('nba')) : response({}, 403)
  ), async () => {
    const result = await worker.fetch(
      new Request('https://aa-sports-api.test/v1/nba/live'), {}, { waitUntil(value) { return value; } },
    );
    const body = await result.json();
    assert.equal(body.note, undefined);
    assert.equal(body.source, 'espn_web');
    assert.equal(body.games.length, 1);
  });
});

test('standings retries both ESPN hosts and preserves real sections', async () => {
  const calls = [];
  await withWorkerMocks(async (url) => {
    calls.push(String(url));
    return String(url).includes('site.web.api') ? response(standingsFixture) : response({}, 403);
  }, async (cacheWrites) => {
    const result = await worker.fetch(
      new Request('https://aa-sports-api.test/v1/mlb/standings'), {}, { waitUntil(value) { return value; } },
    );
    const body = await result.json();
    assert.equal(body.note, undefined);
    assert.equal(body.source, 'espn_web');
    assert.equal(body.sections.length, 1);
    assert.equal(body.sections[0].rows[0].code, 'HME');
    assert.equal(cacheWrites.length, 1);
    assert.ok(calls.some((url) => url.includes('site.web.api.espn.com')));
  });
});

test('a total ESPN outage stays fail-closed and is never cached as an empty slate', async () => {
  await withWorkerMocks(async () => response({}, 503), async (cacheWrites) => {
    const result = await worker.fetch(
      new Request('https://aa-sports-api.test/v1/mlb/live'), {}, { waitUntil(value) { return value; } },
    );
    const body = await result.json();
    assert.deepEqual(body.games, []);
    assert.match(body.note, /espn_site:http_503;espn_web:http_503/);
    assert.equal(cacheWrites.length, 0);
  });
});
