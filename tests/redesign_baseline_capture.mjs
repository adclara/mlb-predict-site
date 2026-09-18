// Baseline visual Fase 0 (rediseño Matchday Studio → producción).
// Captura screenshots de las vistas principales de cloudflare/pages/index.html
// con la API /v1/* mockeada (fixtures mínimas pero representativas), en
// desktop 1440×900 y móvil 390×844 / 360×800. Reporta errores de consola de
// la app y overflow horizontal por viewport.
//
// NO corre asserts de contenido: es una captura de referencia para comparar
// fases del rediseño. Sale con código 1 si hay errores de consola u overflow.
//
// Uso:
//   NODE_PATH=pw-tools/node_modules PLAYWRIGHT_BROWSERS_PATH=pw-tools/browsers \
//     node tests/redesign_baseline_capture.mjs

import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../cloudflare/pages');
// Por defecto escribe la baseline canónica; con AA_CAPTURE_OUT apunta a otra
// carpeta (p. ej. docs/redesign/fase-2) sin tocar baseline/.
const OUT = resolve(HERE, process.env.AA_CAPTURE_OUT || '../docs/redesign/baseline');
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
const today = etToday();

/* ── fixtures ─────────────────────────────────────────────────────────── */

function mlbEvent(id, away, home, start, pct, badges) {
  return {
    sport: 'mlb', league: 'MLB', event_id: id, matchup: `${away.code} @ ${home.code}`,
    start, status: 'pre', away, home,
    prediction: { pick: home.code, prob: pct / 100, prob_pct: pct, confidence: 'alta' },
    metrics: [{ key: 'metric_prob_cal', label: 'Prob. AA calibrada', value: `${pct}%`, kind: 'pct' }],
    snapshot: {
      fielding: { away: { err_l10: 3, epg: 0.3, g: 10 }, home: { err_l10: 6, epg: 0.6, g: 10 } },
      context: { series: { game: 2, len: 3, home_wins: 1, away_wins: 0 } },
      total: { lean: 'over', line: 8.5, aa_total: 9.1, prob_pct: 55 },
      pitchers: {
        away: { name: 'A. Visitor', id: 660271, hand: 'R', era: 3.85 },
        home: { name: 'H. Starter', id: 605400, hand: 'L', era: 3.12 },
      },
    },
    risk: { level: 'bajo', score: 18, coverage: 1 }, odds: null,
    badges, result: null, final: null,
    top_signal: { event_id: id, rank: 1, basis: 'calibrated_probability', verified: true },
  };
}

const MLB_EVENTS = [
  mlbEvent('g1', { code: 'MIN', name: 'Minnesota Twins' }, { code: 'CLE', name: 'Cleveland Guardians' }, `${today}T22:40:00Z`, 57, ['fijo', 'oro']),
  mlbEvent('g2', { code: 'NYY', name: 'New York Yankees' }, { code: 'BOS', name: 'Boston Red Sox' }, `${today}T23:10:00Z`, 61, ['gema']),
  mlbEvent('g3', { code: 'LAD', name: 'Los Angeles Dodgers' }, { code: 'SF', name: 'San Francisco Giants' }, `${today}T01:15:00Z`, 54, []),
];
// El juego en vivo lleva historial de win probability para la curva del detalle.
MLB_EVENTS[2].snapshot.wp = [
  { wp: 0.5 }, { wp: 0.52, half: 'Top', inn: 1 }, { wp: 0.48, half: 'Bot', inn: 1 },
  { wp: 0.55, half: 'Top', inn: 3 }, { wp: 0.6, half: 'Bot', inn: 4 }, { wp: 0.58, half: 'Bot', inn: 5 },
];

const MLB_LIVE = [{
  espn_id: 'g3-live', date: today, start: `${today}T01:15:00Z`, status: 'live',
  status_detail: 'Bot 5th',
  away: { code: 'LAD', score: 3, rec: null }, home: { code: 'SF', score: 2, rec: null },
  period: 5, situation: null, win_prob_home: 0.42,
}];

const MLB_STANDINGS = {
  sport: 'mlb', season: '2026',
  sections: ['AL Este', 'AL Central'].map((name, s) => ({
    name,
    rows: [
      { rank: 1, code: s ? 'CLE' : 'NYY', name: s ? 'Cleveland Guardians' : 'New York Yankees', w: 88, l: 54, pct: '.620', gb: '—' },
      { rank: 2, code: s ? 'MIN' : 'BOS', name: s ? 'Minnesota Twins' : 'Boston Red Sox', w: 80, l: 62, pct: '.563', gb: '8.0' },
    ],
  })),
};

const GATES_CLOSED = {
  winner: { passed: false, approved: false, public: false, reason: 'forward_sample_pending' },
  total: { passed: false, approved: false, public: false, reason: 'market_lines_unavailable' },
  players: { passed: false, approved: false, public: false, reason: 'market_lines_unavailable' },
  combos: { passed: false, approved: false, public: false, reason: 'individual_markets_not_public' },
};

const LEARNING_SHADOW = {
  schema: 'aa_sport_learning_v1', updated_at: `${today}T12:00:00Z`, state: 'training', model_scope: 'shadow',
  gate: { passed: false, approved: false, public: false, reason: 'forward_sample_pending', min_forward: 200, min_dates: 30 },
  historical: { n: 1091, accuracy: 0.663, brier: 0.2132, logloss: 0.616, ece: 0.034 },
  forward: { n: 37, dates: 12, wins: 0, losses: 0, accuracy: null },
  learning_es: ['Modelo en sombra: métricas históricas medidas. El gate permanece cerrado.'],
  learning_en: ['Shadow model: measured historical metrics. The gate remains closed.'],
  attribution_es: 'Métricas medidas con validación cronológica.', attribution_en: 'Metrics measured with chronological validation.',
};

const INTELLIGENCE = {
  version: 'intelligence_v2', date: today, state: 'fresh',
  as_of: new Date().toISOString(), next_refresh: new Date(Date.now() + 1800e3).toISOString(),
  freshness: { age_minutes: 4, stale: false, hard_stale: false },
  sources: { aa: { ok: true }, books: { ok: true }, polymarket: { ok: true, markets: 2 }, kalshi: { ok: true, markets: 2 } },
  slate: [
    { id: 'mlb:g2', sport: 'mlb', event_id: 'g2', start: `${today}T23:10:00Z`, market: 'winner', pick: 'BOS', selection_scope: 'aa_public',
      home: { code: 'BOS', name: 'Boston Red Sox' }, away: { code: 'NYY', name: 'New York Yankees' },
      probability: { value: 0.61, kind: 'aa_calibrated' }, aa: { prob: 0.61, engine: 'v2', public_gate: true },
      books: { prob: 0.59, n: 3, disagreement: 0.02 },
      polymarket: { matched: true, prob: 0.6, bid: 0.59, ask: 0.61, spread: 0.02, volume_24h: 12000 },
      kalshi: { matched: true, prob: 0.6, bid: 0.59, ask: 0.62, spread: 0.03, volume_24h: 8000 },
      consensus: { state: 'agree', market_prob: 0.6, anomalies: [] },
      context: { form: { home: [{ w: true, opp: 'NYY', score: '5-2' }], away: [{ w: false, opp: 'BOS', score: '2-5' }] },
        pitchers: { home: { name: 'H. Starter', era_recent: 3.1 }, away: { name: 'A. Visitor', era_recent: 3.9 } } },
      reasons: [{ code: 'aa_probability', value: 0.61 }] },
    { id: 'wnba:w1', sport: 'wnba', event_id: 'w1', start: `${today + ''}T23:00:00Z`, market: 'winner', pick: 'NYL', selection_scope: 'market_fact',
      home: { code: 'NYL', name: 'New York Liberty' }, away: { code: 'CHI', name: 'Chicago Sky' },
      probability: { value: 0.76, kind: 'market_devig' },
      market_pick: { prob: 0.76, provider: 'DraftKings', price: -380, public_fact: true },
      books: { prob: 0.76, n: 1 },
      polymarket: { matched: true, prob: 0.785, bid: 0.78, ask: 0.79, spread: 0.01, volume_24h: 3400 },
      kalshi: { matched: false, reason: 'not_listed', candidates: 0 },
      consensus: { state: 'agree', market_prob: 0.785, anomalies: [] },
      context: { provider: 'DraftKings', price: -380, pick_record: { text: '23-16', wins: 23, losses: 16 }, opponent_record: { text: '15-24', wins: 15, losses: 24 } },
      reasons: [{ code: 'market_probability', value: 0.76, provider: 'DraftKings' }] },
  ],
  market_bundles: [{ bundle_id: 'mlb:g2+wnba:w1', state: 'informational', joint_prob: null, legs: [
    { id: 'mlb:g2', sport: 'mlb', event_id: 'g2', pick: 'BOS', prob: 0.61, source: 'aa_public', start: `${today}T23:10:00Z` },
    { id: 'wnba:w1', sport: 'wnba', event_id: 'w1', pick: 'NYL', prob: 0.76, source: 'market_fact', start: `${today}T23:00:00Z` },
  ] }],
  combos: { state: 'closed', gate: { passed: false, approved: false, public: false }, sample: { n: 12, dates: 5, min_forward: 100, min_dates: 30 } },
  budget: { kv_writes: 2, d1_rows: 4 }, alerts: false, telegram: false,
};

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function installApiMocks(page) {
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/v1/mlb/today') {
      return json(route, {
        sport: 'mlb', date: today,
        record: { wins: 12, losses: 8, locks: { wins: 5, losses: 3 }, gems: { wins: 7, losses: 5 } },
        events: MLB_EVENTS,
      });
    }
    if (path === '/v1/mlb/live') {
      return json(route, { sport: 'mlb', date: today, updated_at: new Date().toISOString(), games: MLB_LIVE });
    }
    if (path === '/v1/mlb/standings') return json(route, MLB_STANDINGS);
    if (path === '/v1/mlb/learning') {
      return json(route, {
        n_graded: 106, first_date: '2026-03-25', cal: {}, market: {}, history: [], log: [],
        state_es: ['Aprendizaje medido.'], state_en: ['Measured learning.'],
        signals: [{ label: 'Coincide con el favorito del mercado', label_en: 'Matches the market favorite', edge_pp: 11.5 }],
      });
    }
    if (path === '/v1/mlb/simulation') {
      return json(route, {
        n_games: 100, n_oos: 80, ece: 3.8,
        oos: { combined: { acc: 53.2, ll: 0.696, brier: 0.251 } },
        delta_ll: { helps: false },
        selection: [{ thr: 53, n: 40, rate: 55, priced_n: 0, units: null, roi: null, accuracy_signal: true, edge: false }],
        market: { model_acc: 53.7, market_acc: 56.5 },
      });
    }
    if (path === '/v1/mlb/history') return json(route, { predictions: [] });
    if (path === '/v1/injuries') return json(route, { players: [] });
    if (path === '/v1/me') return json(route, { enabled: false, user: null });
    if (path === '/v1/intelligence/today') return json(route, INTELLIGENCE);
    if (path === '/v1/soccer/today') {
      return json(route, {
        sport: 'soccer', date: today,
        by_id: { 'soc-1': { pick: 'LIV', prob: 0.57, tier: 't55', league: 'eng.1' } },
        record: { n: 3, w: 3, l: 0, wr: 1 }, backtest: [{ tier: 't55', n: 6133, hit: 67.7 }], n_test: 16059,
      });
    }
    if (path === '/v1/soccer/live') {
      return json(route, { sport: 'soccer', league: url.searchParams.get('league'), games: [{
        espn_id: 'soc-1', league: 'Premier League', start: `${today}T19:00:00Z`, status: 'pre', status_detail: 'Scheduled',
        away: { code: 'ARS', name: 'Arsenal', score: null, logo: null, rec: '0-0' },
        home: { code: 'LIV', name: 'Liverpool', score: null, logo: null, rec: '0-0' },
      }] });
    }
    if (path === '/v1/soccer/recent') return json(route, { sport: 'soccer', games: [] });
    if (path === '/v1/soccer/standings') return json(route, { sport: 'soccer', season: '2026-27', sections: [] });
    if (path === '/v1/soccer/summary') return json(route, { ok: true, sport: 'soccer', stats: [] });
    if (path === '/v1/soccer/learning') {
      return json(route, { sport: 'soccer', historical: { n: 16059, accuracy: 0.677, brier: 0.19 }, forward: { n: 3 }, gate: { public: true } });
    }
    if (path === '/v1/tennis/rankings') return json(route, { sport: 'tennis', sections: [] });
    const us = path.match(/^\/v1\/(nba|wnba|nfl|ncaaf|nhl|ncaam|tennis)\/(live|recent|standings|today|summary|learning|pipeline-health)$/);
    if (us) {
      const [, sport, action] = us;
      if (action === 'learning') return json(route, { ...LEARNING_SHADOW, sport });
      if (action === 'pipeline-health') return json(route, { schema: 'aa-basketball-producer-health-v1', sport, state: 'fresh' });
      if (action === 'standings') {
        return json(route, { sport, season: '2026', sections: [{ name: 'Conferencia', rows: [
          { rank: 1, code: 'HME', name: 'Home Team', w: 18, l: 7, pct: '.720', gb: '—' },
          { rank: 2, code: 'AWY', name: 'Away Team', w: 16, l: 9, pct: '.640', gb: '2' },
        ] }] });
      }
      if (action === 'summary') return json(route, { ok: true, sport, stats: [] });
      if (action === 'today') {
        const markets = Object.fromEntries(Object.keys(GATES_CLOSED).map(k => [k, {
          state: 'closed', gate: GATES_CLOSED[k], sample: { n: 0, dates: 0, min_forward: 200 },
        }]));
        return json(route, {
          sport, date: today, gate: GATES_CLOSED.winner, gates: GATES_CLOSED, markets,
          events: [{ event_id: `${sport}-1`, espn_id: `${sport}-1`, markets,
            market: { away_ml: 150, home_ml: -175, away_prob: 0.4, home_prob: 0.6, probability_source: 'market_devigged' } }],
          top2: [],
        });
      }
      return json(route, { sport, games: [{
        espn_id: `${sport}-1`, start: `${today}T23:00:00Z`, status: 'pre', status_detail: 'Scheduled',
        away: { code: 'AWY', name: 'Away Team', score: null, logo: null, rec: '16-9' },
        home: { code: 'HME', name: 'Home Team', score: null, logo: null, rec: '18-7' },
        market: { away_ml: 150, home_ml: -175, away_prob: 0.4, home_prob: 0.6, probability_source: 'market_devigged' },
      }] });
    }
    return json(route, {});
  });

  // Fuentes e imágenes externas: se dejan pasar si hay red (baseline con
  // tipografía/logos reales); si el entorno no tiene salida, el ruido de red
  // se filtra en collectErrors y la UI cae a sus fallbacks (iniciales).
  await page.route('https://fonts.googleapis.com/**', route =>
    route.fetch().then(r => route.fulfill({ response: r })).catch(() => route.fulfill({ status: 200, contentType: 'text/css', body: '' })));
}

function collectErrors(page) {
  const errors = [];
  const networkNoise = /ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|Failed to load resource|net::/i;
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !networkNoise.test(msg.text())) errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    const message = request.failure()?.errorText || '';
    if (!networkNoise.test(message)) errors.push(`requestfailed: ${request.url()} ${message}`);
  });
  return errors;
}

/* ── servidor estático (URL.pathname quita el query antes de comprobar '/') ── */

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
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});
await new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', ok); });
const base = `http://127.0.0.1:${server.address().port}`;

mkdirSync(OUT, { recursive: true });

const candidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux64/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = candidates.find(existsSync);

const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

const report = { date: today, base: 'cloudflare/pages/index.html', viewports: {} };
let failures = 0;

async function measureOverflow(page) {
  return page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    docClient: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth,
    bodyClient: document.body.clientWidth,
  }));
}

try {
  for (const vp of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: '390', width: 390, height: 844 },
    { name: '360', width: 360, height: 800 },
  ]) {
    const mobile = vp.width < 900;
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      locale: 'es-ES', timezoneId: 'America/New_York', serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const errors = collectErrors(page);
    await installApiMocks(page);
    const overflow = {};

    const snap = async (name) => {
      await page.waitForTimeout(350); // asienta imágenes/animaciones de entrada
      // Artefacto conocido: en desktop, clickar una fila hace scroll de página y
      // el detalle salía parcialmente de cuadro. Se normaliza el scroll antes de
      // capturar (en móvil el detalle es overlay fixed, no afecta).
      if (!mobile) await page.evaluate(() => window.scrollTo(0, 0));
      const file = join(OUT, `${name}-${vp.name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      overflow[name] = await measureOverflow(page);
      const o = overflow[name];
      if (o.docScroll > o.docClient + 1 || o.bodyScroll > o.bodyClient + 1) failures++;
      console.log(`  📸 ${name}-${vp.name}.png  overflow doc=${o.docScroll - o.docClient}px body=${o.bodyScroll - o.bodyClient}px`);
    };
    const closeMobileDetail = async () => {
      if (mobile) await page.locator('#dback').evaluate(el => el.click()).catch(() => {});
    };

    console.log(`viewport ${vp.name} (${vp.width}×${vp.height})`);

    // 1) Inicio = vista por defecto (Fase 2: home matchday-first).
    await page.goto(`${base}/?baseline=${vp.name}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.homecentral').waitFor({ state: 'visible' });
    await snap('inicio');

    // 2) Central AA (un toque desde Inicio, chip de deportes).
    await page.locator('.sp[data-sport="radar"]').click();
    await page.locator('.intelrow').first().waitFor({ state: 'visible' });
    await snap('central');

    // 3) Detalle de una jugada de la Central AA.
    await page.locator('.intelrow').first().click();
    await page.waitForFunction(() => /Polymarket|mercado/i.test(document.querySelector('#dcard')?.textContent || ''));
    await snap('central-detail');
    await closeMobileDetail();

    // 3) Lista de partidos MLB.
    await page.locator('.sp[data-sport="mlb"]').click();
    await page.locator('.mrow[data-id="g1"]').waitFor({ state: 'visible' });
    await snap('mlb-list');

    // 4) Detalle de partido MLB (hero + pestañas Studio + gates).
    await page.locator('.mrow[data-id="g1"]').click();
    await page.locator('#dcard .dhero').waitFor({ state: 'visible' });
    await snap('mlb-detail');

    // 4b) Gate cerrado diseñado: pestaña Total del comparador de mercados MLB.
    await page.locator('#dcard .market-tab[data-market-kind="total"]').click();
    await page.waitForFunction(() => /sigue en validación|under validation/i.test(document.querySelector('#dcard .market-panel')?.textContent || ''));
    await snap('mlb-gate-total');
    await page.locator('#dcard .market-tab[data-market-kind="winner"]').click();
    await closeMobileDetail();

    // 5) Filtro "En vivo" (el overlay de /v1/mlb/live marca g3 en vivo).
    await page.locator('.pill[data-f="live"]').click();
    await page.locator('.mrow[data-id="g3"]').waitFor({ state: 'visible' });
    await snap('mlb-live');

    // 5b) Detalle en vivo: marcador + WP en vivo mandan (curva + comparador ESPN).
    await page.locator('.mrow[data-id="g3"]').click();
    await page.waitForFunction(() => /ESPN/.test(document.querySelector('#dcard')?.textContent || ''));
    await snap('mlb-live-detail');
    await closeMobileDetail();
    await page.locator('.pill[data-f="all"]').click();

    // 6) Posiciones MLB.
    await page.locator('.ltab[data-lt="pos"]').click();
    await page.locator('#list .sttbl').first().waitFor({ state: 'visible' });
    await snap('mlb-standings');

    // 7) WNBA (gates cerrados + mercado factual).
    await page.locator('.sp[data-sport="wnba"]').click();
    await page.locator('.mrow[data-oid="wnba-1"]').waitFor({ state: 'visible' });
    await snap('wnba-list');

    // 7b) Detalle WNBA: superficie de mercados con gates cerrados y progreso medido.
    await page.locator('.mrow[data-oid="wnba-1"]').click();
    await page.locator('#dcard .market-first').waitFor({ state: 'visible' });
    await snap('wnba-detail');
    await closeMobileDetail();

    // 8) Soccer (única liga no-MLB con predicción pública AA).
    await page.locator('.sp[data-sport="soccer"]').click();
    await page.locator('.mrow[data-oid="soc-1"]').waitFor({ state: 'visible' });
    await snap('soccer-list');

    // 8b) Detalle soccer: Ganador público AA dentro del selector de mercados.
    await page.locator('.mrow[data-oid="soc-1"]').click();
    await page.locator('#dcard .market-first').waitFor({ state: 'visible' });
    await snap('soccer-detail');
    await closeMobileDetail();

    // 9) Estado vacío de Central AA: sin jugadas elegibles no se rellena cuota.
    //    La route registrada al final tiene prioridad sobre el mock general.
    await page.route('**/v1/intelligence/today', (route) => json(route, { ...INTELLIGENCE, slate: [], market_bundles: [] }));
    await page.goto(`${base}/?tab=radar&baseline-empty=${vp.name}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /No hay jugadas públicas elegibles|no eligible public plays/i.test(document.querySelector('#list')?.textContent || ''));
    await snap('central-empty');

    // 10) Skeleton de Inicio: /v1/mlb/today colgado a propósito (se aborta al
    //     cerrar el contexto; el ruido net:: queda filtrado en collectErrors).
    await page.route('**/v1/mlb/today', () => {});
    await page.goto(`${base}/?baseline-skel=${vp.name}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#list .skel').first().waitFor({ state: 'visible' });
    await snap('inicio-skeleton');

    report.viewports[vp.name] = { errors, overflow };
    if (errors.length) {
      failures += errors.length;
      console.log(`  ⚠️ errores de consola en ${vp.name}:`);
      for (const e of errors) console.log(`     ${e}`);
    } else {
      console.log(`  ✅ 0 errores de consola en ${vp.name}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((ok) => server.close(ok));
}

await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\nCapturas en ${OUT} · reporte: report.json`);
if (failures) {
  console.error(`❌ ${failures} problema(s): errores de consola u overflow horizontal`);
  process.exit(1);
}
console.log('✅ Baseline capturado: 0 errores de consola, sin overflow horizontal');
