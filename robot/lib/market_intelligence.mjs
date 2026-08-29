// Pure helpers for the provider-neutral AA market-intelligence pipeline.
// No model weights live here: public AA selections arrive already calculated.
import { probs2way, probs3way } from './espn_odds.mjs';

export const MIN_PUBLIC_PROBABILITY = 0.60;
export const INTELLIGENCE_WINDOW_MS = 36 * 60 * 60 * 1000;

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

export function sameTeam(left, right) {
  const a = canonicalTeam(left), b = canonicalTeam(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && (longer.startsWith(shorter) || longer.endsWith(shorter));
}

export function extractTeams(value) {
  const text = String(value || '');
  const split = text.split(/\s+(?:vs\.?|v\.?|at|@)\s+/i);
  if (split.length !== 2) return null;
  const away = canonicalTeam(split[0]);
  const home = canonicalTeam(split[1].replace(/\?.*$/, ''));
  return away && home ? [away, home] : null;
}

export function matchProviderEventResult(aaEvent, candidates, { toleranceMs = 2 * 3600e3 } = {}) {
  const aaTeams = new Set([
    canonicalTeam(aaEvent?.away?.code || aaEvent?.away), canonicalTeam(aaEvent?.away?.name),
    canonicalTeam(aaEvent?.home?.code || aaEvent?.home), canonicalTeam(aaEvent?.home?.name),
  ].filter(Boolean));
  const aaStart = Date.parse(aaEvent?.start || aaEvent?.start_time || 0);
  const matched = (candidates || []).filter((candidate) => {
    const teams = candidate.teams || extractTeams(candidate.title || candidate.question);
    if (!teams || teams.length !== 2 || !teams.every((team) => [...aaTeams].some((aaTeam) => sameTeam(team, aaTeam)))) return false;
    const start = Date.parse(candidate.start || candidate.gameStartTime || candidate.close_time || 0);
    return Number.isFinite(aaStart) && Number.isFinite(start) && Math.abs(start - aaStart) <= toleranceMs;
  });
  return { match: matched.length === 1 ? matched[0] : null,
    state: matched.length === 1 ? 'matched' : matched.length > 1 ? 'ambiguous' : 'not_listed', candidates: matched.length };
}

export function matchProviderEvent(aaEvent, candidates, options) {
  return matchProviderEventResult(aaEvent, candidates, options).match;
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
  // `Number(null) === 0`; explicitly reject absent values so an unmatched
  // provider can never masquerade as a measured 0% market probability.
  const sources = [bookProb, polyProb, kalshiProb]
    .filter((x) => x != null && x !== '' && Number.isFinite(Number(x))).map(Number);
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

const parseRecord = (value) => {
  const match = String(value || '').match(/(\d+)\s*-\s*(\d+)/);
  if (!match) return null;
  const wins = Number(match[1]), losses = Number(match[2]);
  return { text: `${wins}-${losses}`, wins, losses, pct: wins + losses ? round4(wins / (wins + losses)) : null };
};

export function recentFormByTeam(games, max = 5) {
  const out = new Map();
  const add = (code, row) => {
    const key = canonicalTeam(code), list = out.get(key) || [];
    if (key && list.length < max) { list.push(row); out.set(key, list); }
  };
  for (const game of [...(games || [])].sort((a, b) => Date.parse(b.start || b.date || 0) - Date.parse(a.start || a.date || 0))) {
    if (game.status !== 'final') continue;
    const hs = Number(game.home?.score), as = Number(game.away?.score);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    add(game.home?.code, { w: hs > as, score: `${hs}-${as}`, opp: game.away?.code, date: game.date || String(game.start || '').slice(0, 10) });
    add(game.away?.code, { w: as > hs, score: `${as}-${hs}`, opp: game.home?.code, date: game.date || String(game.start || '').slice(0, 10) });
  }
  return out;
}

const rawAmerican = (side) => {
  if (side == null) return null;
  if (typeof side === 'number' || typeof side === 'string') {
    const value = Number(String(side).replace('+', '')); return Number.isFinite(value) && Math.abs(value) >= 20 ? value : null;
  }
  for (const stage of ['close', 'current', 'open']) {
    const level = side[stage];
    const value = level && Number(String(level.odds ?? level.american ?? level.moneyLine ?? '').replace('+', ''));
    if (Number.isFinite(value) && Math.abs(value) >= 20) return value;
  }
  const value = Number(String(side.moneyLine ?? side.odds ?? side.american ?? '').replace('+', ''));
  return Number.isFinite(value) && Math.abs(value) >= 20 ? value : null;
};

const openingOdds = (odds) => {
  const ml = odds?.moneyline;
  if (!ml || typeof ml !== 'object') return null;
  const side = (value) => value?.open ? { close: value.open } : null;
  return { moneyline: { home: side(ml.home), away: side(ml.away), draw: side(ml.draw) } };
};

export function marketEventFromEspn(event, { sport, league = null, now = Date.now(), recent = new Map() } = {}) {
  const comp = event?.competitions?.[0], state = comp?.status?.type?.state || event?.status?.type?.state;
  const start = event?.date || comp?.date || null, startMs = Date.parse(start || 0);
  if (state !== 'pre' || !Number.isFinite(startMs) || startMs <= now || startMs > now + INTELLIGENCE_WINDOW_MS) return null;
  const competitors = comp?.competitors || [], homeRaw = competitors.find((row) => row.homeAway === 'home'), awayRaw = competitors.find((row) => row.homeAway === 'away');
  const team = (row) => ({ code: row?.team?.abbreviation || row?.team?.shortDisplayName || null,
    name: row?.team?.displayName || row?.team?.shortDisplayName || row?.team?.name || null,
    logo: row?.team?.logo || row?.team?.logos?.[0]?.href || null,
    record: parseRecord(row?.records?.[0]?.summary) });
  const home = team(homeRaw), away = team(awayRaw), odds = Array.isArray(comp?.odds) ? comp.odds[0] : null;
  if (!home.code || !away.code || !odds) return null;
  const soccer = sport === 'soccer', probabilities = soccer ? probs3way(odds) : probs2way(odds);
  if (!probabilities || (!soccer && probabilities.src !== 'ml')) return null;
  const choices = soccer
    ? [{ side: 'home', pick: home.code, prob: probabilities.pH }, { side: 'away', pick: away.code, prob: probabilities.pA }]
    : [{ side: 'home', pick: home.code, prob: probabilities.pH }, { side: 'away', pick: away.code, prob: probabilities.pA }];
  const selected = choices.sort((a, b) => b.prob - a.prob)[0];
  if (!(selected.prob > MIN_PUBLIC_PROBABILITY)) return null;
  const ml = odds.moneyline || {};
  const homePrice = rawAmerican(odds.homeTeamOdds) ?? rawAmerican(ml.home), awayPrice = rawAmerican(odds.awayTeamOdds) ?? rawAmerican(ml.away);
  const price = selected.side === 'home' ? homePrice : awayPrice, open = openingOdds(odds), openProbs = open ? (soccer ? probs3way(open) : probs2way(open)) : null;
  const openProb = openProbs ? (selected.side === 'home' ? openProbs.pH : openProbs.pA) : null;
  const pickTeam = selected.side === 'home' ? home : away, opponent = selected.side === 'home' ? away : home;
  const pickRecent = recent.get(canonicalTeam(pickTeam.code)) || [], oppRecent = recent.get(canonicalTeam(opponent.code)) || [];
  const reasons = [{ code: 'market_probability', value: round4(selected.prob), provider: odds?.provider?.name || odds?.provider?.displayName || null }];
  if ((pickTeam.record?.wins || 0) + (pickTeam.record?.losses || 0) + (opponent.record?.wins || 0) + (opponent.record?.losses || 0) > 0) {
    reasons.push({ code: 'season_record', pick_record: pickTeam.record?.text || null, opponent_record: opponent.record?.text || null });
  }
  if (pickRecent.length || oppRecent.length) reasons.push({ code: 'recent_form', pick_wins: pickRecent.filter((row) => row.w).length,
    pick_n: pickRecent.length, opponent_wins: oppRecent.filter((row) => row.w).length, opponent_n: oppRecent.length });
  if (selected.side === 'home') reasons.push({ code: 'home_field' });
  if (selected.prob >= .85) reasons.push({ code: 'expensive_favorite', value: round4(selected.prob) });
  const lineMove = openProb == null ? null : round4(selected.prob - openProb);
  if (lineMove != null && Math.abs(lineMove) >= .02) reasons.push({ code: 'line_move', value: lineMove });
  return { sport, league: league || sport.toUpperCase(), event_id: String(event.id || comp.id || ''), start, status: 'pre', home, away,
    selection_scope: 'market_fact', prediction: { pick: selected.pick, prob: round4(selected.prob), price,
      engine: 'espn-market-devig-v1', provider: odds?.provider?.name || odds?.provider?.displayName || null, market_fact: true },
    odds: { provider: odds?.provider?.name || odds?.provider?.displayName || null,
      ml_home: homePrice, ml_away: awayPrice,
      over_under: Number.isFinite(Number(odds.overUnder)) ? Number(odds.overUnder) : null, spread: Number.isFinite(Number(odds.spread)) ? Number(odds.spread) : null,
      n_books: 1 },
    context: { probability_kind: 'market_devig', provider: odds?.provider?.name || odds?.provider?.displayName || null,
      price, spread: Number.isFinite(Number(odds.spread)) ? Number(odds.spread) : null,
      total: Number.isFinite(Number(odds.overUnder)) ? Number(odds.overUnder) : null, open_prob: round4(openProb), line_move: lineMove,
      pick_record: pickTeam.record, opponent_record: opponent.record, pick_recent: pickRecent, opponent_recent: oppRecent }, reasons };
}

export function sanitizePublicSlate(events, overlays = new Map(), { max = 12, minProb = MIN_PUBLIC_PROBABILITY, now = Date.now() } = {}) {
  const eligible = (events || []).filter((event) => {
    const p = event?.prediction || event;
    const gate = p?.gate;
    const start = Date.parse(event?.start || event?.start_time || 0), scope = event.selection_scope === 'market_fact' ? 'market_fact' : 'aa_public';
    const authorized = scope === 'market_fact' ? p?.market_fact === true : (!gate || (gate.passed === true && gate.approved === true && gate.public === true));
    return event?.status === 'pre' && Number.isFinite(start) && start > now && start <= now + INTELLIGENCE_WINDOW_MS
      && p?.pick && Number(p?.prob) > minProb && p?.invalidated !== true && authorized;
  });
  // One event can arrive both from the public AA document and from ESPN odds.
  // Prefer the gated AA selection for that exact matchup; otherwise keep the
  // measured market fact. This prevents duplicate legs and source confusion.
  const deduped = new Map();
  for (const event of eligible) {
    const key = `${event.sport}:${canonicalTeam(event.away?.code || event.away)}:${canonicalTeam(event.home?.code || event.home)}:${String(event.start).slice(0, 16)}`;
    const prior = deduped.get(key);
    if (!prior || (prior.selection_scope === 'market_fact' && event.selection_scope !== 'market_fact')) deduped.set(key, event);
  }
  const candidates = [...deduped.values()].sort((a, b) => Number(b?.prediction?.prob ?? b?.prob) - Number(a?.prediction?.prob ?? a?.prob));
  const chosen = [], counts = new Map(), seen = new Set();
  const add = (event) => {
    const key = `${event.sport}:${canonicalTeam(event.away?.code || event.away)}:${canonicalTeam(event.home?.code || event.home)}:${String(event.start).slice(0, 16)}`;
    if (seen.has(key) || chosen.length >= max || (counts.get(event.sport) || 0) >= 3) return;
    seen.add(key); chosen.push(event); counts.set(event.sport, (counts.get(event.sport) || 0) + 1);
  };
  for (const sport of [...new Set(candidates.map((event) => event.sport))]) add(candidates.find((event) => event.sport === sport));
  for (const event of candidates) add(event);
  chosen.sort((a, b) => Number(b?.prediction?.prob ?? b?.prob) - Number(a?.prediction?.prob ?? a?.prob));
  return chosen.map((event) => {
      const p = event.prediction || event;
      const id = `${event.sport || 'unknown'}:${event.event_id}`;
      const overlay = overlays.get(id) || {};
      const scope = event.selection_scope === 'market_fact' ? 'market_fact' : 'aa_public';
      return { id, sport: event.sport, event_id: String(event.event_id), start: event.start || event.start_time || null,
        home: event.home, away: event.away, market: p.market || 'winner', pick: p.pick,
        selection_scope: scope, probability: { value: round4(p.prob), kind: scope === 'market_fact' ? 'market_devig' : 'aa_calibrated' },
        aa: scope === 'aa_public' ? { prob: round4(p.prob), engine: p.engine || p.engine_version || null, public_gate: true } : null,
        market_pick: scope === 'market_fact' ? { prob: round4(p.prob), engine: p.engine || null, provider: p.provider || null,
          price: p.price ?? null, public_fact: true } : null,
        books: overlay.books || null, polymarket: overlay.polymarket || null, kalshi: overlay.kalshi || null,
        wallet_signal: overlay.wallet_signal || null, consensus: overlay.consensus || { state: 'insufficient', anomalies: [] },
        context: event.context || null,
        reasons: (Array.isArray(event.reasons) ? event.reasons : Array.isArray(event.snapshot?.reasons) ? event.snapshot.reasons : Array.isArray(p.reasons) ? p.reasons : []).slice(0, 8) };
    });
}

export function buildMarketBundles(slate, { max = 3 } = {}) {
  const rows = (slate || []).filter((row) => Number(row?.probability?.value) > MIN_PUBLIC_PROBABILITY);
  const candidates = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    if (rows[i].sport === rows[j].sport || rows[i].event_id === rows[j].event_id) continue;
    const legs = [rows[i], rows[j]].map((row) => ({ id: row.id, sport: row.sport, event_id: row.event_id,
      pick: row.pick, prob: row.probability.value, source: row.selection_scope, start: row.start }));
    candidates.push({ bundle_id: legs.map((leg) => leg.id).sort().join('+'), state: 'informational', joint_prob: null,
      legs, sort_score: Math.min(...legs.map((leg) => leg.prob)) });
  }
  const sports = [...new Set(rows.map((row) => row.sport))];
  let triple = null;
  if (sports.length >= 3) {
    const legs = sports.slice(0, 3).map((sport) => rows.find((row) => row.sport === sport)).filter(Boolean)
      .map((row) => ({ id: row.id, sport: row.sport, event_id: row.event_id, pick: row.pick,
        prob: row.probability.value, source: row.selection_scope, start: row.start }));
    if (legs.length === 3) triple = { bundle_id: legs.map((leg) => leg.id).sort().join('+'), state: 'informational', joint_prob: null,
      legs, sort_score: Math.min(...legs.map((leg) => leg.prob)) - .001 };
  }
  const selected = [], pairKinds = new Set();
  for (const candidate of candidates.sort((a, b) => b.sort_score - a.sort_score)) {
    const kind = candidate.legs.map((leg) => leg.sport).sort().join('+');
    if (pairKinds.has(kind)) continue;
    pairKinds.add(kind); selected.push(candidate);
    if (selected.length >= (triple ? Math.max(0, max - 1) : max)) break;
  }
  if (triple && selected.length < max) selected.push(triple);
  return selected
    .map(({ sort_score: _score, ...bundle }) => bundle);
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
