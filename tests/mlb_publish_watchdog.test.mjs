import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WATCHDOG_CRON,
  decideMorningRun,
  publicationState,
} from '../robot/mlb_publish_watchdog.mjs'

const response = (doc, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => doc })
const at = (iso) => new Date(iso)

test('watchdog repara el slate de hoy si todas las predicciones siguen pendientes', async () => {
  const doc = { date: '2026-07-22', events: [{ prediction: { pick: null, prob: null }, pending: true }] }
  const decision = await decideMorningRun({
    eventName: 'schedule', schedule: WATCHDOG_CRON, now: at('2026-07-22T11:27:00Z'),
    fetchImpl: async () => response(doc),
  })
  assert.equal(decision.run, true)
  assert.equal(decision.reason, 'all_predictions_pending')
})

test('watchdog se apaga cuando ya existe al menos una predicción AA válida', async () => {
  const doc = { date: '2026-07-22', events: [
    { prediction: { pick: 'NYY', prob: 0.57 } },
    { prediction: { pick: null, prob: null }, pending: true },
  ] }
  const decision = await decideMorningRun({
    eventName: 'schedule', schedule: WATCHDOG_CRON, now: at('2026-07-22T11:42:00Z'),
    fetchImpl: async () => response(doc),
  })
  assert.equal(decision.run, false)
  assert.equal(decision.reason, 'already_published')
})

test('watchdog repara fecha vieja, falla abierto en red y no corre antes de 7am ET', async () => {
  assert.equal(publicationState({ date: '2026-07-21', events: [] }, '2026-07-22').needsRun, true)
  const failed = await decideMorningRun({
    eventName: 'schedule', schedule: WATCHDOG_CRON, now: at('2026-07-22T11:57:00Z'),
    fetchImpl: async () => { throw new Error('network_down') },
  })
  assert.equal(failed.run, true)
  assert.match(failed.reason, /preflight_failed/)
  const early = await decideMorningRun({
    eventName: 'schedule', schedule: WATCHDOG_CRON, now: at('2026-12-22T11:12:00Z'),
    fetchImpl: async () => { throw new Error('should_not_fetch') },
  })
  assert.equal(early.run, false)
  assert.match(early.reason, /outside_morning_window:6/)
})

test('cron horario, poke y manual conservan el comportamiento normal', async () => {
  for (const input of [
    { eventName: 'schedule', schedule: '7 * * * *' },
    { eventName: 'push', schedule: '' },
    { eventName: 'workflow_dispatch', schedule: '' },
  ]) {
    const decision = await decideMorningRun({ ...input, fetchImpl: async () => { throw new Error('unused') } })
    assert.equal(decision.run, true)
    assert.equal(decision.reason, 'regular_hourly_or_manual')
  }
})
