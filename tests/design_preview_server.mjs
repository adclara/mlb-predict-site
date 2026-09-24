import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../cloudflare/pages');
const QA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/redesign/b2-visual');
const PORT = Number(process.env.AA_PREVIEW_PORT || 4173);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const updatedAt = new Date().toISOString();
const club = (code, name) => ({ code, name });
const game = (id, away, home, hour, pct, pick, pending = false) => ({
  sport: 'mlb', league: 'MLB', event_id: id, matchup: `${away.code} @ ${home.code}`,
  start: `${today}T${hour}:00Z`, status: 'pre', away, home, pending,
  prediction: pending ? null : { pick, prob: pct / 100, prob_pct: pct, probability_source: 'prob_v2', confidence: pct >= 60 ? 'alta' : 'media' },
  metrics: [
    { key: 'metric_prob_cal', label: 'Prob. AA calibrada', value: pending ? '—' : `${pct}%`, kind: 'pct' },
    { key: 'metric_risk', label: 'Riesgo', value: 'bajo', kind: 'risk' },
  ],
  snapshot: {
    verdict_es: 'Lectura AA calibrada para este partido; sin cuota auditada no se afirma ventaja frente al mercado.',
    verdict_en: 'Calibrated AA read for this game; without an audited price, no market edge is claimed.',
    pitchers: {
      away: { id: 660271, name: 'Pablo López', hand: 'R', era: 3.84, era_recent: 3.7, fip: 3.9, k9: 8.2 },
      home: { id: 605400, name: 'Logan Allen', hand: 'L', era: 3.12, era_recent: 3.2, fip: 3.4, k9: 9.1 },
    },
    context: { day_night: 'night', park_factor: 1.01, series: { game: 2, len: 3 } },
    form: { away: [], home: [] }, reasons: ['Probabilidad calibrada con el corte público.'],
    reasons_en: ['Calibrated probability from the public snapshot.'],
  },
  risk: { level: 'bajo', score: 18, coverage: 1 }, odds: null, badges: [], result: null, final: null,
});
const events = [
  game('g1', club('MIN', 'Minnesota Twins'), club('CLE', 'Cleveland Guardians'), '22:40', 57, 'CLE'),
  game('g2', club('NYY', 'New York Yankees'), club('BOS', 'Boston Red Sox'), '23:10', 61, 'BOS'),
  game('g3', club('LAD', 'Los Angeles Dodgers'), club('SF', 'San Francisco Giants'), '15:15', 54, 'LAD'),
  game('g4', club('SEA', 'Seattle Mariners'), club('HOU', 'Houston Astros'), '00:10', 0, '', true),
  game('g5', club('CHC', 'Chicago Cubs'), club('STL', 'St. Louis Cardinals'), '00:45', 55, 'CHC'),
];
const live = [{
  espn_id: 'g3', event_id: 'g3', date: today, start: `${today}T15:15:00Z`, status: 'live', status_detail: 'Bot 5th',
  away: { code: 'LAD', score: 3 }, home: { code: 'SF', score: 2 }, win_prob_home: .42,
}];
const docs = {
  '/v1/mlb/today': { sport: 'mlb', date: today, updated_at: updatedAt, events, publication: { state: 'published', predictions: 4 }, record: null },
  '/v1/mlb/live': { sport: 'mlb', date: today, updated_at: updatedAt, games: live },
  '/v1/mlb/standings': { sport: 'mlb', sections: [] },
  '/v1/intelligence/today': { version: 'intelligence_v2', state: 'fresh', slate: [], market_bundles: [] },
  '/v1/injuries': { players: [] }, '/v1/me': { enabled: false, user: null },
};
const shim = `<script>
  const __aaPreviewDocs = ${JSON.stringify(docs)};
  const __aaNativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.hostname === 'aa-sports-api.opsmira9.workers.dev') {
      const body = __aaPreviewDocs[url.pathname] || {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return __aaNativeFetch(input, init);
  };
</script>`;

createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://local').pathname);
    const qa = pathname.startsWith('/__qa/');
    const relative = qa ? pathname.replace(/^\/__qa\//, '') : pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const root = qa ? QA_ROOT : ROOT;
    const file = resolve(root, relative);
    if (file !== root && !file.startsWith(root + sep)) throw new Error('outside root');
    let body = await readFile(file);
    if (!qa && relative === 'index.html') body = Buffer.from(body.toString('utf8').replace('</head>', `${shim}</head>`));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`AA design preview: http://127.0.0.1:${PORT}/?s=mlb`));
