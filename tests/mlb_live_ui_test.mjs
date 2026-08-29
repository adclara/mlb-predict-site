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
    prediction: { pick: 'CLE', prob: 0.57, prob_pct: 57, confidence: 'media' },
    metrics: [{ key: 'metric_prob_cal', label: 'Prob. AA calibrada', value: '57%', kind: 'pct' }], snapshot: {
      fielding: { away: { err_l10: 2, epg: 0.2, g: 10 }, home: { err_l10: 9, epg: 0.9, g: 10 } },
      context: { series: { game: 4, len: 4, home_wins: 0, away_wins: 3 } },
      total: { lean: 'over', line: 8.5, aa_total: 9.4, prob_pct: 58 },
    }, risk: null, odds: null, badges: ['oro'], result: null, final: null,
    top_signal: { event_id: id, rank: 1, basis: 'calibrated_probability', verified: true },
    run_indicator: { event_id: id, rank: 1, basis: 'projected_total_vs_market_line', market_line: 8.5, projected_runs: 9.4, delta_runs: 0.9, verified: false, status: 'observation' },
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
      pick: null, prob: null, prob_pct: null, confidence: null, engine_version: null,
      invalidated: true, invalidated_reason: 'probable_starter_changed',
    },
    snapshot: null,
    metrics: [],
    risk: null,
    badges: [],
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
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname;
    if (path === '/v1/mlb/today') {
      return json(route, {
        sport: 'mlb', date, record: null,
        run_indicator_meta: { status: 'observation', verified: false, gate_passes: false, record: { wins: 2, losses: 0, pushes: 0, sample_n: 2 } },
        events,
      });
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
    if (path === '/v1/mlb/history') return json(route, { predictions: [
      // Los dos juegos más recientes arrancan a la misma hora. La UI debe
      // tratarlos como grupo y no inventar un orden que infle la racha.
      { date, event_id: 'hist-ml-win', selection_key: 'ml|CLE||', market: 'ml', pick: 'CLE', side: null, line: null, away: 'MIN', home: 'CLE', prob: 0.57, confidence: 'oro', result: 'win', price: -120, public_play: 1, public_lock: 1, public_gem: 0, start_time: `${date}T23:10:00Z`, source_scope: 'causal_verified' },
      { date, event_id: 'hist-ml-loss', selection_key: 'ml|MIN||', market: 'ml', pick: 'MIN', side: null, line: null, away: 'MIN', home: 'CLE', prob: 0.55, confidence: 'alta', result: 'loss', price: 110, public_play: 1, public_lock: 1, public_gem: 0, start_time: `${date}T23:10:00Z`, source_scope: 'causal_verified' },
      // Total legacy factual: conserva mercado/línea/resultado, pero no inventa pick ni probabilidad.
      { date, event_id: 'hist-total', selection_key: 'total||over|8.5', market: 'total', pick: null, side: 'over', line: 8.5, away: 'BOS', home: 'NYY', prob: null, confidence: null, result: 'win', price: null, public_play: 1, public_lock: 0, public_gem: 0, start_time: `${date}T22:10:00Z`, source_scope: 'legacy_public_record' },
      { date, event_id: 'hist-lock-only', selection_key: 'ml|DET||', market: 'ml', pick: 'DET', side: null, line: null, away: 'DET', home: 'KC', prob: null, confidence: null, result: 'loss', price: null, public_play: 0, public_lock: 1, public_gem: 0, start_time: `${date}T21:10:00Z`, source_scope: 'legacy_public_record' },
      { date, event_id: 'hist-gem-only', selection_key: 'ml|LAD||', market: 'ml', pick: 'LAD', side: null, line: null, away: 'SF', home: 'LAD', prob: null, confidence: null, result: 'win', price: null, public_play: 0, public_lock: 0, public_gem: 1, start_time: `${date}T20:10:00Z`, source_scope: 'legacy_public_record' },
      // Push y void permanecen auditables en la API, pero no son W/L ni unidades.
      { date, event_id: 'hist-push', selection_key: 'total||under|7.5', market: 'total', pick: null, side: 'under', line: 7.5, away: 'TB', home: 'TOR', prob: null, confidence: 'alta', result: 'push', price: null, public_play: 1, public_lock: 0, public_gem: 0, source_scope: 'legacy_public_record' },
      { date, event_id: 'hist-void', selection_key: 'ml|BOS||', market: 'ml', pick: 'BOS', side: null, line: null, away: 'BOS', home: 'NYY', prob: 0.54, confidence: 'oro', result: 'void', price: -115, public_play: 1, public_lock: 1, public_gem: 0, source_scope: 'causal_verified' },
    ] });
    if (path === '/v1/injuries') return json(route, { players: [] });
    if (path === '/v1/me') return json(route, { enabled: false, user: null });
    if (path === '/v1/soccer/live') return json(route, { sport: 'soccer', league: requestUrl.searchParams.get('league'), games: [{
      espn_id: 'soc-1', league: 'Premier League', start: `${date}T19:00:00Z`, status: 'pre', status_detail: 'Scheduled',
      away: { code: 'ARS', name: 'Arsenal', score: null, logo: null, rec: '0-0' },
      home: { code: 'LIV', name: 'Liverpool', score: null, logo: null, rec: '0-0' },
    }] });
    if (path === '/v1/soccer/recent') return json(route, { sport: 'soccer', games: [] });
    if (path === '/v1/soccer/standings') return json(route, { sport: 'soccer', season: '2026-27', sections: [] });
    if (path === '/v1/soccer/summary') return json(route, { ok: true, sport: 'soccer', stats: [] });
    if (path === '/v1/soccer/today') return json(route, {
      sport: 'soccer', date, by_id: { 'soc-1': { pick: 'LIV', prob: .57, tier: 't55', league: 'eng.1' } },
      record: { n: 3, w: 3, l: 0, wr: 1 }, backtest: [{ tier: 't55', n: 6133, hit: 67.7 }], n_test: 16059,
    });
    if (path === '/v1/soccer/learning') return json(route, { sport: 'soccer', historical: { n: 16059, accuracy: .677, brier: .19 }, forward: { n: 3 }, gate: { public: true } });
    const us = path.match(/^\/v1\/(wnba|nfl|ncaaf|nhl|ncaam)\/(live|recent|standings|today|summary|learning)$/);
    if (us) {
      const [, sport, action] = us;
      if (sport === 'wnba') {
        if (action === 'learning') return json(route, {
          schema: 'aa_sport_learning_v1', sport, updated_at: `${date}T12:00:00Z`, state: 'training', model_scope: 'shadow',
          gate: { passed: false, approved: false, public: false, reason: 'forward_sample_pending', min_forward: 200, min_dates: 30 },
          historical: { n: 1091, accuracy: 0.663, brier: 0.2132, logloss: 0.616, ece: 0.034 },
          forward: { n: 0, dates: 0, wins: 0, losses: 0, accuracy: null },
          learning_es: ['WNBA: 1,091 predicciones históricas OOS; acierto 66.3% y Brier 0.2132.', 'El modelo sigue en sombra. No se publican picks ni porcentajes.'],
          learning_en: ['WNBA: 1,091 historical OOS predictions; 66.3% accuracy and 0.2132 Brier.', 'The model remains in shadow. No picks or probabilities are published.'],
          attribution_es: 'Métricas medidas con validación cronológica.', attribution_en: 'Metrics measured with chronological validation.',
        });
        if (action === 'standings') return json(route, { sport, season: '2026', sections: [{ name: 'Eastern Conference', rows: [
          { rank: 1, code: 'HME', name: 'Home Team', w: 18, l: 7, pct: '.720', gb: '—' },
          { rank: 2, code: 'AWY', name: 'Away Team', w: 16, l: 9, pct: '.640', gb: '2' },
        ] }] });
        if (action === 'summary') return json(route, { ok: true, sport, stats: [{ key: 'stat_fg', label: 'Tiros de campo', away: '29-65', home: '31-66' }] });
        if (action === 'recent') return json(route, { sport, games: [] });
        if (action === 'today') {
          const gates = {
            winner: { passed: false, approved: false, public: false, reason: 'forward_sample_pending' },
            total: { passed: false, approved: false, public: false, reason: 'market_lines_unavailable' },
            players: { passed: false, approved: false, public: false, reason: 'market_lines_unavailable' },
            combos: { passed: false, approved: false, public: false, reason: 'individual_markets_not_public' },
          };
          const samples = {
            winner: { n: 37, dates: 12, min_forward: 200 }, total: { n: 0, dates: 0, min_forward: 200 },
            players: { n: 0, dates: 0, min_forward: 200 }, combos: { n: 0, dates: 0, min_forward: 100 },
          };
          const markets = Object.fromEntries(Object.keys(gates).map(kind => [kind, { state: 'closed', gate: gates[kind], sample: samples[kind] }]));
          return json(route, { sport, date, gate: gates.winner, sample: samples.winner, gates, samples, markets, events: [{
            event_id: '401857140', espn_id: '401857140', markets,
            market: { away_ml: 260, home_ml: -325, away_prob: .2664, home_prob: .7336, probability_source: 'market_devigged' },
          }], top2: [] });
        }
        return json(route, { sport, games: [{
          espn_id: '401857140', start: `${date}T23:00:00Z`, status: 'live', status_detail: '3rd Qtr',
          away: { code: 'AWY', name: 'Away Team', score: 61, logo: null, rec: '16-9' },
          home: { code: 'HME', name: 'Home Team', score: 67, logo: null, rec: '18-7' },
          market: { away_ml: 260, home_ml: -325 },
        }, {
          espn_id: '401857141', start: `${date}T20:00:00Z`, status: 'pre', status_detail: 'Scheduled',
          away: { code: 'AW2', name: 'Second Away', score: null, logo: null, rec: '15-10' },
          home: { code: 'HM2', name: 'Second Home', score: null, logo: null, rec: '17-8' },
          market: { away_ml: 124, home_ml: -148, away_prob: .445, home_prob: .555, probability_source: 'market_devigged' },
        }] });
      }
      if (action === 'learning' && sport === 'nfl') return json(route, {
        schema: 'aa_sport_learning_v1', sport, updated_at: `${date}T12:00:00Z`, state: 'training', model_scope: 'shadow',
        gate: { passed: false, approved: false, public: false, reason: 'pipeline_integrity_pending', min_forward: 50 },
        historical: { n: 284, accuracy: .637, brier: .2241, logloss: .6393, ece: .0342 },
        forward: { n: 0, dates: 0, wins: 0, losses: 0, accuracy: null },
        learning_es: ['El modelo sensible a jugadores sigue acumulando decisiones pregame.'],
        learning_en: ['The player-aware model is still capturing pregame decisions.'],
        attribution_es: 'Estado medido del entrenamiento privado.', attribution_en: 'Measured private-training status.',
      });
      if (action === 'learning') return json(route, {
        schema: 'aa_sport_learning_v1', sport, updated_at: `${date}T12:00:00Z`, state: 'training', model_scope: 'shadow',
        gate: { passed: false, approved: false, public: false, reason: 'learning_snapshot_pending' },
        historical: { n: 0, accuracy: null, brier: null, logloss: null, ece: null },
        forward: { n: 0, dates: 0, wins: 0, losses: 0, accuracy: null },
        learning_es: ['El Cerebro está capturando decisiones pregame.', 'El gate permanece cerrado.'],
        learning_en: ['The Brain is capturing pregame decisions.', 'The gate remains closed.'],
        attribution_es: 'Estado medido del entrenamiento privado.', attribution_en: 'Measured private-training status.',
      });
      if (action === 'today') return json(route, {
        sport, date, training: true,
        gate: { state: 'closed', passed: false, approved: false, public: false, reason: 'forward_sample_pending' },
        markets: {
          winner: { state: 'closed', gate: { passed: false, approved: false, public: false, reason: 'forward_sample_pending' }, sample: { n: 0, dates: 0, min_forward: 50 } },
          total: { state: 'closed', gate: { passed: false, approved: false, public: false, reason: 'market_lines_unavailable' }, sample: { n: 0, dates: 0, min_forward: 200 } },
          players: { state: 'closed', gate: { passed: false, approved: false, public: false, reason: 'market_lines_unavailable' }, sample: { n: 0, dates: 0, min_forward: 200 } },
          combos: { state: 'closed', gate: { passed: false, approved: false, public: false, reason: 'individual_markets_not_public' }, sample: { n: 0, dates: 0, min_forward: 100 } },
        },
        events: [], top2: [],
      });
      if (action === 'standings') return json(route, { sport, sections: [] });
      if (action === 'summary') return json(route, sport === 'ncaaf' ? {
        ok: true, sport, stats: [{ label: 'Total yards', away: 320, home: 350 }], players: null,
        predictor: { source: 'espn_matchup_predictor', away_pct: 45, home_pct: 55 },
        recent: {
          away: { code: 'AWY', wins: 2, losses: 3, win_pct: 40, games: [
            { event_id: 'a1', result: 'W', score: '28-20', at_vs: '@', opponent: { code: 'OP1' } },
            { event_id: 'a2', result: 'L', score: '14-24', at_vs: 'vs', opponent: { code: 'OP2' } },
          ] },
          home: { code: 'HME', wins: 4, losses: 1, win_pct: 80, games: [
            { event_id: 'h1', result: 'W', score: '31-17', at_vs: 'vs', opponent: { code: 'OP3' } },
            { event_id: 'h2', result: 'W', score: '27-21', at_vs: '@', opponent: { code: 'OP4' } },
          ] },
        }, venue: { name: 'Test Stadium', city: 'Test City', country: 'USA', grass: true }, injuries: null,
      } : { ok: true, sport, stats: [{ label: 'Total yards', away: 320, home: 350 }] });
      if (action === 'recent') return json(route, { sport, games: [] });
      return json(route, { sport, games: [{
        espn_id: `${sport}-1`, start: `${date}T23:00:00Z`, status: 'pre', status_detail: 'Scheduled',
        away: { code: 'AWY', name: 'Away Team', score: null, logo: null, rec: '0-0' },
        home: { code: 'HME', name: 'Home Team', score: null, logo: null, rec: '0-0' },
        market: { away_ml: 150, home_ml: -175, away_prob: .4, home_prob: .6, probability_source: 'market_devigged' },
      }, ...(sport === 'ncaaf' ? [{
        espn_id: 'ncaaf-line-only', start: `${date}T23:30:00Z`, status: 'pre', status_detail: 'Scheduled',
        away: { code: 'SJSU', name: 'San José State', score: null, logo: null, rec: '0-0' },
        home: { code: 'USC', name: 'USC', score: null, logo: null, rec: '0-0' },
        market: { provider: 'DraftKings', spread: -38.5, total: 61.5 },
      }] : [])] });
    }
    return json(route, {});
  });

  // Evita que logos/fuentes externas conviertan el ruido de red del sandbox en
  // falsos errores de la aplicación.
  if (!process.env.AA_MARKET_QA_SCREENSHOT) {
    await page.route('https://a.espncdn.com/**', route => route.fulfill({ status: 204, body: '' }));
  }
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
    await page.goto(`${base}/?tab=mlb&mlb-live-date-regression=${viewport.name}`, { waitUntil: 'domcontentloaded' });
    const state = await rowState(page, 'today-game');
    assert.notEqual(state.time, 'Final', `${viewport.name}: el final de ayer contaminó hoy`);
    assert.deepEqual(state.scores, ['', ''], `${viewport.name}: aparecen marcadores de ayer`);
    const topEs = await page.locator('.topsignals').textContent();
    assert.match(topEs, /Top señales AA/i, `${viewport.name}: falta Top señales ES`);
    assert.match(topEs, /probabilidades calibradas más altas/i, `${viewport.name}: falta explicación calibrada ES`);
    assert.match(topEs, /no son jugadas verificadas ni afirman valor contra la cuota/i, `${viewport.name}: falta deslinde ES`);
    assert.match(topEs, /AA 57%/, `${viewport.name}: falta probabilidad AA ES`);
    assert.equal(await page.locator('.topsignals .bleg').count(), 1, `${viewport.name}: pending/scratch entraron a Top señales`);
    const runEs = await page.locator('.runindicators').textContent();
    assert.match(runEs, /Indicadores AA de Altas/i, `${viewport.name}: faltan indicadores de Altas ES`);
    assert.match(runEs, /Alta 8[,.]5/i, `${viewport.name}: falta línea de Alta ES`);
    assert.match(runEs, /Proyección AA 9[,.]4/i, `${viewport.name}: falta proyección total ES`);
    assert.match(runEs, /gate de Altas cerrado/i, `${viewport.name}: falta estado del gate ES`);
    assert.match(runEs, /récord forward 2-0 \(n=2\)/i, `${viewport.name}: falta muestra forward ES`);
    assert.match(runEs, /no es una jugada verificada ni recomendación/i, `${viewport.name}: falta deslinde de Altas ES`);
    assert.equal(await page.locator('.runindicators .bleg').count(), 1, `${viewport.name}: pending/scratch entraron a indicadores de Altas`);
    await page.locator('.mrow[data-id="today-game"]').click();
    const detailEs = await page.locator('#dcard').textContent();
    assert.match(detailEs, /defensa floja: 9 errores en 10 juegos/i, `${viewport.name}: falta fielding ES`);
    assert.match(detailEs, /necesita ganar para evitar la barrida/i, `${viewport.name}: falta barrida ES`);
    assert.match(detailEs, /Confianza Media/i, `${viewport.name}: falta confianza ES`);
    assert.match(detailEs, /Prob\. AA calibrada\s*57%/i, `${viewport.name}: falta métrica calibrada ES`);
    if (viewport.name === 'mobile-390' && process.env.AA_MARKET_QA_SCREENSHOT) {
      await page.locator('#dcard .market-first').screenshot({ path: process.env.AA_MARKET_QA_SCREENSHOT });
    }
    await page.locator('#dback').evaluate(el => el.click());
    await page.evaluate(() => { mlbPublication = { state: 'overdue' }; renderList(); });
    assert.match(await page.locator('.mrow[data-id="pending-game"]').textContent(), /Publicación atrasada · recuperación automática activa/i, `${viewport.name}: falta overdue ES`);
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
    await page.locator('.ltab[data-lt="hist"]').click();
    await page.waitForFunction(() => /cuota real/i.test(document.querySelector('#dcard')?.textContent || ''));
    const histEs = await page.locator('#dcard').textContent();
    assert.match(histEs, /cuota real · n=2/i, `${viewport.name}: historial no declara cuotas reales ES`);
    assert.match(histEs, /Picks medidos\s*3/i, `${viewport.name}: push\/void inflaron la muestra ES`);
    assert.match(histEs, /Récord\s*2–1/i, `${viewport.name}: total con pick null no entró al récord ES`);
    assert.match(histEs, /Racha actual\s*—\s*según hora programada/i, `${viewport.name}: racha intrahoraria inventada ES`);
    assert.match(histEs, /Alta/i, `${viewport.name}: falta nivel de confianza ES`);
    const histListEs = await page.locator('#list').textContent();
    assert.match(histListEs, /Alta 8\.5/i, `${viewport.name}: total legacy con pick null desapareció ES`);
    assert.equal(await page.locator('#list .hrow').count(), 5, `${viewport.name}: faltan cohortes o push\/void aparecieron como W\/L ES`);
    assert.match(histListEs, /Fijo/i, `${viewport.name}: fijo-only no quedó auditable ES`);
    assert.match(histListEs, /Gema/i, `${viewport.name}: gema-only no quedó auditable ES`);
    assert.doesNotMatch(histListEs, /Baja 7\.5|Gana Boston/i, `${viewport.name}: push\/void visibles como resultado ES`);
    assert.doesNotMatch(histEs, /−110/, `${viewport.name}: historial aún afirma cuota sintética ES`);
    await page.locator('.ltab[data-lt="all"]').click();
    await assertNoOverflow(page, viewport.name);
    await page.locator('.sp[data-sport="soccer"]').click();
    await page.locator('.mrow[data-oid="soc-1"]').waitFor({ state: 'visible' });
    const soccerListEs = await page.locator('#listpane').textContent();
    assert.match(soccerListEs, /Premier/i, `${viewport.name}: Premier no es la liga inicial de Soccer`);
    assert.match(soccerListEs, /Arsenal[\s\S]*Liverpool[\s\S]*AA[\s\S]*57%/i, `${viewport.name}: Soccer no muestra el slate actual con su predicción pública`);
    assert.doesNotMatch(soccerListEs, /Mundial/i, `${viewport.name}: Mundial vencido sigue visible`);
    assert.equal(await page.locator('#lgchips .pill').first().textContent(), 'Premier', `${viewport.name}: el carrusel de Soccer no inicia en Premier`);
    const soccerRowBox = await page.locator('.mrow[data-oid="soc-1"]').boundingBox();
    const soccerChipBox = await page.locator('.mrow[data-oid="soc-1"] .aachip').boundingBox();
    assert.ok(soccerRowBox && soccerChipBox && soccerChipBox.x >= soccerRowBox.x
      && soccerChipBox.x + soccerChipBox.width <= soccerRowBox.x + soccerRowBox.width + 1, `${viewport.name}: chip AA de Soccer recortado`);
    if (viewport.name !== 'desktop') {
      const leagueFlow = await page.locator('#lgchips').evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      assert.ok(leagueFlow.scroll <= leagueFlow.client + 1, `${viewport.name}: ligas de Soccer siguen cortadas horizontalmente`);
      assert.equal(await page.locator('#lgchips .pill').last().isVisible(), true, `${viewport.name}: última liga no visible`);
    }
    if (viewport.name === 'mobile-390' && process.env.AA_NCAAF_SOCCER_SCREENSHOT_DIR) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${process.env.AA_NCAAF_SOCCER_SCREENSHOT_DIR}/07-soccer-list-fixed-mobile.png`, fullPage: false });
    }
    await page.locator('.mrow[data-oid="soc-1"]').click();
    await page.waitForFunction(() => /Predicción AA[\s\S]*57%/i.test(document.querySelector('#dcard')?.textContent || ''));
    const soccerDetailWidth = await page.locator('#detail').evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(soccerDetailWidth.scroll <= soccerDetailWidth.client + 1, `${viewport.name}: detalle Soccer recortado`);
    if (viewport.name === 'mobile-390' && process.env.AA_NCAAF_SOCCER_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.AA_NCAAF_SOCCER_SCREENSHOT_DIR}/05-soccer-detail-fixed-mobile.png`, fullPage: false });
    }
    if (viewport.name !== 'desktop') await page.locator('#dback').evaluate((el) => el.click());
    await assertNoOverflow(page, `${viewport.name}-soccer-es`);
    await page.locator('.sp[data-sport="ncaaf"]').click();
    await page.locator('.mrow[data-oid="ncaaf-1"]').waitFor({ state: 'visible' });
    assert.match(await page.locator('#list').textContent(), /40%[\s\S]*60%[\s\S]*Mercado/i, `${viewport.name}: NCAAF no muestra porcentajes de mercado ES`);
    assert.match(await page.locator('#list').textContent(), /USC -38\.5[\s\S]*Línea/i, `${viewport.name}: NCAAF sin fallback de spread ES`);
    if (viewport.name !== 'desktop') await page.locator('.mrow[data-oid="ncaaf-1"]').click();
    await page.waitForFunction(() => /Predictor externo de ESPN[\s\S]*45%[\s\S]*55%/i.test(document.querySelector('#dcard')?.textContent || ''));
    const ncaafEs = await page.locator('#dcard').textContent();
    assert.match(ncaafEs, /Probabilidad de mercado[\s\S]*Mercado desvigado[\s\S]*40%[\s\S]*60%/i, `${viewport.name}: NCAAF sin probabilidad factual ES`);
    assert.match(ncaafEs, /Por qué los datos favorecen a este lado[\s\S]*quitar el margen/i, `${viewport.name}: NCAAF sin razones ES`);
    assert.match(ncaafEs, /Últimos 5 · temporada anterior[\s\S]*Away Team[\s\S]*2-3[\s\S]*Home Team[\s\S]*4-1/i, `${viewport.name}: NCAAF sin historial ES`);
    assert.match(ncaafEs, /Datos de jugadores[\s\S]*box scores verificados[\s\S]*probabilidad AA sin validación/i, `${viewport.name}: NCAAF sin contexto honesto de jugadores ES`);
    assert.match(ncaafEs, /Sede[\s\S]*Test Stadium[\s\S]*Test City/i, `${viewport.name}: NCAAF sin sede ES`);
    assert.doesNotMatch(ncaafEs, /Modelo AA validado/i, `${viewport.name}: NCAAF presenta mercado como AA ES`);
    if (viewport.name !== 'desktop') await page.locator('#dback').evaluate((el) => el.click());
    await page.locator('.sp[data-sport="wnba"]').click();
    await page.locator('.mrow[data-oid="401857140"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /Evidencia histórica del modelo[\s\S]*66[,.]3%/i.test(document.querySelector('#list')?.textContent || ''));
    assert.equal(await page.locator('.lghead .ttl').textContent(), 'WNBA', `${viewport.name}: WNBA no aparece como liga`);
    const wnbaListEs = await page.locator('#list').textContent();
    assert.match(wnbaListEs, /Away Team/i, `${viewport.name}: falta visitante WNBA ES`);
    assert.match(wnbaListEs, /61[\s\S]*67/, `${viewport.name}: faltan marcadores WNBA ES`);
    assert.match(wnbaListEs, /44[,.]5%[\s\S]*55[,.]5%[\s\S]*Mercado/i, `${viewport.name}: faltan porcentajes por partido del mercado WNBA ES`);
    assert.match(wnbaListEs, /66[,.]3%[\s\S]*1[,.]?091[\s\S]*0[,.]2132/i, `${viewport.name}: falta evidencia histórica visible WNBA ES`);
    assert.match(wnbaListEs, /no el juego de hoy/i, `${viewport.name}: falta distinguir histórico de probabilidad del partido WNBA ES`);
    await page.waitForFunction(() => /Tiros de campo/i.test(document.querySelector('#dcard')?.textContent || ''));
    const wnbaDetailEs = await page.locator('#dcard').textContent();
    assert.match(wnbaDetailEs, /Gate cerrado/i, `${viewport.name}: falta gate honesto WNBA ES`);
    assert.match(wnbaDetailEs, /Probabilidad de mercado[\s\S]*Mercado desvigado[\s\S]*26[,.]6%[\s\S]*73[,.]4%/i, `${viewport.name}: falta probabilidad de mercado WNBA ES`);
    assert.equal(await page.locator('#dcard .market-tab').count(), 4, `${viewport.name}: faltan cuatro mercados WNBA ES`);
    assert.match(wnbaDetailEs, /37\s*\/\s*200/i, `${viewport.name}: falta progreso medido de ganador WNBA ES`);
    assert.match(wnbaDetailEs, /66[,.]3%[\s\S]*1[,.]?091[\s\S]*0[,.]2132/i, `${viewport.name}: el detalle WNBA no muestra evidencia histórica medida`);
    await page.locator('#dcard .market-tab[data-market-kind="total"]').evaluate(el => el.click());
    assert.match(await page.locator('#dcard .market-first').textContent(), /No hay cobertura histórica auditable[\s\S]*0\s*\/\s*200/i, `${viewport.name}: total WNBA no explica su bloqueo ES`);
    await page.locator('#dcard .market-tab[data-market-kind="players"]').evaluate(el => el.click());
    assert.match(await page.locator('#dcard .market-first').textContent(), /línea y precio pregame[\s\S]*0\s*\/\s*200/i, `${viewport.name}: props WNBA no explican su bloqueo ES`);
    await page.locator('#dcard .market-tab[data-market-kind="combos"]').evaluate(el => el.click());
    assert.match(await page.locator('#dcard .market-first').textContent(), /combo no puede abrir[\s\S]*0\s*\/\s*100/i, `${viewport.name}: combos WNBA no explican su bloqueo ES`);
    await page.locator('#dcard .market-tab[data-market-kind="winner"]').evaluate(el => el.click());
    assert.equal(await page.locator('#dcard .market-callout').count(), 0, `${viewport.name}: se publicó una predicción WNBA no validada`);
    assert.equal(await page.locator('.ltab[data-lt="brain"]').isVisible(), true, `${viewport.name}: pestaña Cerebro WNBA oculta`);
    assert.equal(await page.locator('.ltab[data-lt="hist"]').isVisible(), false, `${viewport.name}: historial MLB apareció en WNBA`);
    await page.locator('.ltab[data-lt="brain"]').click();
    await page.locator('#list .sportbrain').waitFor({ state: 'visible' });
    const wnbaBrainEs = await page.locator('#list').textContent();
    assert.match(wnbaBrainEs, /Cerebro AA · WNBA/i, `${viewport.name}: falta Cerebro WNBA ES`);
    assert.match(wnbaBrainEs, /1[,.]091/i, `${viewport.name}: falta muestra histórica WNBA ES`);
    assert.match(wnbaBrainEs, /0[,.]2132/i, `${viewport.name}: falta Brier WNBA ES`);
    assert.match(wnbaBrainEs, /Gate público\s*cerrado/i, `${viewport.name}: WNBA no muestra gate cerrado ES`);
    assert.match(wnbaBrainEs, /modelo sigue en sombra/i, `${viewport.name}: falta explicación de sombra WNBA ES`);
    assert.equal(await page.locator('#list .aachip').count(), 0, `${viewport.name}: Cerebro WNBA publicó un pick individual`);
    await assertNoOverflow(page, `${viewport.name}-wnba-es`);
    await page.locator('.sp[data-sport="mlb"]').click();
    await page.locator('#langbtn').click();
    const topEn = await page.locator('.topsignals').textContent();
    assert.match(topEn, /AA Top signals/i, `${viewport.name}: missing Top signals EN`);
    assert.match(topEn, /highest calibrated probabilities/i, `${viewport.name}: missing calibrated explanation EN`);
    assert.match(topEn, /not verified plays and make no price\/value claim/i, `${viewport.name}: missing Top signals disclaimer EN`);
    assert.doesNotMatch(topEn, /señales|jugadas|cuota|tú decides/i, `${viewport.name}: Spanish leaked into Top signals EN`);
    const runEn = await page.locator('.runindicators').textContent();
    assert.match(runEn, /AA Over indicators/i, `${viewport.name}: missing Over indicators EN`);
    assert.match(runEn, /Over 8\.5/i, `${viewport.name}: missing Over line EN`);
    assert.match(runEn, /AA projection 9\.4/i, `${viewport.name}: missing total projection EN`);
    assert.match(runEn, /Over gate closed/i, `${viewport.name}: missing Over gate status EN`);
    assert.match(runEn, /forward record 2-0 \(n=2\)/i, `${viewport.name}: missing forward sample EN`);
    assert.match(runEn, /not a verified play or recommendation/i, `${viewport.name}: missing Over disclaimer EN`);
    assert.doesNotMatch(runEn, /Altas|línea|proyección|jugada|récord/i, `${viewport.name}: Spanish leaked into Over indicators EN`);
    await page.locator('.mrow[data-id="today-game"]').click();
    const detailEn = await page.locator('#dcard').textContent();
    assert.match(detailEn, /sloppy fielding: 9 errors in 10 games/i, `${viewport.name}: missing fielding EN`);
    assert.match(detailEn, /needs a win to avoid the sweep/i, `${viewport.name}: missing sweep EN`);
    assert.match(detailEn, /Confidence Medium/i, `${viewport.name}: confidence code was not translated in detail EN`);
    assert.match(detailEn, /Calibrated AA prob\.\s*57%/i, `${viewport.name}: calibrated metric was not translated EN`);
    assert.doesNotMatch(detailEn, /Prob\. AA calibrada/i, `${viewport.name}: Spanish metric label leaked into detail EN`);
    assert.doesNotMatch(detailEn, /\bmedia\b|\boro\b|\bfijo\b/i, `${viewport.name}: Spanish confidence or badge leaked into detail EN`);
    await page.locator('#dback').evaluate(el => el.click());
    assert.match(await page.locator('.mrow[data-id="pending-game"]').textContent(), /Publication delayed · automatic recovery active/i, `${viewport.name}: missing overdue EN`);
    const invalidRowEn = await page.locator('.mrow[data-id="invalidated-game"]').textContent();
    assert.match(invalidRowEn, /prediction invalidated · starter changed/i, `${viewport.name}: missing scratch warning EN`);
    assert.doesNotMatch(invalidRowEn, /pronóstico|abridor|análisis/i, `${viewport.name}: Spanish leaked into scratch warning EN`);
    await page.locator('.mrow[data-id="invalidated-game"]').click();
    const invalidDetailEn = await page.locator('#dcard').textContent();
    assert.match(invalidDetailEn, /AA prediction invalidated: the probable starter changed\. The original analysis no longer applies/i, `${viewport.name}: missing prominent warning EN`);
    assert.doesNotMatch(invalidDetailEn, /61%/, `${viewport.name}: invalidated probability visible in detail EN`);
    await page.locator('#dback').evaluate(el => el.click());
    await page.locator('.ltab[data-lt="hist"]').click();
    await page.waitForFunction(() => /actual odds/i.test(document.querySelector('#dcard')?.textContent || ''));
    const histEn = await page.locator('#dcard').textContent();
    assert.match(histEn, /actual odds · n=2/i, `${viewport.name}: history does not disclose actual odds EN`);
    assert.match(histEn, /Current streak\s*—\s*by scheduled start/i, `${viewport.name}: intratime streak was invented EN`);
    assert.match(histEn, /Picks tracked\s*3/i, `${viewport.name}: push\/void inflated the sample EN`);
    assert.match(histEn, /Record\s*2–1/i, `${viewport.name}: null-pick total missing from record EN`);
    assert.match(histEn, /High/i, `${viewport.name}: confidence code was not translated EN`);
    const histListEn = await page.locator('#list').textContent();
    assert.match(histListEn, /Over 8\.5/i, `${viewport.name}: null-pick legacy total disappeared EN`);
    assert.equal(await page.locator('#list .hrow').count(), 5, `${viewport.name}: cohorts missing or push\/void rendered as W\/L EN`);
    assert.match(histListEn, /Lock/i, `${viewport.name}: lock-only row is not auditable EN`);
    assert.match(histListEn, /Gem/i, `${viewport.name}: gem-only row is not auditable EN`);
    assert.doesNotMatch(histListEn, /Alta|Baja|Gana/i, `${viewport.name}: Spanish leaked into history EN`);
    assert.doesNotMatch(histEn, /sin dato|alta|oro|plata|gema|fijo/i, `${viewport.name}: Spanish leaked from confidence codes EN`);
    assert.doesNotMatch(histEn, /−110/, `${viewport.name}: history still claims synthetic odds EN`);
    await page.locator('.ltab[data-lt="brain"]').click();
    const signalLabel = page.locator('.bsig .bsl').first();
    await signalLabel.waitFor({ state: 'visible' });
    assert.equal(await signalLabel.textContent(), 'Matches the market favorite', `${viewport.name}: señal del Cerebro sin traducir`);
    const brainText = await page.locator('#list').textContent();
    assert.match(brainText, /Confidence selection \(no assumed price\)/, `${viewport.name}: simulation still assumes a price`);
    assert.match(brainText, /hit rate >50% \(CI\)/, `${viewport.name}: missing accuracy-only signal`);
    await assertNoOverflow(page, `${viewport.name}-brain-en`);
    for (const newSport of ['nfl', 'ncaaf', 'nhl', 'ncaam']) {
      await page.locator(`.sp[data-sport="${newSport}"]`).click();
      await page.locator(`.mrow[data-oid="${newSport}-1"]`).waitFor({ state: 'visible' });
      assert.match(await page.locator('#list').textContent(), /Training · gate closed/i, `${viewport.name}: ${newSport} missing fail-closed banner`);
      if (newSport === 'ncaaf' && viewport.name === 'mobile-390' && process.env.AA_NCAAF_SOCCER_SCREENSHOT_DIR) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${process.env.AA_NCAAF_SOCCER_SCREENSHOT_DIR}/08-ncaaf-list-fixed-mobile.png`, fullPage: false });
      }
      if (viewport.name !== 'desktop') await page.locator(`.mrow[data-oid="${newSport}-1"]`).click();
      const sportDetail = await page.locator('#dcard').textContent();
      assert.match(sportDetail, /Gate closed/i, `${viewport.name}: ${newSport} missing honest market gate`);
      assert.match(await page.locator('#list').textContent(), /40%[\s\S]*60%[\s\S]*Market/i, `${viewport.name}: ${newSport} per-game market percentages missing`);
      if (newSport === 'ncaaf') assert.match(await page.locator('#list').textContent(), /USC -38\.5[\s\S]*Line/i, `${viewport.name}: NCAAF spread fallback missing`);
      if (newSport === 'nfl') {
        await page.waitForFunction(() => /Historical model evidence[\s\S]*63\.7%/i.test(document.querySelector('#list')?.textContent || ''));
        const nflList = await page.locator('#list').textContent();
        assert.match(nflList, /40%[\s\S]*60%[\s\S]*Market/i, `${viewport.name}: NFL per-game market percentages missing`);
        assert.match(nflList, /63\.7%[\s\S]*284[\s\S]*0\.2241/i, `${viewport.name}: NFL historical evidence is not visible`);
        assert.match(nflList, /not today'?s game/i, `${viewport.name}: NFL historical percentage is not clearly scoped`);
        assert.equal(await page.locator('#dcard .market-tab').count(), 4, `${viewport.name}: NFL missing four markets`);
        assert.match(await page.locator('#dcard .market-first').textContent(), /Market win probability[\s\S]*De-vigged market[\s\S]*40%[\s\S]*60%/i, `${viewport.name}: NFL detail missing market win percentages`);
        assert.match(await page.locator('#dcard .market-first').textContent(), /63\.7%[\s\S]*284[\s\S]*0\.2241/i, `${viewport.name}: NFL detail lacks measured historical evidence`);
        await page.locator('#dcard .market-tab[data-market-kind="total"]').evaluate(el => el.click());
        assert.match(await page.locator('#dcard .market-first').textContent(), /Auditable historical pregame line[\s\S]*0\s*\/\s*200/i, `${viewport.name}: NFL total gate lacks evidence`);
        await page.locator('#dcard .market-tab[data-market-kind="winner"]').evaluate(el => el.click());
      }
      if (newSport === 'ncaaf') {
        await page.waitForFunction(() => /External ESPN predictor[\s\S]*45%[\s\S]*55%/i.test(document.querySelector('#dcard')?.textContent || ''));
        const ncaafDetail = await page.locator('#dcard').textContent();
        assert.match(ncaafDetail, /Market win probability[\s\S]*40%[\s\S]*60%/i, `${viewport.name}: NCAAF missing de-vigged market probability`);
        assert.match(ncaafDetail, /External ESPN predictor[\s\S]*45%[\s\S]*55%/i, `${viewport.name}: NCAAF missing external predictor`);
        assert.match(ncaafDetail, /Why the data favors this side[\s\S]*removing vig/i, `${viewport.name}: NCAAF missing factual reasons`);
        assert.match(ncaafDetail, /Last 5 · previous season[\s\S]*Away Team[\s\S]*2-3[\s\S]*Home Team[\s\S]*4-1/i, `${viewport.name}: NCAAF missing prior-season form`);
        assert.match(ncaafDetail, /Player data[\s\S]*verified box scores[\s\S]*do not turn it into an AA probability/i, `${viewport.name}: NCAAF player-data honesty missing`);
        assert.match(ncaafDetail, /Venue[\s\S]*Test Stadium[\s\S]*Test City/i, `${viewport.name}: NCAAF venue missing`);
        assert.doesNotMatch(ncaafDetail, /Validated AA model/i, `${viewport.name}: NCAAF market fact masquerades as AA`);
        if (viewport.name === 'mobile-390' && process.env.AA_NCAAF_SOCCER_SCREENSHOT_DIR) {
          await page.screenshot({ path: `${process.env.AA_NCAAF_SOCCER_SCREENSHOT_DIR}/06-ncaaf-detail-fixed-mobile.png`, fullPage: false });
          await page.locator('#detail').evaluate((el) => { el.scrollTop = 620; });
          await page.waitForTimeout(150);
          await page.screenshot({ path: `${process.env.AA_NCAAF_SOCCER_SCREENSHOT_DIR}/09-ncaaf-context-fixed-mobile.png`, fullPage: false });
        }
      }
      if (viewport.name !== 'desktop') await page.locator('#dback').evaluate((el) => el.click());
      await page.locator('.ltab[data-lt="brain"]').click();
      await page.locator('#list .sportbrain').waitFor({ state: 'visible' });
      const sportBrain = await page.locator('#list').textContent();
      assert.match(sportBrain, /Public gate\s*closed/i, `${viewport.name}: ${newSport} Brain did not fail closed`);
      assert.match(sportBrain, /capturing pregame decisions/i, `${viewport.name}: ${newSport} Brain missing measured status`);
      await assertNoOverflow(page, `${viewport.name}-${newSport}`);
    }
    await page.locator('.sp[data-sport="wnba"]').click();
    await page.locator('.mrow[data-oid="401857140"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /Team stats[\s\S]*Field goals/i.test(document.querySelector('#dcard')?.textContent || ''));
    const wnbaDetailEn = await page.locator('#dcard').textContent();
    assert.match(wnbaDetailEn, /Gate closed/i, `${viewport.name}: missing honest WNBA gate EN`);
    assert.match(wnbaDetailEn, /Market win probability[\s\S]*De-vigged market[\s\S]*26\.6%[\s\S]*73\.4%/i, `${viewport.name}: missing WNBA market win percentages EN`);
    assert.match(wnbaDetailEn, /Field goals/i, `${viewport.name}: missing WNBA stat translation EN`);
    assert.doesNotMatch(wnbaDetailEn, /Tiros de campo/i, `${viewport.name}: Spanish WNBA stat leaked into EN`);
    assert.doesNotMatch(wnbaDetailEn, /Modelo|entrenamiento|Marcadores|predicciones/i, `${viewport.name}: Spanish leaked into WNBA EN`);
    assert.equal(await page.locator('#dcard .market-callout').count(), 0, `${viewport.name}: unvalidated WNBA prediction became public`);
    await page.locator('.ltab[data-lt="brain"]').click();
    await page.locator('#list .sportbrain').waitFor({ state: 'visible' });
    const wnbaBrainEn = await page.locator('#list').textContent();
    assert.match(wnbaBrainEn, /AA Brain · WNBA/i, `${viewport.name}: missing WNBA Brain EN`);
    assert.match(wnbaBrainEn, /Historical OOS\s*1,091/i, `${viewport.name}: missing WNBA historical sample EN`);
    assert.match(wnbaBrainEn, /Public gate\s*closed/i, `${viewport.name}: missing WNBA closed gate EN`);
    assert.match(wnbaBrainEn, /model remains in shadow/i, `${viewport.name}: missing WNBA shadow disclosure EN`);
    assert.doesNotMatch(wnbaBrainEn, /Cerebro|Histórico|muestra|cerrado|entrenamiento/i, `${viewport.name}: Spanish leaked into WNBA Brain EN`);
    await assertNoOverflow(page, `${viewport.name}-wnba-en`);
    await page.goto(`${base}/?central-default-regression=${viewport.name}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /AA Play Central/i.test(document.querySelector('#list')?.textContent || ''));
    assert.equal(await page.locator('.sp.on').getAttribute('data-sport'), 'radar', `${viewport.name}: Central no abrió por defecto`);
    assert.equal(await page.locator('.spwrap .sp').first().getAttribute('data-sport'), 'radar', `${viewport.name}: Central no es primera`);
    const radarEn = await page.locator('#list').textContent();
    assert.match(radarEn, /AA Play Central/i, `${viewport.name}: missing intelligence central EN`);
    assert.match(radarEn, /never fill a quota/i, `${viewport.name}: missing honest empty state EN`);
    assert.equal(await page.locator('#list .mrow').count(), 0, `${viewport.name}: Central rendered stale legacy rows`);
    await page.locator('#langbtn').evaluate((el) => el.click());
    const radarEs = await page.locator('#list').textContent();
    assert.match(radarEs, /Central de Jugadas AA/i, `${viewport.name}: falta Central AA ES`);
    assert.match(radarEs, /No hay jugadas públicas elegibles|No rellenamos una cuota|Cargando inteligencia/i, `${viewport.name}: falta estado honesto ES`);
    assert.doesNotMatch(radarEs, /AA Play Central|never fill a quota/i, `${viewport.name}: English leaked into Central ES`);
    await assertNoOverflow(page, `${viewport.name}-intelligence-central`);
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
  await page.goto(`${base}/?tab=mlb&mlb-doubleheader-regression=1`, { waitUntil: 'domcontentloaded' });
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
