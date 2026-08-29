// AA Sports — morning publication watchdog.
//
// GitHub's scheduled delivery is best-effort and may skip every morning cron.
// Redundant schedules plus independent workflow_run completions call this
// preflight. It repairs only when today's future slate still has zero AA
// predictions, and becomes a no-op after a verified publication.

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export const WATCHDOG_CRON = '12,27,42,57 11,12 * * *'
const DEFAULT_API = 'https://aa-sports-api.opsmira9.workers.dev'
const ET = 'America/New_York'
const REPAIR_EVENTS = new Set(['workflow_run'])

export function etParts(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: ET, hour: 'numeric', hour12: false,
  }).format(now)) % 24
  return { date, hour }
}

export function publicationState(doc, today, now = new Date()) {
  const events = Array.isArray(doc?.events) ? doc.events : []
  const published = events.filter((event) => event?.prediction?.pick
    && Number.isFinite(Number(event?.prediction?.prob))).length
  const nowMs = now.getTime()
  const starts = events.map((event) => Date.parse(event?.start || ''))
  const future = starts.filter((start) => Number.isFinite(start) && start > nowMs).length
  const unknown = starts.filter((start) => !Number.isFinite(start)).length
  if (doc?.date !== today) return { needsRun: true, reason: `wrong_date:${doc?.date || 'missing'}`, events: events.length, published, future, unknown }
  if (!events.length) return { needsRun: false, reason: 'no_games', events: 0, published: 0, future: 0, unknown: 0 }
  if (published > 0) return { needsRun: false, reason: 'already_published', events: events.length, published, future, unknown }
  if (unknown) return { needsRun: true, reason: 'invalid_start_times', events: events.length, published: 0, future, unknown }
  if (!future) return { needsRun: false, reason: 'no_future_games', events: events.length, published: 0, future: 0, unknown: 0 }
  return { needsRun: true, reason: 'all_predictions_pending', events: events.length, published: 0, future, unknown: 0 }
}

export async function decideMorningRun({
  eventName, schedule, now = new Date(), fetchImpl = fetch, apiBase = DEFAULT_API,
} = {}) {
  const repairTrigger = (eventName === 'schedule' && schedule === WATCHDOG_CRON) || REPAIR_EVENTS.has(eventName)
  if (!repairTrigger) {
    return { run: true, reason: 'regular_hourly_or_manual' }
  }
  const et = etParts(now)
  // Never publish before the advertised cutoff. A delayed repair remains safe
  // after 8am: the causal ledger excludes games that have already started and
  // publicationState stops retries once no future games remain.
  if (et.hour < 7) return { run: false, reason: `before_publication_window:${et.hour}`, date: et.date }
  try {
    const response = await fetchImpl(`${apiBase}/v1/mlb/today`, {
      headers: { accept: 'application/json', 'user-agent': 'aa-sports-watchdog/1.0' },
    })
    if (!response.ok) throw new Error(`http_${response.status}`)
    const state = publicationState(await response.json(), et.date, now)
    return { run: state.needsRun, date: et.date, ...state }
  } catch (error) {
    // Fail open: the repair run is safer than leaving the app frozen. The
    // robot/uploader still enforce all causal and publication guards.
    return { run: true, reason: `preflight_failed:${error.message}`, date: et.date }
  }
}

async function main() {
  const decision = await decideMorningRun({
    eventName: process.env.AA_GITHUB_EVENT_NAME,
    schedule: process.env.AA_GITHUB_EVENT_SCHEDULE,
    apiBase: process.env.AA_API_BASE || DEFAULT_API,
  })
  const output = process.env.GITHUB_OUTPUT
  if (output) fs.appendFileSync(output, `run=${decision.run ? 'true' : 'false'}\nreason=${decision.reason}\n`)
  console.log(JSON.stringify({ message: 'mlb publication watchdog', ...decision }))
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main()
