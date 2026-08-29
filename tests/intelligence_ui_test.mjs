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
const intelligence = { version: 'intelligence_v2', date, state: 'fresh', as_of: now.toISOString(), next_refresh: new Date(now.getTime() + 1800e3).toISOString(),
  sources: { aa: { ok: true }, books: { ok: true }, polymarket: { ok: true, markets: 2 }, kalshi: { ok: true, markets: 2 } },
  slate: [{ id: 'mlb:1', sport: 'mlb', event_id: '1', start: new Date(now.getTime() + 3e6).toISOString(), market: 'winner', pick: 'BOS', selection_scope: 'aa_public',
    home: { code: 'BOS', name: 'Boston Red Sox' }, away: { code: 'NYY', name: 'New York Yankees' }, probability: { value: .64, kind: 'aa_calibrated' }, aa: { prob: .64, engine: 'v2', public_gate: true },
    books: { prob: .62, n: 3, disagreement: .02 }, polymarket: { matched: true, prob: .61, bid: .60, ask: .62, spread: .02, volume_24h: 12000 },
    kalshi: { matched: true, prob: .63, bid: .62, ask: .64, spread: .02, volume_24h: 8000 },
    consensus: { state: 'agree', market_prob: .62, anomalies: [] }, context: { form: { home: [{ w: true, opp: 'NYY', score: '5-2' }], away: [{ w: false, opp: 'BOS', score: '2-5' }] },
      pitchers: { home: { name: 'A. Ace', era_recent: 2.5 }, away: { name: 'B. Arm', era_recent: 4.2 } }, offense: { home: { runs: 5.1 }, away: { runs: 4.2 } } },
    reasons: [{ code: 'aa_probability', value: .64 }, { code: 'aa_form', pick_wins: 1, pick_n: 1, opponent_wins: 0, opponent_n: 1 },
      { code: 'aa_pitching', pick_name: 'A. Ace', opponent_name: 'B. Arm', pick_value: 2.5, opponent_value: 4.2 },
      { code: 'aa_offense', pick_value: 5.1, opponent_value: 4.2 }, { code: 'aa_risk', level: 'bajo', score: 18 }] },
  { id: 'wnba:2', sport: 'wnba', event_id: '2', start: new Date(now.getTime() + 5e6).toISOString(), market: 'winner', pick: 'NY', selection_scope: 'market_fact',
    home: { code: 'NY', name: 'New York Liberty' }, away: { code: 'CHI', name: 'Chicago Sky' }, probability: { value: .76, kind: 'market_devig' },
    market_pick: { prob: .76, provider: 'DraftKings', price: -380, public_fact: true }, books: { prob: .76, n: 1 },
    polymarket: { matched: true, prob: .785, bid: .78, ask: .79, spread: .01, volume_24h: 3400, reason: 'matched' },
    kalshi: { matched: true, prob: .785, bid: .78, ask: .79, spread: .01, volume_24h: 25000, reason: 'matched' }, consensus: { state: 'agree', market_prob: .785, anomalies: [] },
    context: { provider: 'DraftKings', price: -380, spread: -8.5, total: 178.5, pick_record: { text: '23-16', wins: 23, losses: 16 }, opponent_record: { text: '15-24', wins: 15, losses: 24 },
      pick_recent: [{ w: false, opp: 'GS', score: '60-79' }], opponent_recent: [{ w: true, opp: 'NY', score: '93-86' }] },
    reasons: [{ code: 'market_probability', value: .76, provider: 'DraftKings' }, { code: 'season_record', pick_record: '23-16', opponent_record: '15-24' }] }],
  market_bundles: [{ bundle_id: 'mlb:1+wnba:2', state: 'informational', joint_prob: null, legs: [
    { id: 'mlb:1', sport: 'mlb', event_id: '1', pick: 'BOS', prob: .64, source: 'aa_public', start: new Date(now.getTime() + 3e6).toISOString() },
    { id: 'wnba:2', sport: 'wnba', event_id: '2', pick: 'NY', prob: .76, source: 'market_fact', start: new Date(now.getTime() + 5e6).toISOString() }] }],
  combos: { state: 'closed', gate: { passed: false, approved: false, public: false }, sample: { n: 12, dates: 5, min_forward: 100, min_dates: 30 } },
  budget: { kv_writes: 2, d1_rows: 4 }, alerts: false, telegram: false };
for (let index = 3; index <= 12; index++) {
  const sports = ['ncaaf', 'soccer', 'nfl', 'mlb']; const sport = sports[(index - 3) % sports.length];
  intelligence.slate.push({ id: `${sport}:${index}`, sport, event_id: String(index), start: new Date(now.getTime() + (index + 1) * 1e6).toISOString(),
    market: 'winner', pick: `P${index}`, selection_scope: 'market_fact', home: { code: `P${index}`, name: `Pick ${index}` }, away: { code: `O${index}`, name: `Opponent ${index}` },
    probability: { value: .61 + index / 1000, kind: 'market_devig' }, market_pick: { prob: .61 + index / 1000, provider: 'DraftKings', price: -150, public_fact: true },
    books: { prob: .61 + index / 1000, n: 1 }, polymarket: { matched: false, reason: 'not_listed', candidates: 0 }, kalshi: { matched: false, reason: 'not_listed', candidates: 0 },
    consensus: { state: 'agree', market_prob: .61 + index / 1000, anomalies: [] }, context: { provider: 'DraftKings', price: -150 }, reasons: [{ code: 'market_probability', value: .61 + index / 1000, provider: 'DraftKings' }] });
}
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
    await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.locator('.sp[data-sport="radar"]').click(); await page.locator('.intelrow').first().waitFor();
    assert.equal(await page.locator('.intelrow').count(), 12, `${viewport.n}: expected full 12-play slate`);
    const listEs = await page.locator('#list').textContent(); assert.match(listEs, /Central de Jugadas AA/); assert.match(listEs, /WNBA[\s\S]*Favorito del mercado/); assert.match(listEs, /Combinaciones multideporte/);
    assert.match(await page.locator('#dcard').textContent(), /Polymarket[\s\S]*61[,.]0%/); assert.match(await page.locator('#dcard').textContent(), /Pitcheo[\s\S]*A\. Ace/);
    await page.locator('.intelrow[data-rw="wnba:2"]').click(); const wnbaEs = await page.locator('#dcard').textContent();
    assert.match(wnbaEs, /Probabilidad del mercado des-vigada[\s\S]*76[,.]0%/); assert.match(wnbaEs, /Polymarket[\s\S]*78[,.]5%/); assert.match(wnbaEs, /23-16 vs 15-24/);
    assert.match(wnbaEs, /12 \/ 100/); await page.locator('#langbtn').evaluate((el) => el.click()); assert.match(await page.locator('#dcard').textContent(), /AA Play Central/); assert.match(await page.locator('#dcard').textContent(), /De-vigged market probability/);
    assert.match(await page.locator('.lghead .sub').textContent(), /multi-source intelligence/i); assert.doesNotMatch(await page.locator('.lghead .sub').textContent(), /Season/i);
    await page.locator('.intelrow[data-rw="mlb:1"]').evaluate((el) => el.click()); assert.match(await page.locator('#dcard').textContent(), /Starters:[\s\S]*A\. Ace/); assert.doesNotMatch(await page.locator('#dcard').textContent(), /Abridores|riesgo bajo/i);
    if (process.env.AA_INTELLIGENCE_SCREENSHOT) await page.screenshot({ path: `/tmp/aa-intelligence-v2-${viewport.n}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok(overflow <= 1, `${viewport.n}: overflow ${overflow}`);
    assert.deepEqual(errors, [], `${viewport.n}: console errors`); await context.close();
  }
  console.log('✅ Intelligence UI: desktop + 390 + 360, ES/EN, 0 errors, no overflow');
} finally { await browser.close(); await new Promise((ok) => server.close(ok)); }
