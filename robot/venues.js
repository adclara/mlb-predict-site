// Home-park longitude (deg, west negative) + summer UTC offset per team, for the
// day/night + East↔West travel factor of Estadística Adrian. Static (parks don't
// move); avoids a per-game venue fetch on the dashboard.
export const PARKS = {
  ATL: { lon: -84.5, tz: -4 }, AZ: { lon: -112.1, tz: -7 }, BAL: { lon: -76.6, tz: -4 },
  BOS: { lon: -71.1, tz: -4 }, CHC: { lon: -87.7, tz: -5 }, CIN: { lon: -84.5, tz: -4 },
  CLE: { lon: -81.7, tz: -4 }, COL: { lon: -105.0, tz: -6 }, CWS: { lon: -87.6, tz: -5 },
  DET: { lon: -83.0, tz: -4 }, HOU: { lon: -95.4, tz: -5 }, KC: { lon: -94.5, tz: -5 },
  LAA: { lon: -117.9, tz: -7 }, LAD: { lon: -118.2, tz: -7 }, MIA: { lon: -80.2, tz: -4 },
  MIL: { lon: -88.0, tz: -5 }, MIN: { lon: -93.3, tz: -5 }, NYM: { lon: -73.8, tz: -4 },
  NYY: { lon: -73.9, tz: -4 }, OAK: { lon: -121.5, tz: -7 }, PHI: { lon: -75.2, tz: -4 },
  PIT: { lon: -80.0, tz: -4 }, SD: { lon: -117.2, tz: -7 }, SEA: { lon: -122.3, tz: -7 },
  SF: { lon: -122.4, tz: -7 }, STL: { lon: -90.2, tz: -5 }, TB: { lon: -82.7, tz: -4 },
  TEX: { lon: -97.1, tz: -5 }, TOR: { lon: -79.4, tz: -4 }, WSH: { lon: -77.0, tz: -4 },
}

export function park(abbr) {
  return PARKS[abbr] || { lon: -90, tz: -5 } // league-center fallback
}
