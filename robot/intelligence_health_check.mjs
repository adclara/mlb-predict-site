// Read-only production freshness gate for Central AA. Used after publication,
// by deploy diagnostics, and manually during incidents. No secrets required.
const API = 'https://aa-sports-api.opsmira9.workers.dev/v1/intelligence/today';

export function evaluateIntelligenceHealth(doc, { nowMs = Date.now(), maxAgeMinutes = 45 } = {}) {
  const reasons = [], asOfMs = Date.parse(doc?.as_of || ''), ageMinutes = Number.isFinite(asOfMs) ? Math.max(0, (nowMs - asOfMs) / 60000) : null;
  if (doc?.version !== 'intelligence_v2') reasons.push('schema');
  if (ageMinutes == null) reasons.push('missing_as_of');
  else if (ageMinutes > maxAgeMinutes) reasons.push('stale');
  if (doc?.freshness?.hard_stale === true) reasons.push('hard_stale');
  if (doc?.alerts !== false || doc?.telegram !== false) reasons.push('alerts_enabled');
  if (!Array.isArray(doc?.slate)) reasons.push('slate_shape');
  if ((doc?.slate || []).some((item) => !(Number(item?.probability?.value) > .60))) reasons.push('probability_floor');
  return { ok: reasons.length === 0, reasons, age_minutes: ageMinutes == null ? null : Math.round(ageMinutes * 10) / 10,
    state: doc?.state || null, slate: Array.isArray(doc?.slate) ? doc.slate.length : null, as_of: doc?.as_of || null };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function checkProduction({ retries = 9, waitMs = 10000, maxAgeMinutes = 45, fetcher = fetch } = {}) {
  let last = { ok: false, reasons: ['not_checked'] };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetcher(`${API}?health=${Date.now()}-${attempt}`, { headers: { accept: 'application/json', 'cache-control': 'no-cache', 'user-agent': 'aa-intelligence-health/1.0' } });
      const doc = response.ok ? await response.json() : null;
      last = response.ok ? evaluateIntelligenceHealth(doc, { maxAgeMinutes }) : { ok: false, reasons: [`http_${response.status}`] };
    } catch (error) { last = { ok: false, reasons: [String(error?.message || error)] }; }
    console.log(JSON.stringify({ message: 'intelligence health', attempt, retries, ...last }));
    if (last.ok) return last;
    if (attempt < retries) await sleep(waitMs);
  }
  throw new Error(`intelligence_unhealthy ${JSON.stringify(last)}`);
}

if (process.argv[1]?.endsWith('intelligence_health_check.mjs')) {
  const maxArg = process.argv.find((arg) => arg.startsWith('--max-age='));
  const maxAgeMinutes = maxArg ? Number(maxArg.split('=')[1]) : 45;
  checkProduction({ maxAgeMinutes }).catch((error) => { console.error(String(error?.stack || error)); process.exitCode = 1; });
}
