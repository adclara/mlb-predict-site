import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const playwright = require('playwright');
const engine = process.env.AA_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox', 'webkit'].includes(engine), `unsupported browser ${engine}`);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../cloudflare/pages');
const INDEX = resolve(ROOT, 'index.html');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const archiveDate = (() => {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
})();

function mlbEvent(id, index = 0, date = today) {
  return {
    sport: 'mlb', league: 'MLB', event_id: id, matchup: `MIN @ CLE ${index + 1}`,
    start: `${date}T${String(17 + index).padStart(2, '0')}:00:00Z`, status: 'pre',
    away: { code: 'MIN', name: 'Minnesota Twins' },
    home: { code: 'CLE', name: 'Cleveland Guardians' },
    prediction: { pick: 'CLE', prob: .57, prob_pct: 57, confidence: 'media' },
    metrics: [
      { key: 'metric_prob_cal', label: 'Prob. AA calibrada', value: '57%', kind: 'pct' },
      { label: 'Muestra', value: '106', kind: 'count' },
    ],
    snapshot: {
      pitchers: {
        away: { name: 'Away Starter', id: 1, era: 4.2, fip: 4.1 },
        home: { name: 'Home Starter', id: 2, era: 3.1, fip: 3.2 },
      },
      form: { away: [{ w: true, score: '5-2' }], home: [{ w: false, score: '2-5' }] },
      total: { line: 8.5, aa_total: 9.1, lean: 'over', prob_pct: 56 },
      context: { series: { game: 2, len: 3, home_wins: 1, away_wins: 0 } },
    },
    risk: { level: 'bajo', score: 18, coverage: 1 }, odds: null, badges: [], result: null, final: null,
  };
}
const todayEvents = Array.from({ length: 5 }, (_, index) => mlbEvent(`g${index + 1}`, index));
const archiveEvents = Array.from({ length: 3 }, (_, index) => mlbEvent(`d${index + 1}`, index, archiveDate));
const nbaGame = {
  espn_id: 'n1', start: `${today}T23:00:00Z`, status: 'pre', status_detail: 'Scheduled',
  away: { code: 'NY', name: 'New York', score: null },
  home: { code: 'BOS', name: 'Boston', score: null },
};
const centralItem = {
  id: 'r1', sport: 'mlb', event_id: 'r1', start: `${today}T23:00:00Z`, market: 'winner', pick: 'CLE',
  selection_scope: 'aa_public', away: { code: 'MIN', name: 'Minnesota Twins' },
  home: { code: 'CLE', name: 'Cleveland Guardians' }, probability: { value: .57, kind: 'aa_calibrated' },
  aa: { prob: .57, public_gate: true }, books: { prob: .55, n: 1 },
  polymarket: { matched: false, reason: 'not_listed' }, kalshi: { matched: false, reason: 'not_listed' },
  consensus: { state: 'agree', market_prob: .55, anomalies: [] }, reasons: [], context: {},
};

const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function installMocks(page) {
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events: todayEvents, record: null, publication: { state: 'published' } });
    if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
    if (path === `/v1/mlb/day/${archiveDate}` || path === `/v1/mlb/schedule/${archiveDate}`) {
      return json(route, { sport: 'mlb', date: archiveDate, events: archiveEvents, record: null });
    }
    if (path === '/v1/mlb/standings') return json(route, { sections: [] });
    if (path === '/v1/nba/live') return json(route, { sport: 'nba', games: [nbaGame] });
    if (path === '/v1/nba/recent') return json(route, { sport: 'nba', games: [] });
    if (path === '/v1/nba/today') return json(route, { sport: 'nba', events: [] });
    if (path === '/v1/nba/standings') return json(route, { sport: 'nba', sections: [] });
    if (path === '/v1/intelligence/today') return json(route, {
      version: 'intelligence_v2', state: 'fresh', as_of: `${today}T12:00:00Z`, next_refresh: `${today}T12:30:00Z`,
      freshness: { age_minutes: 1, stale: false, hard_stale: false }, slate: [centralItem],
      market_bundles: [{ legs: [{ id: centralItem.id, sport: centralItem.sport, pick: centralItem.pick, prob: .57, source: 'aa_public' }] }],
      combos: { state: 'closed', sample: { n: 0, min_forward: 100 } },
    });
    if (path === '/v1/injuries') return json(route, {});
    if (path === '/v1/me') return json(route, { enabled: false, user: null });
    return json(route, {});
  });
  await page.route(/^https:\/\/(a\.espncdn\.com|img\.mlbstatic\.com|midfield\.mlbstatic\.com)\//, route => route.fulfill({ status: 204, body: '' }));
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ status: 204, body: '' }));
}

function collectErrors(page) {
  const errors = [];
  const knownExternalNoise = /Failed to load resource|ERR_TUNNEL_CONNECTION_FAILED|Load request cancelled|NS_BINDING_ABORTED|Cross-Origin Request Blocked|blocked by CORS policy|CORS request did not succeed|access control checks/i;
  const knownExternalHostText = /aa-sports-api\.opsmira9\.workers\.dev|fonts\.googleapis\.com|fonts\.gstatic\.com|a\.espncdn\.com|img\.mlbstatic\.com|midfield\.mlbstatic\.com/i;
  const isFirstParty = (url, message = '') => {
    try {
      return url ? new URL(url).origin === new URL(base).origin : !knownExternalHostText.test(message);
    }
    catch { return true; }
  };
  const shouldCollect = (url, message) => isFirstParty(url, message) || !knownExternalNoise.test(message);
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && shouldCollect(message.location().url, message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('requestfailed', request => {
    const failure = request.failure()?.errorText || '';
    if (shouldCollect(request.url(), failure)) errors.push(`requestfailed: ${request.url()} ${failure}`);
  });
  return errors;
}

async function assertNoHorizontalOverflow(page, label) {
  const size = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    docClient: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth,
    bodyClient: document.body.clientWidth,
  }));
  assert.ok(size.docScroll <= size.docClient + 1 && size.bodyScroll <= size.bodyClient + 1,
    `${label}: horizontal overflow ${JSON.stringify(size)}`);
}

async function openMockedPage(context, url) {
  const page = await context.newPage();
  const errors = collectErrors(page);
  await installMocks(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { page, errors };
}

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://local').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = resolve(ROOT, relative);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const base = `http://127.0.0.1:${server.address().port}`;
const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const launch = { headless: true };
if (engine === 'chromium' && executable && existsSync(executable)) launch.executablePath = executable;
const browser = await playwright[engine].launch(launch);

try {
  {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = collectErrors(page);
    await page.route(`${base}/filter-probe`, route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><title>filter probe</title>',
    }));
    await page.goto(`${base}/filter-probe`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => console.error('Failed to load resource: same-origin application failure'));
    assert.deepEqual(errors, ['console: Failed to load resource: same-origin application failure'],
      'same-origin console failure was hidden as browser noise');

    errors.length = 0;
    await page.route('https://outside.test/filter-probe', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><script>console.error("Failed to load resource: net::NS_BINDING_ABORTED external noise")</script>',
    }));
    const externalConsole = page.waitForEvent('console', message => message.text().includes('external noise'));
    await page.goto('https://outside.test/filter-probe', { waitUntil: 'domcontentloaded' });
    await externalConsole;
    assert.deepEqual(errors, [], 'known external browser noise was collected as an application failure');
    await context.close();
  }

  const source = await readFile(INDEX, 'utf8');
  assert.match(source, /<body\s+class="aa-list">/, 'initial HTML body must start in aa-list');
  assert.doesNotMatch(source, /document\.body\.style\.overflow\s*=|classList\.add\(['"]open['"]\)/,
    'legacy object overlay writers must be removed');

  for (const viewport of [
    { name: '1440x900', width: 1440, height: 900 },
    { name: '390x844', width: 390, height: 844 },
    { name: '360x800', width: 360, height: 800 },
    { name: '320-reflow', width: 320, height: 800 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      locale: 'es-ES', timezoneId: 'America/New_York', serviceWorkers: 'block',
    });

    const listRun = await openMockedPage(context, `${base}/?s=mlb&date=${archiveDate}`);
    await listRun.page.locator('.mrow[data-id="d3"]').waitFor({ state: 'visible' });
    const listShell = await listRun.page.evaluate(() => {
      const css = selector => getComputedStyle(document.querySelector(selector));
      const layout = css('.layout');
      return {
        list: document.body.classList.contains('aa-list'),
        page: document.body.classList.contains('aa-page'),
        layoutDisplay: layout.display,
        columns: layout.gridTemplateColumns.split(' ').filter(Boolean).length,
        maxWidth: layout.maxWidth,
        detail: css('#detail').display,
        side: css('.colside').display,
        listPane: css('#listpane').display,
      };
    });
    assert.deepEqual(listShell, {
      list: true, page: false, layoutDisplay: 'grid', columns: 1, maxWidth: 'none',
      detail: 'none', side: 'none', listPane: 'block',
    }, `${viewport.name}: list shell`);
    if (viewport.width <= 900) {
      const listMobileNav = await listRun.page.evaluate(() => ({
        bottomDisplay: getComputedStyle(document.querySelector('.aa-bottomnav')).display,
        bottomPosition: getComputedStyle(document.querySelector('.aa-bottomnav')).position,
        endDisplay: getComputedStyle(document.querySelector('.aa-page-endnav')).display,
      }));
      assert.deepEqual(listMobileNav, { bottomDisplay: 'flex', bottomPosition: 'fixed', endDisplay: 'none' },
        `${viewport.name}: list route mobile navigation`);
    }
    if (viewport.name === '1440x900') {
      const third = await listRun.page.locator('.mrow[data-id="d3"]').boundingBox();
      assert.ok(third && third.y + third.height <= viewport.height, `${viewport.name}: three archive rows are not fully visible`);
    }
    await assertNoHorizontalOverflow(listRun.page, `${viewport.name}/list`);
    assert.deepEqual(listRun.errors, [], `${viewport.name}/list: browser errors`);
    await listRun.page.close();

    const objectRun = await openMockedPage(context, `${base}/?s=mlb&g=g1`);
    await objectRun.page.locator('#dcard .dhero').waitFor({ state: 'visible' });
    await objectRun.page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    const objectShell = await objectRun.page.evaluate(() => {
      const css = selector => getComputedStyle(document.querySelector(selector));
      const layout = css('.layout'), detail = css('#detail'), back = document.querySelector('#dback');
      const backBox = back.getBoundingClientRect();
      return {
        list: document.body.classList.contains('aa-list'),
        page: document.body.classList.contains('aa-page'),
        bodyInlineOverflow: document.body.style.overflow,
        bodyOverflowY: getComputedStyle(document.body).overflowY,
        open: document.querySelector('#detail').classList.contains('open'),
        layoutDisplay: layout.display,
        columns: layout.gridTemplateColumns.split(' ').filter(Boolean).length,
        maxWidth: layout.maxWidth,
        listPane: css('#listpane').display,
        side: css('.colside').display,
        detail: {
          display: detail.display, position: detail.position, maxHeight: detail.maxHeight,
          overflowY: detail.overflowY, clientHeight: document.querySelector('#detail').clientHeight,
          scrollHeight: document.querySelector('#detail').scrollHeight,
        },
        back: { display: css('#dback').display, height: backBox.height },
      };
    });
    assert.equal(objectShell.list, false, `${viewport.name}: object retained aa-list`);
    assert.equal(objectShell.page, true, `${viewport.name}: object missing aa-page`);
    assert.equal(objectShell.bodyInlineOverflow, '', `${viewport.name}: object wrote body overflow lock`);
    assert.notEqual(objectShell.bodyOverflowY, 'hidden', `${viewport.name}: object locks body scroll`);
    assert.equal(objectShell.open, false, `${viewport.name}: object uses legacy .open overlay`);
    assert.equal(objectShell.layoutDisplay, 'grid', `${viewport.name}: object layout is not grid`);
    assert.equal(objectShell.columns, 1, `${viewport.name}: object layout is not one column`);
    assert.equal(objectShell.maxWidth, '1180px', `${viewport.name}: object max width`);
    assert.equal(objectShell.listPane, 'none', `${viewport.name}: object list pane visible`);
    assert.equal(objectShell.side, 'none', `${viewport.name}: object side column visible`);
    assert.equal(objectShell.detail.display, 'block', `${viewport.name}: object detail hidden`);
    assert.equal(objectShell.detail.position, 'static', `${viewport.name}: detail is not in document flow`);
    assert.equal(objectShell.detail.maxHeight, 'none', `${viewport.name}: detail still has max-height`);
    assert.equal(objectShell.detail.overflowY, 'visible', `${viewport.name}: detail has internal vertical scrolling`);
    assert.ok(objectShell.detail.scrollHeight <= objectShell.detail.clientHeight + 1, `${viewport.name}: detail is internally scrollable`);
    assert.notEqual(objectShell.back.display, 'none', `${viewport.name}: Back hidden`);
    assert.ok(objectShell.back.height >= 44, `${viewport.name}: Back target ${objectShell.back.height}px`);
    if (viewport.width <= 900) {
      const pageMobileNav = await objectRun.page.evaluate(() => {
        const end = document.querySelector('.aa-page-endnav');
        return {
          bottomDisplay: getComputedStyle(document.querySelector('.aa-bottomnav')).display,
          endDisplay: getComputedStyle(end).display,
          endPosition: getComputedStyle(end).position,
          labels: [...end.querySelectorAll('button')].map(button => button.lastElementChild?.textContent.trim()),
          detailPaddingBottom: parseFloat(getComputedStyle(document.querySelector('#detail')).paddingBottom),
          globalEscapeVisible: document.querySelector('header .logo').getBoundingClientRect().height > 0,
        };
      });
      assert.equal(pageMobileNav.bottomDisplay, 'none', `${viewport.name}: fixed bottom nav visible on object`);
      assert.equal(pageMobileNav.endDisplay, 'grid', `${viewport.name}: missing page-end navigation`);
      assert.equal(pageMobileNav.endPosition, 'static', `${viewport.name}: page-end navigation must stay in document flow`);
      assert.deepEqual(pageMobileNav.labels, ['Inicio', 'Partidos', 'Historial', 'Config'], `${viewport.name}: localized page-end destinations`);
      assert.ok(pageMobileNav.detailPaddingBottom >= 24, `${viewport.name}: missing safe-area base padding`);
      assert.equal(pageMobileNav.globalEscapeVisible, true, `${viewport.name}: compact global escape hidden`);
      if (viewport.width === 390) {
        await objectRun.page.locator('#langbtn').click();
        const englishLabels = await objectRun.page.locator('.aa-page-endnav button').evaluateAll(buttons =>
          buttons.map(button => button.lastElementChild?.textContent.trim()));
        assert.deepEqual(englishLabels, ['Home', 'Games', 'History', 'Settings'], 'page-end navigation did not localize to English');
      }
    }
    const eventBox = await objectRun.page.evaluate(() => {
      const box = document.createElement('div');
      box.className = 'evbox';
      box.innerHTML = '<div style="height:600px">fixture</div>';
      document.querySelector('#dcard').appendChild(box);
      const css = getComputedStyle(box);
      return { maxHeight: css.maxHeight, overflowY: css.overflowY, clientHeight: box.clientHeight, scrollHeight: box.scrollHeight };
    });
    assert.equal(eventBox.maxHeight, 'none', `${viewport.name}: .evbox still has max-height`);
    assert.equal(eventBox.overflowY, 'visible', `${viewport.name}: .evbox still scrolls internally`);
    assert.ok(eventBox.scrollHeight <= eventBox.clientHeight + 1, `${viewport.name}: .evbox has a vertical scrollport`);
    const maxDocumentScroll = await objectRun.page.evaluate(() =>
      document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight);
    await objectRun.page.evaluate(max => window.scrollTo(0, max), maxDocumentScroll);
    await objectRun.page.waitForFunction(() => Math.max(scrollY, document.documentElement.scrollTop, document.body.scrollTop) > 0);
    const scroll = await objectRun.page.evaluate((max) => ({
      y: Math.max(scrollY, document.documentElement.scrollTop, document.body.scrollTop), max,
      detail: document.querySelector('#detail').scrollTop,
    }), maxDocumentScroll);
    assert.ok(scroll.max > 0 && scroll.y > 0, `${viewport.name}: object did not use document scroll ${JSON.stringify(scroll)}`);
    assert.equal(scroll.detail, 0, `${viewport.name}: detail consumed vertical scroll`);
    await assertNoHorizontalOverflow(objectRun.page, `${viewport.name}/object`);
    assert.deepEqual(objectRun.errors, [], `${viewport.name}/object: browser errors`);
    await objectRun.page.close();

    if (viewport.name === '1440x900') {
      const desktopNav = await openMockedPage(context, `${base}/?s=mlb&g=g1`);
      await desktopNav.page.locator('#dcard .dhero').waitFor({ state: 'visible' });
      await desktopNav.page.locator('.aa-rail [data-rail="mlb"]').click();
      await desktopNav.page.waitForFunction(() => location.search === '?s=mlb');
      assert.equal(await desktopNav.page.locator('body.aa-list').count(), 1,
        'desktop Partidos did not leave an MLB object for the canonical list');
      assert.deepEqual(desktopNav.errors, [], 'desktop Partidos destination: browser errors');
      await desktopNav.page.close();
    }

    if (viewport.name === '390x844') {
      for (const destination of [
        { rail: 'home', search: '?s=home' },
        { rail: 'mlb', search: '?s=mlb' },
        { rail: 'hist', search: '?s=mlb&lt=hist' },
        { rail: 'cfg', search: '?s=mlb&lt=cfg' },
      ]) {
        const mobileNav = await openMockedPage(context, `${base}/?s=mlb&g=g1`);
        await mobileNav.page.locator('#dcard .dhero').waitFor({ state: 'visible' });
        await mobileNav.page.locator(`.aa-page-endnav [data-rail="${destination.rail}"]`).click();
        await mobileNav.page.waitForFunction(expected => location.search === expected, destination.search);
        assert.equal(await mobileNav.page.locator('body.aa-list').count(), 1,
          `page-end ${destination.rail} did not open its list destination`);
        assert.deepEqual(mobileNav.errors, [], `page-end ${destination.rail}: browser errors`);
        await mobileNav.page.close();
      }
    }

    await context.close();
  }

  const invalidContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-ES', serviceWorkers: 'block' });
  const invalid = await openMockedPage(invalidContext, `${base}/?s=mlb&g=missing`);
  await invalid.page.locator('.mrow[data-id="g1"]').waitFor({ state: 'attached' });
  assert.equal(await invalid.page.locator('body.aa-page').count(), 1, 'invalid validated object route must remain aa-page');
  assert.equal(await invalid.page.locator('.mrow.sel').count(), 0, 'invalid object selected a fallback row');
  const beforeReload = await invalid.page.evaluate(() => ({ length: history.length, state: history.state }));
  await Promise.all([
    invalid.page.waitForEvent('domcontentloaded'),
    invalid.page.evaluate(() => { location.reload(); }),
  ]);
  await invalid.page.locator('.mrow[data-id="g1"]').waitFor({ state: 'attached' });
  const afterReload = await invalid.page.evaluate(() => ({ length: history.length, state: history.state }));
  assert.equal(afterReload.state.key, beforeReload.state.key, 'object reload replaced the object state');
  assert.equal(afterReload.state.parentKey, beforeReload.state.parentKey, 'object reload replaced the synthetic parent');
  assert.ok(afterReload.length <= beforeReload.length + (engine === 'firefox' ? 1 : 0), 'object reload duplicated app entries');
  assert.equal(await invalid.page.locator('body.aa-page').count(), 1, 'reload lost invalid object shell');
  await invalid.page.evaluate(() => history.back());
  await invalid.page.waitForFunction(() => !new URLSearchParams(location.search).has('g'));
  assert.equal(await invalid.page.locator('body.aa-list').count(), 1, 'Back did not restore list shell');
  await invalid.page.evaluate(() => history.forward());
  await invalid.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'missing');
  assert.equal(await invalid.page.locator('body.aa-page').count(), 1, 'Forward did not restore object shell');
  assert.deepEqual(invalid.errors, [], 'invalid/deep/Back/Forward: browser errors');
  await invalidContext.close();

  const walletContext = await browser.newContext({ viewport: { width: 360, height: 800 }, locale: 'es-ES', serviceWorkers: 'block' });
  const wallet = await openMockedPage(walletContext, `${base}/?s=radar&w=0x${'a'.repeat(40)}`);
  await wallet.page.locator('body.aa-page #dback').waitFor({ state: 'visible' });
  assert.equal(await wallet.page.locator('#detail.open').count(), 0, 'legacy Radar object reopened the overlay class');
  assert.equal(await wallet.page.evaluate(() => document.body.style.overflow), '', 'legacy Radar object locked body scroll');
  await wallet.page.locator('#dback').click();
  await wallet.page.waitForFunction(() => !new URLSearchParams(location.search).has('w'));
  assert.equal(await wallet.page.locator('body.aa-list').count(), 1, 'legacy Radar Back did not restore list shell');
  assert.deepEqual(wallet.errors, [], 'legacy Radar object: browser errors');
  await walletContext.close();

  const rowContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-ES', serviceWorkers: 'block' });
  const mlbRows = await openMockedPage(rowContext, `${base}/?s=mlb`);
  await mlbRows.page.locator('.mrow[data-id="g1"] [data-object-link]').waitFor();
  const mlbMarkup = await mlbRows.page.locator('.mrow[data-id="g1"]').evaluate(row => {
    const link = row.querySelector('[data-object-link]');
    const favorite = row.querySelector('[data-star]');
    const linkBox = link.getBoundingClientRect(), favoriteBox = favorite.getBoundingClientRect();
    return {
      outerTag: row.tagName, outerRole: row.getAttribute('role'), outerTabIndex: row.getAttribute('tabindex'),
      linkTag: link.tagName, href: link.getAttribute('href'), linkHeight: linkBox.height,
      favoriteTag: favorite.tagName, favoriteHeight: favoriteBox.height,
      favoriteSibling: favorite.parentElement === row && link.parentElement === row,
      nestedInteractive: row.querySelectorAll('a a, a button, button a, button button').length,
    };
  });
  assert.deepEqual(mlbMarkup, {
    outerTag: 'DIV', outerRole: null, outerTabIndex: null,
    linkTag: 'A', href: '/?s=mlb&g=g1', linkHeight: mlbMarkup.linkHeight,
    favoriteTag: 'BUTTON', favoriteHeight: mlbMarkup.favoriteHeight, favoriteSibling: true, nestedInteractive: 0,
  }, 'MLB row must have a noninteractive outer row with sibling link/favorite controls');
  // WebKit can report a 44px CSS target as 43.999969px after subpixel layout.
  const targetTolerance = 0.001;
  assert.ok(mlbMarkup.linkHeight >= 44 - targetTolerance, `MLB link target ${mlbMarkup.linkHeight}px`);
  assert.ok(mlbMarkup.favoriteHeight >= 44 - targetTolerance, `MLB favorite target ${mlbMarkup.favoriteHeight}px`);
  const beforeFavorite = mlbRows.page.url();
  await mlbRows.page.locator('.mrow[data-id="g1"] [data-star]').click();
  assert.equal(mlbRows.page.url(), beforeFavorite, 'favorite navigated to object');
  await mlbRows.page.evaluate(() => {
    window.__b1Pushes = 0;
    const push = history.pushState.bind(history);
    history.pushState = (...args) => { window.__b1Pushes += 1; return push(...args); };
  });
  await mlbRows.page.locator('.mrow[data-id="g1"] [data-object-link]').click();
  await mlbRows.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1');
  assert.equal(await mlbRows.page.evaluate(() => window.__b1Pushes), 1, 'MLB link must create one History navigation');
  await mlbRows.page.goBack();
  await mlbRows.page.waitForFunction(() => !new URLSearchParams(location.search).has('g'));
  await mlbRows.page.waitForFunction(() => document.activeElement === document.querySelector('.mrow[data-id="g1"] [data-object-link]'));
  const beforeModified = await mlbRows.page.evaluate(() => ({ href: location.href, pushes: window.__b1Pushes }));
  await mlbRows.page.locator('.mrow[data-id="g1"] [data-object-link]').dispatchEvent('click', { button: 0, ctrlKey: true });
  const afterModified = await mlbRows.page.evaluate(() => ({ href: location.href, pushes: window.__b1Pushes }));
  assert.deepEqual(afterModified, beforeModified, 'modified link click was intercepted instead of preserving new-tab semantics');
  assert.deepEqual(mlbRows.errors, [], 'MLB row semantics: browser errors');
  await mlbRows.page.close();

  const otherRows = await openMockedPage(rowContext, `${base}/?s=nba`);
  await otherRows.page.locator('.mrow[data-oid="n1"] [data-object-link]').waitFor();
  const otherMarkup = await otherRows.page.locator('.mrow[data-oid="n1"]').evaluate(row => ({
    outerTag: row.tagName, outerRole: row.getAttribute('role'),
    linkTag: row.querySelector('[data-object-link]')?.tagName,
    href: row.querySelector('[data-object-link]')?.getAttribute('href'),
    nestedInteractive: row.querySelectorAll('a a, a button, button a, button button').length,
  }));
  assert.deepEqual(otherMarkup, { outerTag: 'DIV', outerRole: null, linkTag: 'A', href: '/?s=nba&sc=n1', nestedInteractive: 0 },
    'other-sport row semantics');
  await otherRows.page.locator('.mrow[data-oid="n1"] [data-object-link]').click();
  await otherRows.page.waitForFunction(() => new URLSearchParams(location.search).get('sc') === 'n1');
  await otherRows.page.goBack();
  await otherRows.page.waitForFunction(() => !new URLSearchParams(location.search).has('sc'));
  await otherRows.page.waitForFunction(() => document.activeElement === document.querySelector('.mrow[data-oid="n1"] [data-object-link]'));
  assert.deepEqual(otherRows.errors, [], 'other-sport row semantics: browser errors');
  await otherRows.page.close();

  const centralRows = await openMockedPage(rowContext, `${base}/?s=radar`);
  await centralRows.page.locator('.intelrow[data-rw="r1"] [data-object-link]').waitFor();
  const centralMarkup = await centralRows.page.locator('.intelrow[data-rw="r1"]').evaluate(row => ({
    outerTag: row.tagName, outerRole: row.getAttribute('role'),
    linkTag: row.querySelector('[data-object-link]')?.tagName,
    href: row.querySelector('[data-object-link]')?.getAttribute('href'),
    nestedInteractive: row.querySelectorAll('a a, a button, button a, button button').length,
  }));
  assert.deepEqual(centralMarkup, { outerTag: 'DIV', outerRole: null, linkTag: 'A', href: '/?s=radar&g=r1', nestedInteractive: 0 },
    'Central row semantics');
  await centralRows.page.locator('.intelrow[data-rw="r1"] [data-object-link]').click();
  await centralRows.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'r1');
  await centralRows.page.goBack();
  await centralRows.page.waitForFunction(() => !new URLSearchParams(location.search).has('g'));
  await centralRows.page.waitForFunction(() => document.activeElement === document.querySelector('.intelrow[data-rw="r1"] [data-object-link]'));
  await centralRows.page.locator('#list .bundleleg[data-rw="r1"] [data-object-link]').click();
  await centralRows.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'r1');
  await centralRows.page.goBack();
  await centralRows.page.waitForFunction(() => !new URLSearchParams(location.search).has('g'));
  await centralRows.page.waitForFunction(() => document.activeElement === document.querySelector('#list .bundleleg[data-rw="r1"] [data-object-link]'));
  assert.equal(await centralRows.page.evaluate(() => document.activeElement.closest('.bundleleg')?.dataset.rw), 'r1',
    'Back from a bundle leg restored the duplicate main Central row instead of the exact bundle anchor');
  assert.deepEqual(centralRows.errors, [], 'Central row semantics: browser errors');
  await centralRows.page.close();
  await rowContext.close();

  console.log(`✅ match page shell (${engine}): route-owned shell + valid row links + exact focus restoration`);
} finally {
  await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
