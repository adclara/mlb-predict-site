// Pure helpers for the provider-neutral AA market-intelligence pipeline.
// No model weights live here: public AA selections arrive already calculated.

const TEAM_ALIASES = Object.freeze({
  arizona: 'AZ', 'arizona diamondbacks': 'AZ', diamondbacks: 'AZ', atlanta: 'ATL', 'atlanta braves': 'ATL',
  baltimore: 'BAL', 'baltimore orioles': 'BAL', boston: 'BOS', 'boston red sox': 'BOS', 'red sox': 'BOS',
  'chicago cubs': 'CHC', 'chicago c': 'CHC', 'chicago white sox': 'CWS', 'chicago ws': 'CWS',
  cincinnati: 'CIN', 'cincinnati reds': 'CIN', cleveland: 'CLE', 'cleveland guardians': 'CLE',
  colorado: 'COL', 'colorado rockies': 'COL', detroit: 'DET', 'detroit tigers': 'DET',
  houston: 'HOU', 'houston astros': 'HOU', 'kansas city': 'KC', 'kansas city royals': 'KC',
  'la angels': 'LAA', 'los angeles angels': 'LAA', 'los angeles a': 'LAA',
  'la dodgers': 'LAD', 'los angeles dodgers': 'LAD', 'los angeles d': 'LAD', dodgers: 'LAD',
  miami: 'MIA', 'miami marlins': 'MIA', milwaukee: 'MIL', 'milwaukee brewers': 'MIL',
  minnesota: 'MIN', 'minnesota twins': 'MIN', 'new york mets': 'NYM', 'new york m': 'NYM',
  'ny yankees': 'NYY', yankees: 'NYY', 'new york yankees': 'NYY', 'new york y': 'NYY',
  athletics: 'OAK', 'oakland athletics': 'OAK', "a s": 'OAK', philadelphia: 'PHI', 'philadelphia phillies': 'PHI',
  pittsburgh: 'PIT', 'pittsburgh pirates': 'PIT', 'san diego': 'SD', 'san diego padres': 'SD',
  seattle: 'SEA', 'seattle mariners': 'SEA', 'san francisco': 'SF', 'san francisco giants': 'SF',
  'st louis': 'STL', 'st louis cardinals': 'STL', 'tampa bay': 'TB', 'tampa bay rays': 'TB',
  texas: 'TEX', 'texas rangers': 'TEX', toronto: 'TOR', 'toronto blue jays': 'TOR',
  washington: 'WSH', 'washington nationals': 'WSH',
});

export const clamp01 = (value) => Math.max(0, Math.min(1, Number(value)));
export const round4 = (value) => value == null || !Number.isFinite(Number(value))
  ? null : Math.round(Number(value) * 1e4) / 1e4;

export function canonicalTeam(value) {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return TEAM_ALIASES[key] || raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function extractTeams(value) {
  const text = String(value || '');
  const split = text.split(/\s+(?:vs\.?|v\.?|at|@)\s+/i);
  if (split.length !== 2) return null;
  const away = canonicalTeam(split[0]);
  const home = canonicalTeam(split[1].replace(/\?.*$/, ''));
  return away && home ? [away, home] : null;
}

export function matchProviderEvent(aaEvent, candidates, { toleranceMs = 2 * 3600e3 } = {}) {
  const aaTeams = new Set([
    canonicalTeam(aaEvent?.away?.code || aaEvent?.away), canonicalTeam(aaEvent?.away?.name),
    canonicalTeam(aaEvent?.home?.code || aaEvent?.home), canonicalTeam(aaEvent?.home?.name),
  ].filter(Boolean));
  const aaStart = Date.parse(aaEvent?.start || aaEvent?.start_time || 0);
  const matched = (candidates || []).filter((candidate) => {
    const teams = candidate.teams || extractTeams(candidate.title || candidate.question);
    if (!teams || teams.length !== 2 || !teams.every((team) => aaTeams.has(canonicalTeam(team)))) return false;
    const start = Date.parse(candidate.start || candidate.gameStartTime || candidate.close_time || 0);
    return Number.isFinite(aaStart) && Number.isFinite(start) && Math.abs(start - aaStart) <= toleranceMs;
  });
  return matched.length === 1 ? matched[0] : null;
}

export function quoteFromBidAsk({ bid, ask, as_of, now = Date.now(), maxAgeMs = 75 * 60e3, maxSpread = 0.10 } = {}) {
  const b = Number(bid), a = Number(ask), ts = Date.parse(as_of || 0);
  const spread = Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
  const fresh = Number.isFinite(ts) && now - ts <= maxAgeMs && now >= ts - 60e3;
  const usable = b > 0 && a < 1 && a >= b && spread <= maxSpread && fresh;
  return { bid: round4(b), ask: round4(a), mid: usable ? round4((a + b) / 2) : null,
    spread: round4(spread), as_of: as_of || null, fresh, usable };
}

export function quoteFromMarket(market, now = Date.now()) {
  let prices = market?.outcomePrices;
  if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { prices = null; } }
  const yes = Array.isArray(prices) ? Number(prices[0]) : null;
  const bid = market?.bestBid ?? market?.yes_bid_dollars;
  const ask = market?.bestAsk ?? market?.yes_ask_dollars;
  const q = quoteFromBidAsk({ bid, ask, as_of: market?.updatedAt || market?.updated_time || new Date(now).toISOString(), now });
  return { ...q, indicative: q.usable ? q.mid : (yes > 0 && yes < 1 ? round4(yes) : null),
    volume_24h: round4(market?.volume24hr ?? market?.volume_24h_fp),
    liquidity: round4(market?.liquidityNum ?? market?.open_interest_fp) };
}

export function wilsonLowerBound(wins, n, z = 1.96) {
  if (!(n > 0) || wins < 0 || wins > n) return 0;
  const p = wins / n, z2 = z * z, d = 1 + z2 / n;
  return clamp01((p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / d);
}

export function qualifiesWallet(profile) {
  const n = Number(profile?.wins || 0) + Number(profile?.losses || 0);
  const wr = n ? Number(profile.wins || 0) / n : 0;
  return n >= 10 && wr >= 0.70 && wilsonLowerBound(Number(profile?.wins || 0), n) >= 0.50
    && Number(profile?.pnl || 0) > 0 && Number(profile?.consistency || 0) >= 0.60
    && Number(profile?.cost || 0) >= 500 && Number(profile?.wash_share || 0) < 0.30
    && Number(profile?.avg_entry || 0) <= 0.85;
}

export function intelligenceState({ aaProb, bookProb, polyProb, kalshiProb, bookDisagreement = 0, move30m = 0, walletSignal = null } = {}) {
  const sources = [bookProb, polyProb, kalshiProb].filter((x) => Number.isFinite(Number(x))).map(Number);
  const divergence = sources.length && Number.isFinite(Number(aaProb))
    ? Math.max(...sources.map((p) => Math.abs(p - Number(aaProb)))) : null;
  const anomalies = [];
  if (divergence != null && divergence >= 0.08) anomalies.push({ code: 'provider_divergence', value: round4(divergence) });
  if (Math.abs(Number(move30m || 0)) >= 0.05) anomalies.push({ code: 'market_move_30m', value: round4(move30m) });
  if (Number(bookDisagreement || 0) >= 0.04) anomalies.push({ code: 'book_disagreement', value: round4(bookDisagreement) });
  if (walletSignal?.qualified_wallets >= 3 && walletSignal?.usd >= 500) anomalies.push({ code: 'possible_informed_pattern', value: walletSignal.qualified_wallets });
  if (!sources.length) return { state: 'insufficient', market_prob: null, divergence, anomalies };
  const marketProb = sources.sort((a, b) => a - b)[Math.floor(sources.length / 2)];
  const state = Math.abs(Number(aaProb) - marketProb) <= 0.05 ? 'agree' : 'conflict';
  return { state, market_prob: round4(marketProb), divergence: round4(divergence), anomalies };
}

export function sanitizePublicSlate(events, overlays = new Map(), { max = 7 } = {}) {
  return (events || []).filter((event) => {
    const p = event?.prediction || event;
    const gate = p?.gate;
    return p?.pick && Number.isFinite(Number(p?.prob)) && p?.invalidated !== true
      && (!gate || (gate.passed === true && gate.approved === true && gate.public === true));
  }).sort((a, b) => Number(b?.prediction?.prob ?? b?.prob) - Number(a?.prediction?.prob ?? a?.prob)).slice(0, max)
    .map((event) => {
      const p = event.prediction || event;
      const id = `${event.sport || 'unknown'}:${event.event_id}`;
      const overlay = overlays.get(id) || {};
      return { id, sport: event.sport, event_id: String(event.event_id), start: event.start || event.start_time || null,
        home: event.home, away: event.away, market: p.market || 'winner', pick: p.pick,
        aa: { prob: round4(p.prob), engine: p.engine || p.engine_version || null, public_gate: true },
        books: overlay.books || null, polymarket: overlay.polymarket || null, kalshi: overlay.kalshi || null,
        wallet_signal: overlay.wallet_signal || null, consensus: overlay.consensus || { state: 'insufficient', anomalies: [] },
        reasons: Array.isArray(p.reasons) ? p.reasons.slice(0, 5) : [] };
    });
}

export function shouldRunPulse(events, now = Date.now()) {
  const active = (events || []).some((event) => {
    if (event?.status === 'live') return true;
    const start = Date.parse(event?.start || event?.start_time || 0);
    return Number.isFinite(start) && start >= now - 30 * 60e3 && start <= now + 18 * 3600e3;
  });
  return active || new Date(now).getUTCHours() % 2 === 0;
}

export function buildShadowCombos(slate, { max = 3 } = {}) {
  const rows = Array.isArray(slate) ? slate : [];
  const teams = (leg) => new Set([canonicalTeam(leg?.home?.code || leg?.home), canonicalTeam(leg?.away?.code || leg?.away)]);
  const candidates = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j];
    if (a.event_id === b.event_id) continue;
    const ta = teams(a), tb = teams(b);
    if ([...ta].some((team) => team && tb.has(team))) continue;
    const independence = Number(a?.aa?.prob) * Number(b?.aa?.prob);
    if (!Number.isFinite(independence)) continue;
    const legs = [a, b].map((leg) => ({ id: leg.id, sport: leg.sport, event_id: leg.event_id, pick: leg.pick, prob: leg.aa.prob, start: leg.start }));
    candidates.push({ combo_id: legs.map((leg) => leg.id).sort().join('+'), legs,
      independence_prob: round4(independence), joint_prob: null, ci_low: null, ci_high: null,
      state: 'shadow', reason: 'correlation_forward_sample_pending' });
  }
  return candidates.sort((a, b) => b.independence_prob - a.independence_prob).slice(0, max);
}
