// Called first/last by the NBA/WNBA workflows. No successful heartbeat on partial work.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateBasketballEvidence } from '../cloudflare/lib/basketball_health.mjs';
const ACCOUNT = 'f02574feb7272a1da2818e35e0ff4342';
const DATABASE = 'ed0969d8-050a-4987-ab98-b047c30f76c9';
export async function heartbeatQuery(sql, params, { token, fetcher = fetch } = {}) {
  if (!token) throw new Error('heartbeat_missing_credentials');
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok || body.success !== true || !Array.isArray(body.result)
    || body.result.length !== 1 || body.result[0]?.success !== true
    || !Array.isArray(body.result[0]?.results)) throw new Error('heartbeat_d1_failed');
  return body.result[0];
}
export async function recordHeartbeat({ sport, phase, runId, evidence = null, now = new Date().toISOString(), query }) {
  if (!['nba', 'wnba'].includes(sport) || !['begin', 'success', 'failure'].includes(phase) || !runId || !query) throw new Error('heartbeat_invalid_arguments');
  if (phase === 'begin') {
    await query(readFileSync(new URL('../cloudflare/migrations/0009_basketball_producer_health.sql', import.meta.url), 'utf8'), []);
    await query(`INSERT INTO basketball_producer_health(sport,run_id,attempt_started_at,attempt_status)
      VALUES(?,?,?,'running') ON CONFLICT(sport) DO UPDATE SET run_id=excluded.run_id,
      attempt_started_at=excluded.attempt_started_at,attempt_finished_at=NULL,attempt_status='running'
      WHERE basketball_producer_health.attempt_started_at <= excluded.attempt_started_at`, [sport, runId, now]);
    return;
  }
  if (phase === 'success' && (evidence?.run_id !== runId || !validateBasketballEvidence(evidence, sport, Date.parse(now)))) throw new Error('heartbeat_capture_unverified');
  const result = phase === 'success'
    ? await query(`UPDATE basketball_producer_health SET attempt_status='success',attempt_finished_at=?,last_success_at=?,evidence_json=?
        WHERE sport=? AND run_id=? AND attempt_status='running' AND attempt_started_at<=?`, [now, now, JSON.stringify(evidence), sport, runId, now])
    : await query(`UPDATE basketball_producer_health SET attempt_status='failed',attempt_finished_at=?
        WHERE sport=? AND run_id=? AND attempt_status='running'`, [now, sport, runId]);
  if (result?.meta?.changes !== 1) throw new Error('heartbeat_attempt_mismatch');
}
async function main() {
  const [phase, sport] = process.argv.slice(2);
  if (!process.env.GITHUB_RUN_ID) throw new Error('heartbeat_requires_workflow_identity');
  const runId = `${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  const evidence = phase === 'success' ? JSON.parse(readFileSync(process.env.AA_PRODUCER_EVIDENCE, 'utf8')) : null;
  await recordHeartbeat({ sport, phase, runId, evidence,
    query: (sql, params) => heartbeatQuery(sql, params, { token: process.env.CLOUDFLARE_API_TOKEN }),
  });
  console.log(JSON.stringify({ sport, phase, run_id: runId }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
