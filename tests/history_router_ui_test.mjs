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
assert.ok(['chromium', 'firefox', 'webkit'].includes(engine));
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../cloudflare/pages');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const shiftDate = (iso, delta) => {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
};
const previousDay = shiftDate(today, -1);
const mlbEvent = (id, index = 0, date = today) => ({
  sport: 'mlb', league: 'MLB', event_id: id, matchup: `MIN @ CLE ${index + 1}`,
  start: `${date}T${String(14 + index).padStart(2, '0')}:00:00Z`, status: 'pre',
  away: { code: 'MIN', name: 'Minnesota Twins' },
  home: { code: 'CLE', name: 'Cleveland Guardians' },
  prediction: { pick: 'CLE', prob: 0.57, prob_pct: 57, confidence: 'media' },
  metrics: [{ key: 'metric_prob_cal', label: 'Prob. AA calibrada', value: '57%', kind: 'pct' }],
  snapshot: {}, risk: { level: 'bajo', score: 18, coverage: 1 }, odds: null, badges: [], result: null, final: null,
});
const events = Array.from({ length: 8 }, (_, index) => mlbEvent(`g${index + 1}`, index));
const dayEvents = Array.from({ length: 3 }, (_, index) => mlbEvent(`d${index + 1}`, index, previousDay));
const nbaGame = {
  espn_id: 'n1', status: 'pre', start: `${today}T23:00:00Z`, status_detail: 'Scheduled',
  away: { code: 'NY', name: 'New York', short_name: 'New York', score: null },
  home: { code: 'BOS', name: 'Boston', short_name: 'Boston', score: null },
};
const radarItem = {
  id: 'r1', sport: 'mlb', pick: 'CLE', start: `${today}T23:00:00Z`, selection_scope: 'aa_public',
  away: { code: 'MIN', name: 'Minnesota Twins' }, home: { code: 'CLE', name: 'Cleveland Guardians' },
  probability: { value: 0.57 }, aa: { prob: 0.57, public_gate: true }, consensus: { state: 'agree', anomalies: [] }, reasons: [], context: {},
};
const json = (route, body) => {
  const path = new URL(route.request().url()).pathname;
  const payload = path === '/v1/mlb/today' && body && !body.publication
    ? { ...body, publication: { state: (body.events || []).some(event => event?.prediction?.pick) ? 'published' : 'waiting' } }
    : body;
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
};

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url || '/', 'http://local').pathname);
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = resolve(ROOT, rel);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) throw new Error('outside');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', ok); });
const base = `http://127.0.0.1:${server.address().port}`;
const executablePath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find(existsSync);
const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' && executablePath ? { executablePath } : {}) });

const knownExternalNoise = /Failed to load resource|ERR_TUNNEL_CONNECTION_FAILED|Load request cancelled|NS_BINDING_ABORTED|Cross-Origin Request Blocked|blocked by CORS policy|CORS request did not succeed|access control checks/i;
const knownExternalHostText = /aa-sports-api\.opsmira9\.workers\.dev|fonts\.googleapis\.com|fonts\.gstatic\.com|a\.espncdn\.com|img\.mlbstatic\.com|midfield\.mlbstatic\.com/i;
const shouldCollectConsole = (page, message) => {
  const locationUrl = message.location().url;
  const text = message.text();
  try {
    const firstParty = locationUrl
      ? new URL(locationUrl).origin === new URL(base).origin
      : !knownExternalHostText.test(text);
    return firstParty || !knownExternalNoise.test(text);
  } catch { return true; }
};

async function mockPage(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && shouldCollectConsole(page, message)) errors.push(message.text());
  });
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
    if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
    if (path === `/v1/mlb/day/${previousDay}` || path === `/v1/mlb/schedule/${previousDay}`) {
      return json(route, { sport: 'mlb', date: previousDay, events: dayEvents, record: null });
    }
    if (path === '/v1/nba/live') return json(route, { sport: 'nba', games: [nbaGame, { ...nbaGame, espn_id: 'n:colon' }] });
    if (path === '/v1/nba/recent') return json(route, { sport: 'nba', games: [] });
    if (path === '/v1/nba/today') return json(route, { sport: 'nba', events: [] });
    if (path === '/v1/intelligence/today') return json(route, {
      version: 'intelligence_v2', state: 'fresh', as_of: `${today}T12:00:00Z`, next_refresh: `${today}T12:30:00Z`, slate: [radarItem],
      market_bundles: [], combos: { sample: { n: 0, min_forward: 100 } },
    });
    return json(route, {});
  });
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, contentType: 'font/woff2', body: '' }));
  return { page, errors };
}

async function delayedMlbPage(context, { todayDelay, dayDelay }) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && shouldCollectConsole(page, message)) errors.push(message.text());
  });
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/mlb/today') {
      await new Promise(resolveDelay => setTimeout(resolveDelay, todayDelay));
      return json(route, { sport: 'mlb', date: today, events: [mlbEvent('today-race')], record: null });
    }
    if (path === `/v1/mlb/day/${previousDay}` || path === `/v1/mlb/schedule/${previousDay}`) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, dayDelay));
      return json(route, { sport: 'mlb', date: previousDay, events: dayEvents, record: null });
    }
    return json(route, path === '/v1/mlb/live' ? { sport: 'mlb', date: today, games: [] } : {});
  });
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, contentType: 'font/woff2', body: '' }));
  return { page, errors };
}

const routeValue = (page, key) => page.evaluate((name) => new URLSearchParams(location.search).get(name), key);
const resetHistoryCounts = (page) => page.evaluate(() => {
  window.__aaPushes = 0;
  window.__aaReplaces = 0;
  if (!window.__aaHistoryWrapped) {
    window.__aaHistoryWrapped = true;
    const push = history.pushState.bind(history);
    const replace = history.replaceState.bind(history);
    history.pushState = (...args) => { window.__aaPushes += 1; return push(...args); };
    history.replaceState = (...args) => { window.__aaReplaces += 1; return replace(...args); };
  }
});
const historyCounts = (page) => page.evaluate(() => ({ push: window.__aaPushes, replace: window.__aaReplaces, length: history.length }));
const waitForMlb = (page, id = 'g1') => page.locator(`.mrow[data-id="${id}"]`).waitFor({ state: 'attached' });
const assertClean = (errors, label) => assert.deepEqual(errors, [], `${label}: console ${errors.join(' | ')}`);

try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
  const parserRun = await mockPage(desktop);
  await parserRun.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
  await waitForMlb(parserRun.page);
  const parsed = await parserRun.page.evaluate(() => aaReadRoute('?tab=mlb&g=g1&date=2026-09-19&lt=hist&dt=pitchers&m=total&p=p_1'));
  assert.deepEqual(parsed, {
    s: 'mlb', g: 'g1', sc: '', date: '2026-09-19', lt: 'hist',
    dt: 'pitchers', m: 'total', p: 'p_1', team: '', w: '',
  });
  const parsedOther = await parserRun.page.evaluate(() => aaReadRoute('?s=nba&sc=n1&team=BOS&m=players'));
  assert.deepEqual(parsedOther, {
    s: 'nba', g: '', sc: 'n1', date: '', lt: '', dt: '', m: 'players', p: '', team: 'BOS', w: '',
  });
  const wallet = `0x${'a'.repeat(40)}`;
  const parsedWallet = await parserRun.page.evaluate((value) => aaReadRoute(`?s=radar&w=${value}`), wallet);
  assert.equal(parsedWallet.w, wallet);
  const invalid = await parserRun.page.evaluate(() => aaReadRoute('?s=nope&tab=nba&g=bad%20id&sc=n1&date=2026-02-30&lt=no&dt=no&m=no&p=p1&team=T1&w=0x123'));
  assert.deepEqual(invalid, {
    s: 'nba', g: '', sc: 'n1', date: '', lt: '', dt: '', m: '', p: 'p1', team: '', w: '',
  });
  const built = await parserRun.page.evaluate(() => {
    const route = Object.freeze({ s: 'mlb', g: 'g1', date: '2026-09-19', lt: 'hist', dt: 'pitchers', m: 'total', p: 'p_1' });
    return aaBuildSearch(route);
  });
  assert.equal(built, '?s=mlb&g=g1&date=2026-09-19&lt=hist&dt=pitchers&m=total&p=p_1');
  const incompatible = await parserRun.page.evaluate(() => ({
    parsed: aaReadRoute('?s=nba&g=g1&sc=n1&dt=pitchers'),
    built: aaBuildSearch({ s: 'nba', g: 'g1', sc: 'n1', dt: 'pitchers' }),
  }));
  assert.deepEqual(incompatible.parsed, {
    s: 'nba', g: '', sc: 'n1', date: '', lt: '', dt: '', m: '', p: '', team: '', w: '',
  });
  assert.equal(incompatible.built, '?s=nba&sc=n1');
  const canonicalDefaults = await parserRun.page.evaluate(() => ({
    mlbList: aaBuildSearch({ s: 'mlb', lt: 'all' }),
    mlbObject: aaBuildSearch({ s: 'mlb', g: 'g1', dt: 'analisis', m: 'winner' }),
    parsedObject: aaReadRoute('?s=mlb&g=g1&lt=all&dt=analisis&m=winner'),
    home: aaBuildSearch({ s: 'home', date: '2026-09-19', lt: 'hist' }),
    parsedHome: aaReadRoute('?s=home&date=2026-09-19&lt=hist'),
  }));
  assert.equal(canonicalDefaults.mlbList, '?s=mlb');
  assert.equal(canonicalDefaults.mlbObject, '?s=mlb&g=g1');
  assert.equal(canonicalDefaults.parsedObject.lt, '');
  assert.equal(canonicalDefaults.parsedObject.dt, '');
  assert.equal(canonicalDefaults.parsedObject.m, '');
  assert.equal(canonicalDefaults.home, '?s=home');
  assert.equal(canonicalDefaults.parsedHome.date, '');
  assert.equal(canonicalDefaults.parsedHome.lt, '');
  assertClean(parserRun.errors, 'parser');
  await parserRun.page.close();
  await desktop.close();

  for (const viewport of [
    { name: '1440', width: 1440, height: 900 },
    { name: '390', width: 390, height: 844 },
    { name: '360', width: 360, height: 800 },
  ]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', locale: 'es-ES' });
    const { page, errors } = await mockPage(context);
    await page.goto(`${base}/?tab=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(page);
    assert.equal(await routeValue(page, 's'), 'mlb', `${viewport.name}: tab no se canonicalizó`);
    assert.equal(await routeValue(page, 'g'), null, `${viewport.name}: lista autoseleccionó g`);
    assert.equal(await page.locator('.mrow.sel').count(), 0, `${viewport.name}: lista marcó un juego`);
    assert.equal(await page.evaluate(() => history.scrollRestoration), 'manual', `${viewport.name}: scrollRestoration`);
    assert.equal((await page.evaluate(() => history.state)).kind, 'list', `${viewport.name}: estado inicial no es lista`);

    await resetHistoryCounts(page);
    await page.locator('.mrow[data-id="g1"] [data-object-link]').click();
    await page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1');
    assert.equal((await historyCounts(page)).push, 1, `${viewport.name}: abrir MLB no hizo un push exacto`);
    const objectState = await page.evaluate(() => history.state);
    assert.equal(objectState.kind, 'object', `${viewport.name}: estado de objeto`);
    assert.ok(objectState.parentKey, `${viewport.name}: falta parentKey`);
    assert.equal(objectState.route.g, 'g1', `${viewport.name}: route estatal`);

    await page.goBack();
    await page.waitForFunction(() => !new URLSearchParams(location.search).get('g'));
    const listState = await page.evaluate(() => history.state);
    assert.equal(listState.kind, 'list', `${viewport.name}: Back no restauró estado lista`);
    assert.equal(await page.locator('.mrow[data-id="g1"]').count(), 1, `${viewport.name}: lista no volvió`);
    await page.waitForFunction(() => document.activeElement?.dataset?.id === 'g1');

    await page.goForward();
    await page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1');
    assert.equal((await page.evaluate(() => history.state)).route.g, 'g1', `${viewport.name}: Forward no restauró objeto`);
    assertClean(errors, viewport.name);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await mockPage(context);
    await run.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(run.page);
    await run.page.locator('.mrow[data-id="g1"] [data-object-link]').click();
    await run.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1');
    await resetHistoryCounts(run.page);
    const before = await run.page.evaluate(() => ({ length: history.length, key: history.state.key, url: location.href }));
    await run.page.evaluate(() => navigateToObject({ ...history.state.route }));
    await run.page.waitForTimeout(50);
    const after = await run.page.evaluate(() => ({ length: history.length, key: history.state.key, url: location.href }));
    assert.deepEqual(after, before, 'click duplicado cambió la entrada activa');
    assert.deepEqual(await historyCounts(run.page).then(({ push, replace }) => ({ push, replace })), { push: 0, replace: 0 }, 'click duplicado escribió History API');
    assertClean(run.errors, 'duplicate object click');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await mockPage(context);
    await run.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(run.page);
    await run.page.locator('.mrow[data-id="g1"] [data-object-link]').click();
    await run.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1');
    const first = await run.page.evaluate(() => ({ length: history.length, parentKey: history.state.parentKey }));
    await resetHistoryCounts(run.page);
    await run.page.evaluate(() => navigateToObject({ ...history.state.route, g: 'g2' }));
    await run.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g2');
    const second = await run.page.evaluate(() => ({ length: history.length, parentKey: history.state.parentKey, kind: history.state.kind }));
    assert.equal(second.kind, 'object');
    assert.equal(second.parentKey, first.parentKey, 'cambiar A→B perdió el padre lógico');
    assert.equal(second.length, first.length, 'cambiar A→B agregó una entrada adyacente');
    assert.deepEqual(await historyCounts(run.page).then(({ push, replace }) => ({ push, replace })), { push: 0, replace: 1 }, 'cambiar A→B no reemplazó el objeto activo');
    await run.page.goBack();
    await run.page.waitForFunction(() => !new URLSearchParams(location.search).get('g'));
    assert.equal((await run.page.evaluate(() => history.state)).key, first.parentKey, 'Back de B no volvió al único padre');
    assertClean(run.errors, 'object A to B');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await mockPage(context);
    await run.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(run.page);
    await resetHistoryCounts(run.page);
    const before = await run.page.evaluate(() => ({ length: history.length, key: history.state.key, url: location.href }));
    await run.page.locator('.ltab[data-lt="all"]').click();
    await run.page.waitForTimeout(50);
    const after = await run.page.evaluate(() => ({ length: history.length, key: history.state.key, url: location.href }));
    assert.deepEqual(after, before, 'pestaña activa canónica cambió la entrada de lista');
    assert.deepEqual(await historyCounts(run.page).then(({ push, replace }) => ({ push, replace })), { push: 0, replace: 0 }, 'pestaña activa canónica escribió History API');
    await run.page.locator('.aa-rail [data-rail="mlb"]').click();
    await run.page.waitForTimeout(50);
    const afterActiveRail = await run.page.evaluate(() => ({ length: history.length, key: history.state.key, url: location.href }));
    assert.deepEqual(afterActiveRail, before, 'Partidos activo cambió la entrada canónica de lista');
    assert.deepEqual(await historyCounts(run.page).then(({ push, replace }) => ({ push, replace })), { push: 0, replace: 0 }, 'Partidos activo escribió History API');
    assertClean(run.errors, 'active canonical list');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await mockPage(context);
    await run.page.goto(`${base}/?s=nba`, { waitUntil: 'domcontentloaded' });
    await run.page.locator('.mrow[data-oid="n:colon"]').waitFor();
    await run.page.locator('.mrow[data-oid="n:colon"] [data-object-link]').click();
    await run.page.waitForFunction(() => new URLSearchParams(location.search).get('sc') === 'n:colon');
    await run.page.goBack();
    await run.page.waitForFunction(() => !new URLSearchParams(location.search).get('sc'));
    await run.page.waitForFunction(() => document.activeElement?.dataset?.oid === 'n:colon');
    assert.equal(await run.page.evaluate(() => document.activeElement.dataset.oid), 'n:colon');
    assertClean(run.errors, 'colon focus id');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 500 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await mockPage(context);
    await run.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(run.page);
    await run.page.locator('.pill[data-f="pre"]').click();
    await run.page.locator('#q').fill('CLE');
    const mlbScroll = await run.page.evaluate(async () => {
      window.scrollTo(0, Math.min(260, document.documentElement.scrollHeight - innerHeight));
      await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      return scrollY;
    });
    assert.ok(mlbScroll > 0, 'fixture de lista no produjo scroll');
    await run.page.locator('.sp[data-sport="nba"]').evaluate(button => button.click());
    await run.page.waitForFunction(() => sport === 'nba' && !otherLoading);
    await run.page.waitForTimeout(50);
    const nbaEntry = await run.page.evaluate(() => ({
      filter, query, input: document.querySelector('#q').value, y: scrollY, state: history.state,
    }));
    assert.equal(nbaEntry.filter, 'all', 'destino heredó el filtro de la lista saliente');
    assert.equal(nbaEntry.query, '', 'destino heredó la búsqueda de la lista saliente');
    assert.equal(nbaEntry.input, '', 'input destino heredó la búsqueda saliente');
    assert.equal(nbaEntry.y, 0, 'destino no inició en scroll 0');
    assert.equal(nbaEntry.state.filter, 'all');
    assert.equal(nbaEntry.state.query, '');
    assert.equal(nbaEntry.state.scrollY, 0);

    await run.page.goBack();
    await run.page.waitForFunction(() => new URLSearchParams(location.search).get('s') === 'mlb');
    await run.page.waitForFunction(() => document.querySelector('#q').value === 'CLE');
    await run.page.waitForFunction(expected => Math.abs(scrollY - expected) <= 2, mlbScroll);
    const restoredMlb = await run.page.evaluate(() => ({ filter, query, y: scrollY, state: history.state }));
    assert.equal(restoredMlb.filter, 'pre');
    assert.equal(restoredMlb.query, 'CLE');
    assert.ok(Math.abs(restoredMlb.y - mlbScroll) <= 2, `Back restauró ${restoredMlb.y}, esperaba ${mlbScroll}`);

    await run.page.goForward();
    await run.page.waitForFunction(() => new URLSearchParams(location.search).get('s') === 'nba');
    await run.page.waitForFunction(() => document.querySelector('.mrow[data-oid="n1"]'));
    await run.page.waitForFunction(() => scrollY === 0);
    const restoredNba = await run.page.evaluate(() => ({ filter, query, input: document.querySelector('#q').value, y: scrollY }));
    assert.deepEqual(restoredNba, { filter: 'all', query: '', input: '', y: 0 }, 'Forward no restauró el estado propio del destino');
    assertClean(run.errors, 'list to list history');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 500 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await mockPage(context);
    await run.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(run.page);
    await run.page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '900px';
      document.body.appendChild(spacer);
    });
    await run.page.locator('.pill[data-f="pre"]').click();
    await run.page.locator('#q').fill('CLE');
    const todayScroll = await run.page.evaluate(async () => {
      window.scrollTo(0, 210);
      await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      return scrollY;
    });
    assert.ok(todayScroll > 0, 'fixture de fecha hoy no produjo scroll');

    await run.page.locator('#dPrev').click();
    await run.page.locator('.mrow[data-id="d1"]').waitFor();
    const archiveEntry = await run.page.evaluate(() => ({ filter, query, input: document.querySelector('#q').value, y: scrollY, state: history.state }));
    assert.equal(archiveEntry.filter, 'all', 'archivo heredó filtro de hoy');
    assert.equal(archiveEntry.query, '', 'archivo heredó búsqueda de hoy');
    assert.equal(archiveEntry.input, '', 'input de archivo heredó búsqueda de hoy');
    assert.equal(archiveEntry.y, 0, 'archivo heredó scroll de hoy');
    assert.equal(archiveEntry.state.filter, 'all');
    assert.equal(archiveEntry.state.query, '');
    assert.equal(archiveEntry.state.scrollY, 0);

    await run.page.locator('.pill[data-f="pre"]').click();
    await run.page.locator('#q').fill('MIN');
    const archiveScroll = await run.page.evaluate(async () => {
      window.scrollTo(0, 170);
      await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      return scrollY;
    });
    assert.ok(archiveScroll > 0, 'fixture de fecha archivada no produjo scroll');

    await run.page.locator('#dToday').click();
    await waitForMlb(run.page);
    await run.page.waitForFunction(() => !new URLSearchParams(location.search).get('date'));
    const todayDestination = await run.page.evaluate(() => ({ filter, query, input: document.querySelector('#q').value, y: scrollY, state: history.state }));
    assert.equal(todayDestination.filter, 'all', 'hoy heredó filtro del archivo');
    assert.equal(todayDestination.query, '', 'hoy heredó búsqueda del archivo');
    assert.equal(todayDestination.input, '', 'input de hoy heredó búsqueda del archivo');
    assert.equal(todayDestination.y, 0, 'hoy heredó scroll del archivo');
    assert.equal(todayDestination.state.filter, 'all');
    assert.equal(todayDestination.state.query, '');
    assert.equal(todayDestination.state.scrollY, 0);

    await run.page.goBack();
    await run.page.locator('.mrow[data-id="d1"]').waitFor();
    await run.page.waitForFunction((expected) => document.querySelector('#q').value === 'MIN' && Math.abs(scrollY - expected) <= 2, archiveScroll);
    assert.equal(await run.page.evaluate(() => filter), 'pre', 'Back no restauró filtro propio del archivo');
    await run.page.goBack();
    await waitForMlb(run.page);
    await run.page.waitForFunction((expected) => document.querySelector('#q').value === 'CLE' && Math.abs(scrollY - expected) <= 2, todayScroll);
    assert.equal(await run.page.evaluate(() => filter), 'pre', 'segundo Back no restauró filtro propio de hoy');
    assertClean(run.errors, 'date state isolation');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 700 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await mockPage(context);
    await run.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(run.page);
    await run.page.locator('#dPrev').click();
    await run.page.locator('.mrow[data-id="d1"]').waitFor();
    await run.page.locator('.aa-rail [data-rail="home"]').click();
    await run.page.waitForFunction(() => new URLSearchParams(location.search).get('s') === 'home');
    await run.page.waitForTimeout(80);
    const homeState = await run.page.evaluate(() => ({
      sport, viewDate, viewFuture, ids: events.map(event => event.event_id), state: history.state,
      past: document.body.classList.contains('viewingpast'), future: document.body.classList.contains('viewingfuture'),
    }));
    assert.equal(homeState.sport, 'home');
    assert.equal(homeState.viewDate, null, 'Inicio conservó viewDate archivado');
    assert.equal(homeState.viewFuture, false, 'Inicio conservó viewFuture archivado');
    assert.deepEqual(homeState.ids, events.map(event => event.event_id), 'Inicio no cargó los eventos de hoy');
    assert.equal(homeState.state.viewDate, null, 'estado de Inicio conservó la fecha archivada');
    assert.equal(homeState.state.route.date, '', 'ruta estatal de Inicio conservó la fecha archivada');
    assert.equal(homeState.past, false, 'Inicio conservó clase de archivo');
    assert.equal(homeState.future, false, 'Inicio conservó clase de futuro');

    await run.page.locator('#dPrev').click();
    await run.page.waitForFunction((date) => {
      const params = new URLSearchParams(location.search);
      return sport === 'mlb' && params.get('s') === 'mlb' && params.get('date') === date;
    }, previousDay);
    await run.page.locator('.mrow[data-id="d1"]').waitFor();
    const dateState = await run.page.evaluate(() => history.state);
    assert.equal(dateState.route.s, 'mlb', 'control de fecha desde Inicio no cambió ruta a MLB');
    assert.equal(dateState.route.date, previousDay, 'control de fecha desde Inicio perdió fecha');
    assert.equal(dateState.kind, 'list');
    assertClean(run.errors, 'home archive and date control');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 390, height: 500 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await mockPage(context);
    await run.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(run.page, 'g2');
    await run.page.locator('.mrow[data-id="g1"] [data-object-link]').click();
    await run.page.waitForFunction(() => document.body.classList.contains('aa-page'));

    await run.page.locator('#dback').evaluate(button => button.click());
    await run.page.waitForFunction(() => !new URLSearchParams(location.search).get('g'));
    await run.page.locator('.mrow[data-id="g2"] [data-object-link]').click();
    await run.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g2');
    await run.page.waitForFunction(() => scrollY === 0 && document.querySelector('#detail').scrollTop === 0);
    const position = await run.page.evaluate(() => ({ detail: document.querySelector('#detail').scrollTop, document: scrollY }));
    assert.deepEqual(position, { detail: 0, document: 0 }, 'entrada de objeto no reinició el scroll de documento');
    assertClean(run.errors, 'detail scroll reset');
    await context.close();
  }

  const behaviorContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
  const behavior = await mockPage(behaviorContext);
  await behavior.page.goto(`${base}/?s=home`, { waitUntil: 'domcontentloaded' });
  await waitForMlb(behavior.page);
  assert.equal(await behavior.page.locator('.mrow.sel').count(), 0, 'Inicio autoseleccionó juego');
  await resetHistoryCounts(behavior.page);
  await behavior.page.locator('.mrow[data-id="g1"] [data-object-link]').click();
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1');
  assert.deepEqual(await historyCounts(behavior.page).then(({ push }) => push), 1, 'Inicio debe abrir con un push');
  assert.equal(await routeValue(behavior.page, 's'), 'mlb', 'Inicio no abrió el objeto en MLB');
  await behavior.page.goBack();
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('s') === 'home');
  assert.equal((await behavior.page.evaluate(() => history.state)).route.s, 'home', 'Back no volvió a Inicio');

  await behavior.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
  await waitForMlb(behavior.page, 'g5');
  await behavior.page.locator('.pill[data-f="pre"]').click();
  await behavior.page.locator('#q').fill('CLE');
  await behavior.page.evaluate(() => window.scrollTo(0, Math.min(420, document.documentElement.scrollHeight - innerHeight)));
  await behavior.page.locator('.mrow[data-id="g5"] [data-object-link]').click();
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g5');
  await behavior.page.goBack();
  await behavior.page.waitForFunction(() => !new URLSearchParams(location.search).get('g'));
  await behavior.page.waitForFunction(() => document.activeElement?.dataset?.id === 'g5');
  const restored = await behavior.page.evaluate(() => ({ state: history.state, query: document.querySelector('#q').value, active: document.activeElement?.dataset?.id, y: scrollY }));
  assert.equal(restored.state.filter, 'pre');
  assert.equal(restored.state.query, 'CLE');
  assert.equal(restored.query, 'CLE');
  assert.equal(restored.active, 'g5');
  assert.ok(Math.abs(restored.y - restored.state.scrollY) <= 2, `scroll no restaurado: ${restored.y} vs ${restored.state.scrollY}`);

  await behavior.page.locator('.mrow[data-id="g1"] [data-object-link]').click();
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1');
  await resetHistoryCounts(behavior.page);
  const lengthBeforeTabs = (await historyCounts(behavior.page)).length;
  await behavior.page.locator('[data-market-kind="total"]').click();
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('m') === 'total');
  await behavior.page.locator('.dtab[data-dt="participantes"]').click();
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('dt') === 'participantes');
  const tabCounts = await historyCounts(behavior.page);
  assert.equal(tabCounts.push, 0, 'dt/m añadieron historial');
  assert.ok(tabCounts.replace >= 2, 'dt/m no usaron replaceState');
  assert.equal(tabCounts.length, lengthBeforeTabs, 'dt/m cambiaron history.length');

  await behavior.page.evaluate(() => navigateToObject({ ...history.state.route, p: 'p1' }));
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('p') === 'p1');
  await behavior.page.goBack();
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1' && !new URLSearchParams(location.search).get('p'));
  assert.equal(await routeValue(behavior.page, 'dt'), 'participantes', 'Back de jugador perdió vista del partido');
  assert.equal((await behavior.page.evaluate(() => history.state)).kind, 'object', 'Back de jugador no volvió al partido');

  await resetHistoryCounts(behavior.page);
  await behavior.page.locator('.sp[data-sport="nba"]').click();
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('s') === 'nba');
  const cleared = new URL(behavior.page.url()).searchParams;
  for (const key of ['g', 'sc', 'p', 'team', 'dt', 'm']) assert.equal(cleared.has(key), false, `sección conservó ${key}`);
  assert.equal((await behavior.page.evaluate(() => history.state)).kind, 'list');
  assert.equal((await historyCounts(behavior.page)).push, 1, 'cambiar sección debe hacer un push');

  await behavior.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
  await waitForMlb(behavior.page);
  await resetHistoryCounts(behavior.page);
  await behavior.page.locator('.ltab[data-lt="pos"]').click();
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('lt') === 'pos');
  assert.equal((await historyCounts(behavior.page)).push, 1, 'lt debe usar pushState');

  await behavior.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
  await waitForMlb(behavior.page);
  await resetHistoryCounts(behavior.page);
  await behavior.page.locator('#dPrev').click();
  await behavior.page.waitForFunction((date) => new URLSearchParams(location.search).get('date') === date, previousDay);
  await behavior.page.locator('.mrow[data-id="d1"]').waitFor();
  assert.equal(await behavior.page.locator('.mrow.sel').count(), 0, 'loadDay autoseleccionó juego');
  assert.equal((await historyCounts(behavior.page)).push, 1, 'date debe usar pushState');
  assert.equal((await behavior.page.evaluate(() => history.state)).viewDate, previousDay);

  await behavior.page.goto(`${base}/?s=nba`, { waitUntil: 'domcontentloaded' });
  await behavior.page.locator('.mrow[data-oid="n1"]').waitFor();
  assert.equal(await routeValue(behavior.page, 'sc'), null, 'lista NBA autoseleccionó partido');
  await resetHistoryCounts(behavior.page);
  await behavior.page.locator('.mrow[data-oid="n1"] [data-object-link]').click();
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('sc') === 'n1');
  assert.equal((await historyCounts(behavior.page)).push, 1, 'NBA debe abrir con un push');
  assert.equal((await behavior.page.evaluate(() => history.state)).kind, 'object');
  await behavior.page.goBack();
  await behavior.page.waitForFunction(() => !new URLSearchParams(location.search).get('sc'));
  await behavior.page.waitForFunction(() => document.activeElement?.dataset?.oid === 'n1');

  await behavior.page.goto(`${base}/?s=radar`, { waitUntil: 'domcontentloaded' });
  await behavior.page.locator('.intelrow[data-rw="r1"] [data-object-link]').waitFor();
  await resetHistoryCounts(behavior.page);
  await behavior.page.locator('.intelrow[data-rw="r1"] [data-object-link]').click();
  await behavior.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'r1');
  assert.equal((await historyCounts(behavior.page)).push, 1, 'Central debe abrir con un push');
  assert.equal((await behavior.page.evaluate(() => history.state)).kind, 'object');
  await behavior.page.goBack();
  await behavior.page.waitForFunction(() => !new URLSearchParams(location.search).get('g'));
  await behavior.page.waitForFunction(() => document.activeElement?.dataset?.rw === 'r1');
  assertClean(behavior.errors, 'behavior');
  await behaviorContext.close();

  for (const race of [
    { name: 'archived-first', todayDelay: 180, dayDelay: 20 },
    { name: 'today-first', todayDelay: 20, dayDelay: 180 },
  ]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await delayedMlbPage(context, race);
    await run.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await run.page.evaluate(({ date }) => {
      pendingGame = 'd1';
      loadDay(date);
    }, { date: previousDay });
    await run.page.locator('.mrow[data-id="d1"]').waitFor();
    await run.page.waitForTimeout(Math.max(race.todayDelay, race.dayDelay) + 80);
    const state = await run.page.evaluate(() => ({
      viewDate, pendingGame, selectedId,
      eventIds: events.map(event => event.event_id),
    }));
    assert.equal(state.viewDate, previousDay, `${race.name}: cambió la fecha activa`);
    assert.deepEqual(state.eventIds, ['d1', 'd2', 'd3'], `${race.name}: una respuesta obsoleta sobrescribió el día`);
    assert.equal(state.selectedId, 'd1', `${race.name}: una respuesta obsoleta consumió pendingGame`);
    assert.equal(state.pendingGame, null, `${race.name}: el día activo no consumió pendingGame`);
    assertClean(run.errors, race.name);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let releaseModel;
    let signalModelRequested;
    const modelGate = new Promise(resolveGate => { releaseModel = resolveGate; });
    const modelRequested = new Promise(resolveRequest => { signalModelRequested = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/wnba/live') return json(route, { sport: 'wnba', games: [{ ...nbaGame, espn_id: 'w1' }] });
      if (path === '/v1/wnba/today') {
        signalModelRequested();
        await modelGate;
        return json(route, { sport: 'wnba', marker: 'stale-wnba-model', markets: { winner: { state: 'closed' } }, events: [] });
      }
      if (path === '/v1/nba/live') return json(route, { sport: 'nba', games: [nbaGame] });
      if (path === '/v1/nba/recent') return json(route, { sport: 'nba', games: [] });
      return json(route, {});
    });
    await page.goto(`${base}/?s=wnba`, { waitUntil: 'domcontentloaded' });
    await modelRequested;
    await page.locator('.sp[data-sport="nba"]').click();
    await page.locator('.mrow[data-oid="n1"]').waitFor();
    releaseModel();
    await page.waitForTimeout(80);
    const state = await page.evaluate(() => ({
      sport,
      ids: otherGames.map(game => game.espn_id),
      nbaDoc: sportModelDocs.get('nba') || null,
      wnbaDoc: sportModelDocs.get('wnba') || null,
    }));
    assert.equal(state.sport, 'nba');
    assert.deepEqual(state.ids, ['n1'], 'modelo obsoleto WNBA mutó los juegos NBA');
    assert.equal(state.nbaDoc, null, 'modelo obsoleto WNBA contaminó el cache NBA');
    assert.equal(state.wnbaDoc, null, 'modelo obsoleto WNBA se guardó tras cambiar de deporte');
    assertClean(errors, 'other model race');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
    let recentJsonStarted = false;
    await context.exposeBinding('aaRecentJsonStarted', () => { recentJsonStarted = true; });
    await context.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await realFetch(...args);
        const url = String(args[0]);
        if (!url.includes('/v1/nba/recent')) return response;
        return new Proxy(response, {
          get(target, property) {
            if (property === 'json') return async () => {
              await window.aaRecentJsonStarted();
              return target.json();
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
    });
    const page = await context.newPage();
    let releaseRecent;
    let signalRecentRequested;
    const recentGate = new Promise(resolveGate => { releaseRecent = resolveGate; });
    const recentRequested = new Promise(resolveRequest => { signalRecentRequested = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/nba/live') return json(route, { sport: 'nba', games: [] });
      if (path === '/v1/nba/recent') {
        signalRecentRequested();
        await recentGate;
        return json(route, { sport: 'nba', games: [{ ...nbaGame, espn_id: 'recent-n1' }] });
      }
      return json(route, {});
    });
    await page.goto(`${base}/?s=nba`, { waitUntil: 'domcontentloaded' });
    await recentRequested;
    await page.locator('.sp[data-sport="mlb"]').click();
    releaseRecent();
    await page.waitForTimeout(80);
    assert.equal(recentJsonStarted, false, 'loadOther consumió recent.json tras cambiar de deporte');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    let releaseSoccer;
    let signalSoccerRequested;
    const soccerGate = new Promise(resolveGate => { releaseSoccer = resolveGate; });
    const soccerRequested = new Promise(resolveRequest => { signalSoccerRequested = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/soccer/live') return json(route, { sport: 'soccer', games: [{ ...nbaGame, espn_id: 'soc-race' }] });
      if (path === '/v1/soccer/today') {
        signalSoccerRequested();
        await soccerGate;
        return json(route, { sport: 'soccer', marker: 'stale-soccer-model', by_id: {} });
      }
      if (path === '/v1/nba/live') return json(route, { sport: 'nba', games: [nbaGame] });
      if (path === '/v1/nba/recent') return json(route, { sport: 'nba', games: [] });
      return json(route, {});
    });
    await page.goto(`${base}/?s=soccer`, { waitUntil: 'domcontentloaded' });
    await soccerRequested;
    await page.locator('.sp[data-sport="nba"]').click();
    await page.locator('.mrow[data-oid="n1"]').waitFor();
    releaseSoccer();
    await page.waitForTimeout(80);
    const state = await page.evaluate(() => ({
      sport,
      ids: otherGames.map(game => game.espn_id),
      soccerMarker: soccerPreds?.marker || null,
    }));
    assert.equal(state.sport, 'nba');
    assert.deepEqual(state.ids, ['n1'], 'soccer obsoleto mutó los juegos NBA');
    assert.equal(state.soccerMarker, null, 'soccer obsoleto mutó el cache tras cambiar de deporte');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    let soccerRequests = 0;
    let releaseFirstSoccer;
    let signalFirstSoccer;
    const firstSoccerGate = new Promise(resolveGate => { releaseFirstSoccer = resolveGate; });
    const firstSoccerRequested = new Promise(resolveRequest => { signalFirstSoccer = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/soccer/live') return json(route, { sport: 'soccer', games: [{ ...nbaGame, espn_id: 'soc-current' }] });
      if (path === '/v1/soccer/today') {
        soccerRequests += 1;
        if (soccerRequests === 1) {
          signalFirstSoccer();
          await firstSoccerGate;
          return json(route, { sport: 'soccer', marker: 'stale-soccer-model', by_id: {} });
        }
        return json(route, {
          sport: 'soccer', marker: 'current-soccer-model',
          by_id: { 'soc-current': { pick: 'BOS', prob: 0.61 } },
        });
      }
      if (path === '/v1/nba/live') return json(route, { sport: 'nba', games: [nbaGame] });
      if (path === '/v1/nba/recent') return json(route, { sport: 'nba', games: [] });
      return json(route, {});
    });
    await page.goto(`${base}/?s=soccer`, { waitUntil: 'domcontentloaded' });
    await firstSoccerRequested;
    await page.locator('.sp[data-sport="nba"]').click();
    await page.locator('.mrow[data-oid="n1"]').waitFor();
    await page.locator('.sp[data-sport="soccer"]').click();
    await page.locator('.mrow[data-oid="soc-current"]').waitFor();
    releaseFirstSoccer();
    await page.waitForTimeout(120);
    const state = await page.evaluate(() => ({ sport, marker: soccerPreds?.marker || null }));
    assert.equal(soccerRequests, 2, 'solicitud soccer obsoleta suprimió la solicitud vigente');
    assert.equal(state.sport, 'soccer');
    assert.equal(state.marker, 'current-soccer-model', 'retorno rápido a soccer no publicó el modelo vigente');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 700 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    let releaseLive;
    let signalLiveRequested;
    const liveGate = new Promise(resolveGate => { releaseLive = resolveGate; });
    const liveRequested = new Promise(resolveRequest => { signalLiveRequested = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') {
        signalLiveRequested();
        await liveGate;
        return json(route, {
          sport: 'mlb', date: today,
          games: [{ ...mlbEvent('live-stale'), date: today, status: 'live' }],
        });
      }
      if (path === `/v1/mlb/day/${previousDay}`) return json(route, { sport: 'mlb', date: previousDay, events: dayEvents, record: null });
      return json(route, {});
    });
    await page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await liveRequested;
    await waitForMlb(page);
    await page.locator('#dPrev').click();
    await page.locator('.mrow[data-id="d1"]').waitFor();
    await page.evaluate(() => {
      window.__aaArchiveRenders = 0;
      const originalRenderAll = renderAll;
      renderAll = (...args) => { window.__aaArchiveRenders += 1; return originalRenderAll(...args); };
    });
    releaseLive();
    await page.waitForTimeout(100);
    const state = await page.evaluate(() => ({
      viewDate, liveSize: liveByKey.size, liveSig: lastLiveSig,
      archiveRenders: window.__aaArchiveRenders,
      archiveIds: [...document.querySelectorAll('.mrow[data-id]')].map(node => node.dataset.id),
    }));
    assert.equal(state.viewDate, previousDay);
    assert.equal(state.liveSize, 0, 'live obsoleto mutó liveByKey del archivo');
    assert.equal(state.liveSig, '[]', 'live obsoleto mutó la firma activa');
    assert.equal(state.archiveRenders, 0, 'live obsoleto volvió a renderizar el archivo');
    assert.deepEqual(state.archiveIds, ['d1', 'd2', 'd3']);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 500 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let releaseNba;
    let signalNbaRequested;
    const nbaGate = new Promise(resolveGate => { releaseNba = resolveGate; });
    const nbaRequested = new Promise(resolveRequest => { signalNbaRequested = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/nba/live') {
        signalNbaRequested();
        await nbaGate;
        return json(route, { sport: 'nba', games: [nbaGame] });
      }
      if (path === '/v1/nba/today') return json(route, { sport: 'nba', events: [] });
      return json(route, {});
    });
    await page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(page);
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '800px';
      document.body.appendChild(spacer);
      const nbaRoute = aaListRoute({ s: 'nba' });
      history.replaceState({ ...aaListState(nbaRoute), scrollY: 230, focusKey: 'oid:n1' }, '', aaRouteUrl(nbaRoute));
      const mlbRoute = aaListRoute({ s: 'mlb' });
      history.pushState({ ...aaListState(mlbRoute), scrollY: 0 }, '', aaRouteUrl(mlbRoute));
      document.querySelector('#q').focus();
    });
    await page.goBack({ waitUntil: 'commit' });
    await nbaRequested;
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const beforeRender = await page.evaluate(() => ({
      rows: document.querySelectorAll('.mrow[data-oid]').length,
      active: document.activeElement?.id || document.activeElement?.dataset?.oid || '',
      y: scrollY,
    }));
    assert.equal(beforeRender.rows, 0, 'NBA demorado ya tenía filas antes de liberar datos');
    assert.equal(beforeRender.active, 'q', 'restauración NBA enfocó antes de renderizar destino');
    assert.notEqual(beforeRender.y, 230, 'restauración NBA aplicó scroll antes de renderizar destino');
    releaseNba();
    await page.locator('.mrow[data-oid="n1"]').waitFor();
    await page.waitForFunction(() => document.activeElement?.dataset?.oid === 'n1' && Math.abs(scrollY - 230) <= 2);
    assertClean(errors, 'delayed NBA restore');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 500 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let releaseNba;
    let signalNbaRequested;
    const nbaGate = new Promise(resolveGate => { releaseNba = resolveGate; });
    const nbaRequested = new Promise(resolveRequest => { signalNbaRequested = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/nba/live') {
        signalNbaRequested();
        await nbaGate;
        return json(route, { sport: 'nba', games: [nbaGame] });
      }
      if (path === '/v1/nba/today') return json(route, { sport: 'nba', events: [] });
      return json(route, {});
    });
    await page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(page);
    await page.evaluate(() => {
      const nbaRoute = aaListRoute({ s: 'nba' });
      history.replaceState({ ...aaListState(nbaRoute), filter: 'final', query: 'nbaq' }, '', aaRouteUrl(nbaRoute));
      const mlbRoute = aaListRoute({ s: 'mlb' });
      history.pushState({ ...aaListState(mlbRoute), filter: 'pre', query: 'CLE' }, '', aaRouteUrl(mlbRoute));
    });
    await page.goBack({ waitUntil: 'commit' });
    await nbaRequested;
    await page.goForward({ waitUntil: 'commit' });
    await page.waitForFunction(() => new URLSearchParams(location.search).get('s') === 'mlb');
    releaseNba();
    await page.waitForTimeout(120);
    const state = await page.evaluate(() => ({
      urlSport: new URLSearchParams(location.search).get('s'),
      historyFilter: history.state?.filter,
      historyQuery: history.state?.query,
      filter,
      query,
      input: document.querySelector('#q').value,
      sport,
    }));
    assert.deepEqual(state, {
      urlSport: 'mlb', historyFilter: 'pre', historyQuery: 'CLE',
      filter: 'pre', query: 'CLE', input: 'CLE', sport: 'mlb',
    }, 'Back→Forward rápido permitió que aaApplyRoute obsoleto sobrescribiera la UI');
    assertClean(errors, 'overlapping Back Forward');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 500 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    let releaseDay;
    let signalDayRequested;
    const dayGate = new Promise(resolveGate => { releaseDay = resolveGate; });
    const dayRequested = new Promise(resolveRequest => { signalDayRequested = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === `/v1/mlb/day/${previousDay}`) {
        signalDayRequested();
        await dayGate;
        return json(route, { sport: 'mlb', date: previousDay, events: dayEvents, record: null });
      }
      return json(route, {});
    });
    await page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(page);
    await page.evaluate(({ date }) => {
      const spacer = document.createElement('div');
      spacer.id = 'history-test-spacer';
      spacer.style.height = '800px';
      document.body.appendChild(spacer);
      const archivedRoute = aaListRoute({ s: 'mlb', date });
      const archivedState = { ...aaListState(archivedRoute), scrollY: 240, focusKey: 'id:d1' };
      history.replaceState(archivedState, '', aaRouteUrl(archivedRoute));
      const todayRoute = aaListRoute({ s: 'mlb' });
      history.pushState({ ...aaListState(todayRoute), scrollY: 0 }, '', aaRouteUrl(todayRoute));
      document.querySelector('#q').focus();
    }, { date: previousDay });
    await page.goBack({ waitUntil: 'commit' });
    await dayRequested;
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const beforeRender = await page.evaluate(() => ({
      oldRows: document.querySelectorAll('.mrow[data-id^="g"]').length,
      active: document.activeElement?.id || document.activeElement?.dataset?.id || '',
      y: scrollY,
    }));
    assert.equal(beforeRender.oldRows, 0, 'popstate archivado volvió a pintar eventos de hoy');
    assert.equal(beforeRender.active, 'q', 'popstate restauró foco antes de renderizar el archivo');
    assert.notEqual(beforeRender.y, 240, 'popstate restauró scroll antes de renderizar el archivo');
    releaseDay();
    await page.locator('.mrow[data-id="d1"]').waitFor();
    await page.waitForFunction(() => document.activeElement?.dataset?.id === 'd1' && Math.abs(scrollY - 240) <= 2);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 500 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let todayRequests = 0;
    let releaseToday;
    let signalTodayRequested;
    const todayGate = new Promise(resolveGate => { releaseToday = resolveGate; });
    const todayRequested = new Promise(resolveRequest => { signalTodayRequested = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') {
        todayRequests += 1;
        if (todayRequests > 1) {
          signalTodayRequested();
          await todayGate;
        }
        return json(route, { sport: 'mlb', date: today, events, record: null });
      }
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === `/v1/mlb/day/${previousDay}`) return json(route, { sport: 'mlb', date: previousDay, events: dayEvents, record: null });
      return json(route, {});
    });
    await page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(page);
    // Let the initial route-owned WebKit scroll reassertion settle before this
    // fixture simulates a later user scroll and creates a second history entry.
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      // A fixed document floor is deterministic across browser layout engines;
      // an empty spacer can collapse differently while the list rerenders.
      document.body.style.minHeight = '1600px';
      document.documentElement.style.scrollBehavior = 'auto';
    });
    await page.waitForFunction(() => document.documentElement.scrollHeight - innerHeight >= 220);
    await page.evaluate(() => window.scrollTo(0, 220));
    await page.waitForFunction(() => Math.abs(scrollY - 220) <= 2);
    await page.evaluate(() => {
      history.replaceState({ ...history.state, scrollY: 220, focusKey: 'id:g1' }, '', location.href);
    });
    await page.locator('#dPrev').evaluate(button => button.click());
    await page.locator('.mrow[data-id="d1"]').waitFor();
    await page.locator('#q').focus();
    await page.goBack({ waitUntil: 'commit' });
    await todayRequested;
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const beforeRender = await page.evaluate(() => ({
      archiveRows: document.querySelectorAll('.mrow[data-id^="d"]').length,
      active: document.activeElement?.id || document.activeElement?.dataset?.id || '',
      y: scrollY,
    }));
    assert.ok(beforeRender.archiveRows > 0, 'popstate a hoy quitó archivo antes de recibir hoy');
    assert.equal(beforeRender.active, 'q', 'popstate a hoy enfocó antes de renderizar hoy');
    assert.notEqual(beforeRender.y, 220, 'popstate a hoy aplicó scroll antes de renderizar hoy');
    releaseToday();
    await page.locator('.mrow[data-id="g1"]').waitFor();
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    try {
      await page.waitForFunction(() => Math.abs(scrollY - 220) <= 2, null, { timeout: 5000 });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        active: document.activeElement?.dataset?.id || document.activeElement?.id || '',
        y: scrollY,
        maxY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
        state: history.state,
      }));
      throw new Error(`hoy renderizado no alcanzó el scroll restaurado: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const restoredToday = await page.evaluate(() => ({ active: document.activeElement?.dataset?.id || document.activeElement?.id || '', y: scrollY, state: history.state }));
    assert.equal(restoredToday.active, 'g1', 'hoy renderizado no restauró foco');
    assert.ok(Math.abs(restoredToday.y - 220) <= 2, `hoy renderizado restauró ${JSON.stringify(restoredToday)}, esperaba scroll 220`);
    assertClean(errors, 'delayed today restore');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 700 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    let historyRequests = 0;
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/mlb/history') {
        historyRequests += 1;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
        return json(route, { predictions: [{ marker: 'direct-hist', date: today, result: 'win', public_play: 1, pick: 'CLE', away: 'MIN', home: 'CLE', prob: 0.57, market: 'winner' }] });
      }
      return json(route, {});
    });
    await page.goto(`${base}/?s=mlb&lt=hist`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => histData?.[0]?.marker === 'direct-hist');
    const state = await page.evaluate(() => ({ listTab, marker: histData?.[0]?.marker || null }));
    assert.equal(historyRequests, 1, 'deep link lt=hist no disparó historial');
    assert.equal(state.listTab, 'hist');
    assert.equal(state.marker, 'direct-hist', 'deep link lt=hist no esperó historial');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 700 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    let standingsRequests = 0;
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/mlb/standings') {
        standingsRequests += 1;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
        return json(route, { marker: 'direct-pos', sections: [{ name: 'AL', rows: [{ code: 'CLE', name: 'Cleveland', w: 1, l: 0, pct: 1, gb: '—' }] }] });
      }
      return json(route, {});
    });
    await page.goto(`${base}/?s=mlb&lt=pos`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => standingsCache.get('mlb')?.marker === 'direct-pos');
    const state = await page.evaluate(() => ({ listTab, marker: standingsCache.get('mlb')?.marker || null }));
    assert.equal(standingsRequests, 1, 'deep link lt=pos no disparó posiciones');
    assert.equal(state.listTab, 'pos');
    assert.equal(state.marker, 'direct-pos', 'deep link lt=pos no esperó posiciones');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 700 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    let learningRequests = 0;
    let simulationRequests = 0;
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/mlb/learning') {
        learningRequests += 1;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
        return json(route, { marker: 'direct-brain', historical: {}, forward: {}, gate: {} });
      }
      if (path === '/v1/mlb/simulation') {
        simulationRequests += 1;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 120));
        return json(route, { marker: 'direct-sim' });
      }
      return json(route, {});
    });
    await page.goto(`${base}/?s=mlb&lt=brain`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => learningDoc?.marker === 'direct-brain' && simDoc?.marker === 'direct-sim');
    const state = await page.evaluate(() => ({ listTab, learning: learningDoc?.marker || null, simulation: simDoc?.marker || null }));
    assert.equal(learningRequests, 1, 'deep link lt=brain no disparó learning');
    assert.equal(simulationRequests, 1, 'deep link lt=brain no disparó simulation');
    assert.equal(state.listTab, 'brain');
    assert.equal(state.learning, 'direct-brain', 'deep link lt=brain no esperó learning');
    assert.equal(state.simulation, 'direct-sim', 'deep link lt=brain no esperó simulation');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 500 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    let releaseHistory;
    let signalHistoryRequested;
    const historyGate = new Promise(resolveGate => { releaseHistory = resolveGate; });
    const historyRequested = new Promise(resolveRequest => { signalHistoryRequested = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/mlb/history') {
        signalHistoryRequested();
        await historyGate;
        return json(route, { predictions: [{ marker: 'restored-hist', date: today, result: 'win', public_play: 1, pick: 'CLE', away: 'MIN', home: 'CLE', prob: 0.57, market: 'winner' }] });
      }
      return json(route, {});
    });
    await page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(page);
    await page.evaluate(() => { loadHistory(); });
    await historyRequested;
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '800px';
      document.body.appendChild(spacer);
      const histRoute = aaListRoute({ s: 'mlb', lt: 'hist' });
      history.replaceState({ ...aaListState(histRoute), scrollY: 210, focusKey: '' }, '', aaRouteUrl(histRoute));
      const allRoute = aaListRoute({ s: 'mlb' });
      history.pushState({ ...aaListState(allRoute), scrollY: 0 }, '', aaRouteUrl(allRoute));
      document.querySelector('#q').focus();
    });
    await page.goBack({ waitUntil: 'commit' });
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const beforeLoader = await page.evaluate(() => ({ active: document.activeElement?.id || '', y: scrollY }));
    assert.equal(beforeLoader.active, 'q', 'lt=hist restauró foco antes de loader pendiente');
    assert.notEqual(beforeLoader.y, 210, 'lt=hist restauró scroll antes de loader pendiente');
    releaseHistory();
    await page.waitForFunction(() => histData?.[0]?.marker === 'restored-hist');
    await page.waitForFunction(() => document.activeElement?.id === 'lghead' && Math.abs(scrollY - 210) <= 2);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 500 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    let brainRequestCount = 0;
    let releaseBrain;
    let signalBrainRequested;
    const brainGate = new Promise(resolveGate => { releaseBrain = resolveGate; });
    const brainRequested = new Promise(resolveRequest => { signalBrainRequested = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/mlb/learning' || path === '/v1/mlb/simulation') {
        brainRequestCount += 1;
        if (brainRequestCount === 2) signalBrainRequested();
        await brainGate;
        return json(route, path.endsWith('/learning')
          ? { marker: 'restored-brain', historical: {}, forward: {}, gate: {} }
          : { marker: 'restored-sim' });
      }
      return json(route, {});
    });
    await page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(page);
    await page.evaluate(() => { loadLearning(); });
    await brainRequested;
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '800px';
      document.body.appendChild(spacer);
      const brainRoute = aaListRoute({ s: 'mlb', lt: 'brain' });
      history.replaceState({ ...aaListState(brainRoute), scrollY: 205, focusKey: '' }, '', aaRouteUrl(brainRoute));
      const allRoute = aaListRoute({ s: 'mlb' });
      history.pushState({ ...aaListState(allRoute), scrollY: 0 }, '', aaRouteUrl(allRoute));
      document.querySelector('#q').focus();
    });
    await page.goBack({ waitUntil: 'commit' });
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const beforeLoader = await page.evaluate(() => ({ active: document.activeElement?.id || '', y: scrollY }));
    assert.equal(beforeLoader.active, 'q', 'lt=brain restauró foco antes de loaders pendientes');
    assert.notEqual(beforeLoader.y, 205, 'lt=brain restauró scroll antes de loaders pendientes');
    releaseBrain();
    await page.waitForFunction(() => learningDoc?.marker === 'restored-brain' && simDoc?.marker === 'restored-sim');
    await page.waitForFunction(() => document.activeElement?.id === 'lghead' && Math.abs(scrollY - 205) <= 2);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 500 }, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    let standingsRequests = 0;
    let releaseStandings;
    let signalStandingsRequested;
    const standingsGate = new Promise(resolveGate => { releaseStandings = resolveGate; });
    const standingsRequested = new Promise(resolveRequest => { signalStandingsRequested = resolveRequest; });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events, record: null });
      if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      if (path === '/v1/mlb/standings') {
        standingsRequests += 1;
        signalStandingsRequested();
        await standingsGate;
        return json(route, { marker: 'restored-pos', sections: [{ name: 'AL', rows: [{ code: 'CLE', name: 'Cleveland', w: 1, l: 0, pct: 1, gb: '—' }] }] });
      }
      return json(route, {});
    });
    await page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(page);
    await page.evaluate(() => { loadStandings(); });
    await standingsRequested;
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '800px';
      document.body.appendChild(spacer);
      const posRoute = aaListRoute({ s: 'mlb', lt: 'pos' });
      history.replaceState({ ...aaListState(posRoute), scrollY: 200, focusKey: '' }, '', aaRouteUrl(posRoute));
      const allRoute = aaListRoute({ s: 'mlb' });
      history.pushState({ ...aaListState(allRoute), scrollY: 0 }, '', aaRouteUrl(allRoute));
      document.querySelector('#q').focus();
    });
    await page.goBack({ waitUntil: 'commit' });
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const beforeLoader = await page.evaluate(() => ({ active: document.activeElement?.id || '', y: scrollY }));
    assert.equal(beforeLoader.active, 'q', 'lt=pos restauró foco antes del loader pendiente');
    assert.notEqual(beforeLoader.y, 200, 'lt=pos restauró scroll antes del loader pendiente');
    assert.equal(standingsRequests, 1, 'lt=pos duplicó el loader pendiente en vez de esperarlo');
    releaseStandings();
    await page.waitForFunction(() => standingsCache.get('mlb')?.marker === 'restored-pos');
    await page.waitForFunction(() => document.activeElement?.id === 'lghead' && Math.abs(scrollY - 200) <= 2);
    await context.close();
  }

  for (const search of ['?s=mlb&g=g1', '?g=g1']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await mockPage(context);
    await run.page.goto(`${base}/${search}`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(run.page);
    await run.page.waitForFunction(() => document.querySelector('.mrow[data-id="g1"]')?.classList.contains('sel'));
    assert.equal(await routeValue(run.page, 's'), 'mlb', `${search}: falta s canónico`);
    assert.equal(await routeValue(run.page, 'g'), 'g1', `${search}: boot perdió g`);
    const directState = await run.page.evaluate(() => history.state);
    assert.equal(directState.kind, 'object', `${search}: deep link no creó objeto`);
    assert.ok(directState.parentKey, `${search}: deep link sin padre interno`);
    const beforeReload = await run.page.evaluate(() => ({ length: history.length, state: history.state }));
    await Promise.all([
      run.page.waitForEvent('domcontentloaded'),
      run.page.evaluate(() => { location.reload(); }),
    ]);
    await waitForMlb(run.page);
    await run.page.waitForFunction(() => document.querySelector('.mrow[data-id="g1"]')?.classList.contains('sel'));
    const afterReload = await run.page.evaluate(() => ({ length: history.length, state: history.state }));
    assert.equal(afterReload.state.key, beforeReload.state.key, `${search}: reload reemplazó objeto`);
    assert.equal(afterReload.state.parentKey, beforeReload.state.parentKey, `${search}: reload reemplazó padre`);
    assert.ok(afterReload.length <= beforeReload.length + (engine === 'firefox' ? 1 : 0), `${search}: reload duplicó entradas de app`);
    await run.page.evaluate(() => history.back());
    await run.page.waitForFunction(() => !new URLSearchParams(location.search).get('g'));
    assert.equal((await run.page.evaluate(() => history.state)).kind, 'list', `${search}: primer Back no fue lista AA`);
    await run.page.evaluate(() => history.forward());
    await run.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1');
    assertClean(run.errors, `deep ${search}`);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await mockPage(context);
    await run.page.addInitScript(() => {
      const push = history.pushState.bind(history);
      history.pushState = (...args) => {
        sessionStorage.setItem('aa_test_reload_pushes', String(Number(sessionStorage.getItem('aa_test_reload_pushes') || 0) + 1));
        return push(...args);
      };
    });
    await run.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await waitForMlb(run.page);
    await run.page.locator('.mrow[data-id="g1"] [data-object-link]').click();
    await run.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1');
    await run.page.goBack();
    await run.page.waitForFunction(() => !new URLSearchParams(location.search).has('g'));
    await run.page.goForward();
    await run.page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1'
      && history.state?.kind === 'object');
    const beforeReload = await run.page.evaluate(() => ({
      length: history.length, key: history.state.key, parentKey: history.state.parentKey,
    }));
    await run.page.evaluate(() => {
      sessionStorage.setItem('aa_test_reload_pushes', '0');
      history.replaceState(null, '', location.href);
    });
    await Promise.all([
      run.page.waitForEvent('domcontentloaded'),
      run.page.evaluate(() => { location.reload(); }),
    ]);
    await waitForMlb(run.page);
    await run.page.waitForFunction(() => document.querySelector('.mrow[data-id="g1"]')?.classList.contains('sel'));
    const afterReload = await run.page.evaluate(() => ({
      length: history.length,
      key: history.state?.key,
      parentKey: history.state?.parentKey,
      pushes: Number(sessionStorage.getItem('aa_test_reload_pushes') || 0),
    }));
    assert.equal(afterReload.key, beforeReload.key, 'Forward object reload replaced the object key');
    assert.equal(afterReload.parentKey, beforeReload.parentKey, 'Forward object reload replaced the parent key');
    assert.equal(afterReload.pushes, 0, 'Forward object reload added an app history entry');
    assert.ok(afterReload.length <= beforeReload.length + (engine === 'firefox' ? 1 : 0),
      'Forward object reload grew browser history beyond reload behavior');
    assertClean(run.errors, 'Forward object null-state reload');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'es-ES' });
    const run = await mockPage(context);
    await run.page.route('https://outside.test/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><title>Outside AA</title><p>outside</p>',
    }));
    const objectUrl = `${base}/?s=mlb&g=g1`;
    await run.page.goto(objectUrl, { waitUntil: 'domcontentloaded' });
    await waitForMlb(run.page);
    const firstVisit = await run.page.evaluate(() => ({ key: history.state.key, parentKey: history.state.parentKey }));
    await run.page.goto('https://outside.test/away', { waitUntil: 'domcontentloaded' });
    await run.page.goto(objectUrl, { waitUntil: 'domcontentloaded' });
    await waitForMlb(run.page);
    const revisit = await run.page.evaluate(() => ({
      key: history.state.key,
      parentKey: history.state.parentKey,
      navigationType: performance.getEntriesByType('navigation')[0]?.type,
    }));
    assert.equal(revisit.navigationType, 'navigate', 'external revisit fixture was not a fresh navigation');
    assert.notEqual(revisit.key, firstVisit.key, 'external revisit reused the prior object state as if it were a reload');
    assert.notEqual(revisit.parentKey, firstVisit.parentKey, 'external revisit reused the prior synthetic parent');
    await run.page.locator('#dback').click();
    await run.page.waitForFunction(expectedOrigin => location.origin === expectedOrigin
      && location.search === '?s=mlb' && history.state?.kind === 'list', base);
    assert.equal(await run.page.evaluate(() => history.state.key), revisit.parentKey,
      'external revisit Back did not land on its new internal parent first');
    assertClean(run.errors, 'external object revisit');
    await context.close();
  }

  const invalidContext = await browser.newContext({ viewport: { width: 360, height: 800 }, serviceWorkers: 'block', locale: 'es-ES' });
  const invalidRun = await mockPage(invalidContext);
  await invalidRun.page.goto(`${base}/?s=mlb&g=missing`, { waitUntil: 'domcontentloaded' });
  await waitForMlb(invalidRun.page);
  assert.equal(await routeValue(invalidRun.page, 'g'), 'missing', 'id inválido se borró silenciosamente');
  assert.equal(await invalidRun.page.locator('.mrow.sel').count(), 0, 'id inválido cayó al primer juego');
  assert.equal(await invalidRun.page.evaluate(() => history.state.kind), 'object');
  await invalidRun.page.locator('#dback').evaluate((button) => button.click());
  await invalidRun.page.waitForFunction(() => !new URLSearchParams(location.search).get('g'));
  assert.equal(await invalidRun.page.evaluate(() => history.state.kind), 'list', '#dback no volvió al padre interno');
  assertClean(invalidRun.errors, 'invalid id');
  await invalidContext.close();

  const invalidOtherContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'es-ES' });
  const invalidOther = await mockPage(invalidOtherContext);
  await invalidOther.page.goto(`${base}/?s=nba&sc=missing`, { waitUntil: 'domcontentloaded' });
  await invalidOther.page.locator('.mrow[data-oid="n1"]').waitFor({ state: 'attached' });
  assert.equal(await invalidOther.page.evaluate(() => otherSel), null, 'sc inválido seleccionó estado interno');
  assert.equal((await invalidOther.page.locator('#dcard').textContent()).includes('Boston'), false, 'sc inválido mostró el primer partido');
  assertClean(invalidOther.errors, 'invalid other id');
  await invalidOtherContext.close();

  console.log(`✅ history router (${engine}): parser + history state + Back/Forward + 1440/390/360`);
} finally {
  await browser.close();
  await new Promise((ok) => server.close(ok));
}
