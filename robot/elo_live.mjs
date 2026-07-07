// Live Elo updater — keeps data/elo.json evolving daily from final scores so the
// ratings never go stale between manual deploys (the deployed file is only a
// snapshot of the private backend's Elo at deploy time).
//
// 538-style MLB Elo: K=4, home advantage 24 (engine.js HFA_ELO), margin-of-victory
// multiplier ((margin+3)^0.8)/(7.5+0.006*eloDiffWinner). Idempotent via
// data/elo_state.json {through, processed:{date:[game_pks]}}: a game is applied at
// most once; on FIRST run the state initializes to "yesterday" and applies nothing
// (the deployed elo.json already contains the season so far — re-applying history
// would double-count). If a future deploy overwrites elo.json, updates simply
// continue forward from that new base.
import fs from 'fs'

const K = 4
const HFA = 24

// Pure single-game update. game: { home, away, hs, as }. Returns delta applied.
export function eloGameUpdate(elo, { home, away, hs, as }) {
  if (hs == null || as == null || hs === as) return 0
  const eH = elo[home] ?? 1500, eA = elo[away] ?? 1500
  const expH = 1 / (1 + Math.pow(10, -((eH + HFA) - eA) / 400))
  const homeWon = hs > as ? 1 : 0
  const margin = Math.abs(hs - as)
  const winnerDiff = homeWon ? (eH + HFA) - eA : eA - (eH + HFA)
  const mov = Math.pow(margin + 3, 0.8) / (7.5 + 0.006 * Math.max(-800, Math.min(800, winnerDiff)))
  const delta = K * mov * (homeWon - expH)
  elo[home] = Math.round((eH + delta) * 10) / 10
  elo[away] = Math.round((eA - delta) * 10) / 10
  return delta
}

// Apply every not-yet-processed graded game (rows from games_v1 files), in date
// order. Mutates elo + state; returns how many games were applied.
export function applyEloUpdates(elo, state, gradedRows, { today }) {
  const rows = gradedRows
    .filter((r) => r.graded && r.final && r.date > state.through)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  let applied = 0
  for (const r of rows) {
    const done = state.processed[r.date] || (state.processed[r.date] = [])
    if (done.includes(r.game_pk)) continue
    const [as, hs] = String(r.final).split('-').map(Number)
    if (!isFinite(as) || !isFinite(hs)) continue
    eloGameUpdate(elo, { home: r.home, away: r.away, hs, as })
    done.push(r.game_pk)
    applied++
  }
  // Compact: fold fully-past dates (older than 2 days) into `through`.
  const cutoff = isoMinusDays(today, 2)
  for (const d of Object.keys(state.processed)) {
    if (d <= cutoff) { if (d > state.through) state.through = d; delete state.processed[d] }
  }
  // `through` only ratchets forward via compaction; per-date lists guard the rest.
  return applied
}

export function loadEloState(fp, today) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')) } catch { /* first run */ }
  // First run: start from yesterday — the deployed elo.json already reflects the
  // season to date; only NEW results from here on are applied.
  return { through: isoMinusDays(today, 1), processed: {} }
}

function isoMinusDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
