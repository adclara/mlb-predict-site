import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../cloudflare/worker/index.js';

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

const isRange = (url) => /dates=\d{8}-\d{8}/.test(url);
const dayOf = (url) => (String(url).match(/dates=(\d{8})/) || [])[1];

// Dos finales por día más un juego programado que el mapeo debe descartar.
const dayScoreboard = (ymd) => {
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const game = (id, status, detail) => ({
    id: `${ymd}-${id}`, date: `${iso}T23:00:00Z`,
    competitions: [{
      status: { type: { name: status, shortDetail: detail } },
      competitors: [
        { homeAway: 'home', score: '90', winner: true, team: { abbreviation: 'HME', shortDisplayName: 'Home' } },
        { homeAway: 'away', score: '80', team: { abbreviation: 'AWY', shortDisplayName: 'Away' } },
      ],
    }],
  });
  return {
    events: [
      game('a', 'STATUS_FINAL', 'Final'),
      game('b', 'STATUS_FINAL', 'Final'),
      game('c', 'STATUS_SCHEDULED', 'Scheduled'),
    ],
  };
};

const fetchRecent = () => worker.fetch(
  new Request('https://aa-sports-api.test/v1/wnba/recent'), {}, { waitUntil(value) { return value; } },
);

test('recent falls back day by day when the date range is rejected', async () => {
  await withWorkerMocks(async (url) => {
    if (String(url).includes('site.api.espn.com')) return response({}, 403);
    if (isRange(url)) return response({}, 400);
    return response(dayScoreboard(dayOf(url)));
  }, async (cacheWrites) => {
    const result = await fetchRecent();
    const body = await result.json();
    assert.equal(body.note, undefined);
    assert.equal(body.source, 'espn_web:by_day');
    assert.equal(body.games.length, 30);
    assert.ok(body.games.every((g) => g.status === 'final'));
    const starts = body.games.map((g) => String(g.start));
    assert.deepEqual(starts, [...starts].sort().reverse());
    assert.equal(cacheWrites.length, 1);
  });
});

test('recent stays fail-closed when the range and every day fail', async () => {
  await withWorkerMocks(async (url) => (
    String(url).includes('site.api.espn.com') ? response({}, 403) : response({}, 400)
  ), async (cacheWrites) => {
    const result = await fetchRecent();
    const body = await result.json();
    assert.deepEqual(body.games, []);
    assert.match(body.note, /recent upstream espn_site:http_403;espn_web:http_400/);
    assert.equal(cacheWrites.length, 0);
  });
});

test('the day-by-day fallback stops calling a host after 2 failures', async () => {
  const calls = [];
  await withWorkerMocks(async (url) => {
    calls.push(String(url));
    if (String(url).includes('site.api.espn.com')) return response({}, 403);
    if (isRange(url)) return response({}, 400);
    return response(dayScoreboard(dayOf(url)));
  }, async () => {
    const result = await fetchRecent();
    const body = await result.json();
    assert.equal(body.games.length, 30);
    // 1 intento del rango + 2 días del fallback; después el host queda descartado.
    const siteCalls = calls.filter((url) => url.includes('site.api.espn.com'));
    assert.equal(siteCalls.length, 3);
    const dayCalls = calls.filter((url) => !isRange(url));
    assert.ok(dayCalls.some((url) => url.includes('site.web.api.espn.com')));
  });
});

test('a healthy range never uses the day-by-day fallback', async () => {
  const calls = [];
  await withWorkerMocks(async (url) => {
    calls.push(String(url));
    return response({
      events: [{
        id: 'range-1', date: '2026-08-10T23:00:00Z',
        competitions: [{
          status: { type: { name: 'STATUS_FINAL', shortDetail: 'Final' } },
          competitors: [
            { homeAway: 'home', score: '90', winner: true, team: { abbreviation: 'HME', shortDisplayName: 'Home' } },
            { homeAway: 'away', score: '80', team: { abbreviation: 'AWY', shortDisplayName: 'Away' } },
          ],
        }],
      }],
    });
  }, async () => {
    const result = await fetchRecent();
    const body = await result.json();
    assert.equal(body.note, undefined);
    assert.equal(body.source, 'espn_site');
    assert.equal(body.games.length, 1);
    assert.equal(calls.length, 1);
    assert.ok(calls.every((url) => isRange(url)));
    assert.ok(calls.every((url) => !url.includes('limit=100')));
  });
});
