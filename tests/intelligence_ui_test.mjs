import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../cloudflare/pages');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const now = new Date(), date = now.toISOString().slice(0, 10);
const intelligence = { version: 'intelligence_v1', date, state: 'fresh', as_of: now.toISOString(), next_refresh: new Date(now.getTime() + 1800e3).toISOString(),
  sources: { aa: { ok: true }, books: { ok: true }, polymarket: { ok: true, markets: 2 }, kalshi: { ok: true, markets: 2 } },
  slate: [{ id: 'mlb:1', sport: 'mlb', event_id: '1', start: new Date(now.getTime() + 3e6).toISOString(), market: 'winner', pick: 'BOS',
    home: { code: 'BOS', name: 'Boston Red Sox' }, away: { code: 'NYY', name: 'New York Yankees' }, aa: { prob: .64, engine: 'v2', public_gate: true },
    books: { prob: .62, n: 3, disagreement: .02 }, polymarket: { matched: true, prob: .61, bid: .60, ask: .62, spread: .02, volume_24h: 12000 },
    kalshi: { matched: true, prob: .63, bid: .62, ask: .64, spread: .02, volume_24h: 8000 },
    consensus: { state: 'agree', market_prob: .62, anomalies: [] }, reasons: [{ code: 'measured_reason', text: 'Boston tiene ventaja medida de picheo.' }] }],
  combos: { state: 'closed', gate: { passed: false, approved: false, public: false }, sample: { n: 12, dates: 5, min_forward: 100, min_dates: 30 } },
  budget: { kv_writes: 2, d1_rows: 4 }, alerts: false, telegram: false };
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const server = createServer(async (req, res) => {
  try { const path = decodeURIComponent(new URL(req.url || '/', 'http://local').pathname); const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, ''); const file = resolve(ROOT, rel);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) throw new Error('outside'); const body = await readFile(file); res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', ok); });
const base = `http://127.0.0.1:${server.address().port}`;
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  for (const viewport of [{ n: 'desktop', width: 1280, height: 900 }, { n: '390', width: 390, height: 844 }, { n: '360', width: 360, height: 800 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' }); const page = await context.newPage(); const errors = [];
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.route('**/v1/**', (route) => new URL(route.request().url()).pathname === '/v1/intelligence/today' ? json(route, intelligence) : json(route, {}));
    await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '' })); await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }));
    await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.locator('.sp[data-sport="radar"]').click(); await page.locator('.intelrow').waitFor();
    assert.match(await page.locator('#list').textContent(), /Central de Jugadas AA/); assert.match(await page.locator('#dcard').textContent(), /Polymarket[\s\S]*61[,.]0%/);
    assert.match(await page.locator('#dcard').textContent(), /12 \/ 100/); await page.locator('#langbtn').click(); assert.match(await page.locator('#dcard').textContent(), /AA Play Central/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok(overflow <= 1, `${viewport.n}: overflow ${overflow}`);
    assert.deepEqual(errors, [], `${viewport.n}: console errors`); await context.close();
  }
  console.log('✅ Intelligence UI: desktop + 390 + 360, ES/EN, 0 errors, no overflow');
} finally { await browser.close(); await new Promise((ok) => server.close(ok)); }
