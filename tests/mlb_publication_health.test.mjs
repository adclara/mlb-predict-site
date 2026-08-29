import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateMlbPublicationHealth } from '../robot/mlb_publication_health_check.mjs'
import { mlbPublicationStatus } from '../cloudflare/worker/index.js'

const event = (start, prediction = { pick: null, prob: null }) => ({ start, prediction, pending: !prediction?.pick })

test('antes de 7am ET un slate pendiente es espera honesta, no fallo', () => {
  const doc = { date: '2026-08-29', events: [event('2026-08-29T17:05:00Z')] }
  const health = evaluateMlbPublicationHealth(doc, { now: new Date('2026-08-29T10:30:00Z') })
  assert.equal(health.ok, true)
  assert.equal(health.state, 'waiting')
})

test('después de 7am ET falla si hay juegos futuros y todas las predicciones siguen pendientes', () => {
  const doc = { date: '2026-08-29', events: [event('2026-08-29T17:05:00Z'), event('2026-08-29T23:15:00Z')] }
  const health = evaluateMlbPublicationHealth(doc, { now: new Date('2026-08-29T13:19:00Z') })
  assert.equal(health.ok, false)
  assert.equal(health.state, 'overdue')
  assert.equal(health.reason, 'all_predictions_pending')
  assert.equal(health.future, 2)
})

test('una predicción causal publicada satisface el gate y un slate terminado no fabrica un fallo', () => {
  const now = new Date('2026-08-29T13:19:00Z')
  const published = { date: '2026-08-29', events: [event('2026-08-29T17:05:00Z', { pick: 'NYY', prob: .57 })] }
  assert.equal(evaluateMlbPublicationHealth(published, { now }).state, 'published')
  const closed = { date: '2026-08-29', events: [event('2026-08-29T12:00:00Z')] }
  assert.equal(evaluateMlbPublicationHealth(closed, { now }).state, 'closed')
})

test('fecha equivocada nunca pasa el gate', () => {
  const health = evaluateMlbPublicationHealth({ date: '2026-08-28', events: [] }, { now: new Date('2026-08-29T13:19:00Z') })
  assert.equal(health.ok, false)
  assert.equal(health.state, 'wrong_date')
})

test('Worker expone waiting, overdue y published sin inventar una predicción', () => {
  const doc = { date: '2026-08-29', events: [event('2026-08-29T17:05:00Z')] }
  assert.equal(mlbPublicationStatus(doc, new Date('2026-08-29T10:30:00Z')).state, 'waiting')
  const overdue = mlbPublicationStatus(doc, new Date('2026-08-29T13:19:00Z'))
  assert.equal(overdue.state, 'overdue')
  assert.equal(overdue.predictions, 0)
  doc.events[0].prediction = { pick: 'NYY', prob: .57 }
  assert.equal(mlbPublicationStatus(doc, new Date('2026-08-29T13:19:00Z')).state, 'published')
})

test('horarios inválidos fallan cerrado después de 7am', () => {
  const doc = { date: '2026-08-29', events: [event(null)] }
  const health = evaluateMlbPublicationHealth(doc, { now: new Date('2026-08-29T13:19:00Z') })
  assert.equal(health.ok, false)
  assert.equal(health.reason, 'invalid_start_times')
  assert.equal(mlbPublicationStatus(doc, new Date('2026-08-29T13:19:00Z')).state, 'invalid')
})
