#!/usr/bin/env node
// Research-only MLB regular-season backfill for the AA Lab five-season study.
// Source: official MLB StatsAPI, free and keyless. This file never writes to
// production data/history; its output stays inside this analysis directory.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://statsapi.mlb.com/api/v1'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'seasons')
const YEARS = [2021, 2022, 2023, 2024, 2025, 2026]
const CHUNKS = [
  ['03-01', '04-30'], ['05-01', '05-31'], ['06-01', '06-30'],
  ['07-01', '07-31'], ['08-01', '08-31'], ['09-01', '10-15'],
]
const ABBR_FIX = { ATH: 'OAK', CHW: 'CWS', ARI: 'AZ' }
const fix = (abbr) => ABBR_FIX[abbr] || abbr
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function getJson(url, tries = 4) {
  let last
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'aa-sports-research/1.0' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      last = error
      if (attempt < tries) await sleep(500 * attempt)
    }
  }
  throw last
}

async function downloadSeason(year) {
  const games = []
  for (const [start, end] of CHUNKS) {
    const url = `${API}/schedule?sportId=1&gameType=R&startDate=${year}-${start}&endDate=${year}-${end}&hydrate=team`
    const payload = await getJson(url)
    for (const day of payload.dates || []) {
      for (const game of day.games || []) {
        if (game.status?.abstractGameState !== 'Final') continue
        const home = fix(game.teams?.home?.team?.abbreviation)
        const away = fix(game.teams?.away?.team?.abbreviation)
        const homeRuns = game.teams?.home?.score
        const awayRuns = game.teams?.away?.score
        if (!home || !away || homeRuns == null || awayRuns == null || homeRuns === awayRuns) continue
        games.push({
          game_pk: String(game.gamePk), date: day.date, start: game.gameDate || null, home, away,
          home_runs: Number(homeRuns), away_runs: Number(awayRuns),
        })
      }
    }
    await sleep(120)
  }
  const unique = [...new Map(games.map((game) => [game.game_pk, game])).values()]
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start)) || a.game_pk.localeCompare(b.game_pk))
  const output = {
    source: 'MLB StatsAPI schedule', season: year,
    downloaded_at: new Date().toISOString(), n: unique.length, games: unique,
  }
  fs.writeFileSync(path.join(OUT, `${year}.json`), JSON.stringify(output))
  console.log(`${year}: ${unique.length} final regular-season games`)
}

fs.mkdirSync(OUT, { recursive: true })
for (const year of YEARS) await downloadSeason(year)
