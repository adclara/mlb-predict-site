// WNBA recovery control. Reads producer evidence, never prediction-row age.
// A skipped wakeup does not write a heartbeat or approve any model.
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basketballDate, validateBasketballEvidence } from '../cloudflare/lib/basketball_health.mjs';
import { heartbeatQuery } from './basketball_heartbeat.mjs';

export const RECOVERY_SOURCES = Object.freeze([
  'mlb-live-observer', 'soccer-shadow', 'US sports freshness QA', 'nba-shadow',
]);
export const RECOVERY_POLICY = Object.freeze({
  intervalMs: 3600000, retryMs: 900000, runningGraceMs: 1500000,
});
const REPO = 'adclara/mlb-predict-site';
const REPO_ID = 1288902452;
const API = 'https://aa-sports-api.opsmira9.workers.dev/v1/wnba/pipeline-health';
const elapsed = (value, now) => {
  const timestamp = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp <= now ? now - timestamp : null;
};

// Check identity before reading credentials or allowing a producer attempt.
// Never check out an upstream workflow's SHA or consume its artifacts.
export function trustedRecoveryTrigger({ eventName, ref, repository, event = {} }) {
  if (ref !== 'refs/heads/main' || repository !== REPO) return false;
  if (['schedule', 'push', 'workflow_dispatch'].includes(eventName)) return true;
  const run = event.workflow_run;
  return eventName === 'workflow_run' && event.action === 'completed'
    && run?.status === 'completed' && run.conclusion === 'success'
    && run.head_branch === 'main' && RECOVERY_SOURCES.includes(run.name)
    && ['schedule', 'push', 'workflow_dispatch'].includes(run.event)
    && run.repository?.id === REPO_ID && run.head_repository?.id === REPO_ID;
}

export function verifiedWnbaEvidence(heartbeat, now = Date.now()) {
  let evidence;
  try { evidence = JSON.parse(heartbeat?.evidence_json); } catch { return false; }
  return evidence?.run_id === heartbeat?.run_id
    && validateBasketballEvidence(evidence, 'wnba', now);
}

export function decideWnbaRecovery(heartbeat, now = Date.now(), { force = false } = {}) {
  if (!Number.isFinite(now)) throw new Error('watchdog_invalid_clock');
  const lastSuccessAge = elapsed(heartbeat?.last_success_at, now);
  const attemptAge = elapsed(heartbeat?.attempt_started_at, now);
  const status = heartbeat?.attempt_status || 'unknown';
  const decision = (run, reason) => ({
    run, reason, observed_at: new Date(now).toISOString(),
    producer_attempt_status: status, last_success_at: heartbeat?.last_success_at ?? null,
    producer_age_seconds: lastSuccessAge == null ? null : Math.floor(lastSuccessAge / 1000),
    // This field prevents a successful preflight from masquerading as production.
    producer_executed: false,
  });
  if (status === 'running' && attemptAge != null && attemptAge < RECOVERY_POLICY.runningGraceMs)
    return decision(false, 'producer_attempt_in_progress');
  if (force) return decision(true, 'explicit_operator_trigger');
  if (status === 'failed' && attemptAge != null && attemptAge < RECOVERY_POLICY.retryMs)
    return decision(false, 'failed_attempt_retry_cooldown');
  if (status !== 'success') return decision(true, 'producer_not_successful');
  if (lastSuccessAge == null) return decision(true, 'producer_timestamp_unverified');
  if (lastSuccessAge >= RECOVERY_POLICY.intervalMs) return decision(true, 'producer_refresh_due');
  if (!verifiedWnbaEvidence(heartbeat, now)) return decision(true, 'schedule_evidence_unverified');
  return decision(false, 'recent_verified_producer_success');
}

export async function readWnbaHeartbeat(query) {
  const response = await query(
    'SELECT sport,run_id,attempt_started_at,attempt_finished_at,attempt_status,last_success_at,evidence_json FROM basketball_producer_health WHERE sport=?',
    ['wnba'],
  );
  if (!Array.isArray(response?.results) || response.results.length > 1)
    throw new Error('watchdog_invalid_heartbeat_response');
  const row = response.results[0] || null;
  if (row && row.sport !== 'wnba') throw new Error('watchdog_wrong_sport');
  return row;
}

export async function recoveryPreflight({ trigger, query, now = Date.now() }) {
  if (!trustedRecoveryTrigger(trigger)) return { run: false, reason: 'untrusted_trigger', producer_executed: false };
  try {
    return decideWnbaRecovery(await readWnbaHeartbeat(query), now, {
      force: ['push', 'workflow_dispatch'].includes(trigger.eventName),
    });
  } catch {
    // Read failure is not health. Attempt the normal strict producer, which will
    // fail visibly if the actual upstream/storage cannot complete its work.
    return { run: true, reason: 'heartbeat_read_unavailable', observed_at: new Date(now).toISOString(), producer_executed: false };
  }
}

export function validateWnbaReadback(heartbeat, health, runId, now = Date.now()) {
  if (!runId || heartbeat?.run_id !== runId || heartbeat.attempt_status !== 'success'
    || !verifiedWnbaEvidence(heartbeat, now)) throw new Error('watchdog_completion_unverified');
  const age = elapsed(heartbeat.last_success_at, now);
  if (age == null || age > 600000) throw new Error('watchdog_completion_not_recent');
  if (health?.schema !== 'aa-basketball-producer-health-v1' || health.sport !== 'wnba'
    || health.producer_status !== 'healthy' || health.last_attempt_status !== 'success'
    || health.last_success_at !== heartbeat.last_success_at
    || health.schedule_status !== 'verified' || health.schedule_date !== basketballDate(now)
    || !['active', 'idle_no_games', 'pending_grading'].includes(health.state)
    || !Number.isInteger(health.pending_grading_count) || health.pending_grading_count < 0)
    throw new Error('watchdog_public_readback_unverified');
  return {
    schema: 'aa-wnba-recovery-readback-v1', observed_at: new Date(now).toISOString(),
    run_id: runId, producer_executed: true, producer_status: health.producer_status,
    last_success_at: health.last_success_at, state: health.state,
    schedule_status: health.schedule_status, schedule_date: health.schedule_date,
    scheduled_games: health.scheduled_games, pending_grading_count: health.pending_grading_count,
    prediction_status: health.prediction_status,
    model_publication_unchanged: true,
  };
}

export async function verifyWnbaCompletion({ query, fetcher = fetch, runId,
  clock = () => Date.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const heartbeat = await readWnbaHeartbeat(query);
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetcher(`${API}?recovery_run=${encodeURIComponent(runId)}&check=${attempt}`, {
        headers: { 'cache-control': 'no-cache', accept: 'application/json' },
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      if (!response.ok) throw new Error('watchdog_public_readback_http');
      return validateWnbaReadback(heartbeat, await response.json(), runId, clock());
    } catch (error) {
      lastError = error;
      if (attempt < 3) await pause(10000);
    }
  }
  throw new Error(`watchdog_readback_failed:${lastError?.message || 'unknown'}`);
}

async function main() {
  const trigger = { eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY,
    event: process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {} };
  const query = (sql, params) => heartbeatQuery(sql, params, { token: process.env.CLOUDFLARE_API_TOKEN });
  const mode = process.argv[2];
  const out = 'wnba-recovery-results';
  mkdirSync(out, { recursive: true });
  if (mode === 'preflight') {
    const result = await recoveryPreflight({ trigger, query });
    writeFileSync(`${out}/preflight.json`, JSON.stringify(result, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${result.run}\nreason=${result.reason}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### WNBA recovery preflight\n- Action: ${result.run ? 'run producer' : 'skip producer'}\n- Reason: ${result.reason}\n- A skipped preflight does not write a heartbeat.\n`);
    console.log(JSON.stringify(result));
  } else if (mode === 'verify') {
    if (!trustedRecoveryTrigger(trigger) || !process.env.GITHUB_RUN_ID) throw new Error('watchdog_untrusted_verification');
    const result = await verifyWnbaCompletion({ query,
      runId: `${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT || '1'}` });
    writeFileSync(`${out}/readback.json`, JSON.stringify(result, null, 2) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### WNBA producer readback\n- Last success: ${result.last_success_at}\n- State: ${result.state}\n- Pending grading: ${result.pending_grading_count}\n- Model publication policy unchanged.\n`);
    console.log(JSON.stringify(result));
  } else throw new Error('watchdog_expected_preflight_or_verify');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
