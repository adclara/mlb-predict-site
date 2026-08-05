import test from 'node:test';
import assert from 'node:assert/strict';

import { assessUsSportsPipeline } from '../robot/lib/us_sports_qa.mjs';

test('off-season empty slate degrades a pipeline error to warning', () => {
  const result = assessUsSportsPipeline({
    live: { games: [] }, today: { events: [] },
    health: { ok: false, state: 'error', age_seconds: 738 },
  });
  assert.equal(result.level, 'warning');
});

test('a scheduled game keeps pipeline failure fatal', () => {
  const result = assessUsSportsPipeline({
    live: { games: [{ id: 'game-1' }] }, today: { events: [{ id: 'game-1' }] },
    health: { ok: false, state: 'error', age_seconds: 738 },
  });
  assert.equal(result.level, 'error');
});

test('an upstream live failure is never mistaken for an empty off-season slate', () => {
  const result = assessUsSportsPipeline({
    live: { games: [], note: 'live upstream 403' }, today: { events: [] },
    health: { ok: false, state: 'error', age_seconds: 738 },
  });
  assert.equal(result.level, 'error');
});
