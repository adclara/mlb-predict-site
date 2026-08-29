import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { sanitizeIntelligenceDoc } from '../cloudflare/worker/index.js';

const sample = (asOf = new Date().toISOString()) => ({
  version: 'intelligence_v1', date: '2026-08-28', state: 'fresh', as_of: asOf,
  next_refresh: new Date(Date.parse(asOf) + 1800e3).toISOString(),
  sources: { aa: { ok: true }, books: { ok: true }, polymarket: { ok: true, markets: 4 }, kalshi: { ok: true, markets: 3 } },
  slate: [{ id: 'mlb:1', sport: 'mlb', event_id: '1', start: '2026-08-28T23:00:00Z', pick: 'BOS', market: 'winner',
    home: { code: 'BOS', name: 'Boston' }, away: { code: 'NYY', name: 'New York' },
    aa: { prob: .62, engine: 'v2', public_gate: true }, books: { prob: .60, n: 3 },
    polymarket: { matched: true, prob: .59, market_id: 'x' }, kalshi: { matched: false },
    consensus: { state: 'agree', market_prob: .60, anomalies: [] }, reasons: ['Measured reason'],
    secret_weights: [1, 2, 3] }],
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
});

test('stale snapshots withdraw consensus claims but preserve authorized AA pick', () => {
  const old = '2026-08-28T10:00:00Z';
  const doc = sanitizeIntelligenceDoc(sample(old), Date.parse('2026-08-28T12:00:00Z'));
  assert.equal(doc.state, 'stale');
  assert.equal(doc.slate[0].aa.prob, .62);
  assert.equal(doc.slate[0].consensus.state, 'insufficient');
  assert.equal(doc.slate[0].polymarket, null);
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
  assert.equal(body.version, 'intelligence_v1');
  assert.equal(body.alerts, false);
  assert.equal(reads, 1);
});
