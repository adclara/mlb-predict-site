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
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function etToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function shiftDate(date, delta) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function event(id, start) {
  return {
    sport: 'mlb', league: 'MLB', event_id: id, matchup: 'MIN @ CLE', start, status: 'pre',
    away: { code: 'MIN', name: 'Minnesota Twins' },
    home: { code: 'CLE', name: 'Cleveland Guardians' },
    prediction: { pick: 'CLE', prob: 0.57, prob_pct: 57, confidence: 'test' },
    metrics: [], snapshot: {
      fielding: { away: { err_l10: 2, epg: 0.2, g: 10 }, home: { err_l10: 9, epg: 0.9, g: 10 } },
      context: { series: { game: 4, len: 4, home_wins: 0, away_wins: 3 } },
    }, risk: null, odds: null, badges: [], result: null, final: null,
  };
}

function pendingEvent(id, start) {
  return {
    ...event(id, start), pending: true,
    prediction: { pick: null, prob: null, prob_pct: null, confidence: null },
    snapshot: null,
  };
}

function invalidatedEvent(id, start) {
  return {
    ...event(id, start),
    prediction: {
      pick: 'CLE', prob: 0.61, prob_pct: 61, confidence: 'alta',
      invalidated: true, invalidated_reason: 'probable_starter_changed',
    },
    snapshot: null,
    metrics: [],
    risk: null,
    badges: ['fijo', 'oro'],
  };
}

function live(id, date, start, status, awayScore, homeScore) {
  return {
    espn_id: id, date, start, status,
    status_detail: status === 'live' ? 'Top 3rd' : status === 'final' ? 'Final' : 'Scheduled',
    away: { code: 'MIN', score: awayScore, rec: null },
    home: { code: 'CLE', score: homeScore, rec: null },
    period: status === 'pre' ? 0 : 3, situation: null,
  };
}

function json(route, body) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installApiMocks(page, date, events, games) {
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/mlb/today') {
      return json(route, { sport: 'mlb', date, record: null, events });
    }
    if (path === '/v1/mlb/live') {
      return json(route, { sport: 'mlb', date, updated_at: new Date().toISOString(), games });
    }
    if (path === '/v1/mlb/learning') {
      return json(route, {
        n_graded: 106, first_date: '2026-03-25', cal: {}, market: {}, history: [], log: [],
        state_es: ['Aprendizaje medido.'], state_en: ['Measured learning.'],
        signals: [{ label: 'Coincide con el favorito del mercado', label_en: 'Matches the market favorite', edge_pp: 11.5 }],
      });
    }
    if (path === '/v1/mlb/simulation') return json(route, {
      n_games: 100, n_oos: 80, ece: 3.8,
      oos: { combined: { acc: 53.2, ll: 0.696, brier: 0.251 } },
      delta_ll: { helps: false },
      selection: [{ thr: 53, n: 40, rate: 55, priced_n: 0, units: null, roi: null, accuracy_signal: true, edge: false }],
      market: { model_acc: 53.7, market_acc: 56.5 },
    });
    if (path === '/v1/injuries') return json(route, { players: [] });
    if (path === '/v1/me') return json(route, { enabled: false, user: null });
    return json(route, {});
  });

  // Evita que logos/fuentes externas conviertan el ruido de red del sandbox en
  // falsos errores de la aplicación.
  await page.route('https://a.espncdn.com/**', route => route.fulfill({ status: 204, body: '' }));
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ status: 204, body: '' }));
}

function collectErrors(page) {
  const errors = [];
  const networkNoise = /ERR_TUNNEL_CONNECTION_FAILED|Failed to load resource/i;
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !networkNoise.test(msg.text())) errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    const message = request.failure()?.errorText || '';
    if (!networkNoise.test(message)) errors.push(`requestfailed: ${request.url()} ${message}`);
  });
  return errors;
}

async function rowState(page, id) {
  const row = page.locator(`.mrow[data-id="${id}"]`);
  await row.waitFor({ state: 'visible' });
  return row.evaluate(el => ({
    time: el.querySelector('.mtime')?.textContent.trim() || '',
    scores: [...el.querySelectorAll('.mscore .ms')].map(x => x.textContent.trim()),
  }));
}

async function assertNoOverflow(page, label) {
  const size = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    docClient: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth,
    bodyClient: document.body.clientWidth,
  }));
  assert.ok(size.docScroll <= size.docClient + 1, `${label}: overflow document ${JSON.stringify(size)}`);
  assert.ok(size.bodyScroll <= size.bodyClient + 1, `${label}: overflow body ${JSON.stringify(size)}`);
}

const server = createServer(async (req, res) => {
  try {
    // URL.pathname quita el query antes de comprobar '/', como exige la suite.
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://local').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = resolve(ROOT, relative);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (error) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});

const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const launch = { headless: true };
const candidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux64/chrome',
  '/opt/pw-browsers/chromium/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = candidates.find(existsSync);
if (executablePath) launch.executablePath = executablePath;

const browser = await chromium.launch(launch);
const today = etToday();
const yesterday = shiftDate(today, -1);

try {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile-390', width: 390, height: 844 },
    { name: 'mobile-360', width: 360, height: 800 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      locale: 'es-ES', timezoneId: 'America/New_York', serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const errors = collectErrors(page);
    await installApiMocks(
      page,
      today,
      [
        event('today-game', `${today}T22:40:00Z`),
        pendingEvent('pending-game', `${today}T23:40:00Z`),
        invalidatedEvent('invalidated-game', `${today}T20:10:00Z`),
      ],
      [live('yesterday-final', yesterday, `${yesterday}T22:40:00Z`, 'final', 4, 13)],
    );
    await page.goto(`${base}/?mlb-live-date-regression=${viewport.name}`, { waitUntil: 'domcontentloaded' });
    const state = await rowState(page, 'today-game');
    assert.notEqual(state.time, 'Final', `${viewport.name}: el final de ayer contaminó hoy`);
    assert.deepEqual(state.scores, ['', ''], `${viewport.name}: aparecen marcadores de ayer`);
    await page.locator('.mrow[data-id="today-game"]').click();
    const detailEs = await page.locator('#dcard').textContent();
    assert.match(detailEs, /defensa floja: 9 errores en 10 juegos/i, `${viewport.name}: falta fielding ES`);
    assert.match(detailEs, /necesita ganar para evitar la barrida/i, `${viewport.name}: falta barrida ES`);
    await page.locator('#dback').evaluate(el => el.click());
    assert.match(await page.locator('.mrow[data-id="pending-game"]').textContent(), /se publica ~7am ET/i, `${viewport.name}: falta pending ES`);
    const invalidRowEs = await page.locator('.mrow[data-id="invalidated-game"]').textContent();
    assert.match(invalidRowEs, /pronóstico invalidado · cambió el abridor/i, `${viewport.name}: falta aviso scratch ES`);
    assert.doesNotMatch(invalidRowEs, /AA\s*61%/i, `${viewport.name}: pick invalidado visible en fila ES`);
    assert.equal(await page.locator('.tkchip[data-id="invalidated-game"]').count(), 0, `${viewport.name}: scratch entró al ticker`);
    assert.equal(await page.locator('.bleg[data-id="invalidated-game"]').count(), 0, `${viewport.name}: scratch entró al boleto`);
    await page.locator('.mrow[data-id="invalidated-game"]').click();
    const invalidDetailEs = await page.locator('#dcard').textContent();
    assert.match(invalidDetailEs, /pronóstico AA invalidado: cambió el abridor probable\. El análisis original ya no aplica/i, `${viewport.name}: falta aviso prominente ES`);
    assert.doesNotMatch(invalidDetailEs, /61%/, `${viewport.name}: probabilidad invalidada visible en detalle ES`);
    await page.locator('#dback').evaluate(el => el.click());
    await assertNoOverflow(page, viewport.name);
    await page.locator('#langbtn').click();
    await page.locator('.mrow[data-id="today-game"]').click();
    const detailEn = await page.locator('#dcard').textContent();
    assert.match(detailEn, /sloppy fielding: 9 errors in 10 games/i, `${viewport.name}: missing fielding EN`);
    assert.match(detailEn, /needs a win to avoid the sweep/i, `${viewport.name}: missing sweep EN`);
    await page.locator('#dback').evaluate(el => el.click());
    assert.match(await page.locator('.mrow[data-id="pending-game"]').textContent(), /publishes around 7am ET/i, `${viewport.name}: missing pending EN`);
    const invalidRowEn = await page.locator('.mrow[data-id="invalidated-game"]').textContent();
    assert.match(invalidRowEn, /prediction invalidated · starter changed/i, `${viewport.name}: missing scratch warning EN`);
    assert.doesNotMatch(invalidRowEn, /pronóstico|abridor|análisis/i, `${viewport.name}: Spanish leaked into scratch warning EN`);
    await page.locator('.mrow[data-id="invalidated-game"]').click();
    const invalidDetailEn = await page.locator('#dcard').textContent();
    assert.match(invalidDetailEn, /AA prediction invalidated: the probable starter changed\. The original analysis no longer applies/i, `${viewport.name}: missing prominent warning EN`);
    assert.doesNotMatch(invalidDetailEn, /61%/, `${viewport.name}: invalidated probability visible in detail EN`);
    await page.locator('#dback').evaluate(el => el.click());
    await page.locator('.ltab[data-lt="brain"]').click();
    const signalLabel = page.locator('.bsig .bsl').first();
    await signalLabel.waitFor({ state: 'visible' });
    assert.equal(await signalLabel.textContent(), 'Matches the market favorite', `${viewport.name}: señal del Cerebro sin traducir`);
    const brainText = await page.locator('#list').textContent();
    assert.match(brainText, /Confidence selection \(no assumed price\)/, `${viewport.name}: simulation still assumes a price`);
    assert.match(brainText, /hit rate >50% \(CI\)/, `${viewport.name}: missing accuracy-only signal`);
    await assertNoOverflow(page, `${viewport.name}-brain-en`);
    assert.deepEqual(errors, [], `${viewport.name}: errores de consola/red de la app`);
    await context.close();
  }

  // Regresión adicional: dos juegos de los mismos equipos en el mismo día se
  // distinguen por hora y no comparten accidentalmente el marcador.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }, locale: 'es-ES',
    timezoneId: 'America/New_York', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await installApiMocks(
    page,
    today,
    [event('double-1', `${today}T17:00:00Z`), event('double-2', `${today}T23:00:00Z`)],
    [
      live('live-1', today, `${today}T17:00:00Z`, 'final', 1, 2),
      live('live-2', today, `${today}T23:00:00Z`, 'live', 3, 4),
    ],
  );
  await page.goto(`${base}/?mlb-doubleheader-regression=1`, { waitUntil: 'domcontentloaded' });
  assert.deepEqual(await rowState(page, 'double-1'), { time: 'Final', scores: ['1', '2'] });
  const second = await rowState(page, 'double-2');
  assert.deepEqual(second.scores, ['3', '4']);
  assert.notEqual(second.time, 'Final');
  await assertNoOverflow(page, 'doubleheader-desktop');
  assert.deepEqual(errors, [], 'doubleheader-desktop: errores de consola/red de la app');
  await context.close();

  console.log('✅ MLB live/date UI: desktop + 390 + 360, doble jornada, 0 errores, sin overflow');
} finally {
  await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
