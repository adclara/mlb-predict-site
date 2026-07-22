import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('contrato de frescura conserva sus tres capas sin cron duplicado', () => {
  const wrangler = read('cloudflare/wrangler.toml')
  const daily = read('.github/workflows/adrian-daily.yml')
  const learning = read('.github/workflows/mlb-learning-daily.yml')
  const live = read('.github/workflows/mlb-live-observer.yml')
  const worker = read('cloudflare/worker/index.js')
  assert.match(wrangler, /crons\s*=\s*\["\*\/5 \* \* \* \*", "\*\/20 \* \* \* \*", "0 13 \* \* \*"\]/)
  assert.match(daily, /cron:\s*'7 \* \* \* \*'/)
  assert.match(learning, /cron:\s*'37 9,10 \* \* \*'/)
  assert.match(live, /cron:\s*'27 \* \* \* \*'/)
  assert.match(worker, /pipeline:\s*'mlb_ingest_20m'/)
  assert.match(worker, /\/v1\/mlb\/pipeline-health/)
  assert.match(worker, /statsapi\.mlb\.com\/api\/v1\/schedule\?sportId=1&date=/)
})
