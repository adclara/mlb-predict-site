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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const gate = { passed: false, approved: false, public: false, state: 'closed', reason: 'forward_sample_pending' };
const event = {
  event_id: '401', espn_id: '401', start: `${date}T23:00:00Z`, status: 'pre', status_detail: 'Scheduled',
  away: { code: 'DAL', name: 'Dallas', score: null, rec: '0-0' }, home: { code: 'PHI', name: 'Philadelphia', score: null, rec: '0-0' },
};
const qaMarkets = {
  winner: { state: 'qa', qa: true, public: false, gate, sample: { n: 2, dates: 1, min_forward: 50 }, pick: 'PHI', side: 'home', prob: .641, price: -120, items: [{ pick: 'PHI', side: 'home', prob: .641, price: -120 }] },
  total: { state: 'qa', qa: true, public: false, gate, sample: { n: 2, dates: 1, min_forward: 200 }, pick: 'over', side: 'over', line: 47.5, prob: .557, items: [{ pick: 'over', side: 'over', line: 47.5, prob: .557 }] },
  players: { state: 'closed', qa: true, gate: { ...gate, reason: 'market_lines_unavailable' }, sample: { n: 0, dates: 0, min_forward: 200 } },
  combos: { state: 'closed', qa: true, gate: { ...gate, reason: 'individual_markets_not_public' }, sample: { n: 0, dates: 0, min_forward: 100 } },
};

function errorsFor(page) {
  const errors = [];
  const noise = /ERR_TUNNEL_CONNECTION_FAILED|Failed to load resource/i;
  page.on('console', (msg) => { if (msg.type() === 'error' && !noise.test(msg.text())) errors.push(`console: ${msg.text()}`); });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => { const message = request.failure()?.errorText || ''; if (!noise.test(message)) errors.push(`requestfailed: ${request.url()} ${message}`); });
  return errors;
}

async function mocks(page) {
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/me') return json(route, { enabled: true, user: { name: 'QA Owner', email: 'qa@example.com', pic: null }, qa: true, qa_configured: true });
    if (path === '/v1/me/favs') return json(route, { favs: [] });
    if (path === '/v1/mlb/today') return json(route, { sport: 'mlb', date, events: [], record: null });
    if (path === '/v1/mlb/live') return json(route, { games: [] });
    if (path === '/v1/injuries') return json(route, {});
    if (path === '/v1/nfl/live') return json(route, { sport: 'nfl', games: [event] });
    if (path === '/v1/qa/nfl/today') return json(route, {
      schema: 'aa_qa_shadow_today_v1', qa: true, public: false, scope: 'shadow', sport: 'nfl', date, row_count: 2,
      markets: qaMarkets, events: [{ ...event, prediction: { pick: 'PHI', side: 'home', prob: .641, qa: true }, markets: qaMarkets }], top2: [],
    });
    if (path === '/v1/qa/nfl/learning') return json(route, {
      qa: true, public: false, sport: 'nfl', gate, historical: { n: 284, accuracy: .634, brier: .2258, ece: .0488 },
      forward: { n: 2, dates: 1 }, learning_es: ['Predicciones sombra congeladas antes del juego.'], learning_en: ['Shadow predictions frozen before the game.'],
    });
    if (path === '/v1/nfl/standings') return json(route, { sport: 'nfl', sections: [] });
    if (path === '/v1/nfl/summary') return json(route, { ok: true, sport: 'nfl', stats: [] });
    if (path === '/v1/nfl/recent') return json(route, { sport: 'nfl', games: [] });
    return json(route, {});
  });
  await page.route('https://a.espncdn.com/**', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }));
}

async function noOverflow(page, label) {
  const size = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bsw: document.body.scrollWidth, bcw: document.body.clientWidth }));
  assert.ok(size.sw <= size.cw + 1 && size.bsw <= size.bcw + 1, `${label}: overflow ${JSON.stringify(size)}`);
}

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://local').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = resolve(ROOT, relative);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  } catch (error) { res.writeHead(404); res.end('not found'); }
});
await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
const base = `http://127.0.0.1:${server.address().port}`;
const candidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const executablePath = candidates.find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

try {
  for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile-390', width: 390, height: 844 }, { name: 'mobile-360', width: 360, height: 800 }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, locale: 'es-ES', timezoneId: 'America/New_York', serviceWorkers: 'block' });
    const page = await context.newPage(); const errors = errorsFor(page); await mocks(page);
    await page.goto(`${base}/?qa=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /QA PRIVADO/i.test(document.querySelector('#qaBanner')?.textContent || ''));
    await page.locator('.sp[data-sport="nfl"]').click();
    await page.locator('.mrow[data-oid="401"]').waitFor({ state: 'visible' });
    await page.locator('.mrow[data-oid="401"]').click();
    const detailEs = await page.locator('#dcard .market-first').textContent();
    assert.match(detailEs, /QA sombra/i, `${viewport.name}: falta estado QA ES`);
    assert.match(detailEs, /Philadelphia 64[,.]1%/i, `${viewport.name}: falta probabilidad sombra ES`);
    assert.match(detailEs, /no público/i, `${viewport.name}: falta deslinde privado ES`);
    assert.match(await page.locator('#list').textContent(), /2 señales sombra medidas/i, `${viewport.name}: falta conteo QA ES`);
    await page.locator('#dcard .market-tab[data-market-kind="total"]').evaluate((el) => el.click());
    assert.match(await page.locator('#dcard .market-first').textContent(), /over[\s\S]*55[,.]7% · 47[,.]5/i, `${viewport.name}: falta total sombra ES`);
    await page.locator('#langbtn').evaluate((el) => el.click());
    const detailEn = await page.locator('#dcard .market-first').textContent();
    assert.match(detailEn, /Shadow QA/i, `${viewport.name}: missing QA state EN`);
    assert.match(detailEn, /Private validation view/i, `${viewport.name}: missing private disclaimer EN`);
    assert.doesNotMatch(detailEn, /QA sombra|Vista de validación|no público/i, `${viewport.name}: Spanish leaked into QA EN`);
    await noOverflow(page, viewport.name);
    assert.deepEqual(errors, [], `${viewport.name}: app errors`);
    await context.close();
  }
  console.log('✅ QA shadow UI: desktop + 390 + 360, ES/EN, 0 errors, no overflow');
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
