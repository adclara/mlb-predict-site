import test from 'node:test';
import assert from 'node:assert/strict';

import { polySignals, polyTelegramGate } from '../cloudflare/worker/index.js';

const NOW = 1_784_650_000;
const DAY = '2026-07-21';

function signal(title, overrides = {}) {
  const wallets = overrides.wallets || [
    { w: 'a', info: 'informed', usd: 240 },
    { w: 'b', info: 'informed', usd: 210 },
    { w: 'c', info: 'informed', usd: 170 },
  ];
  return {
    title, outcome: 'Yes', n: wallets.length, usd: 620, last_ts: NOW - 900,
    sig: {
      title, outcome: 'Yes', info: 'informed', strength: 84, avg_wr_lb: 0.64,
      price: 0.46, wallets,
    },
    ...overrides,
  };
}

test('gate de Telegram rechaza ruido de centavos, extremos y consenso débil', () => {
  const noisy = [
    signal('centavos', { usd: 1 }),
    signal('precio extremo', { sig: { ...signal('x').sig, price: 0.01 } }),
    signal('solo dos', {
      n: 2, wallets: undefined,
      sig: { ...signal('x').sig, wallets: [{ w: 'a', info: 'informed', usd: 300 }, { w: 'b', info: 'informed', usd: 300 }] },
    }),
    signal('vieja', { last_ts: NOW - 7 * 3600 }),
    signal('sin métricas', { usd: undefined, last_ts: undefined, sig: { ...signal('x').sig, strength: undefined, avg_wr_lb: undefined } }),
  ];
  const out = polyTelegramGate(noisy, null, { nowSec: NOW, date: DAY });
  assert.deepEqual(out.items, []);
  assert.equal(out.state.sent, 0);
  assert.equal(out.state.policy, 'rare_v1');
});

test('gate selecciona como máximo dos señales excepcionales por día', () => {
  const out = polyTelegramGate([
    signal('segunda', { sig: { ...signal('x').sig, strength: 82 } }),
    signal('primera', { sig: { ...signal('x').sig, strength: 91 } }),
    signal('tercera', { sig: { ...signal('x').sig, strength: 81 } }),
  ], null, { nowSec: NOW, date: DAY });
  assert.deepEqual(out.items.map((x) => x.title), ['primera', 'segunda']);
  assert.equal(out.state.sent, 2);
  assert.equal(Object.keys(out.state.notified).length, 2);

  const again = polyTelegramGate([signal('cuarta')], out.state, { nowSec: NOW + 60, date: DAY });
  assert.deepEqual(again.items, []);
  assert.equal(again.state.sent, 2);
});

test('gate deduplica por mercado siete días aun al cambiar de fecha', () => {
  const first = polyTelegramGate([signal('única')], null, { nowSec: NOW, date: DAY });
  const nextDay = polyTelegramGate([signal('única', { last_ts: NOW + 86400 - 60 })], first.state, {
    nowSec: NOW + 86400, date: '2026-07-22',
  });
  assert.deepEqual(nextDay.items, []);
  assert.equal(nextDay.state.sent, 0);
});

test('ranking visible excluye montos diminutos, precios extremos y señales viejas', () => {
  const wallet = { win_rate: 0.68, win_rate_lb: 0.61, pre_win_share: 0.7, insider_score: 70 };
  const byWallet = new Map([['a', wallet], ['b', wallet]]);
  const cons = (title, usd, price, age = 60) => ({
    title, outcome: 'Yes', n: 2, usd, price, last_ts: NOW - age,
    wallets: [
      { w: 'a', usd: usd / 2, price, ts: NOW - age },
      { w: 'b', usd: usd / 2, price, ts: NOW - age },
    ],
  });
  const out = polySignals([
    cons('válida', 400, 0.72),
    cons('centavos', 1, 0.60),
    cons('extrema', 400, 0.99),
    cons('vieja', 400, 0.60, 49 * 3600),
    { ...cons('sin timestamp', 400, 0.60), last_ts: undefined },
    { ...cons('sin monto', 400, 0.60), usd: undefined },
  ], byWallet, NOW);
  assert.deepEqual(out.strong.map((x) => x.title), ['válida']);
  assert.deepEqual(out.likely.map((x) => x.title), ['válida']);
  assert.deepEqual(out.filters, { min_usd: 100, min_price: 0.05, max_price: 0.95, max_age_hours: 48 });
});
