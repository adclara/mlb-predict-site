import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketBundles, buildShadowCombos, intelligenceState, marketEventFromEspn, matchProviderEvent,
  qualifiesWallet, quoteFromBidAsk, sameTeam, sanitizePublicSlate, wilsonLowerBound } from '../robot/lib/market_intelligence.mjs';
import { buildWalletProfiles } from '../robot/poly_wallet_profiles.mjs';
import { buildOverlays, freshnessDecision, getJson, kalshiCandidates, polyCandidates, previousFutureCount } from '../robot/market_intelligence.mjs';

test('provider matching requires one unambiguous team/time match', () => {
  const event = { away: { code: 'NYY' }, home: { code: 'BOS' }, start: '2026-08-28T23:00:00Z' };
  const row = { teams: ['NYY', 'BOS'], start: '2026-08-28T23:30:00Z' };
  assert.equal(matchProviderEvent(event, [row]), row);
  assert.equal(matchProviderEvent(event, [row, { ...row }]), null);
  assert.equal(matchProviderEvent(event, [{ ...row, start: '2026-08-29T03:30:00Z' }]), null);
});

test('provider aliases match city names to full team names without weakening ambiguity gate', () => {
  assert.equal(sameTeam('New York', 'New York Liberty'), true);
  assert.equal(sameTeam('Chicago', 'Chicago Sky'), true);
  assert.equal(sameTeam('New York', 'Boston Red Sox'), false);
});

test('Polymarket two-team moneyline is exploded into correctly priced outcome candidates', () => {
  const docs = [[{ title: 'Chicago Sky vs. New York Liberty', endDate: '2026-08-29T17:00:00Z', markets: [{
    active: true, closed: false, sportsMarketType: 'moneyline', conditionId: 'c1', gameStartTime: '2026-08-29T17:00:00Z',
    outcomes: '["Chicago Sky","New York Liberty"]', outcomePrices: '["0.215","0.785"]', clobTokenIds: '["chi","ny"]',
    bestBid: .21, bestAsk: .22, updatedAt: '2026-08-29T10:00:00Z',
  }] }]];
  const rows = polyCandidates(docs, '2026-08-29T10:00:00Z');
  assert.equal(rows.length, 2);
  const ny = rows.find((row) => row.outcomeTeam === 'New York Liberty');
  assert.equal(ny.asset, 'ny');
  assert.equal(ny.bestBid, .78);
  assert.equal(ny.bestAsk, .79);
  assert.equal(JSON.parse(ny.outcomePrices)[0], .785);
});

test('Kalshi candidates retain their series sport to prevent cross-league city matches', () => {
  const docs = [null, null, null, { events: [{ title: 'Chicago vs New York', markets: [{ ticker: 'w1', yes_sub_title: 'New York', yes_bid_dollars: '.78', yes_ask_dollars: '.79' }] }] }];
  const rows = kalshiCandidates(docs, '2026-08-29T10:00:00Z');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].league, 'wnba');
});

test('upstream JSON retries transient failures but not a permanent 404', async () => {
  let calls = 0;
  const transient = await getJson('https://example.test/data', { tries: 3, sleepFn: async () => {}, fetcher: async () => {
    calls++; return calls < 3 ? { ok: false, status: 503, async json() { return {}; } } : { ok: true, status: 200, async json() { return { ok: true }; } };
  } });
  assert.deepEqual(transient, { ok: true }); assert.equal(calls, 3);
  calls = 0;
  const missing = await getJson('https://example.test/missing', { tries: 3, sleepFn: async () => {}, fetcher: async () => {
    calls++; return { ok: false, status: 404, async json() { return {}; } };
  } });
  assert.equal(missing, null); assert.equal(calls, 1);
});

test('freshness preflight dedupes redundant triggers and partial-empty guard detects prior future rows', () => {
  const now = Date.parse('2026-08-29T12:00:00Z');
  const current = { version: 'intelligence_v2', cadence: '30m_redundant', source_health: { critical_ok: 10 } };
  assert.equal(freshnessDecision({ ...current, as_of: '2026-08-29T11:40:00Z' }, now, 30).skip, true);
  assert.equal(freshnessDecision({ ...current, as_of: '2026-08-29T11:20:00Z' }, now, 30).skip, false);
  assert.equal(freshnessDecision({ ...current, as_of: '2026-08-29T11:50:00Z' }, now, 30, true).skip, false);
  assert.equal(freshnessDecision({ as_of: '2026-08-29T11:50:00Z' }, now, 30).skip, false);
  assert.equal(previousFutureCount({ slate: [{ start: '2026-08-29T13:00:00Z' }, { start: '2026-08-29T11:00:00Z' }] }, now), 1);
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

test('unmatched providers stay absent and never become a false 0% conflict', () => {
  const state = intelligenceState({ aaProb: .625, bookProb: .655, polyProb: null, kalshiProb: null });
  assert.equal(state.state, 'agree');
  assert.equal(state.market_prob, .655);
  assert.equal(state.divergence, .03);
  assert.deepEqual(state.anomalies, []);
});

test('wallet qualification penalizes small samples with Wilson', () => {
  assert.ok(wilsonLowerBound(8, 8) < .70);
  const base = { wins: 16, losses: 4, pnl: 1000, consistency: .75, cost: 5000, wash_share: .1, avg_entry: .55 };
  assert.equal(qualifiesWallet(base), true);
  assert.equal(qualifiesWallet({ ...base, wins: 8, losses: 0 }), false);
  assert.equal(qualifiesWallet({ ...base, pnl: -1 }), false);
});

test('public slate is pregame, above 60%, gate-safe and accepts explicit market facts', () => {
  const now = Date.parse('2026-08-28T20:00:00Z');
  const open = { sport: 'mlb', event_id: '1', status: 'pre', start: '2026-08-28T22:00:00Z', home: { code: 'BOS' }, away: { code: 'NYY' },
    prediction: { pick: 'BOS', prob: .62, gate: { passed: true, approved: true, public: true } } };
  const closed = { ...open, event_id: '2', prediction: { pick: 'NYY', prob: .8, gate: { passed: true, approved: false, public: false } } };
  const invalid = { ...open, event_id: '3', prediction: { pick: 'BOS', prob: .9, invalidated: true } };
  const low = { ...open, event_id: '4', prediction: { pick: 'BOS', prob: .60 } };
  const live = { ...open, event_id: '5', status: 'live', prediction: { pick: 'BOS', prob: .8 } };
  const market = { sport: 'wnba', event_id: '6', status: 'pre', start: '2026-08-28T23:00:00Z', selection_scope: 'market_fact',
    home: { code: 'NY' }, away: { code: 'CHI' }, prediction: { pick: 'NY', prob: .76, market_fact: true, provider: 'DraftKings' } };
  const slate = sanitizePublicSlate([closed, invalid, low, live, open, market], new Map(), { now });
  assert.equal(slate.length, 2);
  assert.deepEqual(new Set(slate.map((row) => row.event_id)), new Set(['1', '6']));
  const marketRow = slate.find((row) => row.event_id === '6');
  assert.equal(marketRow.selection_scope, 'market_fact');
  assert.equal(marketRow.market_pick.public_fact, true);
});

test('ESPN WNBA moneyline becomes a factual market selection with measured context', () => {
  const event = { id: '401', date: '2026-08-29T17:00:00Z', competitions: [{ status: { type: { state: 'pre' } },
    competitors: [
      { homeAway: 'home', team: { abbreviation: 'NY', displayName: 'New York Liberty' }, records: [{ summary: '23-16' }] },
      { homeAway: 'away', team: { abbreviation: 'CHI', displayName: 'Chicago Sky' }, records: [{ summary: '15-24' }] },
    ], odds: [{ provider: { name: 'DraftKings' }, spread: -8.5, overUnder: 178.5,
      moneyline: { home: { close: { odds: '-380' }, open: { odds: '-355' } }, away: { close: { odds: '+300' }, open: { odds: '+280' } } } }] }] };
  const parsed = marketEventFromEspn(event, { sport: 'wnba', now: Date.parse('2026-08-29T10:00:00Z') });
  assert.equal(parsed.selection_scope, 'market_fact');
  assert.equal(parsed.prediction.pick, 'NY');
  assert.equal(parsed.prediction.prob, .76);
  assert.equal(parsed.prediction.price, -380);
  assert.equal(parsed.context.pick_record.text, '23-16');
});

test('soccer market fact keeps native 1X2 de-vig probability instead of dropping draw', () => {
  const event = { sport: 'soccer', event_id: 's1', status: 'pre', start: '2026-08-29T18:00:00Z', selection_scope: 'market_fact',
    home: { code: 'JUV', name: 'Juventus' }, away: { code: 'PAR', name: 'Parma' },
    prediction: { pick: 'JUV', prob: .70, market_fact: true }, odds: { ml_home: -500, ml_away: 900, n_books: 1 } };
  const overlay = buildOverlays([event], [], [], Date.parse('2026-08-29T10:00:00Z')).get('soccer:s1');
  assert.equal(overlay.books.prob, .70);
  assert.equal(overlay.consensus.state, 'agree');
  assert.equal(overlay.consensus.market_prob, .70);
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

test('public market bundles require different sports and never invent joint probability', () => {
  const leg = (id, sport, prob) => ({ id: `${sport}:${id}`, event_id: id, sport, pick: id.toUpperCase(), start: '2026-08-29T20:00:00Z',
    selection_scope: 'market_fact', probability: { value: prob, kind: 'market_devig' } });
  const bundles = buildMarketBundles([leg('ny', 'wnba', .76), leg('juv', 'soccer', .72), leg('phi', 'mlb', .67)]);
  assert.equal(bundles.length, 3);
  assert.equal(bundles[0].joint_prob, null);
  assert.ok(bundles.every((bundle) => new Set(bundle.legs.map((row) => row.sport)).size >= 2));
  assert.equal(bundles.some((bundle) => bundle.legs.length === 3), true);
  const pairKinds = bundles.filter((bundle) => bundle.legs.length === 2).map((bundle) => bundle.legs.map((row) => row.sport).sort().join('+'));
  assert.equal(new Set(pairKinds).size, pairKinds.length);
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
