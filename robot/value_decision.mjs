// Prospective moneyline decision experiment. Always shadow; never places bets.
import { createHash } from 'node:crypto';
import { americanDecimal, expectedValue, validProbability } from '../cloudflare/lib/value_contract.mjs';
export const VALUE_POLICY = Object.freeze({
  version: 'value-shadow-v1', probabilityHaircut: .03, minimumStressEV: .02,
  costPerUnit: 0, maxQuoteAgeSeconds: 900, maxProbabilityAgeSeconds: 3600,
  maxMinutesBeforeStart: 180, minSecondsBeforeStart: 60, maxSelectionsPerDay: 2,
  requireLineups: true,
});
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
export const digest = x => createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
const ms = x => typeof x === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(x) ? Date.parse(x) : NaN;
const age = (now, then) => Number.isFinite(now) && Number.isFinite(then) ? (now - then) / 1000 : null;
const explicitPre = row => /^(pre|pre-game|scheduled|warmup|preview)$/i.test(String(row?.observed?.status ?? row?.status ?? ''));
function validatePolicy(p) {
  for (const k of ['probabilityHaircut','minimumStressEV','costPerUnit','maxQuoteAgeSeconds','maxProbabilityAgeSeconds','maxMinutesBeforeStart','minSecondsBeforeStart','maxSelectionsPerDay']) {
    if (!Number.isFinite(p[k]) || p[k] < 0) throw new Error(`Invalid value policy: ${k}`);
  }
  if (p.probabilityHaircut >= 1 || !Number.isInteger(p.maxSelectionsPerDay) || !p.version || typeof p.requireLineups !== 'boolean') throw new Error('Invalid value policy');
}
// Capture only current moneylines from the provider response. Historical open/
// close fallbacks stay useful as context but cannot become executable quotes.
export function currentQuotes(items, capturedAt, source) {
  const price = side => {
    const raw = side?.moneyLine ?? side?.current?.moneyLine?.american ?? side?.current?.moneyLine;
    return String(raw).toUpperCase() === 'EVEN' ? 100 : americanDecimal(raw) == null ? null : Number(raw);
  };
  return (Array.isArray(items) ? items : []).map(it => ({
    provider: it?.provider?.name ?? null,
    ml_home: price(it?.homeTeamOdds), ml_away: price(it?.awayTeamOdds),
    captured_at: capturedAt, source, price_scope: 'current_observed',
    market: 'moneyline', period: 'full_game', execution_verified: false,
  }));
}
export function evaluateValueDecision(row, { asOf, probabilityAsOf, modelSignature, startersVerified = false, policy = VALUE_POLICY } = {}) {
  validatePolicy(policy);
  const now = ms(asOf), start = ms(row?.first_pitch ?? row?.game_datetime), generated = ms(probabilityAsOf);
  const p = row?.p_final, featureAge = age(now, generated), until = age(start, now);
  const blocked = [];
  if (!row?.game_pk || !row?.home || !row?.away || row.home === row.away) blocked.push('invalid_event_identity');
  if (!validProbability(p)) blocked.push('missing_final_probability');
  if (!Number.isFinite(now) || !Number.isFinite(start) || now >= start || !explicitPre(row)) blocked.push('not_verified_pregame');
  if (featureAge == null || featureAge < 0 || featureAge > policy.maxProbabilityAgeSeconds) blocked.push('probability_time_invalid_or_stale');
  if (until != null && (until > policy.maxMinutesBeforeStart * 60 || until < policy.minSecondsBeforeStart)) blocked.push('outside_decision_window');
  if (!modelSignature) blocked.push('missing_model_signature');
  if (startersVerified !== true) blocked.push('starters_unverified');
  if (row?.scratch_warning || row?.invalid_reason) blocked.push('invalidated_analysis');
  if (policy.requireLineups && row?.lineup_features?.both_complete !== true) blocked.push('lineups_unconfirmed');
  const quotes = Array.isArray(row?.odds?.economic_quotes) ? row.odds.economic_quotes : [];
  if (!quotes.length) blocked.push('no_timestamped_quotes');
  // Only freshest observation per provider, never choose a better obsolete quote.
  const latest = new Map();
  for (const q of quotes) {
    const key = String(q?.provider ?? '').trim().toLowerCase();
    if (!key) continue;
    const old = latest.get(key);
    if (!old || (Number.isFinite(ms(q.captured_at)) && (!Number.isFinite(ms(old.captured_at)) || ms(q.captured_at) >= ms(old.captured_at)))) latest.set(key,q);
  }
  if (!latest.size && quotes.length) blocked.push('no_identified_provider');
  const alternatives = [];
  for (const [key,q] of [...latest.entries()].sort(([a],[b]) => a.localeCompare(b))) {
    const qAge = age(now,ms(q.captured_at)), dh = americanDecimal(q.ml_home), da = americanDecimal(q.ml_away);
    const issues = [...blocked];
    if (q.price_scope !== 'current_observed' || q.market !== 'moneyline' || q.period !== 'full_game') issues.push('wrong_price_contract');
    if (qAge == null || qAge < 0 || qAge > policy.maxQuoteAgeSeconds || ms(q.captured_at) >= start) issues.push('quote_time_invalid_or_stale');
    if (dh == null || da == null) issues.push('incomplete_two_sided_prices');
    for (const side of ['home','away']) {
      const probability = validProbability(p) ? (side === 'home' ? p : 1-p) : null;
      const price = q[`ml_${side}`], decimal = americanDecimal(price);
      const stressed = probability == null ? null : Math.max(0, probability-policy.probabilityHaircut);
      const ev = expectedValue(probability,price,{costPerUnit:policy.costPerUnit});
      const stressEV = expectedValue(stressed,price,{costPerUnit:policy.costPerUnit});
      const market = dh && da ? (side === 'home' ? 1/dh : 1/da)/(1/dh+1/da) : null;
      const reasons = [...issues];
      if (ev == null || ev <= 0) reasons.push('nonpositive_expected_value');
      if (stressEV == null || stressEV < policy.minimumStressEV) reasons.push('stress_margin_not_met');
      alternatives.push({ side, team: row?.[side] ?? null, provider:q.provider, provider_key:key,
        probability, price:decimal == null ? null:Number(price), decimal_price:decimal,
        market_probability:market, expected_value:ev, stress_expected_value:stressEV,
        minimum_decimal_price:stressed > 0 ? (1+policy.costPerUnit+policy.minimumStressEV)/stressed : null,
        quote_captured_at:q.captured_at ?? null, source:q.source ?? null, quote_age_seconds:qAge,
        eligible_shadow:reasons.length===0, blocked_reasons:[...new Set(reasons)], execution_verified:false });
    }
  }
  const eligible = alternatives.filter(a => a.eligible_shadow).sort((a,b) => b.stress_expected_value-a.stress_expected_value || b.expected_value-a.expected_value || a.provider_key.localeCompare(b.provider_key) || a.side.localeCompare(b.side));
  return { schema:'aa-value-decision-v1', event_id:String(row?.game_pk ?? ''), home:row?.home ?? null, away:row?.away ?? null,
    start:row?.first_pitch ?? row?.game_datetime ?? null, evaluated_at:asOf,
    probability_as_of:probabilityAsOf ?? null, probability_source:'p_final', model_signature:modelSignature ?? null,
    policy, policy_signature:digest(policy), prob_home:validProbability(p)?p:null,
    probability_stress_note:'Sensitivity scenario, not a confidence interval',
    horizon:until==null?null:until<=900?'T15':until<=3600?'T60':until<=10800?'T180':'early',
    starters:{home:row?.home_probable_pitcher_id??null,away:row?.away_probable_pitcher_id??null,verified:startersVerified===true},
    lineup_complete:row?.lineup_features?.both_complete===true,
    alternatives, candidate:eligible[0]??null, action:eligible.length?'shadow_candidate':'abstain',
    blocked_reasons:eligible.length?[]:[...new Set([...blocked,...alternatives.flatMap(a=>a.blocked_reasons)])],
    public_picks_enabled:false, execution_verified:false, scope:'shadow_research' };
}
export function appendValueDecisions(existing, rows, { date, asOf, probabilityAsOf, modelSignature, officialPitchers = {}, policy = VALUE_POLICY } = {}) {
  validatePolicy(policy);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date||'')) throw new Error('Invalid ledger date');
  if (existing && (existing.schema !== 'aa-value-ledger-v1' || existing.date !== date || !Array.isArray(existing.snapshots))) throw new Error('Incompatible value ledger');
  const ledger = structuredClone(existing ?? {schema:'aa-value-ledger-v1',date,snapshots:[],settlements:{},public_picks_enabled:false});
  for(const s of ledger.snapshots){const {id,...payload}=s;if(id!==digest(payload))throw new Error('Value decision checksum mismatch');}
  const counts=new Map();for(const r of rows||[])counts.set(String(r.game_pk),(counts.get(String(r.game_pk))||0)+1);
  const candidates=(rows||[]).map(row=>{
    const official=officialPitchers[String(row.game_pk)];
    const verified=!!official?.h && !!official?.a && String(official.h)===String(row.home_probable_pitcher_id) && String(official.a)===String(row.away_probable_pitcher_id);
    const d=evaluateValueDecision(row,{asOf,probabilityAsOf,modelSignature,startersVerified:verified,policy});
    if ((row.date ?? row.game_date) !== date) { d.action='abstain'; d.candidate=null; d.blocked_reasons.push('event_outside_ledger_date'); }
    if(counts.get(d.event_id)>1){d.action='abstain';d.candidate=null;d.blocked_reasons.push('duplicate_event');}
    return d;
  }).sort((a,b)=>(b.candidate?.stress_expected_value??-Infinity)-(a.candidate?.stress_expected_value??-Infinity)||a.event_id.localeCompare(b.event_id));
  const existingEvaluations=new Set(ledger.snapshots.map(s=>`${s.event_id}|${s.evaluated_at}|${s.policy_signature}`));
  const used=new Set(ledger.snapshots.filter(s=>s.paper_selected).map(s=>s.event_id));
  for(const d of candidates){
    const key=`${d.event_id}|${d.evaluated_at}|${d.policy_signature}`;
    if(existingEvaluations.has(key))continue;
    d.paper_selected=!!d.candidate && !used.has(d.event_id) && used.size<policy.maxSelectionsPerDay;
    if(d.paper_selected)used.add(d.event_id);
    else if(d.candidate)d.selection_blocked_reason=used.has(d.event_id)?'one_selection_per_event':'daily_exposure_limit';
    const snapshot={id:digest(d),...d};ledger.snapshots.push(snapshot);existingEvaluations.add(key);
  }
  ledger.updated_at=asOf;
  return ledger;
}
// Results are attached separately: decision bytes, rejected alternatives and
// captured prices are never replaced by later quotes or retrospective picks.
export function settleValueDecisions(existing, rows, asOf) {
  const ledger=structuredClone(existing), byId=new Map((rows||[]).map(r=>[String(r.game_pk),r]));
  for(const s of ledger.snapshots||[]){
    const {id,...payload}=s;if(id!==digest(payload))throw new Error('Value decision checksum mismatch');
    if(!s.paper_selected || ledger.settlements?.[s.id])continue;
    const r=byId.get(s.event_id);if(!r || !Number.isFinite(ms(asOf)) || ms(asOf)<=ms(s.start))continue;
    const completed=r.outcome_status==='final' && (r.home_win===0 || r.home_win===1);
    const voided=r.outcome_status==='void';if(!completed && !voided)continue;
    const win=(s.candidate.side==='home')===(r.home_win===1);
    const result=voided?'void':win?'win':'loss';
    ledger.settlements??={};ledger.settlements[s.id]={result,observed_at:asOf,
      paper_units:result==='void'?0:result==='win'?americanDecimal(s.candidate.price)-1-s.policy.costPerUnit:-1-s.policy.costPerUnit,
      execution_verified:false, label:'Hypothetical one-unit outcome at observed price; not actual profit'};
  }
  return ledger;
}
