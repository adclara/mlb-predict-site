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
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.js': 'text/javascript; charset=utf-8' };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
      away: { id: 999999, name: 'Pitcher Fallback', hand: 'R', starts: 8, era_recent: 3.7, fip: 3.9, k9: 8.2 },
      home: { id: 605400, name: 'Logan Allen', hand: 'L', starts: 11, era_recent: 3.2, fip: 3.4, k9: 9.1 },
    },
    lineups: {
      away: [{ id: 123456, name: 'Bateador Uno', order: 1, pos: 'CF', ops: .811, hr: 12, avg: .278 }],
      home: [{ id: 654321, name: 'Bateador Dos', order: 1, pos: 'SS', ops: .834, hr: 18, avg: .284 }],
    },
    hitters: { away: [{ id: 123456, name: 'Bateador Uno', ops: .811, hr: 12, avg: .278 }], home: [{ id: 654321, name: 'Bateador Dos', ops: .834, hr: 18, avg: .284 }] },
    form: { away: [], home: [] }, reasons: ['Probabilidad calibrada con el corte público.'],
  },
  risk: { level: 'bajo', score: 18, coverage: 1 }, badges: [], result: null, final: null,
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
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, locale: 'es-ES', timezoneId: 'America/New_York', serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/i.test(message.text())) errors.push(`console: ${message.text()}`); });
  await page.route('**/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, updated_at: updatedAt, events: [event], publication: { state: 'published', predictions: 1, checked_at: updatedAt }, record: null });
    if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
    if (path === '/v1/mlb/standings') return json(route, { sport: 'mlb', sections: [{ name: 'AL', rows: [{ code: 'CLE', name: 'Cleveland Guardians', w: 88, l: 64, pct: .579 }, { code: 'MIN', name: 'Minnesota Twins', w: 82, l: 70, pct: .539 }] }] });
    if (path === '/v1/injuries') return json(route, { players: [] });
    if (path === '/v1/me') return json(route, { enabled: false, user: null });
    if (path === '/v1/intelligence/today' || path.endsWith('/learning') || path.endsWith('/simulation')) return json(route, {});
    return json(route, {});
  });
  let fallbackRequests = 0;
  await page.route(/^https:\/\/midfield\.mlbstatic\.com\//, route => {
    if (route.request().url().includes('/999999/')) { fallbackRequests += 1; return route.fulfill({ status: 404, body: '' }); }
    return route.fulfill({ status: 200, contentType: 'image/png', body: onePxPng });
  });
  await page.route(/^https:\/\/(a\.espncdn\.com|img\.mlbstatic\.com)\//, route => route.fulfill({ status: 200, contentType: 'image/png', body: onePxPng }));
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ status: 204, body: '' }));
  return { context, page, errors, fallbackCount: () => fallbackRequests };
}

try {
  const run = await setup();
  await run.page.goto(`${base}/?s=mlb&g=g1`, { waitUntil: 'domcontentloaded' });
  await run.page.locator('[data-canonical-probability]').waitFor();
  await run.page.getByRole('tab', { name: /Participantes/ }).click();
  const playerLink = run.page.locator('a[data-player-link="605400"]').first();
  assert.equal(await playerLink.isVisible(), true, 'official-id participant is not linked');
  assert.match(await playerLink.getAttribute('href'), /[?&]p=605400(?:&|$)/, 'participant link is not canonical');
  await playerLink.click();
  await run.page.locator('.object-profile[data-object-kind="player"]').waitFor();
  assert.equal(new URL(await run.page.url()).searchParams.get('p'), '605400', 'player route was not written');
  assert.equal(await run.page.locator('#objectProfileTitle').innerText(), 'Logan Allen');
  await run.page.locator('#faceCaption-605400').waitFor({ state: 'visible' });
  assert.equal(await run.page.locator('#faceCaption-605400').isVisible(), true, 'official-photo caption did not appear after a real load');
  assert.equal(await run.page.locator('.player-profile').getByText('FIP').isVisible(), true, 'event stats are missing from player page');
  await run.page.waitForFunction(() => document.activeElement?.id === 'objectProfileTitle');
  assert.equal(await run.page.locator('#objectProfileTitle').evaluate(el => el === document.activeElement), true, 'player page heading did not receive focus');

  await run.page.locator('#dback').click();
  await run.page.locator('.dtabs').waitFor();
  assert.equal(new URL(await run.page.url()).searchParams.get('p'), null, 'Back did not restore the match');
  assert.equal(await run.page.locator('.dtab[data-dt="participantes"]').getAttribute('aria-selected'), 'true', 'Back did not restore the origin tab');
  await run.page.locator('a[data-team-link="CLE"]').first().click();
  await run.page.locator('.object-profile[data-object-kind="team"]').waitFor();
  assert.equal(new URL(await run.page.url()).searchParams.get('team'), 'CLE', 'team route was not written');
  assert.match(await run.page.locator('.team-profile').innerText(), /Jugadores disponibles en este partido/);
  assert.equal(await run.page.locator('.team-profile a[data-player-link]').count() >= 2, true, 'event roster did not expose available linked players');
  assert.equal(await run.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'team page overflows');
  assert.deepEqual(run.errors, [], 'player/team navigation emitted application errors');
  await run.context.close();

  const broken = await setup({ width: 390, height: 844 });
  await broken.page.goto(`${base}/?s=mlb&g=g1&p=999999`, { waitUntil: 'domcontentloaded' });
  await broken.page.locator('.player-profile .hsfall').waitFor();
  assert.equal(await broken.page.locator('#faceCaption-999999').isHidden(), true, 'failed photo caption stayed visible');
  assert.equal(broken.fallbackCount() >= 1 && broken.fallbackCount() <= 2, true, 'failed image entered a request loop');
  assert.equal(await broken.page.evaluate(() => aaFaceAssetUrl({ sport: 'nba', href: 'https://evil.example/x.png' })), null, 'frontend accepted a hostile face URL');
  assert.equal(await broken.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, '390px player page overflows');
  assert.deepEqual(broken.errors, [], 'fallback page emitted application errors');
  await broken.context.close();

  const missing = await setup({ width: 360, height: 800 });
  await missing.page.goto(`${base}/?s=mlb&g=g1&p=777777`, { waitUntil: 'domcontentloaded' });
  await missing.page.locator('.object-not-found').waitFor();
  await missing.page.waitForFunction(() => document.activeElement?.id === 'objectNotFoundTitle');
  assert.equal(await missing.page.locator('#objectNotFoundTitle').evaluate(el => el === document.activeElement), true, 'not-found heading did not receive focus');
  assert.deepEqual(missing.errors, [], 'not-found route emitted application errors');
  await missing.context.close();

  console.log(`player visuals UI (${engine}): allowlist, official face, fallback and contextual routes passed`);
} finally {
  await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
