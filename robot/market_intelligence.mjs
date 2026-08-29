// AA Sports provider-neutral market intelligence. Read-only upstreams; it
// publishes one compact sanitized snapshot to KV/D1. No alerts or betting.
import { createHash } from 'node:crypto';
import { canonicalTeam, extractTeams, intelligenceState, matchProviderEvent, quoteFromMarket,
  buildShadowCombos, sanitizePublicSlate, shouldRunPulse } from './lib/market_intelligence.mjs';

const AA_API = 'https://aa-sports-api.opsmira9.workers.dev';
const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const KV_ID = '683aa2f8846643bf8a6a8b606e5bf0b7';
const D1_ID = 'ed0969d8-050a-4987-ab98-b047c30f76c9';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;
const DRY_RUN = process.argv.includes('--dry-run') || !TOKEN;
const ET = 'America/New_York';
const SPORTS = ['mlb', 'soccer', 'nba', 'wnba', 'nfl'];
const POLY_TAG = { mlb: 'mlb', soccer: 'soccer', nba: 'nba', wnba: 'basketball', nfl: 'nfl' };
const KALSHI_SERIES = { mlb: 'KXMLBGAME', soccer: 'KXEPLGAME', nba: 'KXNBAGAME', wnba: 'KXWNBAGAME', nfl: 'KXNFLGAME' };

const etDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const timeout = (ms) => AbortSignal.timeout(ms);

async function getJson(url, { optional = false } = {}) {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'aa-sports-intelligence/1.0' }, signal: timeout(12000) });
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  } catch (error) {
    if (!optional) console.warn(JSON.stringify({ message: 'upstream unavailable', url: new URL(url).host, error: String(error?.message || error) }));
    return null;
  }
}

function eventsOf(doc, sport) {
  const rows = Array.isArray(doc?.events) ? doc.events : Array.isArray(doc?.games) ? doc.games : [];
  return rows.map((event) => ({ ...event, sport, event_id: String(event.event_id || event.espn_id || event.id || ''),
    start: event.start || event.start_time || event.date || null,
    prediction: event.prediction || (event.pick && event.prob != null ? event : null) })).filter((event) => event.event_id);
}

async function fetchAaEvents() {
  const routes = SPORTS.map((sport) => `${AA_API}/v1/${sport}/today`);
  const docs = await Promise.all(routes.map((route) => getJson(route, { optional: true })));
  return docs.flatMap((doc, index) => eventsOf(doc, SPORTS[index]));
}

function polyCandidates(docs, nowIso) {
  return docs.flatMap((doc, index) => (Array.isArray(doc) ? doc : []).flatMap((event) => (event.markets || []).map((market) => ({
    ...market, provider: 'polymarket', league: SPORTS[index], title: event.title || market.question,
    teams: extractTeams(event.title || market.question), outcomeTeam: market.groupItemTitle || null,
    start: market.gameStartTime || event.startDate || event.endDate,
    updatedAt: market.updatedAt || event.updatedAt || nowIso,
  })))).filter((market) => market.active !== false && market.closed !== true && market.sportsMarketType === 'moneyline');
}

function kalshiCandidates(docs, nowIso) {
  return (docs || []).flatMap((doc) => (doc?.events || []).flatMap((event) => (event.markets || []).map((market) => ({
    ...market, provider: 'kalshi', title: event.title || market.title, teams: extractTeams(event.title),
    outcomeTeam: market.yes_sub_title || market.title?.replace(/\s+wins$/i, '') || null,
    start: market.expected_expiration_time || market.close_time, updated_time: market.updated_time || nowIso,
  })))).filter((market) => market.status === 'open' || market.status === 'active' || !market.status);
}

function sideProbability(event, match, quote) {
  if (!match || !quote) return null;
  const pick = String(event?.prediction?.pick || '');
  const homePicked = [event?.home?.code, event?.home?.name].some((value) => canonicalTeam(value) === canonicalTeam(pick));
  const awayPicked = [event?.away?.code, event?.away?.name].some((value) => canonicalTeam(value) === canonicalTeam(pick));
  const pickNames = (homePicked ? [event?.home?.code, event?.home?.name] : awayPicked ? [event?.away?.code, event?.away?.name] : [pick]).map(canonicalTeam).filter(Boolean);
  if (!pickNames.includes(canonicalTeam(match.outcomeTeam))) return null;
  const base = quote.mid ?? quote.indicative;
  return base == null ? null : base;
}

function buildOverlays(events, poly, kalshi, now) {
  const out = new Map();
  for (const event of events) {
    if (!event.prediction?.pick || !Number.isFinite(Number(event.prediction?.prob))) continue;
    const pick = event.prediction.pick;
    const pickValues = [pick];
    if ([event.home?.code, event.home?.name].some((value) => canonicalTeam(value) === canonicalTeam(pick))) pickValues.push(event.home?.code, event.home?.name);
    if ([event.away?.code, event.away?.name].some((value) => canonicalTeam(value) === canonicalTeam(pick))) pickValues.push(event.away?.code, event.away?.name);
    const outcomeMatches = (item) => pickValues.some((value) => canonicalTeam(value) === canonicalTeam(item.outcomeTeam));
    const pm = matchProviderEvent(event, poly.filter((item) => (!item.league || item.league === event.sport) && outcomeMatches(item)));
    const km = matchProviderEvent(event, kalshi.filter(outcomeMatches));
    const pq = pm ? quoteFromMarket(pm, now) : null, kq = km ? quoteFromMarket(km, now) : null;
    const pprob = sideProbability(event, pm, pq), kprob = sideProbability(event, km, kq);
    const odds = event.odds || event.prediction?.odds || null;
    let homeProb = odds?.consensus?.p_home ?? odds?.p_home_mkt;
    if (homeProb == null && Number.isFinite(Number(odds?.ml_home)) && Number.isFinite(Number(odds?.ml_away))) {
      const implied = (price) => Number(price) < 0 ? Math.abs(Number(price)) / (Math.abs(Number(price)) + 100) : 100 / (Number(price) + 100);
      const ph = implied(odds.ml_home), pa = implied(odds.ml_away);
      homeProb = ph + pa > 0 ? ph / (ph + pa) : null;
    }
    const pickHome = String(event.prediction.pick).toUpperCase() === String(event.home?.code || event.home).toUpperCase();
    const bookProb = homeProb == null ? null : (pickHome ? Number(homeProb) : 1 - Number(homeProb));
    const books = bookProb == null ? null : { prob: bookProb, n: odds?.consensus?.n_books ?? odds?.n_books ?? odds?.books?.length ?? 1,
      disagreement: odds?.book_disagreement ?? 0, as_of: odds?.captured_at_open || null };
    const consensus = intelligenceState({ aaProb: event.prediction.prob, bookProb, polyProb: pprob, kalshiProb: kprob,
      bookDisagreement: books?.disagreement, move30m: 0 });
    out.set(`${event.sport}:${event.event_id}`, { books,
      polymarket: pm ? { matched: true, market_id: pm.conditionId, prob: pprob, ...pq } : { matched: false },
      kalshi: km ? { matched: true, ticker: km.ticker, prob: kprob, ...kq } : { matched: false },
      wallet_signal: null, consensus });
  }
  return out;
}

async function cf(path, init) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init?.headers || {}) }, signal: timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(`Cloudflare ${response.status}: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  return body;
}

async function loadWalletProfiles() {
  if (!TOKEN) return [];
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_ID}/values/intelligence%3Awallets`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' }, signal: timeout(12000),
    });
    if (!response.ok) return [];
    const doc = await response.json();
    return Array.isArray(doc?.profiles) ? doc.profiles.filter((profile) => profile?.w) : [];
  } catch { return []; }
}

async function attachWalletSignals(events, poly, overlays, profiles, nowMs) {
  if (!profiles.length) return;
  const profileMap = new Map(profiles.map((profile) => [String(profile.w).toLowerCase(), profile]));
  const sideValues = (event, side) => [event?.[side]?.code, event?.[side]?.name].map(canonicalTeam).filter(Boolean);
  await Promise.all(events.filter((event) => event.prediction?.pick && overlays.has(`${event.sport}:${event.event_id}`)).slice(0, 7).map(async (event) => {
    const pickHome = sideValues(event, 'home').includes(canonicalTeam(event.prediction.pick));
    const pickSide = pickHome ? 'home' : 'away', otherSide = pickHome ? 'away' : 'home';
    const find = (side) => matchProviderEvent(event, poly.filter((candidate) => candidate.league === event.sport
      && sideValues(event, side).includes(canonicalTeam(candidate.outcomeTeam))));
    const sides = [{ key: 'support', market: find(pickSide) }, { key: 'oppose', market: find(otherSide) }].filter((row) => row.market?.conditionId);
    if (!sides.length) return;
    const measured = await Promise.all(sides.map(async (row) => {
      const trades = await getJson(`https://data-api.polymarket.com/trades?market=${encodeURIComponent(row.market.conditionId)}&side=BUY&filterType=CASH&filterAmount=50&limit=1000`, { optional: true });
      const start = Date.parse(event.start || 0), byWallet = new Map();
      for (const trade of Array.isArray(trades) ? trades : []) {
        const wallet = String(trade.proxyWallet || '').toLowerCase(), ts = Number(trade.timestamp) * 1000;
        if (!profileMap.has(wallet) || !Number.isFinite(ts) || ts >= start || nowMs - ts > 48 * 3600e3) continue;
        const usd = Number(trade.price) * Number(trade.size);
        if (!(usd >= 50)) continue;
        byWallet.set(wallet, (byWallet.get(wallet) || 0) + usd);
      }
      return { key: row.key, wallets: [...byWallet.entries()], usd: [...byWallet.values()].reduce((sum, value) => sum + value, 0) };
    }));
    const support = measured.find((row) => row.key === 'support') || { wallets: [], usd: 0 };
    const oppose = measured.find((row) => row.key === 'oppose') || { wallets: [], usd: 0 };
    const strongest = support.usd >= oppose.usd ? support : oppose;
    if (!strongest.wallets.length) return;
    const signal = { side: support.wallets.length && oppose.wallets.length ? 'mixed' : strongest === support ? 'support' : 'oppose',
      qualified_wallets: strongest.wallets.length, usd: Math.round(strongest.usd), label: 'possible_informed_pattern',
      profiles: strongest.wallets.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([wallet, usd]) => {
        const profile = profileMap.get(wallet); return { wallet, usd: Math.round(usd), n: profile.n,
          win_rate: profile.win_rate, wr_lb: profile.wr_lb, pnl: profile.pnl };
      }) };
    const overlay = overlays.get(`${event.sport}:${event.event_id}`);
    overlay.wallet_signal = signal;
    overlay.consensus = intelligenceState({ aaProb: event.prediction.prob, bookProb: overlay.books?.prob,
      polyProb: overlay.polymarket?.prob, kalshiProb: overlay.kalshi?.prob,
      bookDisagreement: overlay.books?.disagreement, walletSignal: signal });
  }));
}

async function publish(doc) {
  const payload = JSON.stringify(doc);
  await cf(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_ID}/values/intelligence%3Atoday`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: payload,
  });
  await cf(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_ID}/values/${encodeURIComponent(`intelligence:day:${doc.date}`)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: payload,
  });
  await cf(`/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: `INSERT OR IGNORE INTO market_intelligence_snapshots
      (slot_at, date, state, payload_hash, payload, kv_writes, d1_rows, created_at) VALUES (?, ?, ?, ?, ?, 2, 1, ?)`,
    params: [doc.as_of.slice(0, 16) + ':00Z', doc.date, doc.state, doc.content_hash, payload, doc.as_of] }) });
  const combos = doc.combos?.items || [];
  if (combos.length) {
    const fields = '(date,combo_id,frozen_at,start_time,legs_json,joint_prob,independence_prob,ci_low,ci_high,result,engine_version,gate_version,public_scope,gate_passed,human_approved,updated_at)';
    const marks = combos.map(() => '(?,?,?,?,?,NULL,?,NULL,NULL,NULL,?,?,\'shadow\',0,0,?)').join(',');
    const params = combos.flatMap((combo) => [doc.date, combo.combo_id, doc.as_of,
      combo.legs.map((leg) => leg.start).filter(Boolean).sort()[0] || doc.as_of, JSON.stringify(combo.legs), combo.independence_prob,
      'combo-shadow-v1', 'combo-gate-v1', doc.as_of]);
    await cf(`/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: `INSERT OR IGNORE INTO cross_sport_combo_ledger ${fields} VALUES ${marks}`, params }) });
  }
}

export async function run(now = new Date()) {
  const nowIso = now.toISOString(), nowMs = now.getTime();
  const events = await fetchAaEvents();
  if (!shouldRunPulse(events, nowMs)) {
    console.log(JSON.stringify({ message: 'calm-window skip', events: events.length, now: nowIso }));
    return { skipped: true };
  }
  const [polyDocs, kalshiDocs, walletProfiles] = await Promise.all([
    Promise.all(SPORTS.map((sport) => getJson(
      `https://gamma-api.polymarket.com/events?tag_slug=${POLY_TAG[sport]}&closed=false&limit=100&order=startDate&ascending=false`, { optional: true }))),
    Promise.all(SPORTS.map((sport) => getJson(
      `https://external-api.kalshi.com/trade-api/v2/events?series_ticker=${KALSHI_SERIES[sport]}&status=open&limit=200&with_nested_markets=true`, { optional: true }))),
    loadWalletProfiles(),
  ]);
  const poly = polyCandidates(polyDocs, nowIso), kalshi = kalshiCandidates(kalshiDocs, nowIso);
  const overlays = buildOverlays(events, poly, kalshi, nowMs);
  await attachWalletSignals(events, poly, overlays, walletProfiles, nowMs);
  const slate = sanitizePublicSlate(events, overlays, { max: 7 });
  const comboItems = buildShadowCombos(slate, { max: 3 });
  const doc = { version: 'intelligence_v1', date: etDate(now), state: slate.length ? 'fresh' : 'degraded', as_of: nowIso,
    next_refresh: new Date(nowMs + (events.some((e) => e.status === 'live' || (Date.parse(e.start) - nowMs < 18 * 3600e3 && Date.parse(e.start) >= nowMs - 30 * 60e3)) ? 30 : 120) * 60e3).toISOString(),
    cadence: '30m_active_2h_calm', sources: { aa: { ok: events.length > 0 }, books: { ok: slate.some((x) => x.books) },
      polymarket: { ok: poly.length > 0, markets: poly.length }, kalshi: { ok: kalshi.length > 0, markets: kalshi.length } },
    slate, combos: { state: 'closed', items: comboItems, gate: { passed: false, approved: false, public: false, reason: 'combos_forward_validation_pending' },
      sample: { n: 0, dates: 0, min_forward: 100, min_dates: 30 } },
    budget: { kv_writes: 2, d1_rows: 1 + comboItems.length, max_kv_writes_day: 120, max_d1_rows_day: 5000 },
    alerts: false, telegram: false };
  doc.content_hash = createHash('sha256').update(JSON.stringify(doc)).digest('hex');
  if (DRY_RUN) console.log(JSON.stringify(doc, null, 2)); else await publish(doc);
  return doc;
}

if (process.argv[1]?.endsWith('market_intelligence.mjs')) run().catch((error) => {
  console.error(JSON.stringify({ message: 'market intelligence failed', error: String(error?.stack || error) }));
  process.exitCode = 1;
});
