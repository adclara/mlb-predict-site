// Consume los slots públicos de D1 antes de la corrida privada de MLB.
//
// No calcula predicciones. Materializa, por game_pk, el primer mercado visto y
// la observación pregame más reciente. daily.mjs puede completar inputs que la
// fuente puntual no traiga, siempre respetando captured_at < first_pitch.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342'
const DATABASE_ID = 'ed0969d8-050a-4987-ab98-b047c30f76c9'
const CF = 'https://api.cloudflare.com/client/v4'
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || null
const OUT = process.env.AA_INGEST_SNAPSHOT || '/tmp/aa-mlb-ingest.json'

const etDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date)

const parsed = (value, fallback = null) => {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback } catch { return fallback }
}

const marketNumber = (value) => {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const gameIsPregame = (game) => {
  const statuses = [game?.status, game?.espn_status]
    .filter((value) => value != null && value !== '')
    .map((value) => String(value).toLowerCase())
  return !statuses.some((value) => value !== 'pre' && !/scheduled|preview|warmup|pre-game|pregame/.test(value))
}

const completeMoneyline = (market) => {
  if (!market) return null
  const openHome = marketNumber(market.home_ml_open)
  const openAway = marketNumber(market.away_ml_open)
  if (openHome != null && openAway != null) {
    return { home_ml: openHome, away_ml: openAway, provenance: 'source_open_first_observed' }
  }
  const home = marketNumber(market.home_ml)
  const away = marketNumber(market.away_ml)
  return home != null && away != null
    ? { home_ml: home, away_ml: away, provenance: 'first_complete_capture' }
    : null
}

const completeTotal = (market) => {
  if (!market) return null
  const openTotal = marketNumber(market.total_open)
  const openOver = marketNumber(market.over_price_open)
  const openUnder = marketNumber(market.under_price_open)
  if (openTotal != null && openOver != null && openUnder != null) {
    return { total: openTotal, over_price: openOver, under_price: openUnder, provenance: 'source_open_first_observed' }
  }
  const total = marketNumber(market.total)
  const over = marketNumber(market.over_price)
  const under = marketNumber(market.under_price)
  return total != null && over != null && under != null
    ? { total, over_price: over, under_price: under, provenance: 'first_complete_capture' }
    : null
}

const openingMarket = (parts) => {
  if (!parts?.ml && !parts?.total) return null
  const available = [parts.ml, parts.total].filter(Boolean)
    .sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at))
  const conservative = available[available.length - 1]
  const sharedProvider = parts.ml && parts.total && parts.ml.provider !== parts.total.provider
    ? null
    : parts.ml?.provider ?? parts.total?.provider ?? null
  return {
    provider: sharedProvider,
    ml_provider: parts.ml?.provider ?? null,
    total_provider: parts.total?.provider ?? null,
    home_ml: parts.ml?.home_ml ?? null,
    away_ml: parts.ml?.away_ml ?? null,
    total: parts.total?.total ?? null,
    over_price: parts.total?.over_price ?? null,
    under_price: parts.total?.under_price ?? null,
    spread: parts.spread?.spread ?? null,
    ml_provenance: parts.ml?.provenance ?? null,
    total_provenance: parts.total?.provenance ?? null,
    captured_at_ml_open: parts.ml?.captured_at ?? null,
    captured_at_total_open: parts.total?.captured_at ?? null,
    captured_at_spread_open: parts.spread?.captured_at ?? null,
    // El bloque combinado solo era completamente conocible en el instante
    // más tardío de sus componentes; nunca se retrofecha al primer precio.
    captured_at_open: conservative?.captured_at ?? null,
    ml_source_hash: parts.ml?.source_hash ?? null,
    total_source_hash: parts.total?.source_hash ?? null,
    spread_source_hash: parts.spread?.source_hash ?? null,
    source_hash: conservative?.source_hash ?? null,
  }
}

export function materializeMlbIngest(rows, date) {
  const games = new Map()
  const ordered = [...(rows || [])].sort((a, b) => Number(a.slot_id) - Number(b.slot_id))
  for (const row of ordered) {
    const payload = parsed(row.payload, {})
    const capturedAt = payload.captured_at || row.captured_at || null
    const capturedMs = Date.parse(capturedAt || '')
    if (!Number.isFinite(capturedMs)) continue
    for (const game of payload.games || []) {
      const gamePk = game.mlb_id || (/^\d+$/.test(String(game.id || '')) ? String(game.id) : null)
      const firstPitch = game.start || null
      const firstMs = Date.parse(firstPitch || '')
      if (!gamePk || !Number.isFinite(firstMs) || capturedMs >= firstMs) continue
      const current = games.get(gamePk) || {
        game_pk: Number(gamePk), first_pitch: firstPitch, first_seen_at: capturedAt,
        opening_market: null, latest_pregame: null, _opening: { ml: null, total: null, spread: null },
      }
      // La etapa de la cartelera puede ser `live` porque empezó una matiné.
      // Para cada juego manda su propio estado público: un nocturno que aún
      // está `pre` sigue siendo una observación pregame admisible.
      if (!gameIsPregame(game)) continue
      const market = game.market
      const ml = completeMoneyline(market)
      const total = completeTotal(market)
      if (!current._opening.ml && ml) {
        current._opening.ml = { ...ml, provider: market.provider || null, captured_at: capturedAt, source_hash: row.source_hash || null }
      }
      if (!current._opening.total && total) {
        current._opening.total = { ...total, provider: market.provider || null, captured_at: capturedAt, source_hash: row.source_hash || null }
      }
      if (!current._opening.spread && marketNumber(market?.spread) != null) {
        current._opening.spread = {
          spread: marketNumber(market.spread), captured_at: capturedAt, source_hash: row.source_hash || null,
        }
      }
      current.opening_market = openingMarket(current._opening)
      current.latest_pregame = {
        captured_at: capturedAt, source_hash: row.source_hash || null,
        stage: 'pre', slate_stage: row.stage || payload.stage || null,
        home: game.home || null, away: game.away || null,
      }
      games.set(gamePk, current)
    }
  }
  const latest = ordered[ordered.length - 1] || null
  return {
    schema: 'mlb_ingest_consumer_v1', date,
    consumed_at: new Date().toISOString(),
    watermark_slot_id: latest ? Number(latest.slot_id) : null,
    slots: ordered.length,
    games: Object.fromEntries([...games.entries()].map(([gamePk, value]) => {
      const { _opening, ...published } = value
      return [gamePk, published]
    })),
  }
}

async function querySlots(date) {
  const res = await fetch(`${CF}/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sql: `SELECT slot_id, date, captured_at, stage, source_hash, payload
            FROM mlb_ingest_slots WHERE date = ? ORDER BY slot_id ASC LIMIT 96`,
      params: [date],
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) {
    throw new Error(`D1 query ${res.status}: ${JSON.stringify(body.errors || body).slice(0, 300)}`)
  }
  if (!Array.isArray(body.result) || !body.result.length || body.result.some((part) => part?.success !== true)) {
    throw new Error(`D1 query incompleta: ${JSON.stringify(body.result || body).slice(0, 300)}`)
  }
  return body.result?.[0]?.results || []
}

async function main() {
  if (!TOKEN) {
    console.log('mlb_ingest_consumer: sin token; daily usará sus fuentes directas.')
    return
  }
  const date = process.argv.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) || etDate()
  try {
    const rows = await querySlots(date)
    const doc = materializeMlbIngest(rows, date)
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(doc))
    console.log(`mlb_ingest_consumer: ${rows.length} slots → ${Object.keys(doc.games).length} juegos; watermark ${doc.watermark_slot_id ?? '—'}`)
  } catch (error) {
    console.error(`mlb_ingest_consumer: ${error.message}; daily usará sus fuentes directas.`)
  }
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) await main()
