import test from 'node:test'
import assert from 'node:assert/strict'

import { genericTeamSummary } from '../cloudflare/worker/index.js'

const team = (id, abbreviation, homeAway) => ({ homeAway, team: { id, abbreviation }, statistics: [
  { name: 'totalYards', label: 'Total Yards', displayValue: id === '1' ? '410' : '355' },
] })

const playerBlock = (id, abbreviation, homeAway) => ({ homeAway, team: { id, abbreviation }, statistics: [{
  name: 'passing', labels: ['C/ATT', 'YDS', 'TD'], athletes: [{
    athlete: { id: `${id}01`, displayName: id === '1' ? 'Home QB' : 'Away QB' }, starter: true, stats: ['20/28', '275', '2'],
  }],
}] })

const prior = (id, abbreviation, results) => ({ team: { id, abbreviation }, events: results.map((result, index) => ({
  id: `${id}-${index}`, gameDate: `2025-11-${10 + index}T20:00:00Z`, gameResult: result,
  score: result === 'W' ? '31-20' : '17-24', atVs: index % 2 ? '@' : 'vs',
  opponent: { abbreviation: `O${index}`, shortDisplayName: `Opponent ${index}` },
})) })

test('NCAAF summary sanitizes ESPN predictor, prior form, venue and football players', () => {
  const doc = genericTeamSummary({
    boxscore: {
      teams: [team('1', 'HME', 'home'), team('2', 'AWY', 'away')],
      players: [playerBlock('2', 'AWY', 'away'), playerBlock('1', 'HME', 'home')],
    },
    predictor: { homeTeam: { gameProjection: '61.4' }, awayTeam: { gameProjection: '38.6' } },
    lastFiveGames: [prior('1', 'HME', ['W', 'W', 'L', 'W', 'L']), prior('2', 'AWY', ['L', 'W', 'L', 'L', 'W'])],
    gameInfo: { venue: { fullName: 'Test Stadium', address: { city: 'Austin', state: 'TX', country: 'USA' }, grass: true } },
    injuries: [{ team: { abbreviation: 'AWY' }, injuries: [{ athlete: { displayName: 'Away RB' }, status: 'Questionable', type: { description: 'Ankle' } }] }],
  }, 'ncaaf')

  assert.deepEqual(doc.predictor, { source: 'espn_matchup_predictor', home_pct: 61.4, away_pct: 38.6 })
  assert.equal(doc.recent.home.wins, 3)
  assert.equal(doc.recent.home.win_pct, 60)
  assert.equal(doc.recent.away.losses, 3)
  assert.equal(doc.recent.home.games.length, 5)
  assert.equal(doc.players.home.groups[0].key, 'passing')
  assert.equal(doc.players.home.groups[0].rows[0].name, 'Home QB')
  assert.deepEqual(doc.venue, { name: 'Test Stadium', city: 'Austin', state: 'TX', country: 'USA', grass: true })
  assert.equal(doc.injuries[0].items[0].name, 'Away RB')
})

test('NCAAF summary fails closed on malformed predictor percentages', () => {
  const doc = genericTeamSummary({
    boxscore: { teams: [team('1', 'HME', 'home'), team('2', 'AWY', 'away')] },
    predictor: { homeTeam: { gameProjection: '75' }, awayTeam: { gameProjection: '40' } },
  }, 'ncaaf')
  assert.equal(doc.predictor, null)
  assert.equal(doc.recent, null)
  assert.equal(doc.players, null)
})
