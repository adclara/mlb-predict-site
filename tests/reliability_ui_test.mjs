// Isolated UI contracts: no accounts, production data or external writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url), playwright=require('playwright');
const engine=process.env.AA_TEST_BROWSER || 'chromium';
assert.ok(['chromium','firefox','webkit'].includes(engine));
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../cloudflare/pages');
const OUT=resolve(process.env.AA_UI_ARTIFACT_DIR || '/tmp/aa-reliability-ui',engine);
mkdirSync(OUT,{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://local').pathname, file=resolve(ROOT,path==='/'?'index.html':path.slice(1));
  if(!file.startsWith(ROOT+sep))throw new Error('outside root');
  res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'});res.end(await readFile(file));
}catch{res.writeHead(404);res.end('not found');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const executable=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser=await playwright[engine].launch({headless:true,...(engine==='chromium'&&executable&&existsSync(executable)?{executablePath:executable}:{})});
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const sample={sport:'mlb',league:'MLB',event_id:'reliability-1',matchup:'MIN @ CLE',start:date+'T23:00:00Z',status:'pre',
  away:{code:'MIN',name:'Minnesota Twins'},home:{code:'CLE',name:'Cleveland Guardians'},
  prediction:{pick:'CLE',prob:.57,prob_pct:57,confidence:'media'},
  metrics:[{key:'metric_prob_cal',label:'Prob. AA calibrada',value:'57%',kind:'pct'}],
  snapshot:{verdict_es:'No hay precio comparable; no se puede determinar valor.',verdict_en:'No comparable price; value cannot be determined.'},
  risk:{score:null,level:'desconocido',coverage:0},odds:null,badges:[],result:null,final:null};
const states={
  idle_no_games:['Ejecución completa; hoy no hay partidos','Run completed; no games today'],
  active:['Ejecución completa y calendario verificado','Run completed and schedule verified'],
  producer_stale:['Productor atrasado o detenido','Producer is delayed or stopped'],
  producer_failed:['La última ejecución falló','The latest run failed'],
  schedule_unverified:['Calendario no verificado o atrasado','Schedule unverified or stale'],
  pending_grading:['Resultados históricos pendientes de resolver','Historical results need resolution'],
  producer_unknown:['Sin ejecución correcta verificada','No verified successful run'],
  unavailable:['Monitoreo no disponible','Monitoring unavailable'],
};
let checks=0;
try {
  for(const width of [1280,390,360]){
    // Each browser context has independent mock state. Never carry the prior
    // viewport's final 'unavailable' response into a fresh navigation.
    let healthState='idle_no_games';
    const context=await browser.newContext({viewport:{width,height:900},locale:'es-ES',timezoneId:'America/New_York',serviceWorkers:'block'});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    const json=(route,body)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    await page.route('**/v1/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/v1/me')return json(route,{enabled:false,user:null});
      if(path==='/v1/mlb/today')return json(route,{sport:'mlb',date,events:[sample],record:null});
      if(path==='/v1/mlb/live')return json(route,{sport:'mlb',date,games:[]});
      if(/\/(nba|wnba)\/learning$/.test(path))return json(route,{sport:path.split('/')[2],updated_at:new Date().toISOString(),historical:{n:100,brier:.24},forward:{n:0},gate:{public:false,passed:false,approved:false},learning_es:['Solo validación.'],learning_en:['Validation only.']});
      if(/\/(nba|wnba)\/pipeline-health$/.test(path))return json(route,{schema:'aa-basketball-producer-health-v1',sport:path.split('/')[2],state:healthState,last_success_at:date+'T18:00:00Z',prediction_updated_at:'2026-08-01T12:00:00Z'});
      if(path.endsWith('/today'))return json(route,{date,events:[],by_id:{}});
      if(path.endsWith('/live')||path.endsWith('/recent'))return json(route,{date,games:[]});
      if(path.endsWith('/standings'))return json(route,{sections:[]});
      if(path.endsWith('/intelligence/today'))return json(route,{state:'paused',candidates:[],bundles:[]});
      return json(route,{});
    });
    await page.route(/^https:\/\/(a\.espncdn\.com|midfield\.mlbstatic\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|static\.cloudflareinsights\.com)\//,r=>r.fulfill({status:200,body:'',contentType:'text/plain'}));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/?sport=mlb`,{waitUntil:'domcontentloaded'});
      await page.locator('.sp[data-sport="mlb"]').click();
      await page.locator('.mrow[data-id="reliability-1"]').waitFor();
      assert.ok(await page.locator('#q').isVisible(),`${width}: visible search`);
      await page.locator('#q').fill('AA_NO_SUCH_TEAM');
      await page.waitForFunction(()=>document.querySelectorAll('#list .mrow').length===0);
      await page.locator('#q').fill('');
      await page.locator('.mrow[data-id="reliability-1"]').click();
      assert.match(await page.locator('#dcard').innerText(),/insuficientes|evaluar/i);
      assert.doesNotMatch(await page.locator('#dcard').innerText(),/Ventaja moderada|Riesgo bajo/);
      await page.locator('#langbtn').evaluate(el=>el.click());
      assert.match(await page.locator('#dcard').innerText(),/No comparable price; value cannot be determined/);
      // A cached older payload must not resurrect a green risk label or a value claim.
      await page.evaluate(()=>{const ev=events.find(e=>e.event_id==='reliability-1');ev.risk={level:'bajo',score:0};ev.snapshot={verdict_es:'Ventaja moderada: legacy'};ev.metrics=[{kind:'risk',key:'metric_risk',value:'bajo'}];renderDetail();});
      assert.match(await page.locator('#dcard').innerText(),/insufficient|enough data/i);
      assert.doesNotMatch(await page.locator('#dcard').innerText(),/Ventaja moderada|0\/100/);
      if(width<900)await page.locator('#dback').click();
      await page.locator('#langbtn').click();
      assert.doesNotMatch(await page.locator('#dcard').innerText(),/Ventaja moderada|0\/100/);
      checks+=4;
      for(const sport of ['nba','wnba']){
        healthState='idle_no_games';
        await page.locator(`.sp[data-sport="${sport}"]`).click();
        await page.locator('.ltab[data-lt="brain"]').click();
        // Navigation may start loadLearning(). Drain that request before
        // invalidating its cache: the production loader correctly deduplicates
        // concurrent calls rather than returning a second in-flight request.
        await page.waitForFunction(target=>sport===target && listTab==='brain' && !sportLearningLoading.has(target) && sportProducerHealth.has(target),sport);
        for(const [state,labels] of Object.entries(states)){
          healthState=state;
          await page.evaluate(async()=>{sportLearningAt.delete(sport);await loadLearning();});
          await page.locator(`.producer-status[data-producer-state="${state}"]`).waitFor();
          assert.match(await page.locator('.producer-status').innerText(),new RegExp(labels[0]));
          assert.match(await page.locator('.producer-status').innerText(),/Última ejecución correcta[\s\S]*Última fila de predicción/);
          await page.locator('#langbtn').click();
          assert.match(await page.locator('.producer-status').innerText(),new RegExp(labels[1]));
          assert.match(await page.locator('.producer-status').innerText(),/does not approve the model/);
          assert.doesNotMatch(await page.locator('#list').innerText(),/Gate abierto|Gate passed/);
          const size=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));
          assert.ok(size.sw<=size.cw+1,`${engine}/${width}/${state}: overflow ${JSON.stringify(size)}`);
          await page.locator('#langbtn').click();checks+=2;
        }
      }
      await page.screenshot({path:resolve(OUT,`${width}.png`),fullPage:true});
      assert.deepEqual(errors,[],`${engine}/${width}: browser errors`);
    } catch(error){await page.screenshot({path:resolve(OUT,`${width}-failure.png`),fullPage:true});throw error;}
    finally{await context.close();}
  }
  console.log(JSON.stringify({browser:engine,checks,widths:[1280,390,360],languages:['es','en'],passed:true,production_access:false}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
