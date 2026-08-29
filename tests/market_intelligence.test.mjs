import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShadowCombos, intelligenceState, matchProviderEvent, qualifiesWallet, quoteFromBidAsk,
  sanitizePublicSlate, shouldRunPulse, wilsonLowerBound } from '../robot/lib/market_intelligence.mjs';
import { buildWalletProfiles } from '../robot/poly_wallet_profiles.mjs';

test('provider matching requires one unambiguous team/time match', () => {
  const event = { away: { code: 'NYY' }, home: { code: 'BOS' }, start: '2026-08-28T23:00:00Z' };
  const row = { teams: ['NYY', 'BOS'], start: '2026-08-28T23:30:00Z' };
  assert.equal(matchProviderEvent(event, [row]), row);
  assert.equal(matchProviderEvent(event, [row, { ...row }]), null);
  assert.equal(matchProviderEvent(event, [{ ...row, start: '2026-08-29T03:30:00Z' }]), null);
});

test('quote fails closed when stale, wide, or one-sided', () => {
  const now = Date.parse('2026-08-28T20:00:00Z');
  assert.equal(quoteFromBidAsk({ bid: .58, ask: .62, as_of: '2026-08-28T19:30:00Z', now }).mid, .6);
  assert.equal(quoteFromBidAsk({ bid: .40, ask: .60, as_of: '2026-08-28T19:30:00Z', now }).usable, false);
  assert.equal(quoteFromBidAsk({ bid: .58, ask: .62, as_of: '2026-08-28T17:00:00Z', now }).usable, false);
});

test('anomalies are descriptive and versioned by measured thresholds', () => {
  const state = intelligenceState({ aaProb: .70, bookProb: .60, polyProb: .59, kalshiProb: .61,
    bookDisagreement: .05, move30m: -.06, walletSignal: { qualified_wallets: 3, usd: 800 } });
  assert.equal(state.state, 'conflict');
  assert.deepEqual(state.anomalies.map((x) => x.code), [
    'provider_divergence', 'market_move_30m', 'book_disagreement', 'possible_informed_pattern',
  ]);
});

test('wallet qualification penalizes small samples with Wilson', () => {
  assert.ok(wilsonLowerBound(8, 8) < .70);
  const base = { wins: 16, losses: 4, pnl: 1000, consistency: .75, cost: 5000, wash_share: .1, avg_entry: .55 };
  assert.equal(qualifiesWallet(base), true);
  assert.equal(qualifiesWallet({ ...base, wins: 8, losses: 0 }), false);
  assert.equal(qualifiesWallet({ ...base, pnl: -1 }), false);
});

test('public slate excludes closed gates, invalidated picks and never fills seven', () => {
  const open = { sport: 'mlb', event_id: '1', start: '2026-08-28T22:00:00Z', home: { code: 'BOS' }, away: { code: 'NYY' },
    prediction: { pick: 'BOS', prob: .62, gate: { passed: true, approved: true, public: true } } };
  const closed = { ...open, event_id: '2', prediction: { pick: 'NYY', prob: .8, gate: { passed: true, approved: false, public: false } } };
  const invalid = { ...open, event_id: '3', prediction: { pick: 'BOS', prob: .9, invalidated: true } };
  const slate = sanitizePublicSlate([closed, invalid, open]);
  assert.equal(slate.length, 1);
  assert.equal(slate[0].event_id, '1');
  assert.equal(slate[0].aa.prob, .62);
});

test('adaptive pulse runs near events and only every two hours in calm windows', () => {
  const now = Date.parse('2026-08-28T20:00:00Z');
  assert.equal(shouldRunPulse([], now), true);
  assert.equal(shouldRunPulse([], Date.parse('2026-08-28T21:00:00Z')), false);
  assert.equal(shouldRunPulse([{ start: '2026-08-28T22:00:00Z', status: 'pre' }], Date.parse('2026-08-28T21:00:00Z')), true);
});

test('shadow combo builder uses public legs, distinct events and never claims joint probability', () => {
  const leg = (id, sport, pick, prob, home, away) => ({ id, event_id: id, sport, pick, aa: { prob }, home: { code: home }, away: { code: away }, start: '2026-08-29T00:00:00Z' });
  const combos = buildShadowCombos([
    leg('1', 'mlb', 'BOS', .7, 'BOS', 'NYY'), leg('2', 'nfl', 'KC', .68, 'KC', 'BUF'),
    leg('3', 'nba', 'BOS', .65, 'BOS', 'MIA'),
  ]);
  assert.equal(combos.length, 2);
  assert.equal(combos[0].joint_prob, null);
  assert.equal(combos[0].independence_prob, .476);
  assert.equal(combos[0].state, 'shadow');
});

test('daily wallet profiler uses resolved markets and preserves measured sample', () => {
  const w = '0x1111111111111111111111111111111111111111';
  const universe = Array.from({ length: 20 }, (_, i) => ({ win: 0, end: 1000 + i,
    trades: [{ w, s: 'BUY', o: i < 16 ? 0 : 1, p: .5, sz: 100, ts: 900 + i, a: `a${i}` }] }));
  const profiles = buildWalletProfiles(universe, 2000);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].wins, 16);
  assert.equal(profiles[0].losses, 4);
  assert.equal(profiles[0].cost, 1000);
  assert.ok(profiles[0].wr_lb > .5);
});
