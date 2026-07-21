import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldPublishLatest } from '../cloudflare/upload.mjs'

test('mlb:today acepta exclusivamente la fecha ET actual', () => {
  assert.equal(shouldPublishLatest('2026-07-21', '2026-07-20', '2026-07-21'), false)
  assert.equal(shouldPublishLatest('2026-07-20', '2026-07-21', '2026-07-21'), true)
  assert.equal(shouldPublishLatest('2026-07-21', '2026-07-22', '2026-07-21'), false)
})

test('la fecha correcta repara un KV remoto futuro; candidato inválido no', () => {
  assert.equal(shouldPublishLatest('2026-07-22', '2026-07-21', '2026-07-21'), true)
  assert.equal(shouldPublishLatest(null, '2026-07-21', '2026-07-21'), true)
  assert.equal(shouldPublishLatest('2026-07-21', 'ayer', '2026-07-21'), false)
})
