import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../cloudflare/pages');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const ev = {
  sport: 'mlb', league: 'MLB', event_id: 'g1', matchup: 'MIN @ CLE',
  start: `${today}T23:00:00Z`, status: 'pre',
  away: { code: 'MIN', name: 'Minnesota Twins' },
  home: { code: 'CLE', name: 'Cleveland Guardians' },
  prediction: { pick: 'CLE', prob: 0.57, prob_pct: 57, confidence: 'media' },
  metrics: [{ key: 'metric_prob_cal', label: 'Prob. AA calibrada', value: '57%', kind: 'pct' }],
  snapshot: {}, risk: { level: 'bajo', score: 18, coverage: 1 }, odds: null, badges: [], result: null, final: null,
};
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url || '/', 'http://local').pathname);
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = resolve(ROOT, rel);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) throw new Error('outside');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', ok); });
const base = `http://127.0.0.1:${server.address().port}`;
const executablePath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  for (const viewport of [{ n: '390', width: 390, height: 844 }, { n: 'desktop', width: 1440, height: 900 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', locale: 'es-ES' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.route('**/v1/**', (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/v1/mlb/today') return json(route, { sport: 'mlb', date: today, events: [ev], record: null });
      if (p === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, games: [] });
      return json(route, {});
    });
    await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, contentType: 'font/woff2', body: '' }));
    await page.goto(`${base}/?tab=mlb`, { waitUntil: 'domcontentloaded' });
    await page.locator('.mrow[data-id="g1"]').waitFor();
    const origin = new URL(page.url()).origin;
    await page.locator('.mrow[data-id="g1"]').click();
    await page.waitForFunction(() => new URLSearchParams(location.search).get('g') === 'g1');
    assert.equal(new URL(page.url()).searchParams.get('g'), 'g1', `${viewport.n}: g= no se escribió`);
    if (viewport.n === '390') {
      assert.equal(await page.locator('#detail').evaluate((el) => el.classList.contains('open')), true, '390: overlay no abrió');
    }
    await page.goBack();
    await page.waitForFunction(() => !new URLSearchParams(location.search).get('g'));
    assert.equal(new URL(page.url()).origin, origin, `${viewport.n}: Back salió del origin`);
    assert.equal(await page.locator('#detail').evaluate((el) => el.classList.contains('open')), false, `${viewport.n}: overlay sigue abierto`);
    assert.equal(await page.locator('.mrow[data-id="g1"]').count(), 1, `${viewport.n}: lista no volvió`);
    assert.deepEqual(errors, [], `${viewport.n}: console ${errors.join(' | ')}`);
    await context.close();
  }
  console.log('✅ history router: 390 + desktop, Back se queda en origin');
} finally {
  await browser.close();
  await new Promise((ok) => server.close(ok));
}
