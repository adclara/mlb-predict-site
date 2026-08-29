import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIntelligenceHealth } from '../robot/intelligence_health_check.mjs';

const sample = (asOf) => ({ version: 'intelligence_v2', as_of: asOf, state: 'fresh', freshness: { hard_stale: false },
  slate: [{ probability: { value: .61 } }], alerts: false, telegram: false });

test('health gate accepts a fresh safe Central snapshot', () => {
  const now = Date.parse('2026-08-29T12:00:00Z'), result = evaluateIntelligenceHealth(sample('2026-08-29T11:35:00Z'), { nowMs: now });
  assert.equal(result.ok, true); assert.equal(result.age_minutes, 25);
});

test('health gate rejects stale, malformed, low-probability, or alert-enabled documents', () => {
  const now = Date.parse('2026-08-29T12:00:00Z'), doc = sample('2026-08-29T10:00:00Z');
  doc.version = 'intelligence_v1'; doc.slate[0].probability.value = .59; doc.alerts = true;
  const result = evaluateIntelligenceHealth(doc, { nowMs: now });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ['schema', 'stale', 'alerts_enabled', 'probability_floor']);
});
