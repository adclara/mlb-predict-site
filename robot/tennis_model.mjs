// AA Sports — Modelo de Tenis: Elo por jugador con superficie + walk-forward.
//
// Motor (solo stdlib):
//   - Elo general por jugador + Elo por superficie (hard/clay/grass), con
//     K decreciente con la experiencia: K = 250 / (5 + partidos)^0.4
//     (forma estándar de Elo de tenis; jugadores nuevos se mueven rápido).
//   - Predicción con mezcla: diff = (1-wS)*general + wS*superficie, y la
//     mezcla wS se elige SOLO en el burn-in.
//   - La superficie se INFIERE del nombre del torneo (mapping de torneos
//     conocidos; default hard, que es la mayoría del calendario). Es una
//     aproximación honesta: un torneo mal clasificado solo mueve la mezcla
//     hacia el Elo general.
//
// Validación walk-forward: partidos en orden cronológico, predicción SIEMPRE
// antes de actualizar. Para no filtrar el resultado por la orientación de las
// filas (el ganador siempre viene primero en los datos), cada partido se
// re-orienta determinísticamente: jugador A = primero alfabético, y = 1 si A ganó.
//
// ⚠️ HONESTIDAD: los datos ESPN no traen odds → NO hay comparación vs mercado.
// El gate aquí es calibración + hit-rate por tier; antes de publicar tenis se
// exigirá además modo sombra con odds vivas (mismo protocolo que soccer).
//
// Uso: node robot/tennis_model.mjs backtest [burnUntil=2020-01-01]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'data', 'fase2', 'tennis');

/* ── superficie por torneo (substring, case-insensitive) ─────────────────── */
const CLAY = ['roland garros', 'french open', 'monte carlo', 'monte-carlo', 'internazionali', 'italian open', 'rome', 'madrid', 'barcelona', 'hamburg', 'gstaad', 'bastad', 'båstad', 'umag', 'kitzbuhel', 'kitzbühel', 'estoril', 'marrakech', 'houston', 'geneva', 'cordoba', 'córdoba', 'buenos aires', 'rio open', 'santiago', 'munich', 'bucharest', 'rabat', 'palermo', 'charleston', 'strasbourg', 'prague', 'lausanne', 'budapest', 'parma', 'cagliari', 'belgrade', 'banja luka', 'sardegna', 'bogota', 'bogotá'];
const GRASS = ['wimbledon', 'queen', 'halle', 'hertogenbosch', 'libema', 'rosmalen', 'eastbourne', 'mallorca', 'newport', 'berlin', 'bad homburg', 'nottingham', 'birmingham'];

export function surfaceOf(tourney, tour) {
  const t = String(tourney || '').toLowerCase();
  // Stuttgart: ATP es hierba (junio), WTA es tierra bajo techo (abril)
  if (t.includes('stuttgart')) return tour === 'wta' ? 'clay' : 'grass';
  for (const s of CLAY) if (t.includes(s)) return 'clay';
  for (const s of GRASS) if (t.includes(s)) return 'grass';
  return 'hard';
}

/* ── motor Elo ───────────────────────────────────────────────────────────── */
function makeElo(wS) {
  const gen = new Map();   // { r, n } por jugador
  const surf = new Map();  // { r, n } por jugador|superficie
  const G = (m, k) => { if (!m.has(k)) m.set(k, { r: 1500, n: 0 }); return m.get(k); };
  const K = (n) => 250 / Math.pow(5 + n, 0.4);

  return {
    predict(a, b, sf) {
      const dGen = G(gen, a).r - G(gen, b).r;
      const dSurf = G(surf, `${a}|${sf}`).r - G(surf, `${b}|${sf}`).r;
      const d = (1 - wS) * dGen + wS * dSurf;
      return 1 / (1 + Math.pow(10, -d / 400));
    },
    experience(a, b) { return Math.min(G(gen, a).n, G(gen, b).n); },
    update(a, b, sf, yA) {
      const pGen = 1 / (1 + Math.pow(10, -(G(gen, a).r - G(gen, b).r) / 400));
      const pSurf = 1 / (1 + Math.pow(10, -(G(surf, `${a}|${sf}`).r - G(surf, `${b}|${sf}`).r) / 400));
      const ga = G(gen, a), gb = G(gen, b), sa = G(surf, `${a}|${sf}`), sb = G(surf, `${b}|${sf}`);
      ga.r += K(ga.n) * (yA - pGen); gb.r += K(gb.n) * ((1 - yA) - (1 - pGen));
      sa.r += K(sa.n) * (yA - pSurf); sb.r += K(sb.n) * ((1 - yA) - (1 - pSurf));
      ga.n++; gb.n++; sa.n++; sb.n++;
    },
  };
}

/* ── corrida walk-forward ────────────────────────────────────────────────── */
function run(matches, tour, wS, evalFrom, evalTo = '9999') {
  const elo = makeElo(wS);
  const out = [];
  for (const m of matches) {
    if (!m.w || !m.l || !m.date) continue;
    const sf = surfaceOf(m.tourney, tour);
    // orientación determinística (evita que "el ganador va primero" filtre el resultado)
    const [A, B] = m.w < m.l ? [m.w, m.l] : [m.l, m.w];
    const yA = A === m.w ? 1 : 0;
    const p = elo.predict(A, B, sf);
    if (m.date >= evalFrom && m.date < evalTo) {
      out.push({ p, y: yA, date: m.date, exp: elo.experience(A, B), sf });
    }
    elo.update(A, B, sf, yA);
  }
  return out;
}

/* ── métricas (mismas formas que nba_model) ──────────────────────────────── */
const brier = (rows) => rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length;
const logloss = (rows) => rows.reduce((s, r) => s - Math.log(Math.max(1e-12, r.y ? r.p : 1 - r.p)), 0) / rows.length;
const accuracy = (rows) => rows.filter((r) => (r.p >= 0.5) === (r.y === 1)).length / rows.length;

function calibration(rows, bins = 10) {
  const B = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (const r of rows) {
    const b = Math.min(bins - 1, Math.floor(r.p * bins));
    B[b].n++; B[b].p += r.p; B[b].y += r.y;
  }
  return B.map((b, i) => ({ bin: `${(i / bins).toFixed(1)}-${((i + 1) / bins).toFixed(1)}`, n: b.n, p_media: b.n ? +(b.p / b.n).toFixed(3) : null, freq_real: b.n ? +(b.y / b.n).toFixed(3) : null }));
}

function tiers(rows) {
  const res = {};
  for (const [name, lo, hi] of [['t55', 0.55, 0.6], ['t60', 0.6, 0.65], ['t65', 0.65, 0.7], ['t70', 0.7, 1.01], ['ge60', 0.6, 1.01], ['ge65', 0.65, 1.01], ['ge70', 0.7, 1.01]]) {
    const sel = rows.filter((r) => { const c = Math.max(r.p, 1 - r.p); return c >= lo && c < hi; });
    const hits = sel.filter((r) => (r.p >= 0.5) === (r.y === 1)).length;
    res[name] = { n: sel.length, hit: sel.length ? +(hits / sel.length).toFixed(3) : null, p_media: sel.length ? +(sel.reduce((s, r) => s + Math.max(r.p, 1 - r.p), 0) / sel.length).toFixed(3) : null };
  }
  return res;
}

/* ── backtest por tour ───────────────────────────────────────────────────── */
export function backtest(burnUntil = '2020-01-01') {
  const report = { generated_at: new Date().toISOString(), burn_until: burnUntil, market_comparison: null, tours: {} };
  for (const tour of ['atp', 'wta']) {
    const file = join(DIR, `${tour}.json`);
    if (!existsSync(file)) { console.log(`(sin ${tour}.json, salto)`); continue; }
    const matches = (JSON.parse(readFileSync(file, 'utf8')).matches || [])
      .filter((m) => m.date && m.w && m.l)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const first = matches[0]?.date, last = matches[matches.length - 1]?.date;
    console.log(`\n— ${tour.toUpperCase()}: ${matches.length} partidos (${first} → ${last}) —`);
    if (!matches.length || last <= burnUntil) { console.log('  datos insuficientes para evaluar tras el burn-in'); continue; }

    // 1) wS elegido SOLO dentro del burn-in (validación interna: la primera
    //    mitad del burn-in calienta, la segunda puntúa)
    const burnRows = matches.filter((m) => m.date < burnUntil);
    const mid = burnRows.length ? burnRows[Math.floor(burnRows.length / 2)].date : burnUntil;
    let best = { wS: 0.25, brier: Infinity };
    for (const wS of [0, 0.25, 0.5, 0.75]) {
      const rows = run(matches, tour, wS, mid, burnUntil);
      if (rows.length) { const b = brier(rows); if (b < best.brier) best = { wS, brier: b }; }
    }
    console.log(`  mezcla superficie wS=${best.wS} (brier interna ${Number.isFinite(best.brier) ? best.brier.toFixed(4) : 'n/a'})`);

    // 2) evaluación limpia desde burnUntil, wS congelado
    const rows = run(matches, tour, best.wS, burnUntil);
    // partidos con ambos jugadores rodados (≥10 previos) — el corte publicable
    const seasoned = rows.filter((r) => r.exp >= 10);

    const perYear = {};
    for (const r of rows) {
      const y = r.date.slice(0, 4);
      (perYear[y] = perYear[y] || []).push(r);
    }
    const perYearTab = Object.fromEntries(Object.entries(perYear).map(([y, rs]) => [y, { n: rs.length, brier: +brier(rs).toFixed(4), acc: +accuracy(rs).toFixed(3) }]));

    const t = {
      n_matches: matches.length, range: [first, last], wS: best.wS,
      n_eval: rows.length,
      metrics: { brier: +brier(rows).toFixed(4), brier_baseline_50: 0.25, logloss: +logloss(rows).toFixed(4), acc: +accuracy(rows).toFixed(3) },
      seasoned: { n: seasoned.length, brier: seasoned.length ? +brier(seasoned).toFixed(4) : null, acc: seasoned.length ? +accuracy(seasoned).toFixed(3) : null },
      per_year: perYearTab,
      tiers: tiers(seasoned),
      calibration: calibration(seasoned),
    };
    report.tours[tour] = t;
    console.log(`  eval n=${t.n_eval}: brier ${t.metrics.brier} (azar 0.25) | acc ${t.metrics.acc}`);
    console.log(`  con experiencia (≥10 partidos ambos) n=${t.seasoned.n}: brier ${t.seasoned.brier} | acc ${t.seasoned.acc}`);
    console.log('  por año:', JSON.stringify(perYearTab));
    console.log('  tiers (seasoned):', JSON.stringify(t.tiers));
  }
  writeFileSync(join(DIR, 'tennis_backtest.json'), JSON.stringify(report, null, 2));
  console.log(`\n✅ ${join(DIR, 'tennis_backtest.json')}`);
  return report;
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const cmd = process.argv[2];
if (cmd === 'backtest') {
  backtest(/^\d{4}-\d{2}-\d{2}$/.test(process.argv[3] || '') ? process.argv[3] : '2020-01-01');
} else if (cmd) {
  console.log('Uso: node robot/tennis_model.mjs backtest [burnUntil]');
}
