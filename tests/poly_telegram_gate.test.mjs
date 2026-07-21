import test from 'node:test';
import assert from 'node:assert/strict';

import {
  completePolyTelegramReservations,
  failPolyTelegramReservations,
  polySignals,
  polyTelegramGate,
  polyTelegramLegacySlots,
  polyTelegramRollback,
  polyTelegramStateAfterReservations,
  reservePolyTelegram,
} from '../cloudflare/worker/index.js';

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

class AtomicTelegramD1 {
  constructor({ cutoverBlocked = false } = {}) { this.rows = []; this.cutoverBlocked = cutoverBlocked; }
  prepare(sql) {
    return { bind: (...values) => ({ run: () => this.run(sql, values) }) };
  }
  async run(sql, values) {
    let changes = 0;
    if (/INSERT OR IGNORE INTO poly_telegram_deliveries/i.test(sql)) {
      const [reservation_id, et_date, dedupe_key, reserved_at, payload_hash, usedBefore, cutoverNow, quotaDate, key, cutoff] = values;
      const active = this.rows.filter((r) => r.et_date === quotaDate && ['reserved', 'sent', 'unknown'].includes(r.status));
      const duplicate = this.rows.some((r) => r.dedupe_key === key
        && (['reserved', 'unknown'].includes(r.status) || (r.status === 'sent' && r.sent_at >= cutoff)));
      const used = new Set(active.map((r) => r.slot));
      const slot = [1, 2].find((value) => value > usedBefore && !used.has(value));
      if (!this.cutoverBlocked && cutoverNow && !duplicate && slot) {
        this.rows.push({ reservation_id, et_date, slot, dedupe_key, status: 'reserved', reserved_at, payload_hash });
        changes = 1;
      }
    } else if (/SET status = 'sent'/i.test(sql)) {
      const [sent_at, telegram_message_id, reservation_id] = values;
      const row = this.rows.find((item) => item.reservation_id === reservation_id && item.status === 'reserved');
      if (row) { Object.assign(row, { status: 'sent', sent_at, telegram_message_id }); changes = 1; }
    } else if (/SET status = 'failed'/i.test(sql)) {
      const [failed_at, error, reservation_id] = values;
      const row = this.rows.find((item) => item.reservation_id === reservation_id && item.status === 'reserved');
      if (row) { Object.assign(row, { status: 'failed', slot: null, failed_at, error }); changes = 1; }
    } else if (/SET status = 'unknown'/i.test(sql)) {
      const [failed_at, error, reservation_id] = values;
      const row = this.rows.find((item) => item.reservation_id === reservation_id && item.status === 'reserved');
      if (row) { Object.assign(row, { status: 'unknown', failed_at, error }); changes = 1; }
    } else throw new Error(`SQL inesperado: ${sql}`);
    return { success: true, meta: { changes } };
  }
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

test('D1 hace atómico el máximo global de dos y el dedupe de siete días', async () => {
  const db = new AtomicTelegramD1();
  const candidates = [signal('atómica A'), signal('atómica B'), signal('atómica C')];
  const attempts = await Promise.all(candidates.map((item) => reservePolyTelegram(db, [item], {
    date: DAY, nowSec: NOW,
  })));
  const reservations = attempts.flatMap((result) => result.reservations);
  assert.equal(reservations.length, 2);
  assert.deepEqual(db.rows.filter((row) => row.et_date === DAY).map((row) => row.slot).sort(), [1, 2]);

  await completePolyTelegramReservations(db, [reservations[0]], {
    sentAt: new Date(NOW * 1000).toISOString(), messageId: 77,
  });
  await failPolyTelegramReservations(db, [reservations[1]], {
    failedAt: new Date(NOW * 1000).toISOString(), error: 'Telegram 429', definitive: true,
  });
  const retry = await reservePolyTelegram(db, [candidates[2]], { date: DAY, nowSec: NOW + 60 });
  assert.equal(retry.reservations.length, 1);
  assert.equal(db.rows.find((row) => row.reservation_id === retry.reservations[0].reservation_id).slot, 2);

  // A sent market stays deduplicated after the ET date changes.
  const duplicateNextDay = await reservePolyTelegram(db, [reservations[0].item], {
    date: '2026-07-22', nowSec: NOW + 86400,
  });
  assert.equal(duplicateNextDay.reservations.length, 0);

  // An ambiguous failure keeps its physical slot; it is never released into a
  // possible duplicate or third notification.
  await failPolyTelegramReservations(db, retry.reservations, {
    failedAt: new Date((NOW + 120) * 1000).toISOString(), error: 'timeout', definitive: false,
  });
  assert.equal(db.rows.find((row) => row.reservation_id === retry.reservations[0].reservation_id).status, 'unknown');
});

test('el Worker nuevo guarda silencio durante el solapamiento de cutover', async () => {
  const db = new AtomicTelegramD1({ cutoverBlocked: true });
  const result = await reservePolyTelegram(db, [signal('cutover')], { date: DAY, nowSec: NOW });
  assert.equal(result.reservations.length, 0);
  assert.equal(db.rows.length, 0);
});

test('la transición cuenta alertas legacy y nunca puede producir una tercera', async () => {
  const db = new AtomicTelegramD1();
  const legacy = {
    date: DAY, sent: 1, max_per_day: 2, policy: 'rare_v1',
    notified: { 'legacy|Yes': NOW - 60 },
  };
  const legacySlots = polyTelegramLegacySlots(legacy, DAY);
  assert.equal(legacySlots, 1);

  const attempts = await Promise.all([
    reservePolyTelegram(db, [signal('transición A')], { date: DAY, nowSec: NOW, usedBefore: legacySlots }),
    reservePolyTelegram(db, [signal('transición B')], { date: DAY, nowSec: NOW, usedBefore: legacySlots }),
  ]);
  const reservations = attempts.flatMap((result) => result.reservations);
  assert.equal(reservations.length, 1);
  assert.equal(db.rows[0].slot, 2);

  const gated = polyTelegramGate([signal('transición A')], legacy, { nowSec: NOW, date: DAY });
  const state = polyTelegramStateAfterReservations(gated, [], { legacySlots });
  assert.equal(state.legacy_slots, 1);
  assert.equal(polyTelegramLegacySlots(state, DAY), 1);
  assert.equal(polyTelegramLegacySlots(state, '2026-07-22'), 0);
});

test('la proyección KV cuenta solo reservas admitidas por D1', () => {
  const gated = polyTelegramGate([signal('admitida'), signal('rechazada')], null, { nowSec: NOW, date: DAY });
  const state = polyTelegramStateAfterReservations(gated, [gated.items[0]]);
  assert.equal(state.sent, 1);
  assert.equal(state.policy, 'rare_v2_d1_atomic');
  assert.equal(state.notified['admitida|Yes'], NOW);
  assert.equal(state.notified['rechazada|Yes'], undefined);
});

test('gate deduplica por mercado siete días aun al cambiar de fecha', () => {
  const first = polyTelegramGate([signal('única')], null, { nowSec: NOW, date: DAY });
  const nextDay = polyTelegramGate([signal('única', { last_ts: NOW + 86400 - 60 })], first.state, {
    nowSec: NOW + 86400, date: '2026-07-22',
  });
  assert.deepEqual(nextDay.items, []);
  assert.equal(nextDay.state.sent, 0);
});

test('un rechazo de Telegram libera cupo y consenso para reintento', () => {
  const item = signal('reintentar', { prevN: 2 });
  const gated = polyTelegramGate([item], null, { nowSec: NOW, date: DAY });
  const key = 'reintentar|Yes';
  const rollback = polyTelegramRollback(gated.state, { [key]: 3 }, gated.items, '2026-07-21T12:00:00Z', new Error('HTTP 429'));
  assert.equal(rollback.telegram.sent, 0);
  assert.equal(rollback.telegram.notified[key], undefined);
  assert.equal(rollback.telegram.last_error, 'HTTP 429');
  assert.equal(rollback.cons_notified[key], 2);
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
