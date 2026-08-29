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
  const doc = { date: '2026-07-22', events: [{ start: '2026-07-22T17:00:00Z', prediction: { pick: null, prob: null }, pending: true }] }
  const decision = await decideMorningRun({
    eventName: 'schedule', schedule: WATCHDOG_CRON, now: at('2026-07-22T11:27:00Z'),
    fetchImpl: async () => response(doc),
  })
  assert.equal(decision.run, true)
  assert.equal(decision.reason, 'all_predictions_pending')
})

test('watchdog se apaga cuando ya existe al menos una predicción AA válida', async () => {
  const doc = { date: '2026-07-22', events: [
    { start: '2026-07-22T17:00:00Z', prediction: { pick: 'NYY', prob: 0.57 } },
    { start: '2026-07-22T20:00:00Z', prediction: { pick: null, prob: null }, pending: true },
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
  assert.match(early.reason, /before_publication_window:6/)
})

test('workflow_run independiente repara un cron perdido a las 9:19am ET', async () => {
  const doc = { date: '2026-08-29', events: [
    { start: '2026-08-29T17:05:00Z', prediction: { pick: null, prob: null }, pending: true },
    { start: '2026-08-29T23:15:00Z', prediction: { pick: null, prob: null }, pending: true },
  ] }
  const decision = await decideMorningRun({
    eventName: 'workflow_run', schedule: '', now: at('2026-08-29T13:19:00Z'),
    fetchImpl: async () => response(doc),
  })
  assert.equal(decision.run, true)
  assert.equal(decision.reason, 'all_predictions_pending')
  assert.equal(decision.future, 2)
})

test('repair tardío se detiene cuando ya no quedan juegos futuros', async () => {
  const doc = { date: '2026-08-29', events: [
    { start: '2026-08-29T12:00:00Z', prediction: { pick: null, prob: null }, pending: true },
  ] }
  const decision = await decideMorningRun({
    eventName: 'workflow_run', now: at('2026-08-29T13:19:00Z'), fetchImpl: async () => response(doc),
  })
  assert.equal(decision.run, false)
  assert.equal(decision.reason, 'no_future_games')
})

test('un día MLB sin juegos no crea reparaciones ni picks sintéticos', async () => {
  const decision = await decideMorningRun({
    eventName: 'workflow_run', now: at('2026-08-29T13:19:00Z'),
    fetchImpl: async () => response({ date: '2026-08-29', events: [] }),
  })
  assert.equal(decision.run, false)
  assert.equal(decision.reason, 'no_games')
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
