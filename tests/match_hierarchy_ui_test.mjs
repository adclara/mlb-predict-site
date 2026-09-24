import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const playwright = require('playwright');
const engine = process.env.AA_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox', 'webkit'].includes(engine));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../cloudflare/pages');
const CAPTURE_DIR = process.env.AA_CAPTURE_DIR ? resolve(process.env.AA_CAPTURE_DIR) : null;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const updatedAt = new Date().toISOString();

function game(id, away, home, hour, prediction, extra = {}) {
  return {
    sport: 'mlb', league: 'MLB', event_id: id, matchup: `${away.code} @ ${home.code}`,
    start: `${today}T${hour}:00Z`, status: 'pre', away, home, prediction,
    metrics: [
      { key: 'metric_prob_cal', label: 'Prob. AA calibrada', value: prediction?.prob_pct ? `${prediction.prob_pct}%` : '—', kind: 'pct' },
      { key: 'metric_risk', label: 'Riesgo', value: 'bajo', kind: 'risk' },
    ],
    snapshot: {
      verdict_es: 'Lectura pública construida con datos verificados.',
      verdict_en: 'Public read built from verified data.',
      pitchers: {
        away: { id: 660271, name: 'Ana Visitor', hand: 'R', era: 3.84, era_recent: 3.7, fip: 3.9, k9: 8.2 },
        home: { id: 605400, name: 'Hugo Starter', hand: 'L', era: 3.12, era_recent: 3.2, fip: 3.4, k9: 9.1 },
      },
      form: { away: [], home: [] }, reasons: ['Probabilidad calibrada con el corte público.'],
    },
    risk: { level: 'bajo', score: 18, coverage: 1 }, odds: null,
    badges: ['fijo'], result: null, final: null, ...extra,
  };
}
const teams = {
  min: { code: 'MIN', name: 'Minnesota Twins' }, cle: { code: 'CLE', name: 'Cleveland Guardians' },
  nyy: { code: 'NYY', name: 'New York Yankees' }, bos: { code: 'BOS', name: 'Boston Red Sox' },
  lad: { code: 'LAD', name: 'Los Angeles Dodgers' }, sf: { code: 'SF', name: 'San Francisco Giants' },
  sea: { code: 'SEA', name: 'Seattle Mariners' }, hou: { code: 'HOU', name: 'Houston Astros' },
  chc: { code: 'CHC', name: 'Chicago Cubs' }, stl: { code: 'STL', name: 'St. Louis Cardinals' },
  tor: { code: 'TOR', name: 'Toronto Blue Jays' }, bal: { code: 'BAL', name: 'Baltimore Orioles' },
  sd: { code: 'SD', name: 'San Diego Padres' }, ari: { code: 'ARI', name: 'Arizona Diamondbacks' },
};
const events = [
  game('g1', teams.min, teams.cle, '22:40', { pick: 'CLE', prob: .57, prob_pct: 57, probability_source: 'prob_v2', confidence: 'media' }),
  game('g2', teams.nyy, teams.bos, '23:10', { pick: 'BOS', prob: .61, prob_pct: 61, probability_source: 'prob_v2', confidence: 'alta' }),
  game('g3', teams.lad, teams.sf, '01:15', { pick: 'LAD', prob: .54, prob_pct: 54, probability_source: 'prob_v2', confidence: 'media' }),
  game('g4', teams.sea, teams.hou, '00:10', null, { pending: true }),
  game('g5', teams.chc, teams.stl, '00:45', { pick: 'CHC', prob: .55, prob_pct: 55, probability_source: 'prob_v2', confidence: 'media' }),
  game('g6', teams.tor, teams.bal, '18:05', { pick: 'BAL', prob: .59, prob_pct: 59, probability_source: 'prob_v2', confidence: 'media' }),
  game('g7', teams.sd, teams.ari, '21:40', { pick: 'ARI', prob: .56, prob_pct: 56, probability_source: 'prob_v2', confidence: 'media' }),
];
const live = [{
  espn_id: 'g3', event_id: 'g3', date: today, start: `${today}T01:15:00Z`, status: 'live', status_detail: 'Bot 5th',
  away: { code: 'LAD', score: 3 }, home: { code: 'SF', score: 2 }, win_prob_home: .42,
}];

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
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
const base = `http://127.0.0.1:${server.address().port}`;

const executable = process.env.AA_TEST_EXECUTABLE || (engine === 'chromium' ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH : '');
const launch = { headless: true };
if (executable && existsSync(executable)) launch.executablePath = executable;
const browser = await playwright[engine].launch(launch);

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function mock(page) {
  await page.route('**/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/mlb/today') return json(route, {
      sport: 'mlb', date: today, updated_at: updatedAt, events,
      publication: { state: 'published', predictions: 3, checked_at: updatedAt }, record: null,
    });
    if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date: today, updated_at: updatedAt, games: live });
    if (path === '/v1/mlb/standings') return json(route, { sport: 'mlb', sections: [] });
    if (path === '/v1/intelligence/today') return json(route, { version: 'intelligence_v2', state: 'fresh', slate: [], market_bundles: [] });
    if (path === '/v1/injuries') return json(route, { players: [] });
    if (path === '/v1/me') return json(route, { enabled: false, user: null });
    if (path.endsWith('/learning') || path.endsWith('/simulation')) return json(route, {});
    return json(route, {});
  });
  await page.route(/^https:\/\/(a\.espncdn\.com|img\.mlbstatic\.com|midfield\.mlbstatic\.com)\//, route => route.fulfill({ status: 204, body: '' }));
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ status: 204, body: '' }));
}

async function contextAt(viewport) {
  const context = await browser.newContext({ viewport, locale: 'es-ES', timezoneId: 'America/New_York', serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource/i.test(message.text())) errors.push(`console: ${message.text()}`);
  });
  await mock(page);
  return { context, page, errors };
}
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

try {
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
  if (CAPTURE_DIR) {
    const visual = await contextAt({ width: 1536, height: 1080 });
    await visual.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await visual.page.locator('.mrow').first().waitFor();
    await visual.page.waitForTimeout(1600);
    await visual.page.screenshot({ path: resolve(CAPTURE_DIR, 'implementation-list-1536x1080.png'), fullPage: false });
    await visual.context.close();
  }
  const desktop = await contextAt({ width: 1440, height: 900 });
  await desktop.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
  await desktop.page.locator('.mrow').first().waitFor();
  assert.equal(await desktop.page.locator('.schedule-head').isVisible(), true, 'desktop schedule header is hidden');
  assert.equal(await desktop.page.locator('.mrow').count(), 7, 'schedule lost or duplicated a game');
  assert.deepEqual(await desktop.page.locator('.schedule-kpis dd').allTextContents(), ['7', '6', '1', '0'], 'summary counts disagree with rows');
  assert.equal(await desktop.page.locator('.mrow').evaluateAll(rows => rows.slice(0, 3).every(row => row.getBoundingClientRect().bottom <= innerHeight)), true, 'fewer than three complete rows fit at 1440x900');
  assert.equal(await desktop.page.locator('.mrow').evaluateAll(rows => rows.every(row => row.querySelectorAll(':scope > a[data-object-link]').length === 1 && row.querySelectorAll(':scope > button[data-star]').length === 1)), true, 'row link and sibling favorite contract broke');
  assert.equal(/Fijo/i.test(await desktop.page.locator('#list').textContent()), false, 'legacy Fijo copy returned to the schedule');
  assert.equal(await noOverflow(desktop.page), true, 'desktop schedule overflows horizontally');

  const href = await desktop.page.locator('.mrow[data-id="g1"] a[data-object-link]').getAttribute('href');
  assert.match(href, /[?&]g=g1(?:&|$)/, 'game row is not a real object URL');
  await desktop.page.locator('.mrow[data-id="g1"] a[data-object-link]').click();
  await desktop.page.locator('[data-canonical-probability]').waitFor();
  assert.equal(await desktop.page.locator('.dtabs [role="tab"]').count(), 3, 'detail must expose exactly three primary tabs');
  assert.equal(await desktop.page.locator('[data-canonical-probability]').count(), 1, 'canonical AA probability is not unique');
  assert.equal((await desktop.page.locator('#dcard').textContent()).match(/57%/g)?.length, 1, 'AA probability is repeated in the detail');
  assert.equal(await desktop.page.locator('.summary-markets').count(), 1, 'market status is not nested in Summary');
  assert.equal(await desktop.page.locator('.aa-fact').count(), 5, 'scope/source/time/status/limit metadata is incomplete');
  assert.equal(await desktop.page.locator('.dtabs [data-dt="mercado"]').count(), 0, 'market returned as a primary tab');
  await desktop.page.locator('.summary-markets [data-market-kind="total"]').click();
  assert.equal(new URL(desktop.page.url()).searchParams.get('m'), 'total', 'market selection is not shareable');
  assert.equal(await desktop.page.locator('.summary-markets [data-market-kind="total"]').getAttribute('aria-pressed'), 'true', 'closed market is not announced as selected');
  assert.equal(await desktop.page.locator('.summary-markets .gate-card').count(), 1, 'closed market lacks its gate explanation');
  assert.equal(await desktop.page.locator('[data-canonical-probability]').count(), 1, 'market switching duplicated the canonical AA reading');
  await desktop.page.locator('.dtabs [data-dt="analisis"]').focus();
  await desktop.page.keyboard.press('ArrowRight');
  assert.equal(await desktop.page.locator('.dtabs [data-dt="participantes"]').getAttribute('aria-selected'), 'true', 'arrow-key tab navigation failed');
  await desktop.page.locator('.dtabs [data-dt="participantes"]').focus();
  await desktop.page.keyboard.press('End');
  assert.equal(await desktop.page.locator('.dtabs [data-dt="evidencia"]').getAttribute('aria-selected'), 'true', 'End did not select Evidence');
  assert.deepEqual(desktop.errors, [], 'desktop emitted application errors');
  await desktop.context.close();

  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 800 }]) {
    const mobile = await contextAt(viewport);
    await mobile.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
    await mobile.page.locator('.mrow').first().waitFor();
    assert.equal(await noOverflow(mobile.page), true, `${viewport.width}px list overflows horizontally`);
    assert.equal(await mobile.page.locator('.mrow').evaluateAll(rows => rows.every(row => row.getBoundingClientRect().width <= innerWidth)), true, `${viewport.width}px rows exceed viewport`);
    assert.deepEqual(mobile.errors, [], `${viewport.width}px emitted application errors`);
    await mobile.context.close();
  }

  const narrow = await contextAt({ width: 320, height: 800 });
  await narrow.page.goto(`${base}/?s=mlb&g=g1`, { waitUntil: 'domcontentloaded' });
  await narrow.page.locator('[data-canonical-probability]').waitFor();
  assert.equal(await noOverflow(narrow.page), true, '320px object page overflows horizontally');
  assert.deepEqual(narrow.errors, [], '320px object page emitted application errors');
  await narrow.context.close();

  // A 720 CSS-pixel viewport represents 1440px at 200% browser zoom.
  const zoom = await contextAt({ width: 720, height: 900 });
  await zoom.page.goto(`${base}/?s=mlb&g=g1`, { waitUntil: 'domcontentloaded' });
  await zoom.page.locator('[data-canonical-probability]').waitFor();
  assert.equal(await noOverflow(zoom.page), true, 'effective 200% zoom reflow overflows horizontally');
  assert.deepEqual(zoom.errors, [], 'effective 200% zoom emitted application errors');
  await zoom.context.close();

  console.log(`match hierarchy UI (${engine}): dense schedule, canonical read, tabs and reflow passed`);
} finally {
  await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
