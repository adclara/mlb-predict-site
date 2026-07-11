// AA Sports — Bajas: lesionados y suspendidos por equipo, con marca de
// jugador CRUCIAL (buenas estadísticas de la temporada).
//
// Fuentes (gratis, keyless):
//   - MLB: StatsAPI oficial — roster de 40 con status (Injured List /
//     suspendido) + stats de temporada por jugador para decidir "crucial".
//   - NBA: endpoint de lesiones de ESPN (nombre, posición, estado, detalle).
//     Sin stats en v1 → crucial queda null (se muestra sin estrella).
//
// Publica KV `injuries:latest`:
//   { generated_at, mlb: { CODE: [ {name,pos,status,detail,stat_line,crucial} ] },
//     nba: { CODE: [...] } }
// Los CODE de MLB son los del robot (CWS/AZ/OAK); los de NBA son de ESPN.
//
// La lista es INFORMATIVA para el apostador: el modelo validado NO se altera
// con esto (cambiar el modelo exige re-validación — estándar AA).
//
// Uso: node robot/injuries.mjs  (CLOUDFLARE_API_TOKEN para publicar; sin
// token escribe dist/injuries.json y termina)

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const KV_NAMESPACE_ID = '683aa2f8846643bf8a6a8b606e5bf0b7';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'aa-sports-injuries/1.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) { console.warn(`  ✗ ${url}: ${e.message}`); return null; }
      await sleep(700 * (i + 1));
    }
  }
  return null;
}

/* ── MLB (StatsAPI) ──────────────────────────────────────────────────────── */
// statsapi usa 'ATH' para Athletics; el robot usa 'OAK'
const MLB_CODE_FIX = { ATH: 'OAK' };
const SEASON = new Date().getUTCFullYear();

// baja = cualquier status que no sea activo y huela a lesión/suspensión
const OUT_RE = /injured|il-|suspend|restricted|bereavement|paternity|emergency/i;

function hitterLine(st) {
  if (!st) return null;
  const parts = [];
  if (st.avg) parts.push(`AVG ${st.avg}`);
  if (st.ops) parts.push(`OPS ${st.ops}`);
  if (num(st.homeRuns) != null) parts.push(`${st.homeRuns} HR`);
  return parts.length ? parts.join(' · ') : null;
}
function pitcherLine(st) {
  if (!st) return null;
  const parts = [];
  if (st.era) parts.push(`ERA ${st.era}`);
  if (st.inningsPitched) parts.push(`${st.inningsPitched} IP`);
  if (num(st.saves) > 0) parts.push(`${st.saves} SV`);
  return parts.length ? parts.join(' · ') : null;
}
function isCrucial(pos, hit, pit) {
  if (pos === 'P' && pit) {
    const ip = num(pit.inningsPitched), era = num(pit.era), sv = num(pit.saves);
    return (ip != null && ip >= 40 && era != null && era <= 4.0) || (sv != null && sv >= 10);
  }
  if (hit) {
    const pa = num(hit.plateAppearances), ops = num(hit.ops), hr = num(hit.homeRuns);
    return (pa != null && pa >= 120 && ops != null && ops >= 0.75) || (hr != null && hr >= 15);
  }
  return false;
}

async function pullMlb() {
  console.log('— MLB (StatsAPI) —');
  const out = {};
  const teamsDoc = await getJson('https://statsapi.mlb.com/api/v1/teams?sportId=1');
  const teams = (teamsDoc && teamsDoc.teams) || [];
  const injured = []; // { code, personId, name, pos, status }
  for (const t of teams) {
    const code = MLB_CODE_FIX[t.abbreviation] || t.abbreviation;
    const roster = await getJson(`https://statsapi.mlb.com/api/v1/teams/${t.id}/roster?rosterType=40Man`);
    for (const r of (roster && roster.roster) || []) {
      const desc = (r.status && r.status.description) || '';
      if (!OUT_RE.test(desc)) continue;
      injured.push({
        code, personId: r.person && r.person.id,
        name: r.person && r.person.fullName,
        pos: (r.position && r.position.abbreviation) || null,
        status: desc.replace(/Injured List/i, 'IL').replace(/^\s*\d+-Day IL\s*$/i, (m) => m.trim()),
      });
    }
    await sleep(80);
  }
  console.log(`  ${injured.length} jugadores en IL/suspendidos`);

  // stats de temporada en lotes para decidir "crucial"
  for (let i = 0; i < injured.length; i += 25) {
    const batch = injured.slice(i, i + 25).filter((p) => p.personId);
    if (!batch.length) continue;
    const ids = batch.map((p) => p.personId).join(',');
    const doc = await getJson(`https://statsapi.mlb.com/api/v1/people?personIds=${ids}&hydrate=stats(group=[hitting,pitching],type=[season],season=${SEASON})`);
    const byId = new Map(((doc && doc.people) || []).map((p) => [p.id, p]));
    for (const p of batch) {
      const person = byId.get(p.personId);
      let hit = null, pit = null;
      for (const s of (person && person.stats) || []) {
        const g = s.group && s.group.displayName;
        const st = s.splits && s.splits[0] && s.splits[0].stat;
        if (g === 'hitting') hit = st;
        if (g === 'pitching') pit = st;
      }
      p.stat_line = p.pos === 'P' ? (pitcherLine(pit) || hitterLine(hit)) : (hitterLine(hit) || pitcherLine(pit));
      p.crucial = isCrucial(p.pos, hit, pit);
    }
    await sleep(120);
  }

  for (const p of injured) {
    if (!p.name) continue;
    (out[p.code] = out[p.code] || []).push({ name: p.name, pos: p.pos, status: p.status, stat_line: p.stat_line || null, crucial: !!p.crucial });
  }
  // cruciales primero
  for (const code of Object.keys(out)) out[code].sort((a, b) => (b.crucial - a.crucial));
  console.log(`  equipos con bajas: ${Object.keys(out).length}, cruciales: ${injured.filter((p) => p.crucial).length}`);
  return out;
}

/* ── NBA (ESPN) ──────────────────────────────────────────────────────────── */
async function pullNba() {
  console.log('— NBA (ESPN injuries) —');
  const out = {};
  // mapa displayName → abbreviation
  const teamsDoc = await getJson('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=40');
  const abbr = new Map();
  const teamList = (((teamsDoc || {}).sports || [])[0]?.leagues || [])[0]?.teams || [];
  for (const t of teamList) if (t.team) abbr.set(t.team.displayName, t.team.abbreviation);

  const doc = await getJson('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries');
  for (const entry of (doc && doc.injuries) || []) {
    const code = abbr.get(entry.displayName) || entry.shortDisplayName || entry.displayName;
    for (const inj of entry.injuries || []) {
      const a = inj.athlete || {};
      if (!a.displayName) continue;
      (out[code] = out[code] || []).push({
        name: a.displayName,
        pos: (a.position && a.position.abbreviation) || null,
        status: inj.status || null,
        detail: (inj.details && (inj.details.type || inj.details.detail)) || null,
        stat_line: null,
        crucial: null, // sin stats en v1 — honesto: no adivinamos quién es crucial
      });
    }
  }
  console.log(`  equipos con reporte: ${Object.keys(out).length}`);
  return out;
}

/* ── main ────────────────────────────────────────────────────────────────── */
const doc = { generated_at: new Date().toISOString(), mlb: await pullMlb(), nba: await pullNba() };

const dist = join(process.cwd(), 'cloudflare', 'dist');
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'injuries.json'), JSON.stringify(doc));
console.log(`→ ${join(dist, 'injuries.json')}`);

if (!API_TOKEN) { console.log('Sin CLOUDFLARE_API_TOKEN; no publico a KV.'); process.exit(0); }
const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent('injuries:latest')}`,
  { method: 'PUT', headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(doc) },
);
const body = await res.json().catch(() => ({}));
if (!res.ok || body.success === false) { console.error('✗ KV injuries:latest:', JSON.stringify(body.errors || body).slice(0, 300)); process.exit(1); }
console.log('✅ KV: injuries:latest actualizado (REST).');
