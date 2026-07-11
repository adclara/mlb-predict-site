// AA Sports — Modelo NBA: Elo con margen de victoria + validación walk-forward.
//
// Motor (solo stdlib, como el de MLB/soccer):
//   - Elo por equipo, arranque 1500, arrastre entre temporadas con regresión
//     al centro (los rosters cambian): r ← (1-carry)*1505 + carry*r.
//   - Ventaja local en puntos Elo (0 en sede neutral: burbuja/Copa NBA).
//   - Multiplicador por margen de victoria (estilo FiveThirtyEight):
//     K * ((mov+3)^0.8) / (7.5 + 0.006*elo_diff_ganador).
//   - Fatiga back-to-back: castigo en el CÁLCULO del favorito si el equipo
//     jugó el día anterior (no toca el rating).
//
// Validación walk-forward: los juegos se procesan en orden cronológico y CADA
// predicción se hace ANTES de actualizar ratings (cero fuga). Los
// hiperparámetros (K, HFA, carry, b2b) se eligen SOLO con las temporadas de
// burn-in; las temporadas de evaluación quedan intactas.
//
// ⚠️ HONESTIDAD: el scoreboard histórico de ESPN no conserva odds (odds:null
// en todas las temporadas), así que NO hay comparación modelo-vs-mercado aquí.
// El gate se basa en calibración + hit-rate por tier; la comparación vs
// mercado se hará en modo sombra con odds vivas antes de publicar nada.
//
// Uso: node robot/nba_model.mjs backtest [burnInSeasons=2]

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'data', 'fase2', 'nba');

/* ── carga ───────────────────────────────────────────────────────────────── */
export function loadSeasons() {
  const files = readdirSync(DIR).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
  return files.map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')));
}

/* ── motor Elo ───────────────────────────────────────────────────────────── */
export function makeElo({ k = 20, hfa = 70, carry = 0.75, b2b = 30 } = {}) {
  const R = new Map();       // rating por equipo
  const last = new Map();    // última fecha jugada por equipo
  const get = (t) => (R.has(t) ? R.get(t) : 1500);

  const dayDiff = (a, b) => Math.round((new Date(a + 'T12:00Z') - new Date(b + 'T12:00Z')) / 86400000);

  return {
    newSeason() {
      for (const [t, r] of R) R.set(t, (1 - carry) * 1505 + carry * r);
      last.clear(); // el descanso no cruza temporadas
    },
    // prob de que gane el local, ANTES de ver el resultado
    predict(g) {
      let dh = get(g.home) - get(g.away) + (g.neutral ? 0 : hfa);
      const lh = last.get(g.home), la = last.get(g.away);
      if (lh && dayDiff(g.date, lh) === 1) dh -= b2b;   // local en back-to-back
      if (la && dayDiff(g.date, la) === 1) dh += b2b;   // visita en back-to-back
      return 1 / (1 + Math.pow(10, -dh / 400));
    },
    update(g, pHome) {
      const homeWin = g.hs > g.as ? 1 : 0;
      const mov = Math.abs(g.hs - g.as);
      const eloDiffWinner = homeWin ? get(g.home) - get(g.away) : get(g.away) - get(g.home);
      const mult = Math.pow(mov + 3, 0.8) / (7.5 + 0.006 * eloDiffWinner);
      const delta = k * mult * (homeWin - pHome);
      R.set(g.home, get(g.home) + delta);
      R.set(g.away, get(g.away) - delta);
      last.set(g.home, g.date);
      last.set(g.away, g.date);
    },
    ratings: R,
  };
}

/* ── corrida walk-forward con unos hiperparámetros dados ─────────────────── */
function run(seasons, params, evalFromIdx) {
  const elo = makeElo(params);
  const out = []; // {p, y, season, type} solo de temporadas evaluadas
  seasons.forEach((s, idx) => {
    elo.newSeason();
    const games = [...s.games].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const g of games) {
      if (g.hs == null || g.as == null || !g.home || !g.away || g.hs === g.as) continue;
      const p = elo.predict(g);
      if (idx >= evalFromIdx) out.push({ p, y: g.hs > g.as ? 1 : 0, season: s.season, type: g.type });
      elo.update(g, p);
    }
  });
  return out;
}

/* ── métricas ────────────────────────────────────────────────────────────── */
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

// tiers sobre la prob del LADO ELEGIDO (max(p, 1-p)); hit = acierta el lado
function tiers(rows) {
  const T = { t55: [0.55, 0.6], t60: [0.6, 0.65], t65: [0.65, 0.7], t70: [0.7, 1.01] };
  const res = {};
  for (const [name, [lo, hi]] of Object.entries(T)) {
    const sel = rows.filter((r) => { const c = Math.max(r.p, 1 - r.p); return c >= lo && c < hi; });
    const hits = sel.filter((r) => (r.p >= 0.5) === (r.y === 1)).length;
    res[name] = { n: sel.length, hit: sel.length ? +(hits / sel.length).toFixed(3) : null, p_media: sel.length ? +(sel.reduce((s, r) => s + Math.max(r.p, 1 - r.p), 0) / sel.length).toFixed(3) : null };
  }
  // acumulado ≥ umbral (lo que se publicaría)
  for (const [name, lo] of [['ge60', 0.6], ['ge65', 0.65], ['ge70', 0.7]]) {
    const sel = rows.filter((r) => Math.max(r.p, 1 - r.p) >= lo);
    const hits = sel.filter((r) => (r.p >= 0.5) === (r.y === 1)).length;
    res[name] = { n: sel.length, hit: sel.length ? +(hits / sel.length).toFixed(3) : null, p_media: sel.length ? +(sel.reduce((s, r) => s + Math.max(r.p, 1 - r.p), 0) / sel.length).toFixed(3) : null };
  }
  return res;
}

/* ── backtest completo ───────────────────────────────────────────────────── */
export function backtest(burnInSeasons = 2) {
  const seasons = loadSeasons();
  if (seasons.length <= burnInSeasons) throw new Error(`Solo ${seasons.length} temporadas; burn-in ${burnInSeasons} no deja nada que evaluar`);
  const names = seasons.map((s) => s.season);
  console.log(`Temporadas: ${names.join(', ')} | burn-in: ${names.slice(0, burnInSeasons).join(', ')}`);

  // 1) grid de hiperparámetros SOLO sobre el burn-in (validado dentro del
  //    burn-in: primera temporada calienta, las siguientes puntúan)
  let best = null;
  if (burnInSeasons >= 2) {
    for (const k of [15, 20, 25]) for (const hfa of [50, 70, 90]) for (const carry of [0.6, 0.75]) for (const b2b of [0, 30, 60]) {
      const rows = run(seasons.slice(0, burnInSeasons), { k, hfa, carry, b2b }, 1);
      const b = brier(rows);
      if (!best || b < best.brier) best = { k, hfa, carry, b2b, brier: b };
    }
    console.log(`Grid burn-in → K=${best.k} HFA=${best.hfa} carry=${best.carry} b2b=${best.b2b} (brier ${best.brier.toFixed(4)})`);
  } else {
    best = { k: 20, hfa: 70, carry: 0.75, b2b: 30, brier: null };
    console.log('burn-in corto: hiperparámetros por defecto (K=20 HFA=70 carry=0.75 b2b=30)');
  }

  // 2) evaluación limpia: temporadas después del burn-in, params CONGELADOS
  const rows = run(seasons, best, burnInSeasons);
  const reg = rows.filter((r) => r.type === 2), po = rows.filter((r) => r.type === 3);

  const perSeason = {};
  for (const s of names.slice(burnInSeasons)) {
    const rs = rows.filter((r) => r.season === s);
    if (rs.length) perSeason[s] = { n: rs.length, brier: +brier(rs).toFixed(4), acc: +accuracy(rs).toFixed(3) };
  }

  // baseline: "siempre el local" con la tasa base del burn-in
  const burnRows = run(seasons.slice(0, burnInSeasons), best, 0);
  const pHomeBase = burnRows.reduce((s, r) => s + r.y, 0) / burnRows.length;
  const baseline = rows.reduce((s, r) => s + (pHomeBase - r.y) ** 2, 0) / rows.length;

  const report = {
    generated_at: new Date().toISOString(),
    seasons: names, burn_in: names.slice(0, burnInSeasons),
    params: best,
    n_eval: rows.length,
    market_comparison: null, // ESPN no conserva odds históricas — ver nota del archivo
    metrics: {
      brier: +brier(rows).toFixed(4), logloss: +logloss(rows).toFixed(4), acc: +accuracy(rows).toFixed(3),
      brier_baseline_local: +baseline.toFixed(4), p_home_base: +pHomeBase.toFixed(3),
      regular: reg.length ? { n: reg.length, brier: +brier(reg).toFixed(4), acc: +accuracy(reg).toFixed(3) } : null,
      playoffs: po.length ? { n: po.length, brier: +brier(po).toFixed(4), acc: +accuracy(po).toFixed(3) } : null,
    },
    per_season: perSeason,
    tiers: tiers(rows),
    calibration: calibration(rows),
  };

  console.log(`\nEval n=${rows.length}: brier ${report.metrics.brier} (baseline local ${report.metrics.brier_baseline_local}) | logloss ${report.metrics.logloss} | acc ${report.metrics.acc}`);
  console.log('Por temporada:', JSON.stringify(perSeason));
  console.log('Tiers:', JSON.stringify(report.tiers));
  console.log('Calibración:', JSON.stringify(report.calibration.filter((c) => c.n > 0)));

  writeFileSync(join(DIR, 'nba_backtest.json'), JSON.stringify(report, null, 2));
  console.log(`\n✅ ${join(DIR, 'nba_backtest.json')}`);
  return report;
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const cmd = process.argv[2];
if (cmd === 'backtest') {
  const burn = parseInt(process.argv[3], 10);
  backtest(Number.isFinite(burn) ? burn : 2);
} else if (cmd) {
  console.log('Uso: node robot/nba_model.mjs backtest [burnInSeasons]');
}
