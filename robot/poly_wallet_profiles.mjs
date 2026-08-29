// Daily causal Polymarket sports-wallet profiles for Central AA. This is a
// measurement job only: no live alerts, notifications, Telegram, or copying.
import { createHash } from 'node:crypto';
import { fetchTrades, fetchUniverse, walletMarketStats } from './lib/poly.mjs';
import { qualifiesWallet, wilsonLowerBound } from './lib/market_intelligence.mjs';

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const KV_ID = '683aa2f8846643bf8a6a8b606e5bf0b7';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;
const TAGS = ['mlb', 'nba', 'nfl', 'soccer', 'tennis', 'sports'];
const now = Math.floor(Date.now() / 1000);

export function buildWalletProfiles(universe, nowSec = now) {
  const wallets = new Map();
  for (const market of universe || []) for (const [wallet, row] of walletMarketStats(market)) {
    if (row.shares < 1) continue;
    const rec = wallets.get(wallet) || { w: wallet, markets: [] };
    const both = row.sideSh[0] > 0 && row.sideSh[1] > 0 ? Math.min(...row.sideSh) / Math.max(...row.sideSh) : 0;
    rec.markets.push({ end: market.end, pnl: row.pnl, cost: row.buyCost, avg: row.buyShares ? row.wSum / row.buyShares : null, both });
    wallets.set(wallet, rec);
  }
  const profiles = [];
  for (const rec of wallets.values()) {
    const resolved = rec.markets.filter((market) => market.pnl !== 0);
    const wins = resolved.filter((market) => market.pnl > 0).length, losses = resolved.filter((market) => market.pnl < 0).length;
    const buys = rec.markets.filter((market) => market.avg != null);
    const weeks = new Map();
    for (const market of rec.markets) {
      const week = Math.max(0, Math.floor((nowSec - market.end) / (7 * 86400)));
      weeks.set(week, (weeks.get(week) || 0) + market.pnl);
    }
    const activeWeeks = [...weeks.values()];
    const profile = { w: rec.w, wins, losses, n: wins + losses,
      win_rate: wins + losses ? wins / (wins + losses) : null, wr_lb: wilsonLowerBound(wins, wins + losses),
      pnl: rec.markets.reduce((sum, market) => sum + market.pnl, 0), cost: rec.markets.reduce((sum, market) => sum + market.cost, 0),
      consistency: activeWeeks.length ? activeWeeks.filter((pnl) => pnl > 0).length / activeWeeks.length : 0,
      wash_share: rec.markets.length ? rec.markets.filter((market) => market.both > .5).length / rec.markets.length : 1,
      avg_entry: buys.length ? buys.reduce((sum, market) => sum + market.avg, 0) / buys.length : null };
    if (qualifiesWallet(profile)) profiles.push(profile);
  }
  return profiles.sort((a, b) => b.wr_lb - a.wr_lb || b.pnl - a.pnl).slice(0, 100)
    .map((profile) => ({ ...profile, win_rate: Math.round(profile.win_rate * 1e4) / 1e4,
      wr_lb: Math.round(profile.wr_lb * 1e4) / 1e4, pnl: Math.round(profile.pnl), cost: Math.round(profile.cost),
      consistency: Math.round(profile.consistency * 1e4) / 1e4, wash_share: Math.round(profile.wash_share * 1e4) / 1e4,
      avg_entry: Math.round(profile.avg_entry * 1e4) / 1e4 }));
}

async function publish(doc) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_ID}/values/intelligence%3Awallets`, {
    method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(doc),
  });
  if (!response.ok) throw new Error(`KV ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

export async function run() {
  const universe = await fetchUniverse(TAGS, { sinceTs: now - 30 * 86400, minVol: 20000, maxMarkets: 320 });
  if (universe.length < 40) throw new Error(`resolved sports universe too small: ${universe.length}`);
  const tape = await fetchTrades(universe, { conc: 6 });
  const profiles = buildWalletProfiles(universe, now);
  const doc = { version: 'poly_wallet_profiles_v1', as_of: new Date().toISOString(), window_days: 30,
    universe: universe.length, trades: tape.totalTrades, truncated: tape.truncated, profiles,
    honesty: { copy_edge_validated: false, prior_study_gate_passed: false }, alerts: false, telegram: false };
  doc.content_hash = createHash('sha256').update(JSON.stringify(doc)).digest('hex');
  if (!TOKEN || process.argv.includes('--dry-run')) console.log(JSON.stringify({ ...doc, profiles: profiles.slice(0, 5) }, null, 2));
  else await publish(doc);
  return doc;
}

if (process.argv[1]?.endsWith('poly_wallet_profiles.mjs')) run().catch((error) => {
  console.error(JSON.stringify({ message: 'wallet profiles failed', error: String(error?.stack || error) })); process.exitCode = 1;
});
