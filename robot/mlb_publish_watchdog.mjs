// AA Sports — morning publication watchdog.
//
// GitHub's hourly cron is best-effort and may skip the first run after 7am ET.
// The redundant morning schedule calls this preflight before running the robot.
// It repairs only when today's public slate still has zero AA predictions.

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export const WATCHDOG_CRON = '12,27,42,57 11,12 * * *'
const DEFAULT_API = 'https://aa-sports-api.opsmira9.workers.dev'
const ET = 'America/New_York'

export function etParts(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: ET, hour: 'numeric', hour12: false,
  }).format(now)) % 24
  return { date, hour }
}

export function publicationState(doc, today) {
  const events = Array.isArray(doc?.events) ? doc.events : []
  const published = events.filter((event) => event?.prediction?.pick
    && Number.isFinite(Number(event?.prediction?.prob))).length
  if (doc?.date !== today) return { needsRun: true, reason: `wrong_date:${doc?.date || 'missing'}`, events: events.length, published }
  if (!events.length) return { needsRun: true, reason: 'empty_slate', events: 0, published: 0 }
  if (published === 0) return { needsRun: true, reason: 'all_predictions_pending', events: events.length, published }
  return { needsRun: false, reason: 'already_published', events: events.length, published }
}

export async function decideMorningRun({
  eventName, schedule, now = new Date(), fetchImpl = fetch, apiBase = DEFAULT_API,
} = {}) {
  if (eventName !== 'schedule' || schedule !== WATCHDOG_CRON) {
    return { run: true, reason: 'regular_hourly_or_manual' }
  }
  const et = etParts(now)
  // The paired 11/12 UTC hours cover EDT and EST. Only 7–8am ET is allowed;
  // a badly delayed delivery later in the day cannot create a new slate.
  if (et.hour < 7 || et.hour > 8) return { run: false, reason: `outside_morning_window:${et.hour}`, date: et.date }
  try {
    const response = await fetchImpl(`${apiBase}/v1/mlb/today`, {
      headers: { accept: 'application/json', 'user-agent': 'aa-sports-watchdog/1.0' },
    })
    if (!response.ok) throw new Error(`http_${response.status}`)
    const state = publicationState(await response.json(), et.date)
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
