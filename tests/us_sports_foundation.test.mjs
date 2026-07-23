import test from 'node:test';
import assert from 'node:assert/strict';
import {
  US_SPORTS,
  compactUsSportsIngest,
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
