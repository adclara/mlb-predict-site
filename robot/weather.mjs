// Pre-game weather FORECAST (Open-Meteo — free, keyless, no secrets) so the
// weather factor in adrian.js stops receiving null in the robot path. One fetch
// per unique home park (≤15/day). We only trust what a forecast can honestly
// give pre-game: temperature and wind SPEED (direction relative to each park's
// orientation is unknowable here, so parseWind reads it as 'cross' → wind adds
// 0 runs and only the temp effect (±0.3) applies). The OBSERVED weather captured
// at grading time (daily.mjs attachWeather) remains the ground truth for studies.
import { PARKS } from './venues.js'

const OM = 'https://api.open-meteo.com/v1/forecast'

// Match the game's first-pitch hour in the park's hourly forecast (UTC times).
export function pickHour(hourly, gameIsoUtc) {
  if (!hourly?.time?.length || !gameIsoUtc) return null
  const want = gameIsoUtc.slice(0, 13) // "YYYY-MM-DDTHH"
  let idx = hourly.time.findIndex((t) => t.slice(0, 13) === want)
  if (idx < 0) idx = hourly.time.length - 1 // fallback: latest available
  return {
    temp: hourly.temperature_2m?.[idx] ?? null,
    wind_mph: hourly.wind_speed_10m?.[idx] ?? null,
    wind_from_deg: hourly.wind_direction_10m?.[idx] ?? null,
    precip_pct: hourly.precipitation_probability?.[idx] ?? null,
  }
}

// Classify forecast wind relative to the park's HP→CF bearing: blowing OUT (to
// CF ±45°), IN (from CF ±45°), or cross. Meteorological direction = where the
// wind comes FROM, so blowing-to = from + 180. Returns a wind string in the
// exact shape adrian.js parseWind already understands ("X mph, Out To CF").
export function windLabel(mph, fromDeg, bearing, roof) {
  if (mph == null) return null
  const base = `${Math.round(mph)} mph`
  if (roof || fromDeg == null || bearing == null) return base // dome/unknown → cross (0 effect)
  const to = (fromDeg + 180) % 360
  const diff = Math.abs(((to - bearing + 540) % 360) - 180) // 0 = straight out
  if (diff <= 45) return `${base}, Out To CF`
  if (diff >= 135) return `${base}, In From CF`
  return base
}

// games: parsed schedule rows ({game_pk, home_team_abbr, game_datetime}).
// Returns Map(game_pk -> {temp, wind, precip_pct, source, stage}). Best-effort:
// any failure just leaves games without forecast (weather stays null).
export async function fetchForecasts(games) {
  const out = new Map()
  const byPark = new Map()
  for (const g of games || []) {
    const abbr = g.home_team_abbr
    if (!PARKS[abbr] || !g.game_datetime) continue
    ;(byPark.get(abbr) || byPark.set(abbr, []).get(abbr)).push(g)
  }
  await Promise.all([...byPark.entries()].map(async ([abbr, parkGames]) => {
    const { lat, lon, bearing, roof } = PARKS[abbr]
    try {
      const url = `${OM}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation_probability&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC&forecast_days=2`
      const data = await fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      for (const g of parkGames) {
        const h = pickHour(data.hourly, g.game_datetime)
        if (!h || h.temp == null) continue
        out.set(g.game_pk, {
          temp: Math.round(h.temp),
          wind: windLabel(h.wind_mph, h.wind_from_deg, bearing, roof), // out/in/cross vs the park
          precip_pct: h.precip_pct ?? null,
          source: 'open-meteo', stage: 'forecast',
        })
      }
    } catch { /* park without forecast this run */ }
  }))
  return out
}
