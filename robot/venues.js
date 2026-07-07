// Home-park longitude/latitude (deg, west negative) + summer UTC offset per team,
// for the day/night + East↔West travel factor of Estadística Adrian and the
// Open-Meteo forecast lookup (weather.mjs). Static (parks don't move); avoids a
// per-game venue fetch on the dashboard.
// bearing: APPROXIMATE compass direction (deg from north) of the home-plate →
// center-field line — only used to classify forecast wind as out/in/cross
// (±45° bands tolerate the imprecision). roof: dome/retractable → wind ignored.
export const PARKS = {
  ATL: { lon: -84.5, lat: 33.9, tz: -4, bearing: 30 }, AZ: { lon: -112.1, lat: 33.4, tz: -7, bearing: 0, roof: true }, BAL: { lon: -76.6, lat: 39.3, tz: -4, bearing: 30 },
  BOS: { lon: -71.1, lat: 42.3, tz: -4, bearing: 50 }, CHC: { lon: -87.7, lat: 41.9, tz: -5, bearing: 40 }, CIN: { lon: -84.5, lat: 39.1, tz: -4, bearing: 120 },
  CLE: { lon: -81.7, lat: 41.5, tz: -4, bearing: 0 }, COL: { lon: -105.0, lat: 39.8, tz: -6, bearing: 5 }, CWS: { lon: -87.6, lat: 41.8, tz: -5, bearing: 125 },
  DET: { lon: -83.0, lat: 42.3, tz: -4, bearing: 145 }, HOU: { lon: -95.4, lat: 29.8, tz: -5, bearing: 345, roof: true }, KC: { lon: -94.5, lat: 39.1, tz: -5, bearing: 45 },
  LAA: { lon: -117.9, lat: 33.8, tz: -7, bearing: 65 }, LAD: { lon: -118.2, lat: 34.1, tz: -7, bearing: 25 }, MIA: { lon: -80.2, lat: 25.8, tz: -4, bearing: 75, roof: true },
  MIL: { lon: -88.0, lat: 43.0, tz: -5, bearing: 130, roof: true }, MIN: { lon: -93.3, lat: 45.0, tz: -5, bearing: 90 }, NYM: { lon: -73.8, lat: 40.8, tz: -4, bearing: 30 },
  NYY: { lon: -73.9, lat: 40.8, tz: -4, bearing: 75 }, OAK: { lon: -121.5, lat: 38.6, tz: -7, bearing: 60 }, PHI: { lon: -75.2, lat: 39.9, tz: -4, bearing: 10 },
  PIT: { lon: -80.0, lat: 40.4, tz: -4, bearing: 115 }, SD: { lon: -117.2, lat: 32.7, tz: -7, bearing: 0 }, SEA: { lon: -122.3, lat: 47.6, tz: -7, bearing: 45, roof: true },
  SF: { lon: -122.4, lat: 37.8, tz: -7, bearing: 85 }, STL: { lon: -90.2, lat: 38.6, tz: -5, bearing: 60 }, TB: { lon: -82.7, lat: 27.8, tz: -4, bearing: 45, roof: true },
  TEX: { lon: -97.1, lat: 32.8, tz: -5, bearing: 135, roof: true }, TOR: { lon: -79.4, lat: 43.6, tz: -4, bearing: 345, roof: true }, WSH: { lon: -77.0, lat: 38.9, tz: -4, bearing: 30 },
}

export function park(abbr) {
  return PARKS[abbr] || { lon: -90, tz: -5 } // league-center fallback
}
