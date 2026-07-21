import test from 'node:test'
import assert from 'node:assert/strict'

import { selectPlays } from '../robot/adrian.js'

const analysis = (gamePk, prob, confScore) => {
  const play = {
    game_pk: gamePk,
    matchup: `A${gamePk} @ H${gamePk}`,
    market: 'ml',
    pick: `H${gamePk}`,
    label: `Gana H${gamePk}`,
    prob,
    confScore,
    isValue: false,
  }
  return { game_pk: gamePk, plays: [play], bestPlay: play }
}

test('selectPlays no fabrica probabilidad conjunta ni cuota justa de parlay', () => {
  const selected = selectPlays([
    analysis(1, 0.61, 0.8),
    analysis(2, 0.59, 0.7),
    analysis(3, 0.57, 0.6),
  ])
  assert.equal(selected.plays.length, 3)
  assert.equal(selected.combo, null)
  assert.equal(Object.hasOwn(selected, 'joint_probability'), false)
  assert.equal(Object.hasOwn(selected, 'fair_decimal'), false)
})
