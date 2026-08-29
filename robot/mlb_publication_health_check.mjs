// Read-only production gate for the MLB morning publication. A healthy factual
// ingest is not enough: after 7am ET, a slate with future games must contain at
// least one causally sealed AA prediction or the workflow/deploy fails.
import { etParts, publicationState } from './mlb_publish_watchdog.mjs'

const API = 'https://aa-sports-api.opsmira9.workers.dev/v1/mlb/today'

export function evaluateMlbPublicationHealth(doc, { now = new Date() } = {}) {
  const et = etParts(now)
  const events = Array.isArray(doc?.events) ? doc.events : null
  if (!events) return { ok: false, state: 'invalid', reason: 'events_shape', date: doc?.date || null }
  if (doc?.date !== et.date) return { ok: false, state: 'wrong_date', reason: `wrong_date:${doc?.date || 'missing'}`,
    date: doc?.date || null, expected_date: et.date, events: events.length, predictions: 0, future: 0 }

  const publication = publicationState(doc, et.date, now)
  if (!events.length) return { ok: true, state: 'no_games', reason: 'no_games', date: et.date,
    events: 0, predictions: 0, future: 0, hour_et: et.hour }
  if (publication.published > 0) return { ok: true, state: 'published', reason: publication.reason, date: et.date,
    events: publication.events, predictions: publication.published, future: publication.future, hour_et: et.hour }
  if (et.hour < 7) return { ok: true, state: 'waiting', reason: `before_publication_window:${et.hour}`, date: et.date,
    events: publication.events, predictions: 0, future: publication.future, hour_et: et.hour }
  if (publication.unknown) return { ok: false, state: 'invalid', reason: 'invalid_start_times', date: et.date,
    events: publication.events, predictions: 0, future: publication.future, unknown: publication.unknown, hour_et: et.hour }
  if (!publication.future) return { ok: true, state: 'closed', reason: 'no_future_games', date: et.date,
    events: publication.events, predictions: 0, future: 0, hour_et: et.hour }
  return { ok: false, state: 'overdue', reason: 'all_predictions_pending', date: et.date,
    events: publication.events, predictions: 0, future: publication.future, hour_et: et.hour }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function checkMlbPublication({ retries = 9, waitMs = 10000, fetcher = fetch, now = null } = {}) {
  let last = { ok: false, state: 'not_checked', reason: 'not_checked' }
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetcher(`${API}?publication_health=${Date.now()}-${attempt}`, {
        headers: { accept: 'application/json', 'cache-control': 'no-cache', 'user-agent': 'aa-mlb-publication-health/1.0' },
      })
      const doc = response.ok ? await response.json() : null
      last = response.ok ? evaluateMlbPublicationHealth(doc, { now: now || new Date() })
        : { ok: false, state: 'http_error', reason: `http_${response.status}` }
    } catch (error) {
      last = { ok: false, state: 'request_error', reason: String(error?.message || error) }
    }
    console.log(JSON.stringify({ message: 'mlb publication health', attempt, retries, ...last }))
    if (last.ok) return last
    if (attempt < retries) await sleep(waitMs)
  }
  throw new Error(`mlb_publication_unhealthy ${JSON.stringify(last)}`)
}

if (process.argv[1]?.endsWith('mlb_publication_health_check.mjs')) {
  checkMlbPublication().catch((error) => { console.error(String(error?.stack || error)); process.exitCode = 1 })
}
