import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { basketballDate, validateBasketballEvidence } from '../cloudflare/lib/basketball_health.mjs';

// Exercise the actual producer entry point; all network requests are intercepted.
function run(sport, mode) {
  const root=mkdtempSync(join(tmpdir(),'aa-producer-test-'));
  try {
    const dir=join(root,'fase2',sport);mkdirSync(dir,{recursive:true});
    for(const year of [2024,2025,2026])writeFileSync(join(dir,year+'.json'),JSON.stringify({season:String(year),games:[{date:year===2026?basketballDate():year+'-09-10',home:'H',away:'A',hs:90,as:80}]}));
    const output=join(root,'capture.json');
    const code=`
      globalThis.fetch = async (url,options={}) => {
        const u=new URL(url);
        if(u.hostname==='api.cloudflare.com') {
          if(${JSON.stringify(mode)}==='d1-failure')return new Response(JSON.stringify({success:true,result:[{}]}));
          const sql=JSON.parse(options.body).sql;
          const rows=sql.startsWith('PRAGMA')?[{name:'market_prob'}]:[];
          return new Response(JSON.stringify({success:true,result:[{success:true,results:rows,meta:{changes:1}}]}));
        }
        if(u.hostname==='site.api.espn.com') {
          if(${JSON.stringify(mode)}==='provider-failure')return new Response('{}',{status:503});
          if(${JSON.stringify(mode)}==='malformed')return new Response('{}');
          return new Response(JSON.stringify({events:[]}));
        }
        throw new Error('Network not allowed: '+u.hostname);
      };
      await import(${JSON.stringify(new URL('../robot/nba_shadow.mjs',import.meta.url).href)});
    `;
    const child=spawnSync(process.execPath,['--input-type=module','-e',code],{
      env:{...process.env,DATA_DIR:root,AA_BASKETBALL_SPORT:sport,CLOUDFLARE_API_TOKEN:'synthetic-test-only',AA_REQUIRE_PRODUCER_EVIDENCE:'1',AA_PRODUCER_EVIDENCE:output,GITHUB_RUN_ID:'integration-test',GITHUB_RUN_ATTEMPT:'1'},
      encoding:'utf8',timeout:12000,
    });
    return {status:child.status,error:child.error,stderr:child.stderr,stdout:child.stdout,evidence:existsSync(output)?JSON.parse(readFileSync(output,'utf8')):null};
  } finally {rmSync(root,{recursive:true,force:true});}
}
for(const sport of ['nba','wnba']){
  test(`${sport}: actual producer completes a verified zero-game run`,()=>{
    const result=run(sport,'empty');assert.equal(result.status,0,result.stderr);assert.ok(validateBasketballEvidence(result.evidence,sport));assert.equal(result.evidence.schedule[0].events,0);
  });
}
for(const mode of ['provider-failure','malformed','d1-failure']){
  test(`actual producer fails closed on ${mode} without capture evidence`,()=>{
    const result=run('nba',mode);assert.notEqual(result.status,0);assert.equal(result.error,undefined);assert.equal(result.evidence,null);assert.match(result.stderr,/producer_/);
  });
}
