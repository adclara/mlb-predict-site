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
const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const oldUpdatedAt = new Date(Date.now() - 12 * 60_000).toISOString();
const newUpdatedAt = new Date().toISOString();

const mlbEvent = (id, prediction, extra = {}) => ({
  sport: 'mlb', league: 'MLB', event_id: id, matchup: `MIN @ CLE ${id}`,
  start: `${date}T23:00:00Z`, status: 'pre',
  away: { code: 'MIN', name: 'Minnesota Twins' }, home: { code: 'CLE', name: 'Cleveland Guardians' },
  prediction,
  metrics: [{ key: 'metric_prob_cal', label: 'Prob. AA calibrada', value: prediction?.prob_pct == null ? '—' : `${prediction.prob_pct}%`, kind: 'pct' }],
  snapshot: { verdict_es: 'Lectura pública válida.', verdict_en: 'Valid public reading.' },
  risk: { level: 'desconocido', score: null, coverage: 0 }, odds: null,
  badges: ['gema'], result: null, final: null, ...extra,
});
const publicMlb = mlbEvent('public-1', { pick: 'CLE', prob: .57, prob_pct: 57, confidence: 'media', invalidated: false }, {
  top_signal: { event_id: 'public-1', rank: 1, basis: 'calibrated_probability', verified: true },
});
const privateMlb = mlbEvent('private-1', { state: 'private', pick: 'SECRET', prob: .99, prob_pct: 99 }, {
  top_signal: { event_id: 'private-1', rank: 2, basis: 'private', verified: false },
});
const contradictoryMlb = mlbEvent('closed-1', {
  state: 'closed', gate: { public: true, passed: false, approved: false }, pick: 'SECRET', prob: .99, prob_pct: 99,
}, { top_signal: { event_id: 'closed-1', rank: 3, basis: 'closed', verified: false } });
const xssMlb = mlbEvent('xss-1', {
  state: 'public', gate: { public: true, passed: true, approved: true }, pick: 'CLE', prob: .58,
  prob_pct: '</span><img src=x onerror="window.__xss=1">',
}, { top_signal: { event_id: 'xss-1', rank: 4, basis: 'malicious', verified: true } });

const oldGame = {
  espn_id: 'wnba-1', event_id: 'wnba-1', start: `${date}T23:30:00Z`, status: 'pre', status_detail: 'Scheduled',
  away: { code: 'MIN', name: 'Minnesota Lynx', score: null }, home: { code: 'NY', name: 'New York Liberty', score: null },
};
const publicGate = { state: 'public', passed: true, approved: true, public: true, reason: 'passed' };
const closed = (reason) => ({ state: 'closed', gate: { state: 'closed', passed: false, approved: false, public: false, reason }, sample: { n: 4, dates: 2 } });
const modelDoc = (pick, prob, updatedAt) => ({
  sport: 'wnba', date, updated_at: updatedAt, gate: publicGate,
  markets: { winner: { state: 'public', gate: publicGate, pick, prob }, total: closed('total_pending'), players: closed('players_pending'), combos: closed('combos_pending') },
  events: [{ ...oldGame, prediction: { pick, prob }, markets: { winner: { state: 'public', gate: publicGate, pick, prob }, total: closed('total_pending'), players: closed('players_pending'), combos: closed('combos_pending') } }],
  top2: [{ state: 'public', gate: publicGate, pick, prob, market: 'winner' }],
});
const learningDoc = (updatedAt) => ({
  schema: 'aa_sport_learning_v1', sport: 'wnba', updated_at: updatedAt, state: 'training',
  gate: publicGate, historical: { n: 200, accuracy: .6, brier: .22 }, forward: { n: 200, dates: 30 },
  learning_es: ['Lectura medida.'], learning_en: ['Measured reading.'],
});

let phase = 'old';
const requestCount = new Map();
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function installMocks(page) {
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    requestCount.set(path, (requestCount.get(path) || 0) + 1);
    if (path === '/v1/me') return json(route, { enabled: false, user: null });
    if (path === '/v1/mlb/today') return json(route, {
      sport: 'mlb', date, updated_at: newUpdatedAt, events: [publicMlb, privateMlb, contradictoryMlb, xssMlb], record: null,
      publication: { state: 'published', predictions: 4, checked_at: newUpdatedAt },
    });
    if (path === '/v1/mlb/live') return json(route, { sport: 'mlb', date, games: [] });
    if (path === '/v1/mlb/standings') return json(route, { sport: 'mlb', sections: [] });
    if (path === '/v1/wnba/live') return json(route, { sport: 'wnba', games: ['old', 'closed'].includes(phase) ? [oldGame] : [] });
    if (path === '/v1/wnba/today') return json(route, phase === 'closed'
      ? {
        sport: 'wnba', date, updated_at: newUpdatedAt, metadata: { publication: { state: 'closed' } }, events: [], top2: [],
        markets: { winner: { state: 'public', gate: publicGate, pick: 'SECRET_US_MARKET', prob: .99,
          sample: { n: 4, dates: 2, min_forward: 200 } } },
      }
      : phase === 'old' ? modelDoc('NY', .61, oldUpdatedAt) : modelDoc('MIN', .64, newUpdatedAt));
    if (path === '/v1/wnba/learning') return json(route, learningDoc(phase === 'old' ? oldUpdatedAt : newUpdatedAt));
    if (path === '/v1/wnba/recent') {
      if (phase === 'fail') return json(route, { error: 'forced_recent_failure' }, 500);
      return json(route, { sport: 'wnba', updated_at: newUpdatedAt, games: [{ ...oldGame, _recent: true }] });
    }
    if (path === '/v1/wnba/summary') return json(route, { ok: true, sport: 'wnba', updated_at: phase === 'old' ? oldUpdatedAt : newUpdatedAt, venue: { name: phase === 'old' ? 'OLD SUMMARY' : 'NEW SUMMARY' } });
    if (path === '/v1/wnba/standings') return json(route, { sport: 'wnba', sections: [] });
    if (path === '/v1/wnba/pipeline-health') return json(route, { schema: 'aa-basketball-producer-health-v1', sport: 'wnba', state: 'active' });
    if (path === '/v1/intelligence/today') return json(route, { version: 'intelligence_v2', state: 'fresh', slate: [], market_bundles: [] });
    if (path === '/v1/injuries') return json(route, {});
    if (path.endsWith('/standings')) return json(route, { sections: [] });
    if (path.endsWith('/live') || path.endsWith('/recent')) return json(route, { games: [] });
    if (path.endsWith('/today')) return json(route, { events: [], top2: [] });
    return json(route, {});
  });
  await page.route(/^https:\/\/(a\.espncdn\.com|img\.mlbstatic\.com|midfield\.mlbstatic\.com)\//, (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }));
}

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
await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
const base = `http://127.0.0.1:${server.address().port}`;
const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const launch = { headless: true };
if (engine === 'chromium' && executable && existsSync(executable)) launch.executablePath = executable;
const browser = await playwright[engine].launch(launch);

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'es-ES', timezoneId: 'America/New_York', serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource: the server responded with a status of 500/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });
  await installMocks(page);
  await page.goto(`${base}/?s=mlb`, { waitUntil: 'domcontentloaded' });
  await page.locator('.mrow[data-id="public-1"]').waitFor();

  const publicText = await page.locator('.mrow[data-id="public-1"]').textContent();
  assert.match(publicText, /57%/, 'a valid public prediction disappeared');
  assert.doesNotMatch(documentText(await page.locator('body').textContent()), /SECRET|99%/, 'private or closed prediction leaked');
  assert.equal(await page.locator('img[src="x"]').count(), 0, 'malicious prob_pct created an image');
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'malicious prob_pct executed script');
  assert.equal(await page.locator('#tk').textContent().then((text) => /SECRET|99%/.test(text)), false, 'ticker leaked a private prediction');
  assert.equal(await page.locator('.topsignals').allTextContents().then((items) => /SECRET|99%/.test(items.join(' '))), false, 'Top signals leaked a private prediction');

  const nestedGateResult = await page.evaluate(() => {
    const greenGate = { state: 'public', public: true, passed: true, approved: true };
    const redGate = { state: 'closed', public: false, passed: false, approved: false };
    const publicBlock = { state: 'public', gate: greenGate };
    let tooDeep = { state: 'closed' };
    for (let index = 0; index < 13; index += 1) tooDeep = { metadata: tooDeep };
    const selfAuthorized = { state: 'public', gate: greenGate, pick: 'INNER_SECRET', prob: .99 };
    const validMlb = withMlbPredictionContracts([{ prediction: { pick: 'SAFE', prob: .6 } }], 'mlb_public_today', { publication: { state: 'published' } })[0].prediction;
    const closedMlb = withMlbPredictionContracts([{ prediction: { pick: 'SECRET_DOC', prob: .99 } }], 'mlb_public_today', { publication: { state: 'closed' } })[0].prediction;
    const missingMlb = withMlbPredictionContracts([{ prediction: { pick: 'SECRET_MISSING_DOC', prob: .99 } }], 'mlb_public_today', {})[0].prediction;
    const closedSoccer = soccerPredictionDoc({ publication: { state: 'closed' }, by_id: { x: { pick: 'SECRET_SOCCER_DOC', prob: .99 } } });
    const closedMlbInnerPublic = withMlbPredictionContracts([{ prediction: selfAuthorized }], 'mlb_public_today', { publication: { state: 'closed' } })[0].prediction;
    const rootClosedMlb = withMlbPredictionContracts([{ prediction: selfAuthorized }], 'mlb_public_today', { state: 'closed' })[0].prediction;
    const wrappedClosedMlb = withMlbPredictionContracts([{ prediction: selfAuthorized }], 'mlb_public_today', { metadata: { publication: { state: 'closed' } } })[0].prediction;
    const gateOnlyMlb = withMlbPredictionContracts([{ prediction: selfAuthorized }], 'mlb_public_today', { gate: greenGate })[0].prediction;
    const nestedPayloadMlb = withMlbPredictionContracts([{ prediction: selfAuthorized }], 'mlb_public_today', { data: { events: [{ publication: { state: 'published' } }] } })[0].prediction;
    const closedSoccerInnerPublic = soccerPredictionDoc({ publication: { state: 'closed' }, by_id: { x: selfAuthorized } });
    const rootClosedSoccer = soccerPredictionDoc({ state: 'closed', by_id: { x: selfAuthorized } });
    const wrappedClosedSoccer = soccerPredictionDoc({ metadata: { publication: { state: 'closed' } }, by_id: { x: selfAuthorized } });
    const savedSport = sport, savedDoc = sportModelDocs.get('wnba');
    sport = 'wnba'; sportModelDocs.set('wnba', { metadata: { publication: { state: 'closed' } }, top2: [selfAuthorized] });
    const closedTop2 = top2Banner();
    if (savedDoc) sportModelDocs.set('wnba', savedDoc); else sportModelDocs.delete('wnba');
    sport = savedSport;
    return {
      outerClosed: gatedPrediction({ state: 'public', gate: greenGate, pick: 'SECRET_OUTER_CLOSED', prob: .99 }, { state: 'closed', gate: redGate }),
      innerPrivate: gatedPrediction({ state: 'private', gate: redGate, pick: 'SECRET_INNER_PRIVATE', prob: .99 }, { state: 'public', gate: greenGate }),
      outerContradictory: gatedPrediction({ pick: 'SECRET_OUTER_FLAGS', prob: .99 }, { state: 'public', status: 'closed', private: true, gate: greenGate }),
      innerFailedGate: gatedPrediction({ state: 'public', gate: { state: 'public', public: true, passed: false, approved: false }, pick: 'SECRET_INNER_GATE', prob: .99 }, publicBlock),
      nestedAa: predictionIsPublic({ selection_scope: 'aa_public', probability: { value: .6 }, aa: { prob: .6, public_gate: true, status: 'closed', private: true } }),
      nestedMarket: predictionIsPublic({ selection_scope: 'market_fact', probability: { value: .6 }, market_pick: { prob: .6, public_fact: true, status: 'closed', private: true } }),
      deepAa: predictionIsPublic({ selection_scope: 'aa_public', probability: { value: .6 }, aa: { prob: .6, public_gate: true, publication: { status: 'closed', private: true } } }),
      inheritedPublication: predictionIsPublic({ state: 'public', gate: greenGate, prob: .6, publication: { metadata: { status: 'closed' } } }),
      depthOverflow: predictionIsPublic({ state: 'public', gate: greenGate, prob: .6, publication: tooDeep }),
      measuredOuterState: measuredMarketBlock({ state: 'public', status: 'closed', private: true, gate: greenGate }, 'winner').state,
      closedEvidence: closedMarketEvidence({ winner: { state: 'public', gate: greenGate,
        pick: 'SECRET_EVIDENCE', prob: .99, items: [{ pick: 'SECRET_ITEM' }],
        sample: { n: null, dates: false, min_forward: '', graded: 4 } } }).winner,
      deepOuter: gatedPrediction({ pick: 'SECRET_DEEP_OUTER', prob: .9 }, { state: 'public', gate: greenGate, publication: { state: 'closed' } }),
      privateItemsMarkup: publicMarketItems({ ...publicBlock, items: [{ state: 'private', pick: 'SECRET_PRIVATE_ITEM', prob: .98 }] }),
      deepItemsMarkup: publicMarketItems({ ...publicBlock, items: [{ publication: { state: 'private' }, pick: 'SECRET_DEEP_ITEM', prob: .9 }] }),
      validMlb: predictionIsPublic(validMlb), closedMlb: predictionIsPublic(closedMlb), missingMlb: predictionIsPublic(missingMlb),
      closedSoccer: predictionIsPublic(closedSoccer.by_id.x),
      closedMlbInnerPublic: predictionIsPublic(closedMlbInnerPublic), rootClosedMlb: predictionIsPublic(rootClosedMlb),
      wrappedClosedMlb: predictionIsPublic(wrappedClosedMlb), gateOnlyMlb: predictionIsPublic(gateOnlyMlb), nestedPayloadMlb: predictionIsPublic(nestedPayloadMlb),
      closedSoccerInnerPublic: predictionIsPublic(closedSoccerInnerPublic.by_id.x), rootClosedSoccer: predictionIsPublic(rootClosedSoccer.by_id.x),
      wrappedClosedSoccer: predictionIsPublic(wrappedClosedSoccer.by_id.x),
      closedTop2,
    };
  });
  assert.equal(nestedGateResult.outerClosed, null, 'a closed outer market did not dominate an internally public prediction');
  assert.equal(nestedGateResult.innerPrivate, null, 'a public outer market overwrote an internally private prediction');
  assert.equal(nestedGateResult.outerContradictory, null, 'contradictory outer publication flags were accepted');
  assert.equal(nestedGateResult.innerFailedGate, null, 'a failed inner gate was overwritten by an outer public gate');
  assert.equal(nestedGateResult.nestedAa, false, 'nested AA private/closed state was ignored');
  assert.equal(nestedGateResult.nestedMarket, false, 'nested market private/closed state was ignored');
  assert.equal(nestedGateResult.deepAa, false, 'deep nested AA publication state was ignored');
  assert.equal(nestedGateResult.inheritedPublication, false, 'publication metadata lost its sensitive context');
  assert.equal(nestedGateResult.depthOverflow, false, 'publication traversal failed open after its depth limit');
  assert.equal(nestedGateResult.measuredOuterState, 'closed', 'measured market ignored contradictory outer state');
  assert.deepEqual(nestedGateResult.closedEvidence, {
    state: 'closed', gate: { state: 'closed', passed: false, approved: false, public: false, reason: 'winner_forward_validation_pending' },
    sample: { graded: 4 },
  }, 'closed market evidence retained private values or converted missing counts to zero');
  assert.equal(nestedGateResult.deepOuter, null, 'deep outer publication state was ignored');
  assert.doesNotMatch(nestedGateResult.privateItemsMarkup, /SECRET_PRIVATE_ITEM/, 'private market item rendered inside a public block');
  assert.doesNotMatch(nestedGateResult.deepItemsMarkup, /SECRET_DEEP_ITEM/, 'deep private market item rendered inside a public block');
  assert.equal(nestedGateResult.validMlb, true, 'valid document-level MLB publication was rejected');
  assert.equal(nestedGateResult.closedMlb, false, 'closed MLB document authorized a prediction');
  assert.equal(nestedGateResult.missingMlb, false, 'missing MLB publication contract authorized a prediction');
  assert.equal(nestedGateResult.closedSoccer, false, 'closed Soccer document authorized a prediction');
  assert.equal(nestedGateResult.closedMlbInnerPublic, false, 'closed MLB document let an inner prediction self-authorize');
  assert.equal(nestedGateResult.rootClosedMlb, false, 'closed MLB root let an inner prediction self-authorize');
  assert.equal(nestedGateResult.wrappedClosedMlb, false, 'wrapped MLB publication authority was discarded');
  assert.equal(nestedGateResult.gateOnlyMlb, false, 'a green gate replaced the required MLB document publication');
  assert.equal(nestedGateResult.nestedPayloadMlb, false, 'an event publication was promoted to MLB document authority');
  assert.equal(nestedGateResult.closedSoccerInnerPublic, false, 'closed Soccer document let an inner prediction self-authorize');
  assert.equal(nestedGateResult.rootClosedSoccer, false, 'closed Soccer root let an inner prediction self-authorize');
  assert.equal(nestedGateResult.wrappedClosedSoccer, false, 'wrapped Soccer publication authority was discarded');
  assert.doesNotMatch(nestedGateResult.closedTop2, /INNER_SECRET|99%/, 'closed US document leaked a Top 2 item');

  phase = 'closed';
  await page.evaluate(async () => {
    await setSport('wnba');
    otherSel = 'wnba-1';
    renderOtherDetail();
  });
  const closedUsDetail = await page.locator('#dcard').textContent();
  assert.doesNotMatch(closedUsDetail, /SECRET_US_MARKET|99%/, 'closed US document leaked fallback markets in the integrated detail render');
  assert.match(closedUsDetail, /4\s*\/\s*200/, 'closed US document lost safe, non-authorizing sample evidence');
  phase = 'old';
  await page.evaluate(() => setSport('mlb'));

  await page.evaluate(() => {
    delete window.__soccerXss;
    delete window.__centralXss;
    const soccerProbe = document.createElement('div');
    soccerProbe.id = 'soccer-security-probe';
    document.body.appendChild(soccerProbe);
    soccerPreds = {
      n_test: 100,
      backtest: [{ tier: '</b><img id="soccer-xss" src=x onerror="window.__soccerXss=1"><b>', hit: 55 }],
      record: { n: 1, w: 1, l: 0, wr: 1 },
    };
    soccerProbe.innerHTML = soccerHonestyHtml();

    const centralProbe = document.createElement('div');
    centralProbe.id = 'central-security-probe';
    document.body.appendChild(centralProbe);
    radarDoc = {
      state: 'fresh',
      slate: [{
        id: 'central-xss', selection_scope: 'aa_public', aa: { prob: .61, public_gate: true },
        probability: { value: .61 }, pick: 'SAFE', away: { code: 'AWY', name: 'Away' }, home: { code: 'HME', name: 'Home' },
        context: { spread: '</b><img id="central-xss" src=x onerror="window.__centralXss=1"><b>' },
        consensus: { state: 'agree', anomalies: [] }, reasons: [],
      }],
    };
    radarSel = 'central-xss';
    centralProbe.innerHTML = centralDetailHtml();

    const tennisProbe = document.createElement('div');
    tennisProbe.id = 'tennis-security-probe';
    document.body.appendChild(tennisProbe);
    const tennisPayload = '</td><img id="tennis-xss" src=x onerror="window.__tennisXss=1"><td>';
    tennisProbe.innerHTML = tennisSetline({
      away: { name: 'Away', setscore: [{ g: tennisPayload, tb: tennisPayload }] },
      home: { name: 'Home', setscore: [{ g: 6, tb: 1 }] },
    });
    window.__tennisSetsText = tennisSetsText([6, tennisPayload]);
    tennisProbe.innerHTML += playerCard({ name: 'Player', starts: tennisPayload, era_recent: 2, fip: 3, k9: 9 }, 'Starter');

    const remainingProbe = document.createElement('div');
    remainingProbe.id = 'remaining-security-probe';
    document.body.appendChild(remainingProbe);
    const remainingPayload = '</span><img id="remaining-xss" src=x onerror="window.__remainingXss=1"><span>';
    remainingProbe.innerHTML = cmpRow('Metric', remainingPayload, 1)
      + externalPredictorHtml({ predictor: { away_pct: remainingPayload, home_pct: 55 } }, { away: { name: 'Away' }, home: { name: 'Home' } })
      + previousFormHtml({ recent: { away: { wins: remainingPayload, losses: 1, win_pct: 50, games: [{ result: remainingPayload, score: '1-0' }] } } }, { away: { name: 'Away' }, home: { name: 'Home' } });
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#soccer-xss, #central-xss, #tennis-xss, #remaining-xss').count(), 0, 'API payload created executable markup in a dynamic numeric sink');
  assert.deepEqual(await page.evaluate(() => ({ soccer: window.__soccerXss, central: window.__centralXss, tennis: window.__tennisXss, remaining: window.__remainingXss, sets: window.__tennisSetsText })),
    { soccer: undefined, central: undefined, tennis: undefined, remaining: undefined, sets: '' }, 'API payload executed script or survived numeric validation');
  await page.evaluate(() => {
    document.querySelector('#soccer-security-probe')?.remove();
    document.querySelector('#central-security-probe')?.remove();
    document.querySelector('#tennis-security-probe')?.remove();
    document.querySelector('#remaining-security-probe')?.remove();
    soccerPreds = null;
    radarDoc = null;
    radarSel = null;
  });

  const mlbLegacyXss = await page.evaluate(async () => {
    const payload = '</b><img id="mlb-legacy-xss" src=x onerror="window.__mlbLegacyXss=(window.__mlbLegacyXss||0)+1"><b>';
    const saved = { events, selectedId, dtab, lastRec, todayRecord, simDoc, learningDoc, sport, radarDoc, liveByKey, todayDate, viewDate };
    delete window.__mlbLegacyXss;
    lastRec = { wins: payload, losses: 1, win_rate: .5 };
    renderRecord();
    todayRecord = {
      wins: payload, losses: 1, win_rate: .5,
      locks: { wins: payload, losses: 1, win_rate: .5 },
      gems: { wins: payload, losses: 1, win_rate: .5 },
    };
    const base = events.find(event => event.event_id === 'public-1');
    const hostile = {
      ...base, event_id: 'mlb-hostile', prediction: withPredictionContract({ ...base.prediction }, 'mlb_public_today'),
      snapshot: {
        bats: { away: { label: 'hot', l5_rpg: payload, season_rpg: payload, delta: payload } },
        hitters: { away: [{ name: 'Safe hitter', ops: payload, hr: payload, avg: payload }] },
        lineups: { away: [{ name: 'Safe lineup', order: payload, ops: payload, hr: payload, avg: payload }] },
        pitchers: { away: { name: 'Safe pitcher', starts: payload, era_recent: payload, fip: payload, k9: payload } },
        context: { streak_away: 3 }, form: { away: [] },
        wp: [{ wp: .5 }, { wp: .6, half: 'T', inn: payload }],
        total: { aa_total: payload, line: payload },
      },
    };
    events = [hostile]; selectedId = hostile.event_id;
    for (const tab of ['equipos', 'bateadores', 'analisis']) { dtab = tab; renderDetail(); await new Promise(resolve => setTimeout(resolve, 0)); }
    todayDate = etTodayClient(); viewDate = null;
    liveByKey = new Map([[key(hostile.away.code, hostile.home.code), [{
      date: todayDate, start: hostile.start, status: 'live',
      away: { code: hostile.away.code, score: 0 }, home: { code: hostile.home.code, score: 0 },
      situation: { balls: payload, strikes: payload, outs: payload },
    }]]]);
    dtab = 'analisis'; renderDetail();
    liveByKey = new Map();
    dtab = 'sim'; renderDetail();
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    radarDoc = { state: 'fresh', slate: [] };
    simDoc = {
      oos: { combined: { acc: payload } }, delta_ll: { helps: true },
      selection: [{ n: 30, thr: payload, rate: payload, roi: payload }],
      market: { model_acc: payload, market_acc: 55 },
      n_games: payload, n_oos: payload, ece: payload,
      first_date: 'safe', last_date: 'safe',
    };
    probe.innerHTML = boletoHtml() + jornadaHtml() + centralListHtml() + simCard()
      + calChart([{ date: payload, gap: 1 }, { date: 'safe', gap: 2 }]);
    learningDoc = {
      n_graded: payload, first_date: 'safe', attribution: '',
      cal: { gap: payload }, market: { model_acc: payload, market_acc: 55 },
      state_es: [], state_en: [], signals: [{ label: 'safe', edge_pp: payload }],
      history: [{ date: payload, gap: 1 }, { date: 'safe', gap: 2 }], log: [],
    };
    sport = 'mlb';
    renderBrain();
    await new Promise(resolve => setTimeout(resolve, 0));
    const result = { executed: window.__mlbLegacyXss, node: !!document.querySelector('#mlb-legacy-xss') };
    ({ events, selectedId, dtab, lastRec, todayRecord, simDoc, learningDoc, sport, radarDoc, liveByKey, todayDate, viewDate } = saved);
    probe.remove();
    renderRecord(); renderList(); renderDetail();
    return result;
  });
  assert.deepEqual(mlbLegacyXss, { executed: undefined, node: false }, 'legacy MLB record/detail templates executed API markup');

  const crossLeagueBanner = await page.evaluate(() => {
    otherSnapshotMeta = { key: 'soccer:eng.1:public', updatedAt: new Date(Date.now() - 97 * 60000).toISOString() };
    markOtherSnapshotStale('soccer:esp.1:public');
    const text = document.querySelector('#otherRefreshBanner')?.textContent || '';
    otherSnapshotMeta = null;
    clearOtherSnapshotStale();
    return text;
  });
  assert.doesNotMatch(crossLeagueBanner, /97/, 'stale banner reused the age of another league');

  await page.locator('.sp[data-sport="wnba"]').click();
  await page.locator('.mrow[data-oid="wnba-1"]').waitFor();
  assert.match(await page.locator('#list').textContent(), /NY[\s\S]*61%/, 'initial model snapshot missing');
  await page.locator('.mrow[data-oid="wnba-1"] .mrowlink').click();
  await page.locator('#dcard .market-tab[data-market-kind="winner"]').waitFor();
  await page.waitForFunction(() => /OLD SUMMARY/.test(document.querySelector('#dcard')?.textContent || ''));
  await page.waitForFunction(() => sportLearningPromises.size === 0 && sportLearningLoading.size === 0);
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  await page.evaluate(() => {
    const game = otherGames.find((item) => String(item.espn_id) === 'wnba-1');
    const originalFetch = window.fetch;
    let releaseSummary;
    const summaryGate = new Promise((resolve) => { releaseSummary = resolve; });
    window.__releaseSummary = releaseSummary;
    window.__restoreSummaryFetch = () => { window.fetch = originalFetch; delete window.__restoreSummaryFetch; delete window.__releaseSummary; };
    window.fetch = async (url, options) => {
      if (String(url).includes('/v1/wnba/summary')) {
        await summaryGate;
        return { ok: true, json: async () => { window.__summaryConsumed = (window.__summaryConsumed || 0) + 1; return { ok: true, venue: { name: 'NEW_PARTIAL_SUMMARY' } }; } };
      }
      return originalFetch(url, options);
    };
    summaryCache.delete(summaryKey(game));
    loadSummary(game);
  });
  await page.locator('#dcard .market-tab[data-market-kind="winner"]').focus();
  await page.evaluate(() => { document.querySelector('#detail').scrollTop = 120; window.scrollTo(0, 32); });
  const before = await page.evaluate(() => ({
    url: location.href, historyLength: history.length, activeMarket: document.activeElement?.dataset?.marketKind || '',
    windowScroll: window.scrollY, detailScroll: document.querySelector('#detail')?.scrollTop || 0,
  }));
  await page.evaluate(() => {
    window.__staleAnnouncements = 0;
    const banner = document.querySelector('#otherRefreshBanner');
    new MutationObserver(() => { window.__staleAnnouncements += 1; }).observe(banner, { childList: true, characterData: true, subtree: true });
  });

  phase = 'fail';
  await page.evaluate(async () => { await loadOther(); });
  const focusAfterFailedRefresh = await page.evaluate(() => document.activeElement?.dataset?.marketKind || '');
  await page.evaluate(() => window.__releaseSummary());
  await page.waitForTimeout(100);
  const afterFailure = await page.evaluate(() => ({
    url: location.href, historyLength: history.length, activeMarket: document.activeElement?.dataset?.marketKind || '',
    windowScroll: window.scrollY, detailScroll: document.querySelector('#detail')?.scrollTop || 0,
    banner: document.querySelector('#otherRefreshBanner')?.textContent || '',
  }));
  assert.deepEqual(afterFailure.url, before.url, 'failed refresh changed the URL');
  assert.equal(afterFailure.historyLength, before.historyLength, 'failed refresh changed history length');
  assert.equal(focusAfterFailedRefresh, before.activeMarket, 'failed refresh moved focus');
  assert.equal(afterFailure.windowScroll, before.windowScroll, 'failed refresh changed page scroll');
  assert.equal(afterFailure.detailScroll, before.detailScroll, 'failed refresh changed detail scroll');
  assert.match(afterFailure.banner, /atrasad|stale|actualiz/i, 'failed refresh did not expose stale state');
  assert.match(afterFailure.banner, /12|última|last/i, 'stale state lacks age or timestamp');
  assert.match(await page.locator('#dcard').textContent(), /NY[\s\S]*61%[\s\S]*OLD SUMMARY/, 'failed refresh replaced the prior snapshot');
  assert.doesNotMatch(await page.locator('body').textContent(), /MIN[\s\S]*64%|NEW SUMMARY/, 'failed refresh installed part of the new snapshot');
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify([...summaryCache.values()])), /NEW_PARTIAL_SUMMARY/, 'a late summary created a hybrid after the core refresh failed');
  assert.equal(await page.evaluate(() => window.__summaryConsumed || 0), 0, 'a stale summary body was consumed after navigation/refresh invalidated it');
  await page.evaluate(() => window.__restoreSummaryFetch());
  await page.evaluate(async () => { await loadOther(); });
  assert.equal(await page.evaluate(() => window.__staleAnnouncements), 1, 'same failed refresh was announced more than once');

  phase = 'success';
  await page.locator('#dcard .market-tab[data-market-kind="winner"]').focus();
  await page.evaluate(() => { document.querySelector('#detail').scrollTop = 96; window.scrollTo(0, 24); });
  const beforeSuccess = await page.evaluate(() => ({
    activeMarket: document.activeElement?.dataset?.marketKind || '', windowScroll: window.scrollY,
    detailScroll: document.querySelector('#detail')?.scrollTop || 0, historyLength: history.length, url: location.href,
  }));
  await page.evaluate(async () => { await loadOther(); });
  await page.waitForFunction(() => document.querySelector('#otherRefreshBanner')?.hidden === true);
  const afterSuccess = await page.evaluate(() => ({
    activeMarket: document.activeElement?.dataset?.marketKind || '', windowScroll: window.scrollY,
    detailScroll: document.querySelector('#detail')?.scrollTop || 0, historyLength: history.length, url: location.href,
  }));
  assert.deepEqual(afterSuccess, beforeSuccess, 'successful refresh changed route, history, focus, or scroll');
  assert.match(await page.locator('#list').textContent(), /MIN[\s\S]*64%/, 'successful refresh did not atomically install the new model snapshot');
  assert.doesNotMatch(await page.locator('#list').textContent(), /NY[\s\S]*61%/, 'successful refresh retained the old model snapshot');

  const qaRace = await page.evaluate(async () => {
    const originalFetch = window.fetch;
    let releaseQa;
    const qaResponse = new Promise((resolve) => { releaseQa = resolve; });
    sport = 'wnba';
    qaMode = true;
    sportLearningDocs.clear();
    sportLearningAt.clear();
    sportLearningLoading.clear();
    sportLearningPromises.clear();
    window.fetch = async (url, options) => {
      if (String(url).includes('/v1/qa/wnba/learning')) {
        await qaResponse;
        return new Response(JSON.stringify({ qa: true, learning_es: ['QA_SECRET_CACHE'] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('/v1/wnba/pipeline-health')) {
        return new Response(JSON.stringify({ schema: 'aa-basketball-producer-health-v1', sport: 'wnba', state: 'active' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(url, options);
    };
    const pending = loadLearning();
    await new Promise((resolve) => setTimeout(resolve, 0));
    qaMode = false;
    resetOtherAudienceState();
    releaseQa();
    await pending;
    window.fetch = originalFetch;
    return {
      cached: JSON.stringify(sportLearningDocs.get('wnba') || null),
      pending: sportLearningPromises.has('wnba'),
      loading: sportLearningLoading.has('wnba'),
    };
  });
  assert.doesNotMatch(qaRace.cached, /QA_SECRET_CACHE/, 'a pending QA request repopulated the public learning cache after logout');
  assert.equal(qaRace.pending, false, 'a stale QA learning promise survived the audience reset');
  assert.equal(qaRace.loading, false, 'a stale QA loading marker survived the audience reset');
  assert.deepEqual(errors, [], `application errors: ${errors.join('\n')}`);
  assert.ok((requestCount.get('/v1/wnba/recent') || 0) >= 3, 'transactional refresh sequence did not exercise /recent');
  await context.close();
  console.log(`match hierarchy security UI (${engine}): fail-closed, XSS and atomic refresh passed`);
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

function documentText(value) {
  return String(value || '').replace(/\s+/g, ' ');
}
