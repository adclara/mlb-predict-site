import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/market-intelligence.yml', import.meta.url), 'utf8');
const walletWorkflow = readFileSync(new URL('../.github/workflows/poly-wallet-profiles.yml', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const publisher = readFileSync(new URL('../robot/market_intelligence.mjs', import.meta.url), 'utf8');

test('intelligence workflow has independent redundant triggers and self-dedupes at 30 minutes', () => {
  assert.match(workflow, /cron: '7,22,37,52 \* \* \* \*'/);
  assert.match(workflow, /workflow_run:[\s\S]*soccer-shadow[\s\S]*wnba-shadow[\s\S]*US sports freshness QA/);
  assert.doesNotMatch(workflow, /workflows:\s*\[[^\]]*adrian-daily/);
  assert.doesNotMatch(workflow, /data\/history\/\*\*/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /AA_INTELLIGENCE_MIN_AGE_MINUTES: '30'/);
  assert.match(workflow, /AA_INTELLIGENCE_FORCE/);
  assert.doesNotMatch(workflow, /17 6 \* \* \*/);
  assert.match(walletWorkflow, /cron: '17 6 \* \* \*'/);
  assert.match(walletWorkflow, /poly_wallet_profiles\.mjs/);
});

test('publication and deploy both enforce the production freshness gate', () => {
  assert.match(workflow, /intelligence_health_check\.mjs --max-age=45/);
  assert.match(deploy, /intelligence_health_check\.mjs --max-age=45/);
  assert.match(deploy, /AA_INTELLIGENCE_TRIGGER: deploy[\s\S]*market_intelligence\.mjs/);
  assert.match(deploy, /tests\/intelligence_health\.test\.mjs/);
});

test('latest KV is a commit marker written after history and D1', () => {
  const publish = publisher.slice(publisher.indexOf('async function publish'), publisher.indexOf('export async function run'));
  assert.ok(publish.indexOf('intelligence:day:') < publish.indexOf('market_intelligence_snapshots'));
  assert.ok(publish.indexOf('market_intelligence_snapshots') < publish.indexOf('values/intelligence%3Atoday'));
  assert.match(publish, /kv_readback_mismatch/);
});
