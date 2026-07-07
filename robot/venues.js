// Home-park longitude/latitude (deg, west negative) + summer UTC offset per team,
// for the day/night + East↔West travel factor of Estadística Adrian and the
// Open-Meteo forecast lookup (weather.mjs). Static (parks don't move); avoids a
// per-game venue fetch on the dashboard.
export const PARKS = {
  ATL: { lon: -84.5, lat: 33.9, tz: -4 }, AZ: { lon: -112.1, lat: 33.4, tz: -7 }, BAL: { lon: -76.6, lat: 39.3, tz: -4 },
  BOS: { lon: -71.1, lat: 42.3, tz: -4 }, CHC: { lon: -87.7, lat: 41.9, tz: -5 }, CIN: { lon: -84.5, lat: 39.1, tz: -4 },
  CLE: { lon: -81.7, lat: 41.5, tz: -4 }, COL: { lon: -105.0, lat: 39.8, tz: -6 }, CWS: { lon: -87.6, lat: 41.8, tz: -5 },
  DET: { lon: -83.0, lat: 42.3, tz: -4 }, HOU: { lon: -95.4, lat: 29.8, tz: -5 }, KC: { lon: -94.5, lat: 39.1, tz: -5 },
  LAA: { lon: -117.9, lat: 33.8, tz: -7 }, LAD: { lon: -118.2, lat: 34.1, tz: -7 }, MIA: { lon: -80.2, lat: 25.8, tz: -4 },
  MIL: { lon: -88.0, lat: 43.0, tz: -5 }, MIN: { lon: -93.3, lat: 45.0, tz: -5 }, NYM: { lon: -73.8, lat: 40.8, tz: -4 },
  NYY: { lon: -73.9, lat: 40.8, tz: -4 }, OAK: { lon: -121.5, lat: 38.6, tz: -7 }, PHI: { lon: -75.2, lat: 39.9, tz: -4 },
  PIT: { lon: -80.0, lat: 40.4, tz: -4 }, SD: { lon: -117.2, lat: 32.7, tz: -7 }, SEA: { lon: -122.3, lat: 47.6, tz: -7 },
  SF: { lon: -122.4, lat: 37.8, tz: -7 }, STL: { lon: -90.2, lat: 38.6, tz: -5 }, TB: { lon: -82.7, lat: 27.8, tz: -4 },
  TEX: { lon: -97.1, lat: 32.8, tz: -5 }, TOR: { lon: -79.4, lat: 43.6, tz: -4 }, WSH: { lon: -77.0, lat: 38.9, tz: -4 },
}

export function park(abbr) {
  return PARKS[abbr] || { lon: -90, tz: -5 } // league-center fallback
}
