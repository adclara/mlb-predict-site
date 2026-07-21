// Migra el histórico MLB al ledger causal v2 sin borrar observaciones.
//
// - Anota cada pick con hora publicada, primer lanzamiento y ámbito de récord.
// - Marca filas nativas históricas mutables como no elegibles para entrenamiento.
// - Conserva los backfills as-of como una cohorte separada.
// - Detecta duplicados por game_pk y obtiene el marcador F5 oficial.
// - Reconstruye index.json contando solo public_live pregame.
//
// Uso:
//   node robot/migrate_mlb_ledger.mjs          # auditoría, no escribe
//   node robot/migrate_mlb_ledger.mjs --write  # aplica la migración

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const HIST = path.join(DATA, 'history')
const GAMES = path.join(HIST, 'games')
const WRITE = process.argv.includes('--write')
const API = 'https://statsapi.mlb.com/api/v1'

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const isoMs = (value) => {
  const n = Date.parse(value || '')
  return Number.isFinite(n) ? n : null
}
const dayMs = 86400000

function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function getSchedule(startDate, endDate) {
  const url = `${API}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=linescore`
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`StatsAPI ${res.status} ${startDate}..${endDate}`)
  return res.json()
}

export function scheduleFact(game, officialDate) {
  const innings = game?.linescore?.innings || []
  const firstFive = innings.filter((inning) => Number(inning.num) <= 5)
  const explicitRuns = (value) => value != null && value !== '' && Number.isFinite(Number(value))
  const completeF5 = firstFive.length >= 5 && firstFive.every((inning) =>
    explicitRuns(inning?.home?.runs) && explicitRuns(inning?.away?.runs))
  const sum = (side) => completeF5
    ? firstFive.reduce((total, inning) => total + Number(inning?.[side]?.runs || 0), 0)
    : null
  return {
    game_pk: Number(game.gamePk),
    official_date: game.officialDate || officialDate || null,
    first_pitch: game.gameDate || null,
    status: game?.status?.detailedState || null,
    f5_home_score: sum('home'),
    f5_away_score: sum('away'),
  }
}

async function loadOfficialFacts(dates) {
  const facts = new Map()
  if (!dates.length) return facts
  let cursor = dates[0]
  const last = dates[dates.length - 1]
  while (cursor <= last) {
    const end = addDays(cursor, 27) < last ? addDays(cursor, 27) : last
    const json = await getSchedule(cursor, end)
    for (const block of json.dates || []) for (const game of block.games || []) {
      const fact = scheduleFact(game, block.date)
      if (Number.isFinite(fact.game_pk)) facts.set(fact.game_pk, fact)
    }
    cursor = addDays(end, 1)
  }
  return facts
}

function scopeFor(postedAt, firstPitch, row) {
  if (row?.record_scope) return row.record_scope
  const posted = isoMs(postedAt), start = isoMs(firstPitch)
  if (posted == null || start == null) return 'legacy_unverifiable'
  if (posted < start) return 'public_live'
  if (row?.backfilled || posted - start > dayMs) return 'backtest'
  return 'late_invalid'
}

function annotatePlay(play, rec, fact, gameRow) {
  const postedAt = play.posted_at || rec.slate_frozen_at || rec.generated_at || null
  const firstPitch = play.scheduled_start_utc || fact?.first_pitch || gameRow?.game_datetime || null
  const recordScope = scopeFor(postedAt, firstPitch, gameRow)
  return {
    ...play,
    posted_at: postedAt,
    scheduled_start_utc: firstPitch,
    record_scope: recordScope,
    eligible_public_record: recordScope === 'public_live'
      && isoMs(postedAt) != null && isoMs(firstPitch) != null && isoMs(postedAt) < isoMs(firstPitch),
    ledger_version: 'v2',
  }
}

function canonicalScore(entry) {
  const { row, fileDate, fact } = entry
  let score = 0
  if (fact?.official_date && fileDate === fact.official_date) score += 16
  if (row.graded) score += 8
  if (/final/i.test(String(row.status || fact?.status || ''))) score += 4
  if (row.backfilled) score += 2
  if (row.game_date === fileDate) score += 1
  return score
}

function rebuildIndex(dailyDocs, oldIndex) {
  let w = 0, l = 0, ps = 0, lw = 0, ll = 0, lps = 0, gw = 0, gl = 0, units = 0, pricedN = 0
  const tier = { oro: { wins: 0, losses: 0 }, plata: { wins: 0, losses: 0 } }
  const lab = Object.fromEntries(['over', 'f5', 'pitcher_f5'].map((key) => [key, { wins: 0, losses: 0, pushes: 0 }]))
  const days = []
  const eligible = (pick) => pick.eligible_public_record === true && pick.record_scope === 'public_live'
  for (const rec of dailyDocs.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const plays = (rec.plays || []).filter((pick) => eligible(pick) && pick.result)
    const locks = (rec.locks || []).filter((pick) => eligible(pick) && pick.result)
    const gems = (rec.gems || []).filter((pick) => eligible(pick) && pick.result)
    for (const pick of plays) pick.result === 'win' ? w++ : pick.result === 'loss' ? l++ : ps++
    for (const pick of locks) {
      pick.result === 'win' ? lw++ : pick.result === 'loss' ? ll++ : lps++
      const group = pick.tier === 'plata' ? tier.plata : tier.oro
      if (pick.result === 'win') group.wins++
      else if (pick.result === 'loss') group.losses++
      if (pick.result === 'win' || pick.result === 'loss') {
        const price = Number(pick.price)
        if (Number.isFinite(price) && price !== 0) {
          pricedN++
          units += pick.result === 'win' ? (price > 0 ? price / 100 : 100 / Math.abs(price)) : -1
        }
      }
    }
    for (const pick of gems) pick.result === 'win' ? gw++ : pick.result === 'loss' ? gl++ : null
    for (const key of Object.keys(lab)) for (const pick of rec.market_lab?.[key] || []) {
      if (pick.result === 'win') lab[key].wins++
      else if (pick.result === 'loss') lab[key].losses++
      else if (pick.result === 'push') lab[key].pushes++
    }
    days.push({
      date: rec.date,
      n: (rec.plays || []).filter(eligible).length,
      graded: !!rec.graded,
      wins: plays.filter((p) => p.result === 'win').length,
      losses: plays.filter((p) => p.result === 'loss').length,
      locks_n: (rec.locks || []).filter(eligible).length,
      locks_wins: locks.filter((p) => p.result === 'win').length,
      locks_losses: locks.filter((p) => p.result === 'loss').length,
      gems_n: (rec.gems || []).filter(eligible).length,
      gems_wins: gems.filter((p) => p.result === 'win').length,
      gems_losses: gems.filter((p) => p.result === 'loss').length,
    })
  }
  const rate = (wins, losses) => wins + losses ? Math.round(wins / (wins + losses) * 1000) / 1000 : null
  return {
    updated_at: new Date().toISOString(),
    ledger_version: 'v2',
    record_scope: 'public_live_pregame_only',
    record: { wins: w, losses: l, pushes: ps, win_rate: rate(w, l) },
    locks_record: {
      wins: lw, losses: ll, pushes: lps, win_rate: rate(lw, ll),
      priced_n: pricedN, units: pricedN ? Math.round(units * 100) / 100 : null,
      oro: { ...tier.oro, win_rate: rate(tier.oro.wins, tier.oro.losses) },
      plata: { ...tier.plata, win_rate: rate(tier.plata.wins, tier.plata.losses) },
    },
    gems_record: { wins: gw, losses: gl, win_rate: rate(gw, gl) },
    market_lab_record: oldIndex?.market_lab_record || Object.fromEntries(
      Object.entries(lab).map(([key, value]) => [key, { ...value, win_rate: rate(value.wins, value.losses) }]),
    ),
    days: days.reverse(),
  }
}

async function main() {
  const dailyFiles = fs.readdirSync(HIST).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort()
  const gameFiles = fs.readdirSync(GAMES).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort()
  const dates = [...new Set([...dailyFiles, ...gameFiles].map((file) => file.slice(0, 10)))].sort()
  let official = new Map()
  try {
    official = await loadOfficialFacts(dates)
  } catch (error) {
    console.error(`migrate_mlb_ledger: StatsAPI no disponible; uso solo timestamps locales: ${error.message}`)
  }

  const gameDocs = new Map()
  const entriesByPk = new Map()
  for (const file of gameFiles) {
    const fileDate = file.slice(0, 10)
    const doc = read(path.join(GAMES, file))
    gameDocs.set(fileDate, doc)
    for (const row of doc.games || []) {
      const pk = Number(row.game_pk ?? row.gamePk)
      if (!Number.isFinite(pk)) continue
      const entry = { row, fileDate, fact: official.get(pk) || null }
      if (!entriesByPk.has(pk)) entriesByPk.set(pk, [])
      entriesByPk.get(pk).push(entry)
    }
  }

  const canonical = new Map()
  for (const [pk, entries] of entriesByPk) {
    entries.sort((a, b) => canonicalScore(b) - canonicalScore(a) || a.fileDate.localeCompare(b.fileDate))
    canonical.set(pk, entries[0])
  }

  const counts = {
    daily_files: dailyFiles.length, game_files: gameFiles.length, official_games: official.size,
    public_live: 0, backtest: 0, late_invalid: 0, legacy_unverifiable: 0,
    duplicate_rows: 0, training_eligible: 0, training_excluded: 0, f5_scores: 0,
  }

  for (const [fileDate, doc] of gameDocs) {
    for (const row of doc.games || []) {
      const pk = Number(row.game_pk ?? row.gamePk)
      const fact = official.get(pk) || null
      if (fact?.first_pitch && !row.first_pitch) row.first_pitch = fact.first_pitch
      if (fact) {
        row.f5_home_score = fact.f5_home_score
        row.f5_away_score = fact.f5_away_score
        row.f5_complete = fact.f5_home_score != null && fact.f5_away_score != null
        if (row.f5_complete) counts.f5_scores++
      }
      const isCanonical = canonical.get(pk)?.row === row
      const cohort = row.backfilled ? 'backfill_asof' : 'legacy_native_mutable'
      const eligible = isCanonical && cohort === 'backfill_asof' && row.graded === true
      row.integrity = {
        ledger_version: 'v2',
        cohort,
        training_eligible: eligible,
        reason: !isCanonical ? 'duplicate_game_pk'
          : cohort === 'legacy_native_mutable' ? 'pregame_features_were_overwritten_intraday'
          : row.graded !== true ? 'outcome_not_final' : 'asof_backfill',
        first_pitch: fact?.first_pitch || row.first_pitch || row.game_datetime || null,
        official_date: fact?.official_date || row.game_date || fileDate,
      }
      if (!isCanonical) {
        row.integrity.duplicate_of = `${canonical.get(pk)?.fileDate || 'unknown'}:${pk}`
        counts.duplicate_rows++
      }
      eligible ? counts.training_eligible++ : counts.training_excluded++
    }
    if (WRITE) fs.writeFileSync(path.join(GAMES, `${fileDate}.json`), JSON.stringify(doc, null, 2))
  }

  const dailyDocs = []
  for (const file of dailyFiles) {
    const rec = read(path.join(HIST, file))
    const games = gameDocs.get(rec.date)?.games || []
    const byPk = new Map(games.map((row) => [Number(row.game_pk ?? row.gamePk), row]))
    rec.slate_frozen_at ||= rec.generated_at || null
    rec.ledger_version = 'v2'
    // El pick publicado sí conserva su timestamp/resultado, pero las features
    // nativas de estos slates se sobrescribían intradía. No se permite que una
    // probabilidad/badge legacy pise el cálculo de una fila causal nueva.
    rec.selection_snapshot_verified = false
    rec.selection_snapshot_reason = 'legacy_selection_not_linked_to_immutable_feature_hash'
    for (const key of ['plays', 'locks', 'gems']) {
      rec[key] = (rec[key] || []).map((play) => {
        const pk = Number(play.game_pk ?? play.gamePk)
        const annotated = annotatePlay(play, rec, official.get(pk) || null, byPk.get(pk) || null)
        counts[annotated.record_scope] = (counts[annotated.record_scope] || 0) + 1
        return annotated
      })
    }
    dailyDocs.push(rec)
    if (WRITE) fs.writeFileSync(path.join(HIST, file), JSON.stringify(rec, null, 2))
  }

  const oldIndexPath = path.join(HIST, 'index.json')
  const oldIndex = fs.existsSync(oldIndexPath) ? read(oldIndexPath) : null
  const nextIndex = rebuildIndex(dailyDocs, oldIndex)
  const report = {
    migrated_at: new Date().toISOString(), mode: WRITE ? 'write' : 'audit', counts,
    public_record: nextIndex.record,
    policy: 'Only picks with measured posted_at < official first_pitch count as public_live.',
  }
  if (WRITE) {
    fs.writeFileSync(oldIndexPath, JSON.stringify(nextIndex, null, 2))
    fs.writeFileSync(path.join(HIST, 'ledger_migration.json'), JSON.stringify(report, null, 2))
  }
  console.log(JSON.stringify(report, null, 2))
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) await main()
