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
const HTML_PATH = resolve(ROOT, 'index.html');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
const htmlSource = await readFile(HTML_PATH, 'utf8');
assert.doesNotMatch(htmlSource, /rotateY\s*\(/i, 'page motion must not rotate on the Y axis');
const lateralMotion = htmlSource.split(/\r?\n/).filter(line => /translateX\s*\(/i.test(line) && !line.includes('#polytoast'));
assert.deepEqual(lateralMotion, [], 'only toast centering may use translateX');
assert.match(htmlSource, /@keyframes fadeUp\{from\{opacity:0;transform:translateY\(8px\)/, 'route continuity is not the approved vertical fade');

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const updatedAt = new Date().toISOString();
const onePxPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const event = {
  sport: 'mlb', league: 'MLB', event_id: 'g1', matchup: 'MIN @ CLE', start: `${today}T22:40:00Z`, status: 'pre',
  away: { code: 'MIN', name: 'Minnesota Twins' }, home: { code: 'CLE', name: 'Cleveland Guardians' },
  prediction: { pick: 'CLE', prob: .57, prob_pct: 57, probability_source: 'prob_v2', confidence: 'media' },
  metrics: [{ key: 'metric_prob_cal', label: 'Prob. AA calibrada', value: '57%', kind: 'pct' }],
  snapshot: {
    verdict_es: 'Lectura pública construida con datos verificados.', verdict_en: 'Public read built from verified data.',
    pitchers: {
      away: { id: 660271, name: 'Ana Visitor', hand: 'R', era: 3.84, era_recent: 3.7, fip: 3.9, k9: 8.2 },
      home: { id: 605400, name: 'Logan Allen', hand: 'L', era: 3.12, era_recent: 3.2, fip: 3.4, k9: 9.1 },
    },
    form: { away: [], home: [] }, reasons: ['Probabilidad calibrada con el corte público.'],
  },
  risk: { level: 'bajo', score: 18, coverage: 1 }, odds: null, badges: [], result: null, final: null,
};

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://local').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = resolve(ROOT, relative);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
const base = `http://127.0.0.1:${server.address().port}`;

const executable = process.env.AA_TEST_EXECUTABLE || (engine === 'chromium' ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH : '');
const launch = { headless: true };
if (executable && existsSync(executable)) launch.executablePath = executable;
const browser = await playwright[engine].launch(launch);
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(viewport, reducedMotion = 'no-preference') {
  const context = await browser.newContext({ viewport, reducedMotion, locale: 'es-ES', timezoneId: 'America/New_York', serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource/i.test(message.text())) errors.push(`console: ${message.text()}`);
  });
  await page.route('**/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/mlb/today') return json(route, {
      sport: 'mlb', date: today, updated_at: updatedAt, events: [event],
      publication: { state: 'published', predictions: 1, checked_at: updatedAt }, record: null,
    });
    if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, updated_at: updatedAt, games: [] });
    if (path === '/v1/mlb/standings') return setTimeout(() => json(route, { sport: 'mlb', sections: [] }), 400);
    if (path === '/v1/intelligence/today') return json(route, { version: 'intelligence_v2', state: 'fresh', slate: [], market_bundles: [] });
    if (path === '/v1/injuries') return json(route, { players: [] });
    if (path === '/v1/me') return json(route, { enabled: false, user: null });
    if (path.endsWith('/learning') || path.endsWith('/simulation')) return json(route, {});
    return json(route, {});
  });
  await page.route(/^https:\/\/(a\.espncdn\.com|img\.mlbstatic\.com|midfield\.mlbstatic\.com)\//, route => route.fulfill({ status: 200, contentType: 'image/png', body: onePxPng }));
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ status: 204, body: '' }));
  return { context, page, errors };
}

const styleOf = (page, selector) => page.locator(selector).first().evaluate(element => {
  const style = getComputedStyle(element);
  return { animationName: style.animationName, animationDuration: style.animationDuration, transitionDuration: style.transitionDuration, transform: style.transform };
});
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

try {
  const regular = await setup({ width: 1440, height: 900 });
  await regular.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
  await regular.page.locator('.mrow').waitFor();
  const rowMotion = await styleOf(regular.page, '.mrow');
  assert.equal(rowMotion.animationName, 'fadeUp', 'schedule does not enter with the approved vertical fade');
  assert.equal(rowMotion.animationDuration, '0.2s', 'schedule animation exceeds the 160–220ms contract');

  const routeStart = Date.now();
  await regular.page.locator('.mrow a[data-object-link]').click();
  await regular.page.locator('.dtabs').waitFor();
  assert.ok(Date.now() - routeStart < 1000, 'route change is artificially delayed by motion');
  assert.equal(new URL(regular.page.url()).searchParams.get('g'), 'g1', 'object route did not update synchronously');
  const heroMotion = await styleOf(regular.page, '.dhero');
  assert.equal(heroMotion.animationName, 'fadeUp', 'Inspect hero does not use the approved vertical fade');
  assert.equal(heroMotion.animationDuration, '0.2s', 'Inspect hero animation exceeds the 160–220ms contract');

  await regular.page.locator('#dback').click();
  await regular.page.locator('.mrow a[data-object-link]').waitFor();
  await regular.page.waitForFunction(() => document.activeElement?.matches('.mrow a[data-object-link]'));
  assert.equal(await regular.page.locator('.mrow a[data-object-link]').evaluate(element => element === document.activeElement), true, 'Back did not restore focus to the originating row');

  await regular.page.locator('[data-rail-more]').click();
  await regular.page.locator('.rail-more [data-rail="cfg"]').click();
  await regular.page.locator('#aaReduce').waitFor();
  await regular.page.locator('#aaReduce').check();
  assert.equal(await regular.page.locator('body').evaluate(element => element.classList.contains('aa-reduce-motion')), true, 'app reduced-motion state did not reach the document');
  assert.equal(await regular.page.evaluate(() => localStorage.getItem('aa_reduce_motion')), '1', 'app reduced-motion preference was not persisted');
  assert.equal((await styleOf(regular.page, '.ghostbtn')).transitionDuration, '0s', 'app reduced-motion state leaves transitions active');

  await regular.page.locator('.aa-railbtn[data-rail="mlb"]').click();
  await regular.page.locator('.mrow').waitFor();
  assert.equal((await styleOf(regular.page, '.mrow')).animationDuration, '0s', 'app reduced-motion state leaves schedule animation active');
  await regular.page.reload({ waitUntil: 'domcontentloaded' });
  await regular.page.locator('.mrow').waitFor();
  assert.equal(await regular.page.locator('body').evaluate(element => element.classList.contains('aa-reduce-motion')), true, 'reduced-motion state did not survive reload');
  assert.deepEqual(regular.errors, [], 'regular motion flow emitted application errors');
  await regular.context.close();

  const preference = await setup({ width: 1280, height: 800 }, 'reduce');
  await preference.page.goto(`${base}/?s=mlb&g=g1`, { waitUntil: 'domcontentloaded' });
  await preference.page.locator('.dtabs').waitFor();
  assert.equal(await preference.page.locator('body').evaluate(element => element.classList.contains('aa-reduce-motion')), true, 'OS reduced-motion preference did not reach app state');
  assert.equal((await styleOf(preference.page, '.dhero')).animationDuration, '0s', 'OS reduced-motion preference leaves route animation active');
  assert.deepEqual(preference.errors, [], 'OS reduced-motion flow emitted application errors');
  await preference.context.close();

  const mobile = await setup({ width: 360, height: 800 });
  await mobile.page.goto(`${base}/?s=mlb&g=g1`, { waitUntil: 'domcontentloaded' });
  await mobile.page.locator('.dtabs').waitFor();
  assert.equal(await noOverflow(mobile.page), true, '360px animated Inspect surface overflows horizontally');
  assert.equal((await styleOf(mobile.page, '.dhero')).animationDuration, '0.2s', 'mobile route motion diverges from the desktop contract');
  assert.deepEqual(mobile.errors, [], 'mobile motion flow emitted application errors');
  await mobile.context.close();

  console.log(`motion views UI (${engine}): vertical continuity, focus, instant routing and reduced motion passed`);
} finally {
  await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
