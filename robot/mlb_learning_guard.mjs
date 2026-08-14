// AA Sports MLB — guard idempotente del refit diario.
//
// GitHub Actions puede demorar un cron. El workflow anterior exigía empezar
// exactamente durante 05:xx ET y por eso terminaba verde sin ejecutar nada.
// Este guard usa el estado persistido: en un evento programado corre si el
// snapshot todavía no fue recalculado en la fecha ET actual. Pokes/manuales
// siempre corren.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ET = 'America/New_York'

export function etDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

export function learningDecision({ eventName = 'schedule', snapshot = null, now = new Date() } = {}) {
  if (eventName !== 'schedule') return { run: true, reason: `event_${eventName || 'unknown'}` }
  const today = etDate(now)
  const updatedDate = snapshot?.updated_at ? etDate(snapshot.updated_at) : null
  if (!today || !updatedDate) return { run: true, reason: 'missing_or_invalid_snapshot_timestamp' }
  if (updatedDate !== today) return { run: true, reason: `snapshot_from_${updatedDate}` }
  return { run: false, reason: `already_refit_${today}` }
}

export function verifyLearningSnapshot(snapshot, { now = new Date() } = {}) {
  const today = etDate(now)
  const updatedDate = snapshot?.updated_at ? etDate(snapshot.updated_at) : null
  const errors = []
  if (!snapshot || typeof snapshot !== 'object') errors.push('snapshot_missing')
  if (updatedDate !== today) errors.push(`updated_at_not_today:${updatedDate || 'invalid'}!=${today}`)
  if (!Number.isInteger(snapshot?.n_graded) || snapshot.n_graded < 1) errors.push('n_graded_invalid')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot?.last_date || ''))) errors.push('last_date_invalid')
  return { ok: errors.length === 0, errors, today, updated_date: updatedDate }
}

function snapshotPath() {
  const data = process.env.DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(data, 'history', 'learning.json')
}

function readSnapshot() {
  try { return JSON.parse(fs.readFileSync(snapshotPath(), 'utf8')) } catch { return null }
}

function appendOutput(lines) {
  const out = process.env.GITHUB_OUTPUT
  if (out) fs.appendFileSync(out, `${lines.join('\n')}\n`)
  else process.stdout.write(`${lines.join('\n')}\n`)
}

function main() {
  const snapshot = readSnapshot()
  if (process.argv.includes('--verify')) {
    const check = verifyLearningSnapshot(snapshot)
    console.log(JSON.stringify({ check: 'mlb_learning_snapshot', ...check, last_date: snapshot?.last_date || null }))
    if (!check.ok) process.exit(1)
    return
  }
  const decision = learningDecision({ eventName: process.env.AA_GITHUB_EVENT_NAME || 'schedule', snapshot })
  appendOutput([`run=${decision.run}`, `reason=${decision.reason}`])
  console.log(JSON.stringify({ check: 'mlb_learning_guard', ...decision, updated_at: snapshot?.updated_at || null }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
