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
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeDay, toD1Rows } from './lib/normalize.mjs';
import { semanticContentHash } from './lib/content_hash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, 'data', 'history');
const DIST = join(HERE, 'dist');

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const KV_NAMESPACE_ID = '683aa2f8846643bf8a6a8b606e5bf0b7';
const D1_NAME = 'aa-sports';
const D1_DATABASE_ID = 'ed0969d8-050a-4987-ab98-b047c30f76c9';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const backfill = args.includes('--backfill');
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

// ── Modo API REST (GitHub Actions: sin wrangler, solo CLOUDFLARE_API_TOKEN) ──
const CF = 'https://api.cloudflare.com/client/v4';

async function cfFetch(path, opts) {
  const res = await fetch(CF + path, {
    ...opts,
    headers: { Authorization: `Bearer ${API_TOKEN}`, ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(`Cloudflare API ${path} -> ${res.status}: ${JSON.stringify(body.errors || body).slice(0, 400)}`);
  }
  return body;
}

async function restKvPut(key, value) {
  await cfFetch(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: value,
  });
  console.log(`✅ KV: ${key} actualizado (REST).`);
}

async function restKvGetJson(key) {
  const res = await fetch(
    `${CF}/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${API_TOKEN}` } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cloudflare KV GET ${key} -> ${res.status}`);
  return res.json().catch(() => null);
}

function contentHash(doc) {
  return semanticContentHash(doc);
}

function etToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function shouldPublishLatest(remoteDate, candidateDate, today = etToday()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(candidateDate || ''))) return false;
  // `mlb:today` means exactly today ET. This also repairs a poisoned/future KV:
  // a correct current candidate may replace either an older or a future blob.
  return candidateDate === today;
}

async function restD1Exec(sql) {
  const body = await cfFetch(`/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }),
  });
  if (!Array.isArray(body.result) || !body.result.length || body.result.some((part) => part?.success !== true)) {
    throw new Error(`D1 rechazó el upsert: ${JSON.stringify(body.result || body).slice(0, 400)}`);
  }
  console.log('✅ D1: historial actualizado (REST).');
}

async function main() {
  const date = dateArg || latestDate();
  if (!date) { console.error('No encontré datos en data/history/games/. ¿Corriste el robot?'); process.exit(1); }

  const gamesDoc = readJson(join(DATA, 'games', `${date}.json`));
  if (!gamesDoc) { console.error(`Falta data/history/games/${date}.json`); process.exit(1); }
  const dailyDoc = readJson(join(DATA, `${date}.json`));
  const indexDoc = readJson(join(DATA, 'index.json'));

  // Días anteriores (hasta 10) para computar la forma reciente de cada equipo.
  const gdir = join(DATA, 'games');
  const prevGamesDocs = readdirSync(gdir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .filter((d) => d < date)
    .sort()
    .slice(-10)
    .map((d) => readJson(join(gdir, `${d}.json`)))
    .filter(Boolean);

  const liveDoc = readJson(join(DATA, 'live', `${date}.json`));

  const normalized = normalizeDay(date, gamesDoc, dailyDoc, indexDoc, prevGamesDocs, liveDoc);
  normalized.content_hash = contentHash(normalized);
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

  // Subir a KV (lo último) y D1 (historial):
  //  - con CLOUDFLARE_API_TOKEN (GitHub Actions): API REST, sin wrangler.
  //  - sin token (Mac de Adrian): wrangler con su OAuth local.
  const payload = JSON.stringify(normalized);
  if (API_TOKEN) {
    const [latest, dayBlob] = await Promise.all([
      restKvGetJson('mlb:today'),
      restKvGetJson(`mlb:day:${date}`),
    ]);
    const latestSame = latest?.content_hash === normalized.content_hash;
    const daySame = dayBlob?.content_hash === normalized.content_hash;
    const mayPublishLatest = shouldPublishLatest(latest?.date, date);
    if (!mayPublishLatest) console.log(`↷ KV: mlb:today conserva ${latest?.date || 'el valor remoto'}; ${date} no es hoy ET.`);
    else if (!latestSame) await restKvPut('mlb:today', payload);
    else console.log(`↷ KV: mlb:today sin cambios (${normalized.content_hash.slice(0, 12)}).`);
    if (!daySame) await restKvPut(`mlb:day:${date}`, payload);
    else console.log(`↷ KV: mlb:day:${date} sin cambios.`);
    // D1 tiene su propia idempotencia (INSERT OR REPLACE). Se ejecuta aunque KV
    // ya tenga el mismo hash: así una caída de D1 no queda oculta para siempre
    // por dos PUT de KV que sí alcanzaron a completar en la corrida anterior.
    const sql = buildSql(rows);
    if (sql) await restD1Exec(sql);
  } else {
    if (shouldPublishLatest(null, date)) wrangler(['kv', 'key', 'put', 'mlb:today', '--path', todayPath, '--namespace-id', KV_NAMESPACE_ID, '--remote']);
    else console.log(`↷ KV: no actualizo mlb:today con fecha histórica ${date}.`);
    wrangler(['kv', 'key', 'put', `mlb:day:${date}`, '--path', todayPath, '--namespace-id', KV_NAMESPACE_ID, '--remote']);
    if (rows.length) wrangler(['d1', 'execute', D1_NAME, '--remote', '--file', sqlPath]);
  }

  console.log('\n🎉 Subido a Cloudflare. Prueba el Worker: /v1/mlb/today');
}

async function backfillDays() {
  const gdir = join(DATA, 'games');
  const days = readdirSync(gdir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
  console.log(`Backfill de ${days.length} días → mlb:day:*`);
  for (const d of days) {
    const gamesDoc = readJson(join(gdir, `${d}.json`));
    if (!gamesDoc) continue;
    const dailyDoc = readJson(join(DATA, `${d}.json`));
    const indexDoc = readJson(join(DATA, 'index.json'));
    const prev = days.filter((x) => x < d).slice(-10).map((x) => readJson(join(gdir, `${x}.json`))).filter(Boolean);
    const liveDoc = readJson(join(DATA, 'live', `${d}.json`));
    const doc = normalizeDay(d, gamesDoc, dailyDoc, indexDoc, prev, liveDoc);
    doc.content_hash = contentHash(doc);
    const body = JSON.stringify(doc);
    if (API_TOKEN) await restKvPut(`mlb:day:${d}`, body);
    else {
      const tmp = join(DIST, `mlb-day-${d}.json`);
      mkdirSync(DIST, { recursive: true });
      writeFileSync(tmp, body);
      wrangler(['kv', 'key', 'put', `mlb:day:${d}`, '--path', tmp, '--namespace-id', KV_NAMESPACE_ID, '--remote']);
    }
  }
  console.log('🎉 Backfill de días completo.');
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (direct) {
  if (backfill) await backfillDays();
  else await main();
}
