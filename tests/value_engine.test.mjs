import test from 'node:test';
import assert from 'node:assert/strict';
import { americanDecimal, expectedValue, twoSidedValue } from '../cloudflare/lib/value_contract.mjs';
import { normalizeDay } from '../cloudflare/lib/normalize.mjs';
import { VALUE_POLICY, currentQuotes, evaluateValueDecision, appendValueDecisions, settleValueDecisions } from '../robot/value_decision.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
const date='2026-09-15',asOf=date+'T20:00:00Z',start=date+'T21:00:00Z';
const q={provider:'Test book',ml_home:-150,ml_away:140,captured_at:asOf,source:'fixture',price_scope:'current_observed',market:'moneyline',period:'full_game'};
const row={game_pk:123,home:'NYY',away:'BOS',first_pitch:start,game_datetime:start,date,game_date:date,
  observed:{status:'Scheduled'},p_final:.55,ml_pick:'NYY',adrian_p:.75,home_probable_pitcher_id:1,away_probable_pitcher_id:2,
  lineup_features:{both_complete:true},odds:{ml_home:-150,ml_away:140,provider:'Test book',captured_at:asOf,economic_quotes:[q]},
  feature_as_of:asOf,decision_captured_at:asOf,feature_scope:'pregame_immutable',feature_hash:'a'.repeat(64),
  integrity:{training_eligible:true,cohort:'native_pregame_immutable'}};
const opts={asOf,probabilityAsOf:asOf,modelSignature:'test-only',startersVerified:true};
const ledgerOpts={...opts,date,officialPitchers:{123:{h:1,a:2},124:{h:1,a:2},125:{h:1,a:2}}};
const event=r=>normalizeDay(date,{games:[r]},null,null,[],null).events[0];

test('economic arithmetic: winning most often does not imply positive EV',()=>{
 near(expectedValue(.70,-250),-.02);near(expectedValue(.55,100),.10);near(expectedValue(.45,140),.08);
 near(expectedValue(.51,-110),-.026363636363636367);
 near(expectedValue(.5,100,{pushProbability:.1,costPerUnit:.01}),.09);
});
test('moneyline inputs reject missing/nonfinite/invalid prices without coercing null to zero',()=>{
 for(const p of [null,undefined,'',false,true,0,99,-99,'abc',Infinity,NaN]) assert.equal(americanDecimal(p),null);
 assert.equal(americanDecimal(' +140 '),2.4);assert.equal(americanDecimal(-100),2);
 for(const p of [null,undefined,NaN,-.1,1.1,'0.55'])assert.equal(expectedValue(p,100),null);
 assert.equal(expectedValue(.8,100,{pushProbability:.3}),null);
});
test('value compares both sides and selects positive EV, never just a positive no-vig edge',()=>{
 const v=twoSidedValue(.51,{ml_home:-110,ml_away:-110});assert.equal(v.best_side,null);assert.ok(v.home.edge>0);assert.ok(v.home.ev<0);
 assert.equal(twoSidedValue(.55,{ml_home:-150,ml_away:140}).best_side,'away');
 assert.equal(twoSidedValue(.55,{ml_home:-150}),null);
});
test('regression: a raw 75% cannot leak into the table for a calibrated 51% prediction',()=>{
 const r={...row,p_final:.51,odds:{...row.odds,ml_home:-110,ml_away:-110},value:{home:{model:.75,market:.5,price:-110,ev:.432},away:{model:.25,market:.5,price:-110,ev:-.523},best_side:'home'}};
 const before=structuredClone(r),e=event(r);
 assert.equal(e.prediction.prob,.51);assert.equal(e.prediction.probability_source,'p_final');
 assert.equal(e.snapshot.value.home.model_pct,51);assert.equal(e.snapshot.value.home.ev_pct,-2.6);assert.equal(e.snapshot.value.best_side,null);
 assert.equal(e.snapshot.value.schema,'aa-value-v1');assert.equal(e.snapshot.value.public_recommendation,false);
 assert.deepEqual(r,before);
});
test('away orientation matches display; observed later prices cannot replace the decision price',()=>{
 const e=event({...row,ml_pick:'BOS',observed:{status:'Final',odds:{ml_home:-300,ml_away:270,captured_at:date+'T23:00:00Z'}}});
 assert.equal(e.prediction.prob,.45);assert.equal(e.snapshot.value.away.model_pct,45);assert.equal(e.snapshot.value.away.price,140);
 assert.equal(e.snapshot.value.price_scope,'frozen_capture');assert.equal(e.odds.ml_away,270);
});
test('uncalibrated/provisional/invalidated rows cannot expose an economic claim',()=>{
 assert.equal(event({...row,p_final:null}).snapshot?.value,null);
 assert.equal(event({...row,feature_scope:'provisional_pregame'}).snapshot,null);
 const e=event({...row,observed:{status:'Scheduled',captured_at:date+'T20:10:00Z',pitchers:{home:{id:9},away:{id:2}}}});
 // Existing scratch contract is covered by the dedicated MLB integrity suite.
 assert.ok(e.snapshot==null || e.snapshot.value?.home.model_pct===e.prediction.prob_pct);
});
test('economic selector can prefer a 45% underdog and preserve its real price',()=>{
 const d=evaluateValueDecision(row,{...opts,policy:{...VALUE_POLICY,minimumStressEV:0}});assert.equal(d.action,'shadow_candidate');assert.equal(d.candidate.side,'away');
 near(d.candidate.expected_value,.08);near(d.candidate.stress_expected_value,.008);
});
// The default 3pp stress/2% floor intentionally rejects this marginal example.
test('default stress margin abstains even when nominal EV is positive',()=>{
 const d=evaluateValueDecision(row,opts);assert.equal(d.action,'abstain');
 assert.ok(d.alternatives.some(x=>x.side==='away' && x.expected_value>0 && x.blocked_reasons.includes('stress_margin_not_met')));
});
test('45% underdog with a sufficiently better price passes the stress test',()=>{
 const d=evaluateValueDecision({...row,odds:{economic_quotes:[{...q,ml_away:160}]}},opts);
 assert.equal(d.candidate.side,'away');near(d.candidate.expected_value,.17);near(d.candidate.stress_expected_value,.092);
 near(d.candidate.minimum_decimal_price,1.02/.42);assert.equal(d.public_picks_enabled,false);assert.equal(d.execution_verified,false);
});
test('missing/stale/future/unilateral quotes and incomplete data all abstain',()=>{
 for(const quote of [{...q,captured_at:date+'T19:00:00Z'},{...q,captured_at:date+'T20:10:00Z'},{...q,captured_at:null},{...q,ml_home:null},{...q,price_scope:'close'}])
   assert.equal(evaluateValueDecision({...row,p_final:.8,odds:{economic_quotes:[quote]}},opts).action,'abstain');
 for(const update of [{p_final:null},{lineup_features:null},{first_pitch:date+'T19:00:00Z'},{observed:{status:'Live'}},{scratch_warning:true}])
   assert.equal(evaluateValueDecision({...row,...update},opts).action,'abstain');
 assert.equal(evaluateValueDecision(row,{...opts,startersVerified:false}).action,'abstain');
 assert.equal(evaluateValueDecision(row,{...opts,probabilityAsOf:date+'T18:00:00Z'}).action,'abstain');
});
test('price shopping uses only freshest quote per provider and can choose another provider',()=>{
 const quotes=[{...q,ml_away:190,captured_at:date+'T19:50:00Z'},{...q,ml_away:140},{...q,provider:'Second',ml_away:165}];
 const d=evaluateValueDecision({...row,odds:{economic_quotes:quotes}},opts);assert.equal(d.candidate.provider,'Second');
 assert.equal(d.alternatives.find(x=>x.provider==='Test book' && x.side==='away').price,140);
});
test('current quote adapter never recycles provider open/close fields',()=>{
 const rows=currentQuotes([{provider:{name:'X'},homeTeamOdds:{close:{moneyLine:{american:'-150'}}},awayTeamOdds:{open:{moneyLine:{american:'+140'}}}}],asOf,'fixture');
 assert.equal(rows[0].ml_home,null);assert.equal(rows[0].ml_away,null);
 const current=currentQuotes([{provider:{name:'X'},homeTeamOdds:{moneyLine:'EVEN'},awayTeamOdds:{current:{moneyLine:{american:'+140'}}}}],asOf,'fixture');
 assert.equal(current[0].ml_home,100);assert.equal(current[0].ml_away,140);
});
test('append-only ledger preserves decisions/rejections, deduplicates replays and caps exposure',()=>{
 const good={...row,odds:{economic_quotes:[{...q,ml_away:160}]}};
 const input=[good,{...good,game_pk:124},{...good,game_pk:125}];
 const first=appendValueDecisions(null,input,ledgerOpts),copy=structuredClone(first);
 assert.equal(first.snapshots.length,3);assert.equal(first.snapshots.filter(x=>x.paper_selected).length,2);
 assert.equal(appendValueDecisions(first,input,ledgerOpts).snapshots.length,3);
 const later=appendValueDecisions(first,[{...good,p_final:.52}],{...ledgerOpts,asOf:date+'T20:05:00Z',probabilityAsOf:date+'T20:05:00Z'});
 assert.deepEqual(later.snapshots.slice(0,3),first.snapshots);assert.deepEqual(first,copy);
 assert.equal(later.snapshots[3].paper_selected,false);assert.equal(later.snapshots[3].selection_blocked_reason,'one_selection_per_event');
 const corrupted=structuredClone(first);corrupted.snapshots[0].candidate.price=900;
 assert.throws(()=>appendValueDecisions(corrupted,[],ledgerOpts),/checksum/);
});
test('duplicates cannot qualify and empty days do not fabricate selections',()=>{
 assert.equal(appendValueDecisions(null,[row,row],ledgerOpts).snapshots[0].action,'abstain');
 assert.equal(appendValueDecisions(null,[],ledgerOpts).snapshots.length,0);
});
test('settlement adds a hypothetical result without mutating decision bytes or counting it as real profit',()=>{
 const first=appendValueDecisions(null,[{...row,odds:{economic_quotes:[{...q,ml_away:160}]}}],ledgerOpts);
 const settled=settleValueDecisions(first,[{game_pk:123,outcome_status:'final',home_win:0}],date+'T23:00:00Z');
 assert.deepEqual(settled.snapshots,first.snapshots);assert.deepEqual(first.settlements,{});
 const result=Object.values(settled.settlements)[0];near(result.paper_units,1.6);assert.equal(result.execution_verified,false);
 assert.deepEqual(settleValueDecisions(settled,[{game_pk:123,outcome_status:'final',home_win:1}],date+'T23:05:00Z'),settled);
});
test('policy changes are explicit and invalid policy cannot silently lower gates',()=>{
 assert.throws(()=>evaluateValueDecision(row,{...opts,policy:{...VALUE_POLICY,maxQuoteAgeSeconds:NaN}}),/policy/);
 const a=evaluateValueDecision(row,opts),b=evaluateValueDecision(row,{...opts,policy:{...VALUE_POLICY,minimumStressEV:.04}});
 assert.notEqual(a.policy_signature,b.policy_signature);
});

test('no settlement before start and no cross-date selection',()=>{
 const good={...row,odds:{economic_quotes:[{...q,ml_away:160}]}};
 const first=appendValueDecisions(null,[good],ledgerOpts);
 assert.deepEqual(settleValueDecisions(first,[{game_pk:123,outcome_status:'final',home_win:0}],asOf).settlements,{});
 assert.equal(appendValueDecisions(null,[{...good,date:'2026-09-16'}],ledgerOpts).snapshots[0].action,'abstain');
});
