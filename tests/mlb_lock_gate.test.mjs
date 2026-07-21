import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { selectLocks, starterRecentGate } from '../robot/adrian.js';
import { lockGateReport } from '../robot/learn.js';

function analysis(overrides = {}) {
  return {
    game_pk: 1, home: 'CLE', away: 'MIN', matchup: 'MIN @ CLE',
    pitcher_recent: {
      home: { recent: { era: 3.1, n: 3 } },
      away: { recent: { era: 5.2, n: 3 } },
    },
    ml: {
      market: 'ml', game_pk: 1, matchup: 'MIN @ CLE', pick: 'CLE', label: 'Gana CLE',
      prob: 0.68, prob_v2: 0.58, confidence: 'alta', aligned: true, agree: 5, reasons: [],
    },
    ...overrides,
  };
}

const odds = new Map([[1, {
  fav_side: 'home', p_home_mkt: 0.59, ml_home: -145, ml_away: 125,
  consensus: { p_home: 0.59, p_away: 0.41, n_books: 1 }, book_disagreement: 0,
}]]);

test('gate de abridor exige dos salidas medidas por lado y ERA mejor', () => {
  assert.deepEqual(starterRecentGate(analysis(), 'CLE'), {
    passes: true, pick_era: 3.1, opp_era: 5.2, starts: 3,
  });
  assert.equal(starterRecentGate(analysis({ pitcher_recent: {
    home: { recent: { era: 3.1, n: 1 } }, away: { recent: { era: 5.2, n: 3 } },
  } }), 'CLE').passes, false);
  assert.equal(starterRecentGate(analysis({ pitcher_recent: {
    home: { recent: { era: 5.3, n: 3 } }, away: { recent: { era: 3.2, n: 3 } },
  } }), 'CLE').passes, false);
});

test('ORO requiere mercado + 5 factores + ventaja reciente del abridor', () => {
  const locks = selectLocks([analysis()], odds);
  assert.equal(locks.length, 1);
  assert.equal(locks[0].tier, 'oro');
  assert.equal(locks[0].selection_rule, 'market_agree5_starter_v1');

  const fourFactors = analysis({ ml: { ...analysis().ml, agree: 4 } });
  assert.deepEqual(selectLocks([fourFactors], odds), []);

  const worseStarter = analysis({ pitcher_recent: {
    home: { recent: { era: 5.3, n: 3 } }, away: { recent: { era: 3.2, n: 3 } },
  } });
  assert.deepEqual(selectLocks([worseStarter], odds), []);
});

test('no rellena cupos con PLATA cuando el gate fuerte no pasa', () => {
  const marketOnly = analysis({ ml: { ...analysis().ml, agree: 4 } });
  assert.deepEqual(selectLocks([marketOnly], odds, { max: 2 }), []);
});

test('replay real del nuevo ORO pasa muestra, intervalo y ambos cortes', () => {
  const rows = [];
  for (const file of readdirSync('data/history/games').filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
    rows.push(...(JSON.parse(readFileSync(`data/history/games/${file}`, 'utf8')).games || []));
  }
  const report = lockGateReport(rows);
  assert.equal(report.rule, 'market_agree5_starter_v1');
  assert.ok(report.all.n >= 100, `muestra insuficiente: ${report.all.n}`);
  assert.ok(report.all.lo > report.gate.threshold, `IC inferior ${report.all.lo} no supera ${report.gate.threshold}`);
  assert.ok(report.train.p > report.gate.threshold);
  assert.ok(report.test.p > report.gate.threshold);
  assert.equal(report.gate.passes, true);
});
