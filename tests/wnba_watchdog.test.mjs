import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basketballDate, basketballNextDate } from '../cloudflare/lib/basketball_health.mjs';
import { recordHeartbeat } from '../robot/basketball_heartbeat.mjs';
import { RECOVERY_SOURCES, trustedRecoveryTrigger, decideWnbaRecovery,
  recoveryPreflight, readWnbaHeartbeat, validateWnbaReadback, verifyWnbaCompletion } from '../robot/wnba_watchdog.mjs';
const NOW = Date.parse('2026-09-27T13:15:00Z');
const iso = age => new Date(NOW - age * 60000).toISOString();
function evidence(runId = '42.1', minutes = 2, games = 4) {
  const date = basketballDate(NOW);
  return { schema: 'aa-basketball-capture-v1', sport: 'wnba', complete: true,
    source_failures: 0, run_id: runId,
    schedule: [date, basketballNextDate(date)].map(date => ({ date,
      source: 'espn', complete: true, checked_at: iso(minutes), events: games,
      eligible_pregame: games, logged: games })) };
}
function heartbeat(minutes = 2, games = 4) {
  return { sport: 'wnba', run_id: '42.1', attempt_status: 'success',
    last_success_at: iso(minutes), attempt_started_at: iso(minutes + 1),
    evidence_json: JSON.stringify(evidence('42.1', minutes, games)) };
}
function trigger(name = 'schedule') {
  return { eventName: name, ref: 'refs/heads/main', repository: 'adclara/mlb-predict-site',
    event: { action: 'completed', workflow_run: { name: 'soccer-shadow', head_branch: 'main',
      status: 'completed', conclusion: 'success', event: 'schedule',
      repository: { id: 1288902452 }, head_repository: { id: 1288902452 } } } };
}
function health(h = heartbeat()) {
  return { schema: 'aa-basketball-producer-health-v1', sport: 'wnba', producer_status: 'healthy',
    last_attempt_status: 'success', last_success_at: h.last_success_at,
    schedule_status: 'verified', schedule_date: basketballDate(NOW), state: 'active',
    scheduled_games: 4, pending_grading_count: 0, prediction_status: 'stale' };
}
const queryFor = h => async () => ({ results: h ? [h] : [] });

test('main-only direct triggers and allowlisted independent completions are admitted', () => {
  for (const type of ['schedule', 'push', 'workflow_dispatch', 'workflow_run']) assert.equal(trustedRecoveryTrigger(trigger(type)), true);
  for (const name of RECOVERY_SOURCES) {
    const t = trigger('workflow_run'); t.event.workflow_run.name = name;
    assert.equal(trustedRecoveryTrigger(t), true);
  }
});
test('forks, branches, PR events, failed sources and completion loops are rejected', () => {
  const changes = [t => t.ref = 'refs/heads/feature', t => t.repository = 'other/repo',
    t => t.eventName = 'pull_request', t => t.event.action = 'requested',
    t => t.event.workflow_run.head_branch = 'feature', t => t.event.workflow_run.conclusion = 'failure',
    t => t.event.workflow_run.status = 'in_progress', t => t.event.workflow_run.head_repository.id = 1,
    t => delete t.event.workflow_run.repository, t => t.event.workflow_run.event = 'pull_request',
    t => t.event.workflow_run.event = 'workflow_run', t => t.event.workflow_run.name = 'wnba-shadow',
    t => t.event.workflow_run.name = 'market-intelligence', t => t.event.workflow_run.name = 'adrian-daily'];
  for (const change of changes) { const t = trigger('workflow_run'); change(t); assert.equal(trustedRecoveryTrigger(t), false); }
});
test('rejected trigger performs no D1 access', async () => {
  const t = trigger('workflow_run'); t.event.workflow_run.head_repository.id = 9;
  const result = await recoveryPreflight({ trigger: t, now: NOW, query: () => { throw new Error('must not read'); } });
  assert.equal(result.reason, 'untrusted_trigger'); assert.equal(result.run, false);
});
test('fresh verified no-game day skips without consulting prediction age or gates', () => {
  const h = heartbeat(10, 0); h.prediction_updated_at = '2020-01-01'; h.gate = { public: false };
  const before = JSON.stringify(h), result = decideWnbaRecovery(h, NOW);
  assert.equal(result.run, false); assert.equal(result.reason, 'recent_verified_producer_success');
  assert.equal(result.producer_executed, false); assert.equal(JSON.stringify(h), before);
});
test('active and pending-grading observations preserve the hourly producer cadence', () => {
  const h = heartbeat(59); h.pending_grading_count = 3;
  assert.equal(decideWnbaRecovery(h, NOW).run, false);
  assert.equal(decideWnbaRecovery(heartbeat(60), NOW).run, true);
});
test('the five-hour scheduler gap is repaired despite fresh prediction rows', () => {
  const h = heartbeat(300); h.prediction_updated_at = iso(0);
  const result = decideWnbaRecovery(h, NOW);
  assert.equal(result.reason, 'producer_refresh_due'); assert.equal(result.producer_age_seconds, 18000);
  assert.equal(result.run, true);
});
test('missing, invalid and future successful timestamps require recovery', () => {
  for (const timestamp of [null, '', 'broken', iso(-2)]) {
    const h = heartbeat(); h.last_success_at = timestamp;
    assert.equal(decideWnbaRecovery(h, NOW).run, true);
  }
  assert.equal(decideWnbaRecovery(null, NOW).run, true);
});
test('fresh rows cannot hide invalid calendar evidence or mismatched run identity', () => {
  for (const change of [e => e.complete = false, e => e.source_failures = 1,
    e => e.run_id = 'old', e => e.schedule[0].date = '2026-09-26',
    e => e.schedule[0].logged = 0]) {
    const h = heartbeat(), e = JSON.parse(h.evidence_json); change(e); h.evidence_json = JSON.stringify(e);
    assert.equal(decideWnbaRecovery(h, NOW).reason, 'schedule_evidence_unverified');
  }
});
test('date rollover requires new calendar evidence even on a recently successful producer', () => {
  const midnight = Date.parse('2026-09-28T04:01:00Z');
  const h = heartbeat(); h.last_success_at = new Date(midnight - 120000).toISOString();
  assert.equal(decideWnbaRecovery(h, midnight).run, true);
});
test('in-flight attempts are not cancelled or overlapped, even by an operator poke', () => {
  const h = heartbeat(); h.attempt_status = 'running'; h.attempt_started_at = iso(5);
  assert.equal(decideWnbaRecovery(h, NOW, { force: true }).reason, 'producer_attempt_in_progress');
  h.attempt_started_at = iso(26); assert.equal(decideWnbaRecovery(h, NOW).run, true);
});
test('failed attempts use a bounded cooldown without becoming healthy', () => {
  const h = heartbeat(); h.attempt_status = 'failed'; h.attempt_started_at = iso(5);
  assert.equal(decideWnbaRecovery(h, NOW).reason, 'failed_attempt_retry_cooldown');
  assert.equal(decideWnbaRecovery(h, NOW).producer_attempt_status, 'failed');
  h.attempt_started_at = iso(15); assert.equal(decideWnbaRecovery(h, NOW).run, true);
});
test('read failure attempts the strict producer instead of claiming health', async () => {
  const result = await recoveryPreflight({ trigger: trigger(), now: NOW, query: async () => { throw new Error('D1 outage'); } });
  assert.equal(result.run, true); assert.equal(result.reason, 'heartbeat_read_unavailable');
  assert.equal(result.producer_executed, false);
});
test('read-only heartbeat query validates sport and shape', async () => {
  let statement;
  await readWnbaHeartbeat(async (sql, params) => { statement = sql; assert.deepEqual(params, ['wnba']); return { results: [] }; });
  assert.match(statement, /^SELECT /); assert.doesNotMatch(statement, /INSERT|UPDATE|DELETE/);
  for (const response of [{}, { results: [heartbeat(), heartbeat()] }, { results: [{ sport: 'nba' }] }])
    await assert.rejects(readWnbaHeartbeat(async () => response));
});
test('explicit operator trigger can recover immediately without altering policy', async () => {
  const result = await recoveryPreflight({ trigger: trigger('push'), query: queryFor(heartbeat()), now: NOW });
  assert.equal(result.run, true); assert.equal(result.reason, 'explicit_operator_trigger');
});
test('post-run readback accepts idle and pending grading without inventing prediction freshness', () => {
  const h = heartbeat();
  for (const state of ['active', 'idle_no_games', 'pending_grading']) {
    const body = health(h); body.state = state; body.pending_grading_count = state === 'pending_grading' ? 2 : 0;
    const result = validateWnbaReadback(h, body, '42.1', NOW);
    assert.equal(result.producer_executed, true); assert.equal(result.prediction_status, 'stale');
    assert.equal(result.pending_grading_count, body.pending_grading_count);
  }
});
test('old, malformed, failed or unrelated readback cannot verify a producer', () => {
  const h = heartbeat();
  for (const change of [b => b.last_success_at = iso(9), b => b.producer_status = 'failed',
    b => b.last_attempt_status = 'running', b => b.schedule_status = 'unverified',
    b => b.sport = 'nba', b => b.pending_grading_count = null, b => b.schedule_date = '2026-09-26']) {
    const body = health(h); change(body); assert.throws(() => validateWnbaReadback(h, body, '42.1', NOW));
  }
  assert.throws(() => validateWnbaReadback(h, health(h), '43.1', NOW));
  assert.throws(() => validateWnbaReadback(heartbeat(11), health(heartbeat(11)), '42.1', NOW));
});
test('public readback retries a stale cache and succeeds only on exact completion', async () => {
  const h = heartbeat(); let calls = 0;
  const result = await verifyWnbaCompletion({ query: queryFor(h), runId: '42.1', clock: () => NOW, pause: async () => {},
    fetcher: async (url, options) => { assert.match(url, /recovery_run=42.1/); assert.equal(options.redirect, 'error');
      calls++; const body = health(h); if (calls < 3) body.last_success_at = iso(9);
      return new Response(JSON.stringify(body)); } });
  assert.equal(calls, 3); assert.equal(result.last_success_at, h.last_success_at);
});
test('persistent public API outage is a visible verification failure, never success', async () => {
  let calls = 0;
  await assert.rejects(verifyWnbaCompletion({ query: queryFor(heartbeat()), runId: '42.1', clock: () => NOW,
    pause: async () => {}, fetcher: async () => { calls++; throw new Error('network'); } }), /readback_failed/);
  assert.equal(calls, 4);
});
test('SQLite lifecycle: stale -> actual capture success -> independent wake skips with no write', async () => {
  const db = new DatabaseSync(':memory:');
  const query = async (sql, params) => {
    if (/^SELECT/.test(sql)) return { results: db.prepare(sql).all(...params) };
    if (/^\s*(--[^\n]*\n)*\s*CREATE TABLE/.test(sql)) { db.exec(sql); return { meta: { changes: 0 } }; }
    return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
  };
  try {
    await recordHeartbeat({ sport: 'wnba', phase: 'begin', runId: '41.1', now: iso(310), query });
    await recordHeartbeat({ sport: 'wnba', phase: 'success', runId: '41.1', now: iso(300), query, evidence: evidence('41.1', 300) });
    assert.equal((await recoveryPreflight({ trigger: trigger('workflow_run'), now: NOW, query })).run, true);
    await recordHeartbeat({ sport: 'wnba', phase: 'begin', runId: '42.1', now: iso(3), query });
    await recordHeartbeat({ sport: 'wnba', phase: 'success', runId: '42.1', now: iso(1), query, evidence: evidence() });
    const before = JSON.stringify(await readWnbaHeartbeat(query));
    for (let i = 0; i < 3; i++) assert.equal((await recoveryPreflight({ trigger: trigger('workflow_run'), now: NOW, query })).run, false);
    assert.equal(JSON.stringify(await readWnbaHeartbeat(query)), before);
  } finally { db.close(); }
});
test('workflow preserves gates, singleton concurrency, trusted checkout and gated costly steps', () => {
  const text = readFileSync(new URL('../.github/workflows/wnba-shadow.yml', import.meta.url), 'utf8');
  assert.match(text, /cron: '11,31,51 \* \* \* \*'/);
  assert.match(text, /group: wnba-shadow\s+cancel-in-progress: false/);
  assert.match(text, /ref: main\s+persist-credentials: false/);
  assert.match(text, /contents: read/); assert.doesNotMatch(text, /contents: write|pull_request_target|workflow_run.head_sha/);
  assert.match(text, /AA_REQUIRE_PRODUCER_EVIDENCE: '1'/);
  assert.match(text, /if: steps.recovery.outputs.run == 'true' && \(github.event_name == 'push' \|\| github.event_name == 'workflow_dispatch'\)/);
  assert.ok(text.indexOf('wnba_watchdog.mjs preflight') < text.indexOf('basketball_heartbeat.mjs begin wnba'));
  assert.ok(text.indexOf('basketball_heartbeat.mjs success wnba') > text.indexOf('wnba_publish_simulation.mjs'));
  assert.ok(text.indexOf('wnba_watchdog.mjs verify') > text.indexOf('basketball_heartbeat.mjs success wnba'));
});
