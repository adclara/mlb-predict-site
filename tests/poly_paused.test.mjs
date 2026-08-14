import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import worker from '../cloudflare/worker/index.js';

test('todas las rutas públicas de Radar fallan cerradas sin tocar datos ni red', async () => {
  let reads = 0;
  const env = {
    ALLOWED_ORIGIN: '*',
    AA_LATEST: { async get() { reads++; throw new Error('Radar no debe leer KV'); } },
    DB: { prepare() { reads++; throw new Error('Radar no debe leer D1'); } },
  };
  const originalFetch = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = async () => { upstream++; throw new Error('Radar no debe llamar upstream'); };
  try {
    for (const route of ['radar', 'alerts', 'track', 'wallet?addr=0x0000000000000000000000000000000000000000']) {
      const response = await worker.fetch(new Request(`https://api.test/v1/poly/${route}`), env, { waitUntil() {} });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: false, paused: true, state: 'paused', reason: 'operator_paused',
      });
    }
    assert.equal(reads, 0);
    assert.equal(upstream, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('crons antiguos de Radar se ignoran sin programar trabajo', async () => {
  for (const cron of ['*/5 * * * *', '0 13 * * *']) {
    let scheduled = 0;
    await worker.scheduled({ cron, scheduledTime: Date.now() }, {}, { waitUntil() { scheduled++; } });
    assert.equal(scheduled, 0);
  }
});

test('deploy no exige crons Radar ni configura Telegram', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /CRON RADAR AÚN ACTIVO/);
  assert.doesNotMatch(workflow, /wrangler@[^\n]+ secret put TG_BOT_TOKEN/);
  assert.doesNotMatch(workflow, /api\.telegram\.org/);
  assert.doesNotMatch(workflow, /UPDATE poly_telegram_policy/);
});
