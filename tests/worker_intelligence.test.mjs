import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { sanitizeIntelligenceDoc } from '../cloudflare/worker/index.js';

const sample = (asOf = new Date().toISOString()) => ({
  version: 'intelligence_v2', date: '2026-08-28', state: 'fresh', as_of: asOf,
  next_refresh: new Date(Date.parse(asOf) + 1800e3).toISOString(),
  cadence: '30m_redundant', source_health: { requests: 20, retries: 2, ok: 19, failed: 1, critical_ok: 10, critical_failed: 0,
    by_host: { 'site.api.espn.com': { ok: 10, failed: 0, retries: 1 } } },
  sources: { aa: { ok: true }, books: { ok: true }, polymarket: { ok: true, markets: 4 }, kalshi: { ok: true, markets: 3 } },
  slate: [{ id: 'mlb:1', sport: 'mlb', event_id: '1', start: new Date(Date.parse(asOf) + 3 * 3600e3).toISOString(), pick: 'BOS', market: 'winner', selection_scope: 'aa_public',
    home: { code: 'BOS', name: 'Boston' }, away: { code: 'NYY', name: 'New York' },
    probability: { value: .62, kind: 'aa_calibrated' }, aa: { prob: .62, engine: 'v2', public_gate: true }, books: { prob: .61, n: 3 },
    polymarket: { matched: true, prob: .59, market_id: 'x' }, kalshi: { matched: false },
    consensus: { state: 'agree', market_prob: .61, anomalies: [] }, reasons: ['Measured reason'],
    secret_weights: [1, 2, 3] }],
  market_bundles: [],
  combos: { items: [{ pick: 'must-not-leak', prob: .9 }], sample: { n: 12, dates: 5, min_forward: 100, min_dates: 30 } },
  budget: { kv_writes: 2, d1_rows: 1 }, alerts: true, telegram: true,
});

test('sanitizer exposes only gated singles and always closes combos/alerts', () => {
  const doc = sanitizeIntelligenceDoc(sample(), Date.now());
  assert.equal(doc.slate.length, 1);
  assert.equal(doc.slate[0].pick, 'BOS');
  assert.equal('secret_weights' in doc.slate[0], false);
  assert.equal(doc.combos.state, 'closed');
  assert.equal('items' in doc.combos, false);
  assert.equal(doc.alerts, false);
  assert.equal(doc.telegram, false);
  assert.equal(doc.cadence, '30m_redundant');
  assert.equal(doc.source_health.critical_ok, 10);
});

test('stale snapshots withdraw consensus claims but preserve authorized AA pick', () => {
  const old = '2026-08-28T10:00:00Z';
  const doc = sanitizeIntelligenceDoc(sample(old), Date.parse('2026-08-28T12:00:00Z'));
  assert.equal(doc.state, 'stale');
  assert.equal(doc.slate[0].aa.prob, .62);
  assert.equal(doc.slate[0].stale, true);
  assert.equal(doc.slate[0].consensus.state, 'insufficient');
  assert.equal(doc.slate[0].polymarket.reason, 'snapshot_stale');
  assert.equal(doc.freshness.age_minutes, 120);
});

test('market facts above 60% never masquerade as AA and hard-stale ones disappear', () => {
  const asOf = '2026-08-28T10:00:00Z', doc = sample(asOf);
  doc.slate.push({ id: 'wnba:2', sport: 'wnba', event_id: '2', start: '2026-08-28T20:00:00Z', pick: 'NY', market: 'winner',
    selection_scope: 'market_fact', home: { code: 'NY', name: 'Liberty' }, away: { code: 'CHI', name: 'Sky' },
    probability: { value: .76, kind: 'market_devig' }, market_pick: { prob: .76, provider: 'DraftKings', price: -380, public_fact: true },
    books: { prob: .76, n: 1 }, polymarket: { matched: true, prob: .785, reason: 'matched' }, kalshi: { matched: true, prob: .785, reason: 'matched' },
    consensus: { state: 'agree', market_prob: .785, anomalies: [] }, context: { pick_record: { text: '23-16', wins: 23, losses: 16 }, opponent_record: { text: '15-24', wins: 15, losses: 24 } },
    reasons: [{ code: 'market_probability', value: .76, provider: 'DraftKings' }] });
  doc.market_bundles = [{ bundle_id: 'mlb:1+wnba:2', legs: [
    { id: 'mlb:1', sport: 'mlb', event_id: '1', pick: 'BOS', prob: .62, source: 'aa_public', start: doc.slate[0].start },
    { id: 'wnba:2', sport: 'wnba', event_id: '2', pick: 'NY', prob: .76, source: 'market_fact', start: '2026-08-28T20:00:00Z' }], joint_prob: null }];
  const fresh = sanitizeIntelligenceDoc(doc, Date.parse('2026-08-28T10:30:00Z'));
  const market = fresh.slate.find((row) => row.id === 'wnba:2');
  assert.equal(market.aa, null);
  assert.equal(market.market_pick.public_fact, true);
  assert.equal(fresh.market_bundles.length, 1);
  const stale = sanitizeIntelligenceDoc(doc, Date.parse('2026-08-28T12:00:00Z'));
  const staleMarket = stale.slate.find((row) => row.id === 'wnba:2');
  assert.equal(staleMarket.stale, true);
  assert.equal(staleMarket.polymarket.reason, 'snapshot_stale');
  assert.equal(staleMarket.market_pick.price, null);
  assert.equal(staleMarket.context.price, null);
  assert.equal(staleMarket.context.spread, null);
  assert.deepEqual(stale.market_bundles, []);
  const hardStale = sanitizeIntelligenceDoc(doc, Date.parse('2026-08-28T17:00:01Z'));
  assert.equal(hardStale.slate.some((row) => row.id === 'wnba:2'), false);
  assert.equal(hardStale.freshness.hard_stale, true);
});

test('fresh partial source state stays degraded instead of masquerading as fresh', () => {
  const doc = sample('2026-08-28T10:00:00Z'); doc.state = 'degraded'; doc.source_health.critical_failed = 1;
  const publicDoc = sanitizeIntelligenceDoc(doc, Date.parse('2026-08-28T10:10:00Z'));
  assert.equal(publicDoc.state, 'degraded');
  assert.equal(publicDoc.freshness.stale, false);
});

test('sanitizer preserves missing market numbers as null instead of manufacturing 0%', () => {
  const doc = sample();
  doc.slate[0].consensus.market_prob = null;
  doc.slate[0].consensus.divergence = null;
  const safe = sanitizeIntelligenceDoc(doc, Date.now());
  assert.equal(safe.slate[0].consensus.market_prob, null);
  assert.equal(safe.slate[0].consensus.divergence, null);
});

test('public intelligence route reads one KV blob and returns sanitized contract', async () => {
  let reads = 0;
  const env = { ALLOWED_ORIGIN: '*', AA_LATEST: { async get(key) { reads++; assert.equal(key, 'intelligence:today'); return JSON.stringify(sample()); } } };
  const response = await worker.fetch(new Request('https://api.test/v1/intelligence/today'), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.version, 'intelligence_v2');
  assert.equal(body.alerts, false);
  assert.equal(reads, 1);
});
