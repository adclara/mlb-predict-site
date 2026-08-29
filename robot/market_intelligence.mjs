// AA Sports provider-neutral market intelligence. Read-only upstreams; it
// publishes one compact sanitized snapshot to KV/D1. No alerts or betting.
import { createHash } from 'node:crypto';
import { canonicalTeam, extractTeams, intelligenceState, matchProviderEvent, matchProviderEventResult, quoteFromMarket, sameTeam,
  buildMarketBundles, buildShadowCombos, marketEventFromEspn, recentFormByTeam,
  sanitizePublicSlate } from './lib/market_intelligence.mjs';

const AA_API = 'https://aa-sports-api.opsmira9.workers.dev';
const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const KV_ID = '683aa2f8846643bf8a6a8b606e5bf0b7';
const D1_ID = 'ed0969d8-050a-4987-ab98-b047c30f76c9';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;
const DRY_RUN = process.argv.includes('--dry-run') || !TOKEN;
const FORCE = process.env.AA_INTELLIGENCE_FORCE === '1';
const MIN_AGE_MINUTES = Math.max(0, Number(process.env.AA_INTELLIGENCE_MIN_AGE_MINUTES || 0) || 0);
const TRIGGER = String(process.env.AA_INTELLIGENCE_TRIGGER || (DRY_RUN ? 'dry-run' : 'unknown')).slice(0, 40);
const ET = 'America/New_York';
const SPORTS = ['mlb', 'soccer', 'nba', 'wnba', 'nfl', 'ncaaf', 'nhl', 'ncaam'];
const AA_SPORTS = ['mlb', 'soccer', 'nba', 'wnba', 'nfl'];
const POLY_TAG = { mlb: 'mlb', soccer: 'soccer', nba: 'nba', wnba: 'basketball', nfl: 'nfl', ncaaf: 'cfb', nhl: 'nhl', ncaam: 'college-basketball' };
const KALSHI_SERIES = { mlb: 'KXMLBGAME', soccer: 'KXEPLGAME', nba: 'KXNBAGAME', wnba: 'KXWNBAGAME', nfl: 'KXNFLGAME',
  ncaaf: 'KXNCAAFGAME', nhl: 'KXNHLGAME', ncaam: 'KXNCAAMGAME' };
const ESPN_FEEDS = { mlb: 'baseball/mlb', nba: 'basketball/nba', wnba: 'basketball/wnba', nfl: 'football/nfl',
  ncaaf: 'football/college-football', nhl: 'hockey/nhl', ncaam: 'basketball/mens-college-basketball' };
const SOCCER_LEAGUES = ['eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'usa.1', 'mex.1', 'uefa.champions'];

const etDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const timeout = (ms) => AbortSignal.timeout(ms);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const telemetry = { requests: 0, retries: 0, ok: 0, failed: 0, critical_ok: 0, critical_failed: 0, by_host: {} };
const resetTelemetry = () => {
  for (const key of ['requests', 'retries', 'ok', 'failed', 'critical_ok', 'critical_failed']) telemetry[key] = 0;
  telemetry.by_host = {};
};
const log = (value) => { if (!DRY_RUN) console.log(JSON.stringify(value)); };
const hostMetric = (url, key) => {
  const host = new URL(url).host, row = telemetry.by_host[host] || { ok: 0, failed: 0, retries: 0 };
  row[key] = (row[key] || 0) + 1; telemetry.by_host[host] = row;
};

export function freshnessDecision(current, nowMs, minAgeMinutes, force = false) {
  const ageMinutes = current?.as_of && Number.isFinite(Date.parse(current.as_of))
    ? Math.max(0, (nowMs - Date.parse(current.as_of)) / 60000) : null;
  const verifiable = current?.version === 'intelligence_v2' && current?.cadence === '30m_redundant'
    && Number(current?.source_health?.critical_ok || 0) > 0;
  return { skip: !force && verifiable && ageMinutes != null && ageMinutes < minAgeMinutes,
    age_minutes: ageMinutes, verifiable };
}

export function previousFutureCount(previous, nowMs) {
  return (previous?.slate || []).filter((item) => Number.isFinite(Date.parse(item?.start)) && Date.parse(item.start) > nowMs).length;
}

export async function getJson(url, { optional = false, critical = false, tries = 3, fetcher = fetch, sleepFn = sleep, label = 'upstream' } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    telemetry.requests++;
    try {
      const response = await fetcher(url, { headers: { accept: 'application/json', 'user-agent': 'aa-sports-intelligence/2.0', 'cache-control': 'no-cache' }, signal: timeout(12000) });
      if (!response.ok) {
        const error = new Error(`http_${response.status}`); error.status = response.status; throw error;
      }
      const body = await response.json(); telemetry.ok++; hostMetric(url, 'ok'); if (critical) telemetry.critical_ok++;
      return body;
    } catch (error) {
      lastError = error;
      const retryable = error?.status === 429 || error?.status >= 500 || error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.status == null;
      if (attempt < tries && retryable) {
        telemetry.retries++; hostMetric(url, 'retries');
        await sleepFn(Math.min(3000, 300 * (2 ** (attempt - 1))));
        continue;
      }
      break;
    }
  }
  telemetry.failed++; hostMetric(url, 'failed'); if (critical) telemetry.critical_failed++;
  if (!DRY_RUN) console.warn(JSON.stringify({ message: 'upstream unavailable', label, optional, critical,
    host: new URL(url).host, path: new URL(url).pathname, error: String(lastError?.message || lastError) }));
  return null;
}

function eventsOf(doc, sport) {
  const rows = Array.isArray(doc?.events) ? doc.events : Array.isArray(doc?.games) ? doc.games : [];
  return rows.map((event) => ({ ...event, sport, event_id: String(event.event_id || event.espn_id || event.id || ''),
    start: event.start || event.start_time || event.date || null,
    prediction: event.prediction || (event.pick && event.prob != null ? event : null) })).filter((event) => event.event_id);
}

function aaReasons(event) {
  const pick = event?.prediction?.pick, pickedHome = canonicalTeam(pick) === canonicalTeam(event?.home?.code), snapshot = event?.snapshot || {};
  const pickSide = pickedHome ? 'home' : 'away', opponentSide = pickedHome ? 'away' : 'home', reasons = [];
  if (Number.isFinite(Number(event?.prediction?.prob))) reasons.push({ code: 'aa_probability', value: Number(event.prediction.prob) });
  const pickForm = snapshot.form?.[pickSide] || [], opponentForm = snapshot.form?.[opponentSide] || [];
  if (pickForm.length || opponentForm.length) reasons.push({ code: 'aa_form', pick_wins: pickForm.filter((row) => row.w).length,
    pick_n: pickForm.length, opponent_wins: opponentForm.filter((row) => row.w).length, opponent_n: opponentForm.length });
  const pickPitcher = snapshot.pitchers?.[pickSide], opponentPitcher = snapshot.pitchers?.[opponentSide];
  if (pickPitcher || opponentPitcher) reasons.push({ code: 'aa_pitching', pick_name: pickPitcher?.name || null,
    opponent_name: opponentPitcher?.name || null, pick_value: pickPitcher?.era_recent ?? pickPitcher?.fip ?? null,
    opponent_value: opponentPitcher?.era_recent ?? opponentPitcher?.fip ?? null });
  const pickOffense = snapshot.offense?.[pickSide], opponentOffense = snapshot.offense?.[opponentSide];
  if (pickOffense || opponentOffense) reasons.push({ code: 'aa_offense', pick_value: pickOffense?.runs ?? null, opponent_value: opponentOffense?.runs ?? null });
  if (event?.risk) reasons.push({ code: 'aa_risk', level: event.risk.level || null, score: event.risk.score ?? null });
  return reasons;
}

async function fetchAaEvents() {
  const routes = AA_SPORTS.map((sport) => `${AA_API}/v1/${sport}/today`);
  const docs = await Promise.all(routes.map((route) => getJson(route, { optional: true })));
  return docs.flatMap((doc, index) => eventsOf(doc, AA_SPORTS[index])).map((event) => ({
    ...event, selection_scope: event.prediction ? 'aa_public' : event.selection_scope,
    reasons: aaReasons(event),
    context: event.snapshot ? { probability_kind: 'aa_calibrated', metrics: event.metrics || [], summary_es: event.summary_es || null,
      form: event.snapshot.form || null, offense: event.snapshot.offense || null, pitchers: event.snapshot.pitchers || null,
      bullpen: event.snapshot.bullpen || null, edges: event.snapshot.edges || null, weather: event.snapshot.context?.weather || null,
      risk: event.risk || null, market: event.snapshot.market || null } : null,
  }));
}

const dateKeys = (now) => [...new Set([0, 18, 36].map((hours) => etDate(new Date(now.getTime() + hours * 3600e3)).replaceAll('-', '')))];
const compactFinal = (event) => {
  const comp = event?.competitions?.[0], state = comp?.status?.type?.state || event?.status?.type?.state;
  if (state !== 'post') return null;
  const competitors = comp?.competitors || [], home = competitors.find((row) => row.homeAway === 'home'), away = competitors.find((row) => row.homeAway === 'away');
  const side = (row) => ({ code: row?.team?.abbreviation || row?.team?.shortDisplayName || null, score: Number(row?.score) });
  const h = side(home), a = side(away);
  return h.code && a.code && Number.isFinite(h.score) && Number.isFinite(a.score)
    ? { espn_id: String(event.id || comp?.id || ''), start: event.date || comp?.date, date: String(event.date || comp?.date || '').slice(0, 10), status: 'final', home: h, away: a } : null;
};

async function fetchMarketEvents(now) {
  const dates = dateKeys(now);
  const range = `${etDate(new Date(now.getTime() - 8 * 86400e3)).replaceAll('-', '')}-${etDate(now).replaceAll('-', '')}`;
  const [scoreboardRows, historyRows] = await Promise.all([
    Promise.all([
      ...Object.entries(ESPN_FEEDS).flatMap(([sport, feed]) => dates.map(async (date) => ({ sport, league: sport.toUpperCase(),
        doc: await getJson(`https://site.api.espn.com/apis/site/v2/sports/${feed}/scoreboard?dates=${date}&limit=400`,
          { optional: true, critical: true, label: `scoreboard:${sport}:${date}` }) }))),
      ...SOCCER_LEAGUES.flatMap((league) => dates.map(async (date) => ({ sport: 'soccer', league,
        doc: await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${date}&limit=200`,
          { optional: true, critical: true, label: `scoreboard:soccer:${league}:${date}` }) }))),
    ]),
    Promise.all([
      ...Object.entries(ESPN_FEEDS).map(async ([sport, feed]) => ({ sport,
        doc: await getJson(`https://site.api.espn.com/apis/site/v2/sports/${feed}/scoreboard?dates=${range}&limit=500`, { optional: true }) })),
      ...SOCCER_LEAGUES.map(async (league) => ({ sport: 'soccer',
        doc: await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${range}&limit=500`, { optional: true }) })),
    ]),
  ]);
  const historyBySport = new Map();
  for (const row of historyRows) {
    const list = historyBySport.get(row.sport) || [], seen = new Set(list.map((game) => game.espn_id));
    for (const event of row.doc?.events || []) { const game = compactFinal(event); if (game && !seen.has(game.espn_id)) { seen.add(game.espn_id); list.push(game); } }
    historyBySport.set(row.sport, list);
  }
  const recent = new Map([...historyBySport].map(([sport, games]) => [sport, recentFormByTeam(games)]));
  const out = [], seen = new Set();
  for (const row of scoreboardRows) for (const event of row.doc?.events || []) {
    const parsed = marketEventFromEspn(event, { sport: row.sport, league: row.league, now: now.getTime(), recent: recent.get(row.sport) || new Map() });
    if (!parsed) continue;
    const key = `${parsed.sport}:${parsed.event_id}`;
    if (!seen.has(key)) { seen.add(key); out.push(parsed); }
  }
  return out;
}

export function polyCandidates(docs, nowIso) {
  const parse = (value) => { if (Array.isArray(value)) return value; try { return JSON.parse(value || '[]'); } catch { return []; } };
  return docs.flatMap((doc, index) => (Array.isArray(doc) ? doc : []).flatMap((event) => (event.markets || []).flatMap((market) => {
    if (market.active === false || market.closed === true || market.sportsMarketType !== 'moneyline') return [];
    const base = { ...market, provider: 'polymarket', league: SPORTS[index], title: event.title || market.question,
      teams: extractTeams(event.title || market.question), start: market.gameStartTime || event.endDate || event.startDate,
      updatedAt: market.updatedAt || event.updatedAt || nowIso };
    if (market.groupItemTitle) return [{ ...base, outcomeTeam: market.groupItemTitle }];
    const outcomes = parse(market.outcomes), prices = parse(market.outcomePrices).map(Number), tokens = parse(market.clobTokenIds);
    if (outcomes.length !== 2 || prices.length !== 2) return [];
    return outcomes.map((outcomeTeam, outcomeIndex) => ({ ...base, outcomeTeam, outcomeIndex,
      asset: tokens[outcomeIndex] || null, outcomePrices: JSON.stringify([prices[outcomeIndex], prices[1 - outcomeIndex]]),
      bestBid: outcomeIndex === 0 ? market.bestBid : (Number.isFinite(Number(market.bestAsk)) ? 1 - Number(market.bestAsk) : null),
      bestAsk: outcomeIndex === 0 ? market.bestAsk : (Number.isFinite(Number(market.bestBid)) ? 1 - Number(market.bestBid) : null) }));
  })));
}

export function kalshiCandidates(docs, nowIso) {
  return (docs || []).flatMap((doc, index) => (doc?.events || []).flatMap((event) => (event.markets || []).map((market) => ({
    ...market, provider: 'kalshi', league: SPORTS[index], title: event.title || market.title, teams: extractTeams(event.title),
    outcomeTeam: market.yes_sub_title || market.title?.replace(/\s+wins$/i, '') || null,
    start: market.expected_expiration_time || market.close_time,
    // Kalshi's `updated_time` tracks contract metadata, not quote freshness.
    // The bid/ask below is observed by this run, so its auditable timestamp is
    // the capture time rather than the contract's creation/update timestamp.
    source_updated_time: market.updated_time || null, updated_time: nowIso,
  })))).filter((market) => market.status === 'open' || market.status === 'active' || !market.status);
}

function sideProbability(event, match, quote) {
  if (!match || !quote) return null;
  const pick = String(event?.prediction?.pick || '');
  const homePicked = [event?.home?.code, event?.home?.name].some((value) => canonicalTeam(value) === canonicalTeam(pick));
  const awayPicked = [event?.away?.code, event?.away?.name].some((value) => canonicalTeam(value) === canonicalTeam(pick));
  const pickNames = homePicked ? [event?.home?.code, event?.home?.name] : awayPicked ? [event?.away?.code, event?.away?.name] : [pick];
  if (!pickNames.some((value) => sameTeam(value, match.outcomeTeam))) return null;
  const base = quote.mid ?? quote.indicative;
  return base == null ? null : base;
}

export function buildOverlays(events, poly, kalshi, now) {
  const out = new Map();
  for (const event of events) {
    if (!event.prediction?.pick || !Number.isFinite(Number(event.prediction?.prob))) continue;
    const pick = event.prediction.pick;
    const pickValues = [pick];
    if ([event.home?.code, event.home?.name].some((value) => canonicalTeam(value) === canonicalTeam(pick))) pickValues.push(event.home?.code, event.home?.name);
    if ([event.away?.code, event.away?.name].some((value) => canonicalTeam(value) === canonicalTeam(pick))) pickValues.push(event.away?.code, event.away?.name);
    const outcomeMatches = (item) => pickValues.some((value) => sameTeam(value, item.outcomeTeam));
    const pmResult = matchProviderEventResult(event, poly.filter((item) => (!item.league || item.league === event.sport) && outcomeMatches(item)));
    // Kalshi exposes expected settlement (typically game start + duration), not
    // the exact scheduled tip/kickoff. Five hours covers that offset; multiple
    // same-team events (doubleheaders) remain ambiguous and fail closed.
    const kmResult = matchProviderEventResult(event, kalshi.filter((item) => (!item.league || item.league === event.sport) && outcomeMatches(item)), { toleranceMs: 5 * 3600e3 });
    const pm = pmResult.match, km = kmResult.match;
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
    // A market_fact probability was already de-vigged by its native market
    // shape (including soccer 1X2). Reusing it avoids incorrectly collapsing
    // soccer to two sides and manufacturing a disagreement by dropping draw.
    const bookProb = event.selection_scope === 'market_fact' ? Number(event.prediction.prob)
      : homeProb == null ? null : (pickHome ? Number(homeProb) : 1 - Number(homeProb));
    const books = bookProb == null ? null : { prob: bookProb, n: odds?.consensus?.n_books ?? odds?.n_books ?? odds?.books?.length ?? 1,
      disagreement: odds?.book_disagreement ?? 0, as_of: odds?.captured_at_open || null };
    const consensus = intelligenceState({ aaProb: event.prediction.prob, bookProb, polyProb: pprob, kalshiProb: kprob,
      bookDisagreement: books?.disagreement, move30m: 0 });
    out.set(`${event.sport}:${event.event_id}`, { books,
      polymarket: pm ? { matched: true, market_id: pm.conditionId, prob: pprob, ...pq,
        reason: pq?.usable ? 'matched' : 'quote_rejected' } : { matched: false, reason: pmResult.state, candidates: pmResult.candidates },
      kalshi: km ? { matched: true, ticker: km.ticker, prob: kprob, ...kq,
        reason: kq?.usable ? 'matched' : 'quote_rejected' } : { matched: false, reason: kmResult.state, candidates: kmResult.candidates },
      wallet_signal: null, consensus });
  }
  return out;
}

async function cf(path, init, tries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init?.headers || {}) }, signal: timeout(15000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) {
        const error = new Error(`Cloudflare ${response.status}: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt >= tries || error?.retryable === false) break;
      log({ message: 'cloudflare write retry', path, attempt, error: String(error?.message || error) });
      await sleep(Math.min(3000, 400 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

async function readKvJson(key) {
  if (!TOKEN) return null;
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_ID}/values/${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json', 'cache-control': 'no-cache' }, signal: timeout(12000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`kv_get_${response.status}`);
    return await response.json();
  } catch (error) {
    log({ message: 'kv read failed', key, error: String(error?.message || error) });
    return null;
  }
}

async function loadWalletProfiles() {
  const doc = await readKvJson('intelligence:wallets');
  return Array.isArray(doc?.profiles) ? doc.profiles.filter((profile) => profile?.w) : [];
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
        if (row.market.asset && String(trade.asset || '') !== String(row.market.asset)) continue;
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
  log({ message: 'publish started', content_hash: doc.content_hash, bytes: Buffer.byteLength(payload), slate: doc.slate.length });
  // `intelligence:today` is the commit marker. Write history and ledgers first
  // so a partial failure leaves the old latest snapshot eligible for retry.
  await cf(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_ID}/values/${encodeURIComponent(`intelligence:day:${doc.date}`)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: payload,
  });
  const d1Result = await cf(`/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`, { method: 'POST', headers: { 'content-type': 'application/json' },
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
  await cf(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_ID}/values/intelligence%3Atoday`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: payload,
  });
  let readback = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    readback = await readKvJson('intelligence:today');
    if (readback?.content_hash === doc.content_hash) break;
    if (attempt < 10) await sleep(3000);
  }
  if (!readback || readback.content_hash !== doc.content_hash) {
    throw new Error(`kv_readback_mismatch expected=${doc.content_hash} actual=${readback?.content_hash || 'missing'}`);
  }
  log({ message: 'publish verified', content_hash: doc.content_hash,
    d1: d1Result?.result?.[0]?.meta || null, combos: combos.length, kv_readback: true });
}

export async function run(now = new Date()) {
  const startedAt = Date.now(), nowIso = now.toISOString(), nowMs = now.getTime();
  resetTelemetry();
  if (!DRY_RUN && !FORCE && MIN_AGE_MINUTES > 0) {
    const current = await readKvJson('intelligence:today') || await getJson(`${AA_API}/v1/intelligence/today?freshness=${Date.now()}`,
      { optional: true, tries: 2, label: 'freshness-preflight' });
    const decision = freshnessDecision(current, nowMs, MIN_AGE_MINUTES, FORCE), ageMinutes = decision.age_minutes;
    if (decision.skip) {
      log({ message: 'freshness preflight skip', trigger: TRIGGER, age_minutes: +ageMinutes.toFixed(1),
        min_age_minutes: MIN_AGE_MINUTES, as_of: current.as_of });
      return { skipped: true, reason: 'fresh', age_minutes: ageMinutes };
    }
    log({ message: 'freshness preflight run', trigger: TRIGGER, force: false,
      age_minutes: ageMinutes == null ? null : +ageMinutes.toFixed(1), min_age_minutes: MIN_AGE_MINUTES });
  } else if (!DRY_RUN) {
    log({ message: 'freshness preflight run', trigger: TRIGGER, force: FORCE, min_age_minutes: MIN_AGE_MINUTES });
  }
  const [aaEvents, marketEvents] = await Promise.all([fetchAaEvents(), fetchMarketEvents(now)]);
  const events = [...aaEvents, ...marketEvents];
  if (telemetry.critical_ok === 0) throw new Error('all_critical_scoreboards_unavailable');
  const [polyDocs, kalshiDocs, walletProfiles] = await Promise.all([
    Promise.all(SPORTS.map((sport) => getJson(
      `https://gamma-api.polymarket.com/events?tag_slug=${POLY_TAG[sport]}&closed=false&limit=500&order=startDate&ascending=false`, { optional: true }))),
    Promise.all(SPORTS.map((sport) => getJson(
      `https://external-api.kalshi.com/trade-api/v2/events?series_ticker=${KALSHI_SERIES[sport]}&status=open&limit=200&with_nested_markets=true`, { optional: true }))),
    loadWalletProfiles(),
  ]);
  const poly = polyCandidates(polyDocs, nowIso), kalshi = kalshiCandidates(kalshiDocs, nowIso);
  const overlays = buildOverlays(events, poly, kalshi, nowMs);
  await attachWalletSignals(events, poly, overlays, walletProfiles, nowMs);
  const slate = sanitizePublicSlate(events, overlays, { max: 12, now: nowMs });
  const comboItems = buildShadowCombos(slate, { max: 3 });
  const marketBundles = buildMarketBundles(slate, { max: 3 });
  if (!slate.length && telemetry.critical_failed > 0 && !DRY_RUN) {
    const previous = await readKvJson('intelligence:today');
    const previousFuture = previousFutureCount(previous, nowMs);
    if (previousFuture) {
      log({ message: 'empty partial snapshot rejected; previous KV preserved', previous_future: previousFuture,
        critical_ok: telemetry.critical_ok, critical_failed: telemetry.critical_failed });
      return { preserved: true, reason: 'partial_empty', previous_future: previousFuture };
    }
    throw new Error(`partial_empty_snapshot critical_ok=${telemetry.critical_ok} critical_failed=${telemetry.critical_failed}`);
  }
  const doc = { version: 'intelligence_v2', date: etDate(now), state: telemetry.critical_failed ? 'degraded' : slate.length ? 'fresh' : 'degraded', as_of: nowIso,
    next_refresh: new Date(nowMs + 30 * 60e3).toISOString(),
    cadence: '30m_redundant', sources: { aa: { ok: aaEvents.length > 0 }, books: { ok: slate.some((x) => x.books) },
      polymarket: { ok: poly.length > 0, markets: poly.length }, kalshi: { ok: kalshi.length > 0, markets: kalshi.length } },
    slate, combos: { state: 'closed', items: comboItems, gate: { passed: false, approved: false, public: false, reason: 'combos_forward_validation_pending' },
      sample: { n: 0, dates: 0, min_forward: 100, min_dates: 30 } },
    market_bundles: marketBundles,
    source_health: { requests: telemetry.requests, retries: telemetry.retries, ok: telemetry.ok, failed: telemetry.failed,
      critical_ok: telemetry.critical_ok, critical_failed: telemetry.critical_failed, by_host: telemetry.by_host },
    budget: { kv_writes: 2, d1_rows: 1 + comboItems.length, max_kv_writes_day: 120, max_d1_rows_day: 5000 },
    alerts: false, telegram: false };
  doc.content_hash = createHash('sha256').update(JSON.stringify(doc)).digest('hex');
  if (DRY_RUN) console.log(JSON.stringify(doc, null, 2));
  else {
    await publish(doc);
    log({ message: 'market intelligence complete', trigger: TRIGGER, duration_ms: Date.now() - startedAt,
      state: doc.state, slate: slate.length, sports: [...new Set(slate.map((item) => item.sport))],
      poly_matches: slate.filter((item) => item.polymarket?.prob != null).length,
      kalshi_matches: slate.filter((item) => item.kalshi?.prob != null).length,
      bundles: marketBundles.map((bundle) => bundle.legs.length), source_health: doc.source_health });
  }
  return doc;
}

if (process.argv[1]?.endsWith('market_intelligence.mjs')) run().catch((error) => {
  console.error(JSON.stringify({ message: 'market intelligence failed', error: String(error?.stack || error) }));
  process.exitCode = 1;
});
