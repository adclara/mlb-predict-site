import test from 'node:test';
import assert from 'node:assert/strict';
import { aaFaceAsset, FACE_HOSTS } from '../cloudflare/lib/assets.mjs';

test('official face catalog builds the expected keyless URL for every supported sport', () => {
  const cases = {
    mlb: 'https://midfield.mlbstatic.com/v1/people/42/spots/240',
    nba: 'https://cdn.nba.com/headshots/nba/latest/260x190/42.png',
    nfl: 'https://a.espncdn.com/i/headshots/nfl/players/full/42.png',
    tennis: 'https://a.espncdn.com/i/headshots/tennis/players/full/42.png',
    wnba: 'https://a.espncdn.com/i/headshots/wnba/players/full/42.png',
    nhl: 'https://a.espncdn.com/i/headshots/nhl/players/full/42.png',
    ncaaf: 'https://a.espncdn.com/i/headshots/college-football/players/full/42.png',
    ncaam: 'https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/42.png',
    soccer: 'https://a.espncdn.com/i/headshots/soccer/players/full/42.png',
  };
  for (const [sport, expected] of Object.entries(cases)) assert.equal(aaFaceAsset({ sport, id: 42 }), expected, sport);
  assert.deepEqual(Object.keys(FACE_HOSTS).sort(), Object.keys(cases).sort());
});

test('face catalog accepts only the per-sport HTTPS allowlist and otherwise falls back safely', () => {
  assert.equal(aaFaceAsset({ sport: 'nba', href: 'https://cdn.nba.com/headshots/nba/latest/260x190/7.png' }), 'https://cdn.nba.com/headshots/nba/latest/260x190/7.png');
  assert.equal(aaFaceAsset({ sport: 'nba', href: 'http://cdn.nba.com/insecure.png' }), null);
  assert.equal(aaFaceAsset({ sport: 'nba', href: 'https://evil.example/steal.png' }), null);
  assert.equal(aaFaceAsset({ sport: 'nba', href: 'https://evil.example/steal.png', id: 7 }), 'https://cdn.nba.com/headshots/nba/latest/260x190/7.png');
  assert.equal(aaFaceAsset({ sport: 'mlb', href: 'https://a.espncdn.com/i/headshots/mlb/players/full/7.png' }), null);
  assert.equal(aaFaceAsset({ sport: 'mlb', id: '../7' }), null);
  assert.equal(aaFaceAsset({ sport: 'unsupported', id: 7 }), null);
});
