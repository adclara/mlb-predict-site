import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeOddsBlocks } from '../robot/odds.js';
import { buildMarketLab, f5Outcome, gradeMarketLab, marketLabReport, totalAtMarket } from '../robot/market_lab.mjs';

function row(id = 1, overrides = {}) {
  return {
    game_pk: id, date: '2026-07-21', matchup: 'MIN @ CLE', home: 'CLE', away: 'MIN',
    adj_total: 9.2, line: 8.5, total_runs: 10, graded: true, formula_version: 'v2',
    odds: { over_under_open: 8, over_under: 8.5, wp_curve: [{ inn: 5, home_score: 3, away_score: 1 }] },
    factor_leans: { f5: 0.25 },
    brief: { f5: { home_lead: 0.56, away_lead: 0.29 }, pitchers: { home: { name: 'Parker Messick' }, away: { name: 'Kendry Rojas' } } },
    pitcher_recent: { home: { era: 3.1, n: 3 }, away: { era: 5.2, n: 3 } },
    ...overrides,
  };
}

test('preserva línea O/U de apertura aunque la captura final cambie', () => {
  const open = mergeOddsBlocks(null, {
    capture_phase: 'pregame', captured_at: '2026-07-21T12:00:00Z', provider: 'book',
    over_under: 8, over_price: -110, under_price: -110, spread: -1.5,
    p_home_mkt: 0.56, ml_home: -125, ml_away: 110,
  });
  const close = mergeOddsBlocks(open, {
    capture_phase: 'postgame', captured_at: '2026-07-22T03:00:00Z', provider: 'book',
    over_under: 9, over_price: -115, under_price: -105, spread: -2.5,
    p_home_mkt: 0.58, ml_home: -140, ml_away: 120,
  });
  assert.equal(close.over_under_open, 8);
  assert.equal(close.over_under_close, 9);
  assert.equal(close.over_under, 9);
  assert.equal(close.total_line_move, 1);
  assert.equal(close.open_provenance, 'explicit_pregame');
  assert.equal(close.captured_at_open, '2026-07-21T12:00:00Z');
});

test('Over sombra usa línea real de apertura, no la referencia del modelo', () => {
  const t = totalAtMarket(row());
  assert.equal(t.line, 8);
  assert.equal(t.side, 'over');
  assert.equal(t.edge_runs, 1.2);
  assert.ok(t.p_over > 0.5);
  assert.equal(totalAtMarket(row(2, { odds: null })), null);
  assert.equal(totalAtMarket(row(3, { adj_total: null })), null);
});

test('F5 deriva ganador y empate desde el score de cinco entradas', () => {
  assert.deepEqual(f5Outcome(row()), { home: 3, away: 1, result: 'home' });
  assert.deepEqual(f5Outcome(row(2, { f5_home_score: 2, f5_away_score: 2 })), { home: 2, away: 2, result: 'push' });
  assert.equal(f5Outcome(row(3, { f5_home_score: null, f5_away_score: null, odds: null })), null);
});

test('registra máximo dos candidatos por categoría y nunca los publica', () => {
  const lab = buildMarketLab([row(1), row(2), row(3)], { max: 2 });
  assert.equal(lab.published, false);
  assert.equal(lab.over.length, 2);
  assert.equal(lab.f5.length, 2);
  assert.equal(lab.pitcher_f5.length, 2);
  assert.equal(lab.gates.over.passes, false);
});

test('gradúa Over y F5 sin convertirlos en picks públicos', () => {
  const lab = buildMarketLab([row()], { max: 2 });
  const games = new Map([[1, { game_pk: 1, home_score: 6, away_score: 4, f5_home_score: 3, f5_away_score: 1 }]]);
  assert.equal(gradeMarketLab(lab, games), true);
  assert.equal(lab.over[0].result, 'win');
  assert.equal(lab.f5[0].result, 'win');
  assert.equal(lab.pitcher_f5[0].result, 'win');
});

test('reporte cronológico mantiene Over/F5 cerrados cuando falta el gate', () => {
  const rows = [];
  for (let d = 1; d <= 12; d++) for (let i = 0; i < 3; i++) rows.push(row(d * 10 + i, {
    date: `2026-07-${String(d).padStart(2, '0')}`,
  }));
  const report = marketLabReport(rows, { minTest: 100 });
  assert.equal(report.markets.over.gate.passes, false);
  assert.equal(report.markets.over.forward.n, 0);
  assert.match(report.markets.over.gate.reason, /sin línea y juice pregame auditables/);
  assert.equal(report.markets.f5.gate.has_market_price, false);
  assert.equal(report.markets.pitcher_f5.gate.passes, false);
});
