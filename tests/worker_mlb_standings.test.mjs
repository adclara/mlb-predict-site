import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker/index.js';
import { mlbStandingsRequest, parseMlbStandings } from '../cloudflare/lib/mlb_standings.mjs';

const entry = (code, wins, losses, seed, pct = wins / (wins + losses)) => ({
  team: { abbreviation: code, shortDisplayName: code },
  stats: [
    { name: 'wins', value: wins, displayValue: String(wins) },
    { name: 'losses', value: losses, displayValue: String(losses) },
    { name: 'winPercent', value: pct, displayValue: Number(pct).toFixed(3) },
    ...(seed == null ? [] : [{ name: 'playoffSeed', value: seed }]),
  ],
});
const fixture = (season, entries, name = 'American League West') => ({
  season: { year: season, displayName: String(season) },
  children: [{ name, standings: { entries } }],
});
const currentSeason = () => mlbStandingsRequest().season;

async function withMocks(fetcher, callback) {
  const oldFetch = globalThis.fetch, oldCaches = globalThis.caches;
  const writes = [], reads = [], calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(await fetcher(new URL(url))), {
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.caches = { default: {
    async match(key) { reads.push(key.url); return null; },
    async put(key, value) { writes.push({ key: key.url, body: await value.text() }); },
  } };
  const pending = [];
  const request = async (sport = 'mlb') => {
    const response = await worker.fetch(new Request(`https://aa-sports-api.test/v1/${sport}/standings`), {}, {
      waitUntil(value) { pending.push(value); },
    });
    await Promise.all(pending);
    return { status: response.status, body: await response.json() };
  };
  try { await callback({ request, writes, reads, calls }); }
  finally { globalThis.fetch = oldFetch; globalThis.caches = oldCaches; }
}

test('MLB requests and cache namespace use the ET year across UTC New Year', () => {
  const before = mlbStandingsRequest(new Date('2027-01-01T03:00:00Z'));
  const after = mlbStandingsRequest(new Date('2027-01-01T06:00:00Z'));
  assert.equal(before.season, 2026);
  assert.equal(after.season, 2027);
  assert.notEqual(before.cacheTag, after.cacheTag);
  for (const url of [before.upstream, before.alternate]) assert.equal(new URL(url).searchParams.get('season'), '2026');
});

test('MLB fixes the unordered AL West response without requiring a rank stat', () => {
  const data = fixture(2026, [entry('ATH', 60, 88, 14), entry('LAA', 56, 92, 15),
    entry('HOU', 75, 73, 3), entry('TEX', 72, 76, 8), entry('SEA', 69, 79, 12)]);
  const before = JSON.stringify(data);
  const rows = parseMlbStandings(data, 2026).sections[0].rows;
  assert.deepEqual(rows.map(r => r.code), ['HOU', 'TEX', 'SEA', 'ATH', 'LAA']);
  assert.deepEqual(rows.map(r => r.rank), [1, 2, 3, 4, 5]);
  assert.equal(JSON.stringify(data), before, 'parser must not mutate upstream evidence');
  assert.equal(rows[0].w, '75');
  assert.equal(rows[0].l, '73');
});

test('MLB fixes the unordered NL West response', () => {
  const data = fixture(2026, [entry('SF', 62, 87, 14), entry('COL', 55, 93, 15),
    entry('LAD', 90, 58, 2), entry('SD', 80, 68, 6), entry('ARI', 79, 69, 7)], 'National League West');
  assert.deepEqual(parseMlbStandings(data, 2026).sections[0].rows.map(r => r.code), ['LAD', 'SD', 'ARI', 'SF', 'COL']);
});

test('MLB uses exact win fractions, not rounded display percentages or playoff group seeding', () => {
  const data = fixture(2026, [entry('LOW', 77, 73, 1), entry('HIGH', 76, 72, 4)]);
  assert.equal(data.children[0].standings.entries[0].stats[2].displayValue, '0.513');
  assert.equal(data.children[0].standings.entries[1].stats[2].displayValue, '0.514');
  // Deliberately make presentation values indistinguishable: ordering is factual.
  for (const e of data.children[0].standings.entries) e.stats[2].displayValue = '.51';
  assert.deepEqual(parseMlbStandings(data, 2026).sections[0].rows.map(r => r.code), ['HIGH', 'LOW']);
});

test('MLB breaks exact percentage ties using complete unique provider seeds without exposing them as ranks', () => {
  const data = fixture(2026, [entry('B', 80, 80, 8), entry('A', 79, 79, 6)]);
  const rows = parseMlbStandings(data, 2026).sections[0].rows;
  assert.deepEqual(rows.map(r => [r.code, r.rank]), [['A', 1], ['B', 2]]);
  assert.ok(rows.every(r => !Object.hasOwn(r, 'seed') && !Object.hasOwn(r, 'percentage')));
});

test('MLB does not coerce absent statistics into zero wins or manufacture a rank', () => {
  const data = fixture(2026, [{ team: { abbreviation: 'UNKNOWN' }, stats: [] }]);
  const row = parseMlbStandings(data, 2026).sections[0].rows[0];
  assert.equal(row.w, null);
  assert.equal(row.l, null);
  assert.equal(row.rank, null);
});

test('MLB traverses nested division and flat league fallback shapes', () => {
  const flat = { season: { year: 2026 }, name: 'League', standings: { entries: [entry('A', 2, 1)] } };
  const nested = { season: { year: 2026 }, children: [{ name: 'AL', children: fixture(2026, [entry('A', 2, 1)]).children }] };
  assert.equal(parseMlbStandings(flat, 2026).sections[0].name, 'League');
  assert.equal(parseMlbStandings(nested, 2026).sections[0].name, 'American League West');
});

test('MLB rejects wrong and missing seasons rather than relabeling a feed', () => {
  assert.throws(() => parseMlbStandings(fixture(2027, []), 2026), /season mismatch/);
  assert.throws(() => parseMlbStandings({ children: [] }, 2026), /season mismatch/);
});

test('MLB Worker pins both upstreams and isolates old cached standings', async () => {
  const season = currentSeason();
  await withMocks(() => fixture(season, [entry('A', 2, 1)]), async ({ request, calls, reads, writes }) => {
    const result = await request();
    assert.equal(result.status, 200);
    assert.equal(result.body.season, String(season));
    assert.equal(calls.length, 2);
    assert.ok(calls.every(u => new URL(u).searchParams.get('season') === String(season)));
    assert.ok(reads[0].includes(`mlb-div-v2-${season}`));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].key, reads[0]);
  });
});

test('MLB Worker falls back from a wrong-season primary response to a valid season', async () => {
  const season = currentSeason();
  await withMocks(url => fixture(url.searchParams.has('level') ? season + 1 : season, [entry('A', 2, 1)]), async ({ request, writes }) => {
    const { body } = await request();
    assert.equal(body.season, String(season));
    assert.equal(body.sections.length, 1);
    assert.equal(writes.length, 1);
  });
});

test('MLB Worker never caches wrong-season data when both upstreams are invalid', async () => {
  await withMocks(() => fixture(currentSeason() + 1, [entry('A', 2, 1)]), async ({ request, writes }) => {
    const { body } = await request();
    assert.deepEqual(body.sections, []);
    assert.equal(body.note, 'standings upstream');
    assert.equal(writes.length, 0);
  });
});

test('NBA keeps provider season and rank semantics unchanged', async () => {
  const data = fixture(2027, [entry('A', 10, 20), entry('B', 20, 10)], 'Conference');
  data.children[0].standings.entries[0].stats.push({ name: 'rank', value: 2 });
  data.children[0].standings.entries[1].stats.push({ name: 'rank', value: 1 });
  await withMocks(() => data, async ({ request, calls }) => {
    const { body } = await request('nba');
    assert.equal(body.season, '2027');
    assert.deepEqual(body.sections[0].rows.map(r => r.code), ['B', 'A']);
    assert.ok(calls.every(u => !new URL(u).searchParams.has('season')));
  });
});
