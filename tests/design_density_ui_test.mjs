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
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const updatedAt = new Date().toISOString();
const onePxPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const event = {
  sport: 'mlb', league: 'MLB', event_id: 'g1', matchup: 'MIN @ CLE', start: `${today}T22:40:00Z`, status: 'pre',
  away: { code: 'MIN', name: 'Minnesota Twins' }, home: { code: 'CLE', name: 'Cleveland Guardians' },
  prediction: { pick: 'CLE', prob: .57, prob_pct: 57, probability_source: 'prob_v2', confidence: 'media' },
  metrics: [
    { key: 'metric_prob_cal', label: 'Prob. AA calibrada', value: '57%', kind: 'pct' },
    { key: 'metric_risk', label: 'Riesgo', value: 'bajo', kind: 'risk' },
  ],
  snapshot: {
    verdict_es: 'Lectura pública construida con datos verificados.',
    verdict_en: 'Public read built from verified data.',
    pitchers: {
      away: { id: 660271, name: 'Visitante con nombre largo', hand: 'R', starts: 8, era: 3.84, era_recent: 3.7, fip: 3.9, k9: 8.2 },
      home: { id: 605400, name: 'Logan Allen', hand: 'L', starts: 11, era: 3.12, era_recent: 3.2, fip: 3.4, k9: 9.1 },
    },
    lineups: {
      away: [{ id: 123456, name: 'Bateador visitante', order: 1, pos: 'CF', ops: .811, hr: 12, avg: .278 }],
      home: [{ id: 654321, name: 'Bateador local', order: 1, pos: 'SS', ops: .834, hr: 18, avg: .284 }],
    },
    hitters: {
      away: [{ id: 123456, name: 'Bateador visitante', ops: .811, hr: 12, avg: .278 }],
      home: [{ id: 654321, name: 'Bateador local', ops: .834, hr: 18, avg: .284 }],
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
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(viewport) {
  const context = await browser.newContext({ viewport, locale: 'es-ES', timezoneId: 'America/New_York', serviceWorkers: 'block' });
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
    if (path === '/v1/mlb/standings') return json(route, { sport: 'mlb', sections: [] });
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

const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const assertMinimum = async (page, selectors, minimum, label) => {
  const failures = await page.evaluate(({ selectors: targets, minimum: min }) => targets.flatMap(selector =>
    [...document.querySelectorAll(selector)].filter(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return element.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden' && (rect.width + .1 < min || rect.height + .1 < min);
    }).map(element => ({ selector, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }))), { selectors, minimum });
  assert.deepEqual(failures, [], label);
};
const assertFontMinimum = async (page, selectors, minimum, label) => {
  const failures = await page.evaluate(({ selectors: targets, minimum: min }) => targets.flatMap(selector =>
    [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length && parseFloat(getComputedStyle(element).fontSize) < min)
      .map(element => ({ selector, size: getComputedStyle(element).fontSize, text: element.textContent.trim().slice(0, 40) }))), { selectors, minimum });
  assert.deepEqual(failures, [], label);
};
const assertNoEmojiInChrome = async page => {
  const offenders = await page.evaluate(() => [...document.querySelectorAll('nav, h1, h2, h3, .pagehead, .recentnote, .bsect')]
    .filter(element => element.getClientRects().length && /\p{Extended_Pictographic}/u.test(element.innerText || ''))
    .map(element => element.innerText.trim().slice(0, 80)));
  assert.deepEqual(offenders, [], 'visible navigation or headings contain emoji');
};

try {
  const desktop = await setup({ width: 1440, height: 900 });
  await desktop.page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
  await desktop.page.locator('.mrow').waitFor();
  await assertMinimum(desktop.page, ['.pill', '.sp', '.ltab', '.mstar', '.datebox .arrow', '.datebox .today', '.aa-railbtn'], 44, 'list controls are smaller than 44 CSS px');
  await assertFontMinimum(desktop.page, ['.mpitcher small', '.status-source', '.mclub .nm'], 12, 'critical schedule text is smaller than 12px');
  await assertNoEmojiInChrome(desktop.page);
  assert.equal(await desktop.page.locator('.sp').evaluateAll(items => items.every((item, index) => index === items.length - 1 || item.getBoundingClientRect().right <= items[index + 1].getBoundingClientRect().left + .1)), true, 'sports navigation items overlap');
  assert.equal(await desktop.page.evaluate(() => ['header', '#listpane'].every(selector => getComputedStyle(document.querySelector(selector)).backdropFilter === 'none')), true, 'operational shell still uses glass blur');
  assert.equal(await noOverflow(desktop.page), true, '1440px list overflows');

  const contrast = await desktop.page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const color = name => style.getPropertyValue(name).trim();
    const rgb = value => {
      const hex = value.replace('#', '');
      return hex.length === 3 ? [...hex].map(char => parseInt(char + char, 16)) : [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16));
    };
    const luminance = value => {
      const channels = rgb(value).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
      return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
    };
    const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + .05) / (lo + .05); };
    const page = color('--page');
    return {
      text: ratio(color('--text'), page), dim: ratio(color('--dim'), page), faint: ratio(color('--faint'), page),
      onSky: ratio(color('--on-sky'), color('--sky')), skyUi: ratio(color('--sky'), page),
    };
  });
  for (const key of ['text', 'dim', 'faint', 'onSky']) assert.ok(contrast[key] >= 4.5, `${key} contrast ${contrast[key].toFixed(2)} is below 4.5:1`);
  assert.ok(contrast.skyUi >= 3, `sky UI contrast ${contrast.skyUi.toFixed(2)} is below 3:1`);

  await desktop.page.locator('.mrow a[data-object-link]').click();
  await desktop.page.locator('[data-canonical-probability]').waitFor();
  await assertMinimum(desktop.page, ['.dback', '.dtab', '.market-status', '.sharebtn'], 44, 'detail controls are smaller than 44 CSS px');
  await assertFontMinimum(desktop.page, ['.aa-fact b', '.dwhen', '.aa-reading p'], 12, 'critical detail text is smaller than 12px');
  assert.equal(await desktop.page.evaluate(() => ['header', '#detail', '#dcard'].every(selector => getComputedStyle(document.querySelector(selector)).backdropFilter === 'none')), true, 'Inspect surface still uses glass blur');
  await assertNoEmojiInChrome(desktop.page);

  await desktop.page.getByRole('tab', { name: /Participantes/ }).click();
  await desktop.page.locator('a[data-player-link="605400"]').first().click();
  await desktop.page.locator('.player-profile').waitFor();
  await assertFontMinimum(desktop.page, ['.object-profile-context b', '.available-person small'], 12, 'profile metadata is smaller than 12px');
  assert.equal(await noOverflow(desktop.page), true, 'desktop player profile overflows');

  await desktop.page.locator('#langbtn').click();
  assert.equal(await desktop.page.getAttribute('html', 'lang'), 'en', 'language toggle did not switch the document');
  assert.equal(await desktop.page.evaluate(() => localStorage.getItem('aa_lang')), 'en', 'language preference was not persisted');
  await desktop.page.reload({ waitUntil: 'domcontentloaded' });
  await desktop.page.locator('.player-profile').waitFor();
  assert.equal(await desktop.page.getAttribute('html', 'lang'), 'en', 'persisted language was not restored');
  assert.match(await desktop.page.locator('#dback').innerText(), /Games/i, 'English contextual copy did not render');
  assert.equal(await noOverflow(desktop.page), true, 'English text expansion overflows');
  assert.deepEqual(desktop.errors, [], 'desktop emitted application errors');
  await desktop.context.close();

  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 800 }, { width: 320, height: 800 }, { width: 720, height: 900 }]) {
    const run = await setup(viewport);
    await run.page.goto(`${base}/?s=mlb&g=g1`, { waitUntil: 'domcontentloaded' });
    await run.page.locator('[data-canonical-probability]').waitFor();
    assert.equal(await noOverflow(run.page), true, `${viewport.width}px Inspect surface overflows horizontally`);
    await assertMinimum(run.page, ['.dback', '.dtab', '.market-status', '.sharebtn'], 44, `${viewport.width}px controls are smaller than 44 CSS px`);
    assert.deepEqual(run.errors, [], `${viewport.width}px emitted application errors`);
    await run.context.close();
  }

  console.log(`design density UI (${engine}): type, targets, contrast, no-glass, i18n and reflow passed`);
} finally {
  await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
