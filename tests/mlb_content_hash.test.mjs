import test from 'node:test'
import assert from 'node:assert/strict'

import { semanticContentHash } from '../cloudflare/lib/content_hash.mjs'

test('hash semántico ignora timestamps de transporte anidados', () => {
  const a = {
    date: '2026-07-21', updated_at: '2026-07-21T12:00:00Z', content_hash: 'old',
    events: [{ event_id: '1', updated_at: '2026-07-21T12:00:00Z', status: 'pre', odds: { ml_home: -120 } }],
  }
  const b = {
    ...a, updated_at: '2026-07-21T13:00:00Z', content_hash: 'different',
    events: [{ ...a.events[0], updated_at: '2026-07-21T13:00:00Z' }],
  }
  assert.equal(semanticContentHash(a), semanticContentHash(b))
  assert.notEqual(semanticContentHash(a), semanticContentHash({ ...b, events: [{ ...b.events[0], odds: { ml_home: -125 } }] }))
})
