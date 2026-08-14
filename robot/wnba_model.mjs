// AA Sports — WNBA Elo/MOV en sombra.
// Reutiliza el motor de básquet validado, pero ajusta parámetros únicamente
// con temporadas WNBA y deja temporadas posteriores intactas para evaluación.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { backtest } from './nba_model.mjs'

export function backtestWnba(burnInSeasons = 2) {
  const data = process.env.DATA_DIR || path.join(process.cwd(), 'data')
  return backtest(burnInSeasons, {
    dir: path.join(data, 'fase2', 'wnba'),
    label: 'WNBA',
    outputName: 'wnba_backtest.json',
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2]
  if (cmd === 'backtest') {
    const burn = Number.parseInt(process.argv[3], 10)
    backtestWnba(Number.isFinite(burn) ? burn : 2)
  } else if (cmd) {
    console.log('Uso: node robot/wnba_model.mjs backtest [burnInSeasons]')
  }
}
