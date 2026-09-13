import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateValueDecision, appendValueDecisions } from '../robot/value_decision.mjs';
const asOf='2026-09-15T20:00:00Z';
const row={game_pk:1,date:'2026-09-15',home:'A',away:'B',p_final:.55,observed:{status:'Scheduled'},lineup_features:{both_complete:true}};
const options={asOf,probabilityAsOf:asOf,modelSignature:'fixture',startersVerified:true};
test('post-start observations are rejected and never mislabeled as T15 pregame',()=>{
 for(const [start,lead] of [['2026-09-15T20:00:00Z',0],['2026-09-15T19:00:00Z',-3600]]){
  const d=evaluateValueDecision({...row,first_pitch:start},options);
  assert.equal(d.seconds_before_start,lead);assert.equal(d.horizon,'after_start');
  assert.equal(d.action,'abstain');assert.ok(d.blocked_reasons.includes('not_verified_pregame'));
 }
});
test('positive decision lead times retain truthful horizon bins',()=>{
 for(const [start,lead,horizon] of [['2026-09-15T20:10:00Z',600,'T15'],['2026-09-15T20:30:00Z',1800,'T60'],['2026-09-15T22:00:00Z',7200,'T180']]){
  const d=evaluateValueDecision({...row,first_pitch:start},options);
  assert.equal(d.seconds_before_start,lead);assert.equal(d.horizon,horizon);
 }
});
test('append path records rejected after-start observations without paper selections',()=>{
 const l=appendValueDecisions(null,[{...row,first_pitch:'2026-09-15T19:00:00Z'}],{...options,date:row.date});
 assert.equal(l.snapshots[0].horizon,'after_start');assert.equal(l.snapshots[0].paper_selected,false);
});
