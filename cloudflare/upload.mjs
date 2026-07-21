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
import { normalizeAmericanPrice, normalizeDay, toD1Rows } from './lib/normalize.mjs';
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
const backfillD1Prices = args.includes('--backfill-d1-prices');
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

export function buildSql(rows) {
  if (!rows.length) return '';
  const cols = ['sport', 'date', 'event_id', 'league', 'start_time', 'status', 'home', 'away', 'pick', 'prob', 'price', 'confidence', 'engine_version', 'result', 'updated_at'];
  const values = rows.map((r) => '(' + cols.map((c) => sqlVal(r[c])).join(', ') + ')').join(',\n');
  return `INSERT OR REPLACE INTO predictions\n(${cols.join(', ')})\nVALUES\n${values};\n`;
}

// Ledger separado: una fila por selección/mercado. Así un Over y una moneyline
// del mismo juego conservan resultados distintos y nunca se pisan entre sí.
export function buildPublicRecordBackfillSql(rows) {
  const publicRows = Array.isArray(rows) ? rows : [];
  if (!publicRows.length) return '';
  const cols = ['date', 'event_id', 'selection_key', 'market', 'pick', 'side', 'line', 'home', 'away',
    'prob', 'price', 'confidence', 'public_play', 'public_lock', 'public_gem', 'result', 'posted_at',
    'start_time', 'engine_version', 'source_scope', 'invalidated', 'invalidated_reason', 'updated_at'];
  const values = publicRows.map((r) => '(' + cols.map((c) => sqlVal(r[c])).join(', ') + ')').join(',\n');
  const mutable = cols.filter((c) => !['date', 'event_id', 'selection_key'].includes(c));
  const changes = mutable.map((c) => `mlb_public_picks.${c} IS NOT excluded.${c}`).join('\n  OR ');
  return `INSERT INTO mlb_public_picks\n(${cols.join(', ')})\nVALUES\n${values}\n` +
    'ON CONFLICT(date, event_id, selection_key) DO UPDATE SET\n  ' +
    mutable.map((c) => `${c} = excluded.${c}`).join(',\n  ') +
    `\nWHERE ${changes};\n`;
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

async function restD1Exec(sql, label = 'historial') {
  const body = await cfFetch(`/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }),
  });
  if (!Array.isArray(body.result) || !body.result.length || body.result.some((part) => part?.success !== true)) {
    throw new Error(`D1 rechazó el upsert: ${JSON.stringify(body.result || body).slice(0, 400)}`);
  }
  console.log(`✅ D1: ${label} actualizado (REST).`);
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
  const publicRows = historicalPublicRecordRows();
  const publicSql = buildPublicRecordBackfillSql(publicRows);

  mkdirSync(DIST, { recursive: true });
  const todayPath = join(DIST, 'mlb-today.json');
  const sqlPath = join(DIST, 'mlb-upsert.sql');
  const publicSqlPath = join(DIST, 'mlb-public-record-upsert.sql');
  writeFileSync(todayPath, JSON.stringify(normalized));
  writeFileSync(sqlPath, buildSql(rows));
  writeFileSync(publicSqlPath, publicSql);

  console.log(`✅ Normalizado ${date}: ${normalized.events.length} eventos, ${rows.length} filas.`);
  console.log(`   ${todayPath}`);
  console.log(`   ${sqlPath}`);
  console.log(`   ${publicSqlPath} (${publicRows.length} selecciones/mercados)`);

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
    if (publicSql) await restD1Exec(publicSql, 'ledger público MLB');
  } else {
    if (shouldPublishLatest(null, date)) wrangler(['kv', 'key', 'put', 'mlb:today', '--path', todayPath, '--namespace-id', KV_NAMESPACE_ID, '--remote']);
    else console.log(`↷ KV: no actualizo mlb:today con fecha histórica ${date}.`);
    wrangler(['kv', 'key', 'put', `mlb:day:${date}`, '--path', todayPath, '--namespace-id', KV_NAMESPACE_ID, '--remote']);
    if (rows.length) wrangler(['d1', 'execute', D1_NAME, '--remote', '--file', sqlPath]);
    if (publicSql) wrangler(['d1', 'execute', D1_NAME, '--remote', '--file', publicSqlPath]);
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

const validResult = (value) => ['win', 'loss', 'push', 'void'].includes(value) ? value : null;
const selectionLine = (value) => {
  if (value == null || value === '') return null;
  const line = Number(value);
  return Number.isFinite(line) ? line : null;
};
const selectionKeyFor = (pick) => {
  const market = String(pick?.market || 'ml').toLowerCase();
  const side = pick?.side == null ? '' : String(pick.side).toLowerCase();
  const parsedLine = selectionLine(pick?.line);
  const line = parsedLine == null ? '' : parsedLine;
  const team = pick?.pick == null ? '' : String(pick.pick).toUpperCase();
  return `${market}|${team}|${side}|${line}`;
};
const pregameStarterInvalidation = (invalidation, scheduledStart) => {
  const detectedMs = Date.parse(invalidation?.detected_at || '');
  const startMs = Date.parse(scheduledStart || invalidation?.scheduled_start_utc || '');
  return Number.isFinite(detectedMs) && Number.isFinite(startMs) && detectedMs < startMs;
};

export function publicRecordRows(date, dailyDoc, normalized) {
  const byEvent = new Map((normalized?.events || []).map((event) => [String(event.event_id), {
    home: event.home?.code || null, away: event.away?.code || null,
    start_time: event.start || null, updated_at: normalized.updated_at || null,
  }]));
  const selected = new Map();
  const invalidations = dailyDoc?.starter_invalidations || {};
  const verified = dailyDoc?.selection_snapshot_verified === true;
  for (const [list, badge, kind] of [[dailyDoc?.plays, null, 'play'], [dailyDoc?.gems, 'gema', 'gem'], [dailyDoc?.locks, null, 'lock']]) {
    for (const pick of Array.isArray(list) ? list : []) {
      if (pick?.game_pk == null || pick.record_scope !== 'public_live' || pick.eligible_public_record !== true) continue;
      const postedMs = Date.parse(pick.posted_at || '');
      const startMs = Date.parse(pick.scheduled_start_utc || '');
      if (!Number.isFinite(postedMs) || !Number.isFinite(startMs) || postedMs >= startMs) continue;
      const price = normalizeAmericanPrice(pick.price);
      const eventId = String(pick.game_pk);
      const selectionKey = selectionKeyFor(pick);
      const mapKey = `${eventId}\u0000${selectionKey}`;
      const facts = byEvent.get(eventId);
      if (!facts) continue;
      const previous = selected.get(mapKey) || {};
      const rawProb = pick.prob_v2 ?? pick.prob;
      const measuredProb = rawProb == null || rawProb === '' ? null : Number(rawProb);
      const gameInvalidation = invalidations[eventId] || invalidations[pick.game_pk];
      const causalInvalidation = pregameStarterInvalidation(gameInvalidation, pick.scheduled_start_utc);
      const invalidated = previous.invalidated === 1 || causalInvalidation;
      selected.set(mapKey, {
        date, event_id: eventId, selection_key: selectionKey,
        market: String(pick.market || 'ml').toLowerCase(),
        pick: pick.pick ?? previous.pick ?? null,
        side: pick.side ?? previous.side ?? null,
        line: selectionLine(pick.line) ?? previous.line ?? null,
        ...facts,
        // The causal gate is evaluated against this exact first-pitch value.
        // Legacy normalized events may only carry YYYY-MM-DD, which would make
        // an honest afternoon posting look later than a fake midnight start.
        start_time: pick.scheduled_start_utc,
        prob: verified && Number.isFinite(measuredProb) && measuredProb >= 0 && measuredProb <= 1
          ? measuredProb : (previous.prob ?? null),
        price: price ?? previous.price ?? null,
        // Legacy rows preserve only factual cohort labels via public_* flags.
        // Their model-derived confidence is not causally auditable either.
        confidence: verified
          ? (pick.tier ?? badge ?? pick.confidence ?? previous.confidence ?? null)
          : null,
        public_play: kind === 'play' || previous.public_play === 1 ? 1 : 0,
        public_lock: kind === 'lock' || previous.public_lock === 1 ? 1 : 0,
        public_gem: kind === 'gem' || previous.public_gem === 1 ? 1 : 0,
        result: validResult(pick.result) ?? previous.result ?? null,
        posted_at: pick.posted_at || previous.posted_at || null,
        engine_version: verified ? (pick.engine ?? previous.engine_version ?? null) : null,
        source_scope: verified ? 'causal_verified' : 'legacy_public_record',
        invalidated: invalidated ? 1 : 0,
        invalidated_reason: invalidated
          ? (gameInvalidation?.reason || 'probable_starter_changed') : null,
      });
    }
  }
  return [...selected.values()].map((row) => row.invalidated === 1 ? {
    ...row, pick: null, side: null, line: null, prob: null, price: null,
    confidence: null, result: null, engine_version: null,
  } : row);
}

export function historicalPublicRecordRows() {
  const gdir = join(DATA, 'games');
  const days = readdirSync(gdir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
  const rows = [];
  for (const date of days) {
    const gamesDoc = readJson(join(gdir, `${date}.json`));
    const dailyDoc = readJson(join(DATA, `${date}.json`));
    if (!gamesDoc || !dailyDoc) continue;
    const prev = days.filter((d) => d < date).slice(-10).map((d) => readJson(join(gdir, `${d}.json`))).filter(Boolean);
    const liveDoc = readJson(join(DATA, 'live', `${date}.json`));
    const normalized = normalizeDay(date, gamesDoc, dailyDoc, readJson(join(DATA, 'index.json')), prev, liveDoc);
    rows.push(...publicRecordRows(date, dailyDoc, normalized));
  }
  return rows;
}

async function backfillHistoricalD1Prices() {
  const rows = historicalPublicRecordRows();
  const priced = rows.filter((row) => normalizeAmericanPrice(row.price) != null).length;
  const active = rows.filter((row) => row.invalidated === 0).length;
  const sql = buildPublicRecordBackfillSql(rows);
  console.log(`Backfill D1: ${active} selecciones públicas activas; ${rows.length - active} invalidadas; ${priced} con cuota real capturada.`);
  if (!sql) return;
  mkdirSync(DIST, { recursive: true });
  const sqlPath = join(DIST, 'mlb-public-record-upsert.sql');
  writeFileSync(sqlPath, sql);
  if (dryRun) {
    console.log(`(--dry-run) SQL escrito en ${sqlPath}; no se subió nada.`);
    return;
  }
  if (API_TOKEN) await restD1Exec(sql);
  else wrangler(['d1', 'execute', D1_NAME, '--remote', '--file', sqlPath]);
  console.log('🎉 Ledger público MLB sincronizado en D1.');
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (direct) {
  if (backfillD1Prices) await backfillHistoricalD1Prices();
  else if (backfill) await backfillDays();
  else await main();
}
