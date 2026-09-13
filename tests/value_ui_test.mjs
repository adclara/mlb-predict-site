// End-to-end normalized API -> UI contracts. Fixtures, no production writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDay } from '../cloudflare/lib/normalize.mjs';
const require=createRequire(import.meta.url), pw=require('playwright');
const engine=process.env.AA_TEST_BROWSER||'chromium';
assert.ok(['chromium','firefox','webkit'].includes(engine));
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../cloudflare/pages');
const OUT=resolve(process.env.AA_UI_ARTIFACT_DIR||'/tmp/aa-value-ui',`value-${engine}`);mkdirSync(OUT,{recursive:true});
const mime={'.html':'text/html','.js':'application/javascript','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=createServer((req,res)=>{try{
 const path=new URL(req.url,'http://local').pathname,file=resolve(ROOT,path==='/'?'index.html':path.slice(1));
 if(!file.startsWith(ROOT+sep))throw Error('invalid path');
 res.writeHead(200,{'content-type':mime[extname(file)]||'application/json'});res.end(readFileSync(file));
}catch{res.writeHead(404);res.end('not found');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const exe=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser=await pw[engine].launch({headless:true,...(engine==='chromium'&&exe&&existsSync(exe)?{executablePath:exe}:{})});
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date());
const row={game_pk:99881,date,game_date:date,game_datetime:date+'T23:50:00Z',first_pitch:date+'T23:50:00Z',
  home:'NYY',away:'BOS',ml_pick:'NYY',p_final:.51,adrian_p:.75,
  decision_captured_at:date+'T12:00:00Z',feature_as_of:date+'T12:00:00Z',feature_scope:'pregame_immutable',feature_hash:'a'.repeat(64),
  integrity:{training_eligible:true,cohort:'native_pregame_immutable'},observed:{status:'Scheduled'},
  odds:{provider:'Test book',ml_home:-110,ml_away:-110,captured_at:date+'T11:59:00Z'},
  value:{home:{model:.75,market:.5,price:-110,ev:.432},away:{model:.25,market:.5,price:-110,ev:-.523},best_side:'home'}};
const doc=normalizeDay(date,{games:[row]},null,null,[],null);
const underdog=normalizeDay(date,{games:[{...row,p_final:.55,odds:{...row.odds,ml_home:-150,ml_away:140}}]},null,null,[],null).events[0];
let checks=0;
try{
 for(const width of [1280,390,360]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',timezoneId:'America/New_York'});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const json=(r,b)=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(b)});
  await page.route('**/v1/**',r=>{
    const p=new URL(r.request().url()).pathname;
    if(p==='/v1/mlb/today')return json(r,doc);
    if(p==='/v1/me')return json(r,{enabled:false,user:null});
    if(p.endsWith('/live')||p.endsWith('/recent'))return json(r,{date,games:[]});
    if(p.endsWith('/today'))return json(r,{date,events:[],by_id:{}});
    return json(r,{});
  });
  await page.route(/^https:\/\/(a\.espncdn\.com|midfield\.mlbstatic\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|static\.cloudflareinsights\.com)\//,r=>r.fulfill({status:200,body:'',contentType:'text/plain'}));
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}/?sport=mlb`,{waitUntil:'domcontentloaded'});
    await page.locator('.sp[data-sport="mlb"]').click();await page.locator('.mrow[data-id="99881"]').click();
    await page.locator('.dtab[data-dt="mercado"]').click();
    for(const lang of ['es','en']){
      if(lang==='en')await page.locator('#langbtn').evaluate(el=>el.click());
      assert.match(await page.locator('.valtbl').innerText(),/51%/);
      assert.match(await page.locator('.valtbl').innerText(),/-2\.6%/);
      assert.doesNotMatch(await page.locator('.valtbl').innerText(),/75%|43\.2%/);
      assert.equal(await page.locator('.valtbl tr.best').count(),0);
      assert.match(await page.locator('.value-provenance').innerText(),/p_final/);
      assert.match(await page.locator('.value-threshold').innerText(),/1\.9608/);
      checks+=6;
    }
    await page.evaluate(e=>{events[events.findIndex(x=>x.event_id==='99881')]=e;renderDetail();},underdog);
    assert.equal(await page.locator('.valtbl tr.best').count(),1);
    assert.match(await page.locator('.valtbl tr.best').innerText(),/45%[\s\S]*\+140[\s\S]*\+8%/);
    const dims=await page.evaluate(()=>({s:document.documentElement.scrollWidth,c:document.documentElement.clientWidth}));
    assert.ok(dims.s<=dims.c+1,`${engine}/${width}: overflow ${JSON.stringify(dims)}`);
    await page.screenshot({path:resolve(OUT,`${width}.png`),fullPage:true});checks+=3;
    await page.evaluate(()=>{const e=events.find(x=>x.event_id==='99881');e.snapshot.value.home.model_pct=75;renderDetail();});
    assert.equal(await page.locator('.valtbl').count(),0);checks++;
    await page.evaluate(()=>{const e=events.find(x=>x.event_id==='99881');e.snapshot.value.schema='legacy';renderDetail();});
    assert.equal(await page.locator('.valtbl').count(),0);checks++;
    assert.deepEqual(errors,[]);
  }catch(e){await page.screenshot({path:resolve(OUT,`${width}-failure.png`),fullPage:true});throw e;}
  finally{await context.close();}
 }
 console.log(JSON.stringify({browser:engine,checks,widths:[1280,390,360],languages:['es','en'],passed:true,fixtures_only:true}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
