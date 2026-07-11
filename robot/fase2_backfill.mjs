// AA Sports — Fase 2: backfill histórico multideporte (corre en GitHub Actions).
//
// Descarga los datos históricos que entrenarán/validarán los modelos de
// soccer, tenis y NBA, los normaliza a JSON compacto y los deja en data/fase2/.
// Todas las fuentes son públicas, gratuitas y keyless:
//   - Soccer: football-data.co.uk (resultados + odds de cierre, CSV por liga/temporada)
//   - Tenis:  github.com/JeffSackmann tennis_atp / tennis_wta (CSV por año)
//   - NBA:    ESPN scoreboard por fecha (regular + playoffs)
//
// Uso: node robot/fase2_backfill.mjs [soccer|tennis|nba|all]

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'fase2');
const what = (process.argv[2] || 'all').toLowerCase();
const manifest = { generated_at: new Date().toISOString(), soccer: {}, tennis: {}, nba: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, asText = true, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'aa-sports-backfill/1.0' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return asText ? await res.text() : await res.json();
    } catch (e) {
      if (i === tries - 1) { console.warn(`  ✗ ${url}: ${e.message}`); return null; }
      await sleep(800 * (i + 1));
    }
  }
  return null;
}

// CSV simple (las fuentes usadas no llevan comas dentro de campos con comillas
// salvo casos raros; se manejan comillas básicas por si acaso).
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (line) => {
    const out = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = split(l);
    const row = {};
    head.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
}

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

/* ── SOCCER ──────────────────────────────────────────────────────────────── */
// Ligas top de football-data.co.uk + 6 temporadas. Guardamos resultado y las
// odds de cierre (B365 y Pinnacle) para validar valor vs mercado.
const SOCCER_DIVS = { E0: 'premier', SP1: 'laliga', I1: 'seriea', D1: 'bundesliga', F1: 'ligue1' };
const SOCCER_SEASONS = ['2021', '2122', '2223', '2324', '2425', '2526'];

async function pullSoccer() {
  console.log('— SOCCER (football-data.co.uk) —');
  const dir = join(OUT, 'soccer');
  mkdirSync(dir, { recursive: true });
  for (const [div, name] of Object.entries(SOCCER_DIVS)) {
    const rows = [];
    for (const ss of SOCCER_SEASONS) {
      const txt = await get(`https://www.football-data.co.uk/mmz4281/${ss}/${div}.csv`);
      if (!txt) continue;
      for (const r of parseCsv(txt)) {
        if (!r.HomeTeam || r.FTHG === '' || r.FTHG == null) continue;
        rows.push({
          season: ss, date: r.Date || null,
          home: r.HomeTeam, away: r.AwayTeam,
          hg: num(r.FTHG), ag: num(r.FTAG), res: r.FTR || null,       // H/D/A
          hg_ht: num(r.HTHG), ag_ht: num(r.HTAG),
          odds_h: num(r.B365H) ?? num(r.PSH), odds_d: num(r.B365D) ?? num(r.PSD), odds_a: num(r.B365A) ?? num(r.PSA),
        });
      }
      await sleep(200);
    }
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ div, league: name, matches: rows }));
    manifest.soccer[name] = rows.length;
    console.log(`  ${name}: ${rows.length} partidos`);
  }
}

/* ── TENIS ───────────────────────────────────────────────────────────────── */
const TENNIS_YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

async function pullTennis() {
  console.log('— TENIS (Jeff Sackmann) —');
  const dir = join(OUT, 'tennis');
  mkdirSync(dir, { recursive: true });
  for (const tour of ['atp', 'wta']) {
    const rows = [];
    for (const y of TENNIS_YEARS) {
      const txt = await get(`https://raw.githubusercontent.com/JeffSackmann/tennis_${tour}/master/${tour}_matches_${y}.csv`);
      if (!txt) continue;
      for (const r of parseCsv(txt)) {
        if (!r.winner_name || !r.loser_name) continue;
        rows.push({
          date: r.tourney_date || null, tourney: r.tourney_name || null,
          surface: r.surface || null, level: r.tourney_level || null, round: r.round || null,
          best_of: num(r.best_of),
          w: r.winner_name, w_rank: num(r.winner_rank),
          l: r.loser_name, l_rank: num(r.loser_rank),
          score: r.score || null,
        });
      }
      await sleep(200);
    }
    writeFileSync(join(dir, `${tour}.json`), JSON.stringify({ tour, matches: rows }));
    manifest.tennis[tour] = rows.length;
    console.log(`  ${tour.toUpperCase()}: ${rows.length} partidos`);
  }
}

/* ── NBA ─────────────────────────────────────────────────────────────────── */
// ESPN scoreboard por fecha (keyless). 3 temporadas: regular (type 2) y playoffs (3).
const NBA_SEASONS = [
  { name: '2023-24', from: '2023-10-24', to: '2024-06-30' },
  { name: '2024-25', from: '2024-10-22', to: '2025-06-30' },
  { name: '2025-26', from: '2025-10-21', to: '2026-07-01' },
];

function* dateRange(from, to) {
  const d = new Date(from + 'T12:00:00Z'), end = new Date(to + 'T12:00:00Z');
  while (d <= end) { yield d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 1); }
}

async function pullNba() {
  console.log('— NBA (ESPN por fecha) —');
  const dir = join(OUT, 'nba');
  mkdirSync(dir, { recursive: true });
  for (const season of NBA_SEASONS) {
    const games = [];
    const dates = [...dateRange(season.from, season.to)];
    // lotes de 8 fechas en paralelo para no tardar ni saturar
    for (let i = 0; i < dates.length; i += 8) {
      const batch = dates.slice(i, i + 8);
      const results = await Promise.all(batch.map(async (day) => {
        const d = await get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day.replaceAll('-', '')}`, false);
        if (!d || !Array.isArray(d.events)) return [];
        return d.events.map((ev) => {
          const c = (ev.competitions && ev.competitions[0]) || {};
          const comp = c.competitors || [];
          const home = comp.find((x) => x.homeAway === 'home') || {};
          const away = comp.find((x) => x.homeAway === 'away') || {};
          const st = (c.status && c.status.type) || {};
          if (!String(st.name || '').toUpperCase().includes('FINAL')) return null;
          return {
            date: day,
            type: (ev.season && ev.season.type) || null, // 2 regular, 3 playoffs
            home: home.team && home.team.abbreviation, hs: num(home.score),
            away: away.team && away.team.abbreviation, as: num(away.score),
          };
        }).filter(Boolean);
      }));
      games.push(...results.flat());
      await sleep(150);
      if (i % 80 === 0) console.log(`  ${season.name}: ${day0(dates, i)}… ${games.length} juegos`);
    }
    writeFileSync(join(dir, `${season.name}.json`), JSON.stringify({ season: season.name, games }));
    manifest.nba[season.name] = games.length;
    console.log(`  ${season.name}: ${games.length} juegos finales`);
  }
}
const day0 = (dates, i) => dates[Math.min(i, dates.length - 1)];

/* ── main ────────────────────────────────────────────────────────────────── */
mkdirSync(OUT, { recursive: true });
if (what === 'all' || what === 'soccer') await pullSoccer();
if (what === 'all' || what === 'tennis') await pullTennis();
if (what === 'all' || what === 'nba') await pullNba();
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('\n✅ Backfill Fase 2 completo:', JSON.stringify(manifest));
