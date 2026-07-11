// AA Sports — uploader: publica las predicciones del día a Cloudflare.
//
// Lee lo que el robot ya produjo (data/history/...), lo normaliza al esquema AA
// (SOLO resultados, sin internals del modelo) y lo sube a:
//   - KV  (mlb:today)  -> lectura caliente para el frontend
//   - D1  (predictions) -> historial consultable
//
// Uso (desde la carpeta cloudflare/, con wrangler ya logueado):
//   node upload.mjs             # usa el día más reciente disponible
//   node upload.mjs 2026-07-07  # un día específico
//   node upload.mjs --dry-run   # solo escribe dist/, no sube nada
//
// No necesita token: usa el wrangler OAuth de tu Mac. En GitHub Actions se
// usará CLOUDFLARE_API_TOKEN (Paso C).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeDay, toD1Rows } from './lib/normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, 'data', 'history');
const DIST = join(HERE, 'dist');

const KV_NAMESPACE_ID = '683aa2f8846643bf8a6a8b606e5bf0b7';
const D1_NAME = 'aa-sports';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

function latestDate() {
  const gdir = join(DATA, 'games');
  if (!existsSync(gdir)) return null;
  const days = readdirSync(gdir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
  return days.length ? days[days.length - 1] : null;
}

function readJson(p) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function sqlVal(x) {
  if (x == null) return 'NULL';
  if (typeof x === 'number') return Number.isFinite(x) ? String(x) : 'NULL';
  return `'${String(x).replace(/'/g, "''")}'`;
}

function buildSql(rows) {
  if (!rows.length) return '';
  const cols = ['sport', 'date', 'event_id', 'league', 'start_time', 'status', 'home', 'away', 'pick', 'prob', 'confidence', 'engine_version', 'result', 'updated_at'];
  const values = rows.map((r) => '(' + cols.map((c) => sqlVal(r[c])).join(', ') + ')').join(',\n');
  return `INSERT OR REPLACE INTO predictions\n(${cols.join(', ')})\nVALUES\n${values};\n`;
}

function wrangler(argv) {
  console.log(`\n$ wrangler ${argv.join(' ')}`);
  const r = spawnSync('wrangler', argv, { cwd: HERE, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`wrangler exited with code ${r.status}`);
}

function main() {
  const date = dateArg || latestDate();
  if (!date) { console.error('No encontré datos en data/history/games/. ¿Corriste el robot?'); process.exit(1); }

  const gamesDoc = readJson(join(DATA, 'games', `${date}.json`));
  if (!gamesDoc) { console.error(`Falta data/history/games/${date}.json`); process.exit(1); }
  const dailyDoc = readJson(join(DATA, `${date}.json`));
  const indexDoc = readJson(join(DATA, 'index.json'));

  const normalized = normalizeDay(date, gamesDoc, dailyDoc, indexDoc);
  const rows = toD1Rows(normalized);

  mkdirSync(DIST, { recursive: true });
  const todayPath = join(DIST, 'mlb-today.json');
  const sqlPath = join(DIST, 'mlb-upsert.sql');
  writeFileSync(todayPath, JSON.stringify(normalized));
  writeFileSync(sqlPath, buildSql(rows));

  console.log(`✅ Normalizado ${date}: ${normalized.events.length} eventos, ${rows.length} filas.`);
  console.log(`   ${todayPath}`);
  console.log(`   ${sqlPath}`);

  if (dryRun) { console.log('\n(--dry-run) No se subió nada.'); return; }

  // Subir a KV (lo último) y D1 (historial).
  wrangler(['kv', 'key', 'put', 'mlb:today', '--path', todayPath, '--namespace-id', KV_NAMESPACE_ID, '--remote']);
  if (rows.length) wrangler(['d1', 'execute', D1_NAME, '--remote', '--file', sqlPath]);

  console.log('\n🎉 Subido a Cloudflare. Prueba el Worker: /v1/mlb/today');
}

main();
