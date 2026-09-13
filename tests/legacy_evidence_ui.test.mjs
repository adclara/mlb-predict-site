import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../cloudflare/pages/index.html',import.meta.url),'utf8');
const extract=name=>{ const source=html.match(new RegExp('function '+name+'\\([^]*?\\n}')); assert.ok(source, name); return vm.runInNewContext('('+source[0]+')'); };
const risk=extract('publicRiskView'),verdict=extract('publicVerdictView');
test('old cached risk labels and malformed scores cannot become verified low risk',()=>{
 for(const value of [null,{}, {level:'bajo',score:0}, {level:'bajo',score:0,coverage:.8}, {level:'bajo',score:NaN,coverage:1}, {level:'alto',score:101,coverage:1}]) {
  assert.equal(risk(value).level,'desconocido');assert.equal(risk(value).score,null);
 }
});
test('complete descriptive risk evidence retains its actual label and score',()=>{
 for(const level of ['bajo','medio','alto']){ const value={level,score:55,coverage:1};assert.equal(risk(value),value); }
});
test('old one-language verdicts cannot retain obsolete value claims',()=>{
 for(const lang of ['es','en'])assert.equal(verdict({verdict_es:'Ventaja moderada'},lang,'neutral'),'neutral');
 assert.equal(verdict({verdict_es:'Sin ventaja',verdict_en:'No edge'},'es','neutral'),'Sin ventaja');
 assert.equal(verdict({verdict_es:'Sin ventaja',verdict_en:'No edge'},'en','neutral'),'No edge');
});
test('ticket, metrics and detail all use the coverage-checked risk presentation',()=>{
 assert.match(html,/publicRiskView\(ev\.risk\)/);
 assert.match(html,/const risk = publicRiskView\(ev\.risk\)/);
 assert.match(html,/m\.kind === 'risk' \? t\('risk_' \+ risk\.level\)/);
 assert.doesNotMatch(html,/risk real amerita|real risk warrants/);
});
