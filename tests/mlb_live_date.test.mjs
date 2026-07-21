import test from 'node:test';
import assert from 'node:assert/strict';

import { mlbLiveEventsForDate, mlbScoreboardUrl } from '../cloudflare/worker/index.js';

test('MLB live consulta explícitamente el día ET solicitado', () => {
  assert.equal(
    mlbScoreboardUrl('2026-07-21'),
    'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20260721&limit=100',
  );
});

test('MLB live descarta ayer y conserva juegos nocturnos del mismo día ET', () => {
  const data = {
    events: [
      { id: 'yesterday', date: '2026-07-20T23:00:00Z' },
      { id: 'today', date: '2026-07-21T22:40:00Z' },
      // 22:10 ET del 21 de julio aunque en UTC ya sea día 22.
      { id: 'today-night', date: '2026-07-22T02:10:00Z' },
      { id: 'tomorrow', date: '2026-07-22T17:00:00Z' },
      { id: 'invalid', date: null },
    ],
  };

  assert.deepEqual(
    mlbLiveEventsForDate(data, '2026-07-21').map((event) => event.id),
    ['today', 'today-night'],
  );
});

test('MLB live falla cerrado ante un documento sin eventos', () => {
  assert.deepEqual(mlbLiveEventsForDate(null, '2026-07-21'), []);
  assert.deepEqual(mlbLiveEventsForDate({}, '2026-07-21'), []);
});
