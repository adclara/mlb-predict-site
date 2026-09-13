// Shared server-side arithmetic. No model fitting, weights or trade execution.
export const VALUE_SCHEMA = 'aa-value-v1';
export const validProbability = p => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
export function americanDecimal(price) {
  if (typeof price !== 'number' && typeof price !== 'string') return null;
  if (typeof price === 'string' && !/^[+-]?\d+(\.\d+)?$/.test(price.trim())) return null;
  const n = Number(price);
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null;
  const d = n > 0 ? 1 + n / 100 : 1 + 100 / -n;
  return Number.isFinite(d) && d > 1 ? d : null;
}
export function expectedValue(p, price, { pushProbability = 0, costPerUnit = 0 } = {}) {
  const d = americanDecimal(price);
  if (!validProbability(p) || !validProbability(pushProbability) || p + pushProbability > 1
    || !Number.isFinite(costPerUnit) || costPerUnit < 0 || d == null) return null;
  return p * (d - 1) - (1 - p - pushProbability) - costPerUnit;
}
export function twoSidedValue(pHome, odds) {
  if (!validProbability(pHome) || !odds) return null;
  const dh = americanDecimal(odds.ml_home), da = americanDecimal(odds.ml_away);
  if (dh == null || da == null) return null; // No unilateral or invented market baseline.
  const mass = 1 / dh + 1 / da;
  const marketHome = validProbability(odds.consensus?.p_home) ? odds.consensus.p_home
    : validProbability(odds.p_home_mkt) ? odds.p_home_mkt : (1 / dh) / mass;
  const side = (p, m, price) => ({
    model: p, market: m, price: Number(price), edge: p - m,
    ev: expectedValue(p, price), break_even_decimal: p > 0 ? 1 / p : null,
  });
  const home = side(pHome, marketHome, odds.ml_home);
  const away = side(1 - pHome, 1 - marketHome, odds.ml_away);
  const best = home.ev >= away.ev ? 'home' : 'away';
  return { schema: VALUE_SCHEMA, home, away, best_side: (best === 'home' ? home : away).ev > 1e-12 ? best : null };
}
