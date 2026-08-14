import test from 'node:test'
import assert from 'node:assert/strict'
import { etDate, learningDecision, verifyLearningSnapshot } from '../robot/mlb_learning_guard.mjs'

const now = new Date('2026-08-13T10:45:00Z') // 06:45 ET: cron atrasado fuera de 05:xx

test('cron atrasado corre si el snapshot todavía es de ayer', () => {
  const got = learningDecision({ eventName: 'schedule', now, snapshot: { updated_at: '2026-08-12T09:37:00Z' } })
  assert.equal(got.run, true)
  assert.match(got.reason, /^snapshot_from_/)
})

test('segunda expresión UTC no repite un refit ya hecho hoy ET', () => {
  const got = learningDecision({ eventName: 'schedule', now, snapshot: { updated_at: '2026-08-13T09:55:00Z' } })
  assert.deepEqual(got, { run: false, reason: 'already_refit_2026-08-13' })
})

test('poke y manual siempre ejecutan aunque el snapshot sea de hoy', () => {
  for (const eventName of ['push', 'workflow_dispatch']) {
    assert.equal(learningDecision({ eventName, now, snapshot: { updated_at: now.toISOString() } }).run, true)
  }
})

test('snapshot ausente o inválido se recupera ejecutando', () => {
  assert.equal(learningDecision({ eventName: 'schedule', now, snapshot: null }).run, true)
  assert.equal(learningDecision({ eventName: 'schedule', now, snapshot: { updated_at: 'bad' } }).run, true)
})

test('verificación exige timestamp ET de hoy, muestra y last_date válidos', () => {
  const ok = verifyLearningSnapshot({ updated_at: '2026-08-13T10:00:00Z', n_graded: 1603, last_date: '2026-08-12' }, { now })
  assert.equal(ok.ok, true)
  const bad = verifyLearningSnapshot({ updated_at: '2026-08-12T10:00:00Z', n_graded: 0, last_date: null }, { now })
  assert.equal(bad.ok, false)
  assert.equal(bad.errors.length, 3)
})

test('fecha ET no cambia prematuramente a medianoche UTC', () => {
  assert.equal(etDate('2026-08-14T01:30:00Z'), '2026-08-13')
})
