import test from 'node:test';
import assert from 'node:assert/strict';
import { riskScore } from '../robot/odds.js';
import { verdictFor } from '../cloudflare/lib/normalize.mjs';
const complete={odds:{book_disagreement:0, p_home_mkt:.55, line_move:0},adrian_p:.55,pitcher_recent:{home:{fatigue:{level:'normal'}}},news_delta:0,ml_pick:'NYY',home:'NYY'};
test('absent and empty odds are insufficient data, never low risk',()=>{
 for(const data of [{},{odds:{}},{odds:{book_disagreement:0}},{...complete,adrian_p:NaN}]){const risk=riskScore(data);assert.equal(risk.level,'desconocido');assert.equal(risk.score,null);assert.ok(risk.coverage<1);}
});
test('complete observed zero-risk signals remain distinguishable from missing data',()=>{
 const risk=riskScore(complete);assert.equal(risk.level,'bajo');assert.equal(risk.score,0);assert.equal(risk.coverage,1);assert.equal(risk.kind,'descriptive_not_loss_probability');
});
test('real producer fatigue objects are interpreted rather than silently ignored',()=>{
 const risk=riskScore({...complete,pitcher_recent:{home:{fatigue:{level:'alta'}}}});assert.equal(risk.score,15);assert.match(risk.reasons.join(' '),/fatiga alta/);
});
test('missing and zero market edge never claim moderate/solid value in either language',()=>{
 for(const language of ['es','en'])for(const odds of [null,{}, {p_home_mkt:.55}]){
 const text=verdictFor({ml_pick:'NYY',home:'NYY',odds},.55,language);assert.doesNotMatch(text,/Ventaja moderada|Candidato sólido|Moderate edge|Solid candidate/);
 }
});
test('positive probability gap is described in percentage points and not as profit',()=>{
 assert.match(verdictFor({ml_pick:'NYY',home:'NYY',odds:{p_home_mkt:.55}},.57),/puntos porcentuales/);
 assert.match(verdictFor({ml_pick:'NYY',home:'NYY',odds:{p_home_mkt:.55}},.57,'en'),/does not establish profitable odds/);
});
