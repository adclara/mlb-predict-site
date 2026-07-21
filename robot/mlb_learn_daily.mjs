// AA Sports MLB — refit diario, separado de la captura/gradación horaria.
//
// Lee exclusivamente el ledger local que ya produjo daily.mjs. buildSnapshot()
// aplica las guardas de deduplicación y causalidad temporal; este proceso no
// consulta fuentes externas ni publica predicciones.

import fs from 'node:fs'
import path from 'node:path'
import { buildSnapshot } from './learn.js'

const DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const HIST = path.join(DATA, 'history')
const GAMES = path.join(HIST, 'games')
const OUT = path.join(HIST, 'learning.json')

function readRows() {
  if (!fs.existsSync(GAMES)) return []
  const files = fs.readdirSync(GAMES)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
  const rows = []
  for (const file of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(GAMES, file), 'utf8'))
      for (const row of doc.games || []) rows.push(row)
    } catch (error) {
      console.error(`mlb_learn_daily: omito ${file}: ${error.message}`)
    }
  }
  return rows
}

const rows = readRows()
const snapshot = buildSnapshot(rows, { now: new Date().toISOString() })
fs.mkdirSync(HIST, { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2))
console.log(`mlb_learn_daily: ${snapshot.n_graded}/${snapshot.n_total} filas elegibles; ${OUT}`)
