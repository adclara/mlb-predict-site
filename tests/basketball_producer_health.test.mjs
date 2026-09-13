import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessBasketballHealth, validateBasketballEvidence, basketballDate } from '../cloudflare/lib/basketball_health.mjs';
import { recordHeartbeat, heartbeatQuery } from '../robot/basketball_heartbeat.mjs';
import worker from '../cloudflare/worker/index.js';
const NOW = Date.parse('2026-09-12T20:00:00Z');
function evidence(sport = 'wnba', events = 0) {
  return { schema: 'aa-basketball-capture-v1', sport, run_id: '42.1', complete: true, source_failures: 0,
    schedule: ['2026-09-12','2026-09-13'].map(date => ({ date, checked_at: '2026-09-12T19:50:00Z', source: 'espn', complete: true, events, eligible_pregame: events, logged: events })) };
}
function hb(sport = 'wnba', events = 0) {
  return { sport, run_id: '42.1', attempt_status: 'success', attempt_started_at: '2026-09-12T19:40:00Z', last_success_at: '2026-09-12T19:55:00Z', evidence_json: JSON.stringify(evidence(sport, events)) };
}
const predictions = { n: 100, graded: 100, pending_grading: 0, updated_at: '2026-09-08T12:00:00Z' };
const assess = (heartbeat = hb(), rows = predictions) => assessBasketballHealth({ sport: 'wnba', heartbeat, predictions: rows, now: NOW });
test('verified zero-game day is idle despite old prediction rows', () => {
  const result = assess(); assert.equal(result.state, 'idle_no_games'); assert.equal(result.ok, true);
  assert.equal(result.producer_status, 'healthy'); assert.equal(result.prediction_status, 'stale');
  assert.equal(result.last_success_at, hb().last_success_at); assert.equal(result.prediction_updated_at, predictions.updated_at);
});
test('empty prediction table is not proof of failure after a verified zero-game run', () => {
  assert.equal(assess(hb(), { n:0, graded:0, pending_grading:0, updated_at:null }).state, 'idle_no_games');
});
test('fresh predictions cannot replace a missing/stopped heartbeat', () => {
  const fresh = { ...predictions, updated_at: new Date(NOW).toISOString() };
  assert.equal(assess(null, fresh).state, 'producer_unknown');
  assert.equal(assess({ ...hb(), last_success_at: '2026-09-12T16:00:00Z' }, fresh).state, 'producer_stale');
});
test('provider/job failure preserves last success and cannot become green', () => {
  const result = assess({ ...hb(), attempt_status: 'failed' }); assert.equal(result.state, 'producer_failed'); assert.equal(result.ok,false);
  assert.equal(result.last_success_at, hb().last_success_at);
});
test('running and abandoned attempts are not successful heartbeats', () => {
  assert.equal(assess({ ...hb(), attempt_status: 'running', attempt_started_at: '2026-09-12T19:55:00Z' }).state,'producer_running');
  assert.equal(assess({ ...hb(), attempt_status: 'running', attempt_started_at: '2026-09-12T18:00:00Z' }).state,'producer_stale');
});
test('historical pending grading remains visible on a no-game day', () => {
  const result = assess(hb(), { ...predictions, pending_grading: 2 }); assert.equal(result.state,'pending_grading'); assert.equal(result.ok,false); assert.equal(result.pending_grading_count,2);
});
test('active complete slate is verified without forcing prediction freshness', () => {
  const result = assess(hb('wnba',3)); assert.equal(result.state,'active'); assert.equal(result.scheduled_games,3); assert.equal(result.ok,true);
});
test('missing, failed, partial and malformed schedules never justify idle', () => {
  for (const ev of [null, {}, { ...evidence(), source_failures:1 }, { ...evidence(), schedule:[null,null] }, { ...evidence(), schedule:[] }, { ...evidence(), run_id:'old-run' }]) {
    assert.equal(assess({ ...hb(), evidence_json: JSON.stringify(ev) }).state,'schedule_unverified');
  }
  const ev=evidence(); ev.schedule[0].eligible_pregame=2; ev.schedule[0].events=2; ev.schedule[0].logged=1;
  assert.equal(validateBasketballEvidence(ev,'wnba',NOW),false);
});
test('wrong date, future timestamp and stale schedule are rejected', () => {
  for(const change of [{date:'2026-09-11'}, {checked_at:'2026-09-12T21:00:00Z'}, {checked_at:'2026-09-12T10:00:00Z'}]){
    const ev=evidence();Object.assign(ev.schedule[0],change);assert.equal(validateBasketballEvidence(ev,'wnba',NOW),false);
  }
});
test('NBA six-hour cadence is not judged against WNBA one-hour cadence', () => {
  const heartbeat=hb('nba'); heartbeat.last_success_at='2026-09-12T15:00:00Z';
  const result=assessBasketballHealth({sport:'nba',heartbeat,predictions,now:NOW});assert.equal(result.ok,true);assert.equal(result.interval_minutes,360);
});
test('schedule date uses New York before and after UTC midnight', () => {
  assert.equal(basketballDate(Date.parse('2026-09-13T00:30:00Z')),'2026-09-12');
  assert.equal(basketballDate(Date.parse('2026-09-13T04:30:00Z')),'2026-09-13');
});
test('heartbeat writer rejects missing evidence and mismatched run identity before any write', async () => {
  for(const ev of [null, {...evidence(),run_id:'other'}, {...evidence(),complete:false}]){
    let calls=0;await assert.rejects(recordHeartbeat({sport:'wnba',phase:'success',runId:'42.1',now:new Date(NOW).toISOString(),evidence:ev,query:async()=>{calls++;}}),/capture_unverified/);assert.equal(calls,0);
  }
});
test('successful completion is guarded by the current running attempt', async () => {
  let sql,params;
  await recordHeartbeat({sport:'wnba',phase:'success',runId:'42.1',now:new Date(NOW).toISOString(),evidence:evidence(),query:async(s,p)=>{sql=s;params=p;return {meta:{changes:1}};}});
  assert.match(sql,/run_id=\? AND attempt_status='running'/);assert.equal(params[4],'42.1');
  await assert.rejects(recordHeartbeat({sport:'wnba',phase:'success',runId:'42.1',now:new Date(NOW).toISOString(),evidence:evidence(),query:async()=>({meta:{changes:0}})}),/attempt_mismatch/);
});
test('failure and begin writes never refresh or erase last_success_at', async () => {
  const calls=[];const query=async(sql,params)=>{calls.push({sql,params});return {meta:{changes:1}};};
  await recordHeartbeat({sport:'wnba',phase:'failure',runId:'42.1',query});assert.doesNotMatch(calls[0].sql,/last_success_at\s*=/);
  calls.length=0;await recordHeartbeat({sport:'wnba',phase:'begin',runId:'42.1',query});assert.doesNotMatch(calls[1].sql,/last_success_at\s*=/);
});
test('malformed D1 success envelopes cannot create a successful producer report', async () => {
  for(const body of [{}, {success:true,result:[]}, {success:true,result:[{success:false,results:[]}]}, {success:true,result:[{}]}]){
    await assert.rejects(heartbeatQuery('SELECT 1',[],{token:'test-only',fetcher:async()=>new Response(JSON.stringify(body))}),/d1_failed/);
  }
});
test('workflow success is after required publishing; failure uses a separate status path', () => {
  for(const sport of ['nba','wnba']){
    const text=readFileSync(new URL(`../.github/workflows/${sport}-shadow.yml`,import.meta.url),'utf8');
    assert.match(text,/AA_REQUIRE_PRODUCER_EVIDENCE: '1'/);
    assert.ok(text.indexOf(`basketball_heartbeat.mjs success ${sport}`)>text.indexOf(`sport_brain.mjs ${sport}`));
    if(sport==='wnba')assert.ok(text.indexOf('basketball_heartbeat.mjs success wnba')>text.indexOf('node robot/wnba_publish_simulation.mjs'));
    assert.match(text,/if: failure\(\) && steps.producer_attempt.outcome == 'success'/);
  }
});
test('Worker exposes a fail-closed unavailable state when heartbeat storage is unavailable', async () => {
  const response=await worker.fetch(new Request('https://example.test/v1/wnba/pipeline-health'),{DB:{prepare(){throw new Error('unavailable');}}},{});
  const result=await response.json();assert.equal(result.ok,false);assert.equal(result.state,'unavailable');assert.equal(result.last_success_at,null);
});

test('SQLite heartbeat state survives failure and rejects an old run completion', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');
  const query=async(sql,params)=>{
    if(/^\s*(--[^\n]*\n)*\s*CREATE TABLE/.test(sql)) { db.exec(sql); return {meta:{changes:0}}; }
    const result=db.prepare(sql).run(...params);return {meta:{changes:Number(result.changes)}};
  };
  try {
    await recordHeartbeat({sport:'wnba',phase:'begin',runId:'42.1',now:'2026-09-12T19:40:00Z',query});
    await recordHeartbeat({sport:'wnba',phase:'success',runId:'42.1',now:'2026-09-12T19:55:00Z',evidence:evidence(),query});
    await recordHeartbeat({sport:'wnba',phase:'begin',runId:'43.1',now:'2026-09-12T20:00:00Z',query});
    await recordHeartbeat({sport:'wnba',phase:'failure',runId:'43.1',now:'2026-09-12T20:01:00Z',query});
    const row=db.prepare('SELECT * FROM basketball_producer_health').get();
    assert.equal(row.last_success_at,'2026-09-12T19:55:00Z');assert.equal(row.attempt_status,'failed');
    await assert.rejects(recordHeartbeat({sport:'wnba',phase:'success',runId:'42.1',now:'2026-09-12T20:02:00Z',evidence:evidence(),query}),/attempt_mismatch/);
  }finally{db.close();}
});
