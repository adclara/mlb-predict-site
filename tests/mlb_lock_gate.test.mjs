import test from 'node:test';
import assert from 'node:assert/strict';

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

test('replay de ORO falla cerrado cuando el precio histórico no tiene apertura auditable', () => {
  // Fixture causal deliberadamente fuerte, pero con una línea histórica sin
  // provenance/timestamp. El test no puede depender de que el ledger vivo siga
  // teniendo exactamente cero aperturas auditables: esa muestra crece a diario.
  const rows = [{
    game_pk: 99, date: '2026-07-01', home: 'CLE', away: 'MIN', status: 'Final',
    graded: true, home_win: 1, final: '2-4', ml_result: 'win',
    formula_version: 'v2', adrian_p: 0.70, agree: 6, ml_pick: 'CLE',
    pitcher_recent: { home: { era: 3.1, n: 3 }, away: { era: 5.2, n: 3 } },
    odds: { p_home_open: 0.59 }, // legacy: no explicit_pregame or captured_at_open
    capture_phase: 'pregame', feature_as_of: '2026-07-01T12:00:00Z',
    first_pitch: '2026-07-01T23:00:00Z', feature_hash: 'a'.repeat(64),
    integrity: { training_eligible: true, cohort: 'native_pregame_immutable' },
  }];
  const report = lockGateReport(rows);
  assert.equal(report.rule, 'market_agree5_starter_v1');
  assert.deepEqual({ n: report.all.n, wins: report.all.wins, losses: report.all.losses }, { n: 0, wins: 0, losses: 0 });
  assert.deepEqual({ n: report.test.n, wins: report.test.wins, losses: report.test.losses }, { n: 0, wins: 0, losses: 0 });
  assert.equal(report.gate.passes, false);
  assert.match(report.gate.reason, /muestra\/intervalo insuficiente/);
});
