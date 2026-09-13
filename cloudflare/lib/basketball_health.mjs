// Producer liveness is independent of prediction freshness. No model gates here.
export const BASKETBALL_INTERVALS = Object.freeze({ nba: 360, wnba: 60 });
export function basketballDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
export function basketballNextDate(date) {
  return new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
}
const time = value => typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
const age = (value, now) => Number.isFinite(time(value)) && time(value) <= now + 60000 ? Math.max(0, Math.floor((now - time(value)) / 1000)) : null;
const integer = value => typeof value === 'number' && Number.isInteger(value) && value >= 0;
export function validateBasketballEvidence(evidence, sport, now = Date.now()) {
  if (!evidence || evidence.schema !== 'aa-basketball-capture-v1' || evidence.sport !== sport
    || evidence.complete !== true || evidence.source_failures !== 0 || !evidence.run_id
    || !Array.isArray(evidence.schedule)) return false;
  const interval = BASKETBALL_INTERVALS[sport];
  if (!interval) return false;
  const today = basketballDate(now), dates = [today, basketballNextDate(today)];
  if (evidence.schedule.some(row => !row || typeof row !== 'object') || evidence.schedule.length !== 2 || new Set(evidence.schedule.map(row => row.date)).size !== 2) return false;
  return dates.every(date => {
    const row = evidence.schedule.find(item => item.date === date);
    const elapsed = age(row?.checked_at, now);
    return row?.source === 'espn' && row?.complete === true && integer(row.events)
      && integer(row.eligible_pregame) && integer(row.logged)
      && row.eligible_pregame <= row.events && row.logged === row.eligible_pregame
      && elapsed != null && elapsed <= interval * 120;
  });
}
export function assessBasketballHealth({ sport, heartbeat = null, predictions = null, now = Date.now() }) {
  const interval = BASKETBALL_INTERVALS[sport];
  if (!interval) throw new Error('unsupported_basketball_sport');
  const lastSuccess = heartbeat?.last_success_at || null;
  const producerAge = age(lastSuccess, now), predictionTime = predictions?.updated_at || null;
  const predictionAge = age(predictionTime, now);
  const pending = predictions?.pending_grading == null ? null : Number(predictions.pending_grading);
  let evidence = null;
  try { evidence = typeof heartbeat?.evidence_json === 'string' ? JSON.parse(heartbeat.evidence_json) : null; } catch {}
  const scheduleValid = evidence?.run_id === heartbeat?.run_id && validateBasketballEvidence(evidence, sport, now);
  const producerStatus = heartbeat?.attempt_status === 'failed' ? 'failed'
    : heartbeat?.attempt_status === 'running' ? 'running'
    : heartbeat?.attempt_status !== 'success' || producerAge == null ? 'unknown'
    : producerAge > interval * 120 ? 'stale' : 'healthy';
  let state = producerStatus === 'healthy' ? 'active' : 'producer_' + producerStatus;
  if (producerStatus === 'running' && (age(heartbeat?.attempt_started_at, now) == null || age(heartbeat?.attempt_started_at, now) > 1800)) state = 'producer_stale';
  if (producerStatus === 'healthy') {
    if (!scheduleValid) state = 'schedule_unverified';
    else if (pending == null || !Number.isFinite(pending) || pending < 0) state = 'grading_unverified';
    else if (pending > 0) state = 'pending_grading';
    else if (evidence.schedule.find(row => row.date === basketballDate(now)).events === 0) state = 'idle_no_games';
  }
  return {
    schema: 'aa-basketball-producer-health-v1', sport,
    ok: ['active', 'idle_no_games'].includes(state), state,
    producer_status: state === 'producer_stale' ? 'stale' : producerStatus,
    last_success_at: lastSuccess, last_attempt_at: heartbeat?.attempt_started_at || null,
    last_attempt_status: heartbeat?.attempt_status || 'unknown',
    prediction_updated_at: predictionTime,
    prediction_status: predictionAge == null ? 'unknown' : predictionAge > interval * 120 ? 'stale' : 'fresh',
    prediction_age_seconds: predictionAge, pending_grading_count: pending,
    schedule_status: scheduleValid ? 'verified' : 'unverified',
    schedule_date: scheduleValid ? basketballDate(now) : null,
    scheduled_games: scheduleValid ? evidence.schedule.find(row => row.date === basketballDate(now)).events : null,
    interval_minutes: interval, age_seconds: producerAge,
    latest: { captured_at: lastSuccess, n: Number(predictions?.n || 0), graded: Number(predictions?.graded || 0) },
    model_publication_unchanged: true,
  };
}
