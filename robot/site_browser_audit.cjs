// Read-only production audit: no login, form submission, favorites write, or model publication.
const { createRequire } = require('node:module');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = createRequire('/tmp/aa-browser/package.json')('playwright');
const OUT = process.env.AUDIT_OUT || 'audit-results';
const SITE = 'https://aasport.net';
const API = 'https://aa-sports-api.opsmira9.workers.dev';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const report = { started_at: new Date().toISOString(), cases: [], skipped_cases: [], page_errors: [], console_errors: [], failed_requests: [], http_errors: [], http_checks: [] };
  try {
    const year = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(new Date());
    for (const [name, url] of [
      ['site', SITE + '/'], ['www', 'https://www.aasport.net/'],
      ['manifest', SITE + '/manifest.webmanifest'], ['service-worker', SITE + '/sw.js'],
      ['icon192', SITE + '/assets/icon-192.png'], ['icon512', SITE + '/assets/icon-512.png'],
      ['mlb-standings-api', API + '/v1/mlb/standings'],
      ['mlb-standings-source', 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings?level=3'],
      ['mlb-standings-explicit-season', `https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings?level=3&season=${year}`],
      ['anonymous-qa', API + '/v1/qa/nfl/today'],
    ]) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
        const text = r.headers.get('content-type')?.includes('image/') ? '' : await r.text();
        const result = { name, url, final_url: r.url, status: r.status, headers: Object.fromEntries(r.headers) };
        if (name.includes('standings')) {
          const d = JSON.parse(text); result.season = d.season;
          fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify(d, null, 2));
        }
        if (name === 'site') result.bytes = Buffer.byteLength(text);
        result.pass = r.status === (name === 'anonymous-qa' ? 401 : 200);
        report.http_checks.push(result);
      } catch (error) { report.http_checks.push({ name, url, pass: false, error: error.message }); }
    }
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 360, height: 800 }]) {
      const context = await browser.newContext({ viewport, locale: 'es-US', timezoneId: 'America/New_York' });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const label = String(viewport.width);
      page.on('pageerror', error => report.page_errors.push({ viewport: label, message: error.message, stack: error.stack }));
      page.on('console', message => { if (message.type() === 'error') report.console_errors.push({ viewport: label, message: message.text() }); });
      page.on('requestfailed', request => report.failed_requests.push({ viewport: label, url: request.url(), error: request.failure()?.errorText }));
      page.on('response', response => { if (response.status() >= 400) report.http_errors.push({ viewport: label, url: response.url(), status: response.status() }); });
      async function settle() {
        await page.waitForLoadState('networkidle', { timeout: 20000 });
        await page.waitForFunction(() => !document.querySelector('#list .skel') && !otherLoading && !histLoading && !learningLoading && !radarLoading && !sportLearningLoading.size);
      }
      async function closeDetail() {
        if (await page.locator('#detail').evaluate(e => e.classList.contains('open'))) await page.locator('#dback').click();
      }
      async function run(name, action) {
        try {
          await action();
          await settle();
          const state = await page.evaluate(() => ({
            title: document.title, url: location.href, sport, listTab, viewDate, viewFuture,
            viewport: innerWidth, scroll_width: document.documentElement.scrollWidth,
            body_text: document.body.innerText.slice(0, 26000),
            list_text: document.querySelector('#list')?.innerText.slice(0, 16000),
            broken_images: [...document.images].filter(i => i.complete && !i.naturalWidth && i.getBoundingClientRect().width > 0).map(i => i.src)
          }));
          fs.writeFileSync(`${OUT}/${label}-${name}.json`, JSON.stringify(state, null, 2));
          if (viewport.width === 1440 || ['home', 'mlb', 'mlb-detail', 'mlb-pos', 'ncaaf', 'english'].includes(name)) {
            await page.screenshot({ path: `${OUT}/${label}-${name}.png`, fullPage: true });
          }
          assert.ok(state.scroll_width <= state.viewport + 1, `Horizontal page overflow: ${state.scroll_width}/${state.viewport}`);
          assert.equal(state.broken_images.length, 0, `Broken images: ${state.broken_images.join(', ')}`);
          assert.ok(state.body_text.length > 250, 'Page content is unexpectedly empty');
          report.cases.push({ viewport: label, name, pass: true, sport: state.sport, tab: state.listTab, text_length: state.body_text.length });
        } catch (error) {
          report.cases.push({ viewport: label, name, pass: false, error: error.message });
          await page.screenshot({ path: `${OUT}/${label}-${name}-failure.png`, fullPage: true }).catch(() => {});
        }
        console.log('BROWSER_CASE', JSON.stringify(report.cases.at(-1)));
      }
      await run('home', async () => {
        const r = await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        assert.equal(r.status(), 200);
        await page.locator('.sp[data-sport="radar"].on').waitFor();
      });
      await run('central-detail', async () => {
        const row = page.locator('#list [data-rw]').first();
        if (await row.count()) { await row.click(); assert.ok((await page.locator('#dcard').innerText()).length > 100); }
        else assert.match(await page.locator('#list').innerText(), /sin|ningun|no |0\/12/i);
      });
      await closeDetail();
      for (const sp of ['mlb', 'nba', 'wnba', 'nfl', 'ncaaf', 'nhl', 'ncaam', 'soccer', 'tennis']) {
        await run(sp, async () => {
          await closeDetail();
          await page.locator(`.sp[data-sport="${sp}"]`).click();
          await page.locator(`.sp[data-sport="${sp}"].on`).waitFor();
        });
        await run(`${sp}-detail`, async () => {
          const row = page.locator(sp === 'mlb' ? '#list .mrow[data-id]' : '#list .mrow[data-oid]').first();
          if (await row.count()) { await row.click(); assert.ok((await page.locator('#dcard').innerText()).length > 80); }
          else assert.ok((await page.locator('#list').innerText()).length > 20, 'Empty slate lacks an explanation');
        });
        await closeDetail();
        for (const tab of sp === 'mlb' ? ['pos', 'hist', 'brain', 'favs', 'all'] : ['pos', 'brain', 'all']) {
          await run(`${sp}-${tab}`, async () => {
            await page.locator(`.ltab[data-lt="${tab}"]`).click();
            await page.locator(`.ltab[data-lt="${tab}"].on`).waitFor();
          });
        }
        if (sp === 'mlb') {
          await run('mlb-search-empty', async () => {
            assert.ok(await page.locator('#q').isVisible(), 'Search must be available on mobile and desktop');
            await page.locator('#q').fill('AA_AUDIT_NO_MATCH_928');
            assert.equal(await page.locator('#list .mrow').count(), 0);
          });
          await page.locator('#q').fill('');
          await run('mlb-previous-day', async () => {
            await page.locator('#dPrev').click();
            await page.waitForFunction(() => !!viewDate && !viewFuture);
          });
          await run('mlb-back-today', async () => {
            await page.locator('#dToday').click();
            await page.waitForFunction(() => viewDate === null);
          });
          await run('mlb-next-day', async () => {
            await page.locator('#dNext').click();
            await page.waitForFunction(() => !!viewDate && viewFuture);
          });
          await page.locator('#dToday').click();
          await settle();
        }
      }
      await run('english', async () => {
        await page.locator('#langbtn').click();
        await page.waitForFunction(() => document.title.includes('The data decides'));
      });
      await run('spanish', async () => {
        await page.locator('#langbtn').click();
        await page.waitForFunction(() => document.title.includes('Los datos deciden'));
      });
      await context.close();
    }
  } catch (error) {
    report.fatal = error.stack || String(error);
  } finally {
    await browser.close();
    report.finished_at = new Date().toISOString();
    fs.writeFileSync(`${OUT}/browser-report.json`, JSON.stringify(report, null, 2));
    console.log('BROWSER_SUMMARY', JSON.stringify({ cases: report.cases.length, skipped: report.skipped_cases, failed: report.cases.filter(c => !c.pass), page_errors: report.page_errors, console_errors: report.console_errors, http_errors: report.http_errors, failed_requests: report.failed_requests, http_checks: report.http_checks, fatal: report.fatal }));
    if (report.fatal || report.page_errors.length || report.console_errors.length || report.http_errors.length || report.failed_requests.length || report.cases.some(c => !c.pass) || report.http_checks.some(c => !c.pass)) process.exitCode = 1;
  }
})();
