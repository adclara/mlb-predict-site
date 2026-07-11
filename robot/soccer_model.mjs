// AA Sports — Motor de soccer (Dixon-Coles) + backtest walk-forward honesto.
//
// Modelo: Poisson bivariado con fuerzas de ataque/defensa por equipo,
// decaimiento temporal exponencial, ventaja local y corrección de
// Dixon-Coles para marcadores bajos. Produce probabilidades 1X2 y goles
// esperados. Solo stdlib de Node (mismo espíritu que el motor MLB).
//
// Backtest: walk-forward por liga — para cada jornada se ajusta el modelo
// SOLO con partidos anteriores y se predice la jornada. Se compara contra el
// mercado (odds promedio des-vigadas) con Brier/log-loss, calibración y ROI
// de una estrategia de valor con odds B365 reales.
//
// Uso:
//   node robot/soccer_model.mjs backtest            # todas las ligas
//   node robot/soccer_model.mjs backtest premier    # una liga

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA = join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'fase2', 'soccer');
const LEAGUES = ['premier', 'laliga', 'seriea', 'bundesliga', 'ligue1'];
const XI = 0.0065;          // decaimiento temporal (por día)
const MAX_GOALS = 10;       // truncado de la matriz de marcadores
const BURN_SEASONS = 1;     // temporadas de calentamiento antes de evaluar

/* ── utilidades ──────────────────────────────────────────────────────────── */

// fechas de football-data: dd/mm/yyyy o dd/mm/yy → días epoch
function toDay(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let y = +m[3]; if (y < 100) y += 2000;
  return Math.floor(Date.UTC(y, +m[2] - 1, +m[1]) / 86400000);
}

const pois = (k, l) => {
  // Poisson pmf estable para k pequeño
  let p = Math.exp(-l);
  for (let i = 1; i <= k; i++) p *= l / i;
  return p;
};

// corrección Dixon-Coles para (0,0),(0,1),(1,0),(1,1)
function tau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/* ── ajuste del modelo (IPF ponderado) ──────────────────────────────────── */

// Ajusta att/def por equipo + ventaja local con pesos exp(-XI * antigüedad).
export function fitLeague(matches, asOfDay, rho = -0.1) {
  const teams = new Map(); // team -> {att, def}
  const w = [];
  const rows = [];
  for (const m of matches) {
    if (m.day >= asOfDay) continue;
    rows.push(m);
    w.push(Math.exp(-XI * (asOfDay - m.day)));
    if (!teams.has(m.home)) teams.set(m.home, { att: 1, def: 1 });
    if (!teams.has(m.away)) teams.set(m.away, { att: 1, def: 1 });
  }
  if (rows.length < 50) return null;

  let sumW = 0, sumHG = 0, sumAG = 0;
  for (let i = 0; i < rows.length; i++) { sumW += w[i]; sumHG += w[i] * rows[i].hg; sumAG += w[i] * rows[i].ag; }
  let mu = (sumHG + sumAG) / (2 * sumW);      // goles medios por lado
  let adv = sumHG / Math.max(1e-9, sumAG);    // ventaja local inicial

  for (let iter = 0; iter < 40; iter++) {
    const accA = new Map(), accD = new Map(); // team -> {num, den}
    const get = (map, t) => { let v = map.get(t); if (!v) { v = { num: 0, den: 0 }; map.set(t, v); } return v; };
    let advNum = 0, advDen = 0;
    for (let i = 0; i < rows.length; i++) {
      const m = rows[i], wi = w[i];
      const h = teams.get(m.home), a = teams.get(m.away);
      const lh = mu * adv * h.att * a.def;
      const la = mu * a.att * h.def;
      // ataque: goles anotados vs esperados
      const ah = get(accA, m.home); ah.num += wi * m.hg; ah.den += wi * mu * adv * a.def;
      const aa = get(accA, m.away); aa.num += wi * m.ag; aa.den += wi * mu * h.def;
      // defensa: goles permitidos vs esperados
      const dh = get(accD, m.home); dh.num += wi * m.ag; dh.den += wi * mu * a.att;
      const da = get(accD, m.away); da.num += wi * m.hg; da.den += wi * mu * adv * h.att;
      advNum += wi * m.hg; advDen += wi * mu * h.att * a.def;
      void lh; void la;
    }
    let meanAtt = 0, n = 0;
    for (const [t, obj] of teams) {
      const A = accA.get(t), D = accD.get(t);
      if (A && A.den > 0) obj.att = 0.7 * obj.att + 0.3 * (A.num / A.den);
      if (D && D.den > 0) obj.def = 0.7 * obj.def + 0.3 * (D.num / D.den);
      meanAtt += obj.att; n++;
    }
    // normaliza (media att = 1) para identificabilidad
    meanAtt /= n;
    for (const obj of teams.values()) { obj.att /= meanAtt; obj.def *= meanAtt; }
    adv = 0.7 * adv + 0.3 * (advNum / Math.max(1e-9, advDen));
  }
  return { teams, mu, adv, rho, n: rows.length };
}

// probabilidades 1X2 + goles esperados para un partido
export function predictMatch(fit, home, away) {
  const h = fit.teams.get(home), a = fit.teams.get(away);
  if (!h || !a) return null; // equipo nuevo sin historia: no se predice
  const lh = fit.mu * fit.adv * h.att * a.def;
  const la = fit.mu * a.att * h.def;
  let pH = 0, pD = 0, pA = 0;
  for (let x = 0; x <= MAX_GOALS; x++) {
    for (let y = 0; y <= MAX_GOALS; y++) {
      const p = pois(x, lh) * pois(y, la) * tau(x, y, lh, la, fit.rho);
      if (p <= 0) continue;
      if (x > y) pH += p; else if (x === y) pD += p; else pA += p;
    }
  }
  const s = pH + pD + pA;
  return { pH: pH / s, pD: pD / s, pA: pA / s, xg_home: lh, xg_away: la };
}

// estima rho por búsqueda en malla sobre la primera temporada (log-lik)
function estimateRho(matches, burnEndDay) {
  let best = -0.1, bestLL = -Infinity;
  for (let rho = -0.2; rho <= 0.05; rho += 0.025) {
    const fit = fitLeague(matches, burnEndDay, rho);
    if (!fit) continue;
    let ll = 0, n = 0;
    for (const m of matches) {
      if (m.day >= burnEndDay) continue;
      const h = fit.teams.get(m.home), a = fit.teams.get(m.away);
      if (!h || !a) continue;
      const lh = fit.mu * fit.adv * h.att * a.def, la = fit.mu * a.att * h.def;
      const p = Math.max(1e-12, pois(m.hg, lh) * pois(m.ag, la) * tau(m.hg, m.ag, lh, la, rho));
      ll += Math.log(p); n++;
    }
    if (n && ll > bestLL) { bestLL = ll; best = rho; }
  }
  return best;
}

/* ── mercado: prob implícitas des-vigadas ───────────────────────────────── */
function marketProbs(m) {
  const oh = m.avg_h ?? m.odds_h, od = m.avg_d ?? m.odds_d, oa = m.avg_a ?? m.odds_a;
  if (!oh || !od || !oa) return null;
  const ih = 1 / oh, id = 1 / od, ia = 1 / oa, s = ih + id + ia;
  return { pH: ih / s, pD: id / s, pA: ia / s };
}

/* ── backtest walk-forward ──────────────────────────────────────────────── */
export function backtestLeague(name) {
  const doc = JSON.parse(readFileSync(join(DATA, `${name}.json`), 'utf8'));
  const matches = doc.matches
    .map((m) => ({ ...m, day: toDay(m.date) }))
    .filter((m) => m.day != null && m.hg != null && m.ag != null)
    .sort((a, b) => a.day - b.day);

  // burn-in: la primera temporada del dataset
  const seasons = [...new Set(matches.map((m) => m.season))].sort();
  const burnSeasons = new Set(seasons.slice(0, BURN_SEASONS));
  const burnEndDay = Math.max(...matches.filter((m) => burnSeasons.has(m.season)).map((m) => m.day)) + 1;
  const rho = estimateRho(matches, burnEndDay);

  // agrupa por día y ajusta una vez por jornada
  const days = [...new Set(matches.filter((m) => m.day >= burnEndDay).map((m) => m.day))].sort((a, b) => a - b);
  const byDay = new Map();
  for (const m of matches) {
    if (m.day < burnEndDay) continue;
    if (!byDay.has(m.day)) byDay.set(m.day, []);
    byDay.get(m.day).push(m);
  }

  const preds = [];
  for (const d of days) {
    const fit = fitLeague(matches, d, rho);
    if (!fit) continue;
    for (const m of byDay.get(d)) {
      const p = predictMatch(fit, m.home, m.away);
      if (!p) continue;
      const mk = marketProbs(m);
      preds.push({ m, p, mk });
    }
  }

  // ── ancla de mercado (la receta validada en MLB): p_final = α·modelo + (1-α)·mercado.
  // α se afina SOLO en la primera temporada evaluada (tune) y se congela para el
  // resto (test) — sin fuga de información.
  const y = (m) => (m.res === 'H' ? [1, 0, 0] : m.res === 'D' ? [0, 1, 0] : [0, 0, 1]);
  const evalSeasons = [...new Set(preds.map(({ m }) => m.season))].sort();
  const tuneSeason = evalSeasons[0];
  const brierOf = (rows, alpha) => {
    let b = 0, n = 0;
    for (const { m, p, mk } of rows) {
      if (!mk) continue;
      const [yH, yD, yA] = y(m);
      const q = {
        pH: alpha * p.pH + (1 - alpha) * mk.pH,
        pD: alpha * p.pD + (1 - alpha) * mk.pD,
        pA: alpha * p.pA + (1 - alpha) * mk.pA,
      };
      b += (q.pH - yH) ** 2 + (q.pD - yD) ** 2 + (q.pA - yA) ** 2; n++;
    }
    return n ? b / n : Infinity;
  };
  const tuneRows = preds.filter(({ m }) => m.season === tuneSeason);
  let alpha = 0, bestB = Infinity;
  for (let a = 0; a <= 1.0001; a += 0.05) {
    const b = brierOf(tuneRows, a);
    if (b < bestB) { bestB = b; alpha = Math.round(a * 100) / 100; }
  }
  const testRows = preds.filter(({ m }) => m.season !== tuneSeason);

  // ── métricas en TEST (α congelado) ──
  let bModel = 0, bMkt = 0, bBlend = 0, llModel = 0, llMkt = 0, llBlend = 0, nBoth = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, hit: 0 }));
  // selección estilo MLB: tiers por prob máxima del blend
  const tiers = { 't55': { n: 0, hit: 0, p: 0 }, 't60': { n: 0, hit: 0, p: 0 }, 't65': { n: 0, hit: 0, p: 0 }, 't70': { n: 0, hit: 0, p: 0 } };
  for (const { m, p, mk } of testRows) {
    const [yH, yD, yA] = y(m);
    if (!mk) continue;
    nBoth++;
    const q = {
      pH: alpha * p.pH + (1 - alpha) * mk.pH,
      pD: alpha * p.pD + (1 - alpha) * mk.pD,
      pA: alpha * p.pA + (1 - alpha) * mk.pA,
    };
    bModel += (p.pH - yH) ** 2 + (p.pD - yD) ** 2 + (p.pA - yA) ** 2;
    bMkt += (mk.pH - yH) ** 2 + (mk.pD - yD) ** 2 + (mk.pA - yA) ** 2;
    bBlend += (q.pH - yH) ** 2 + (q.pD - yD) ** 2 + (q.pA - yA) ** 2;
    llModel -= Math.log(Math.max(1e-12, yH ? p.pH : yD ? p.pD : p.pA));
    llMkt -= Math.log(Math.max(1e-12, yH ? mk.pH : yD ? mk.pD : mk.pA));
    llBlend -= Math.log(Math.max(1e-12, yH ? q.pH : yD ? q.pD : q.pA));
    const bi = Math.min(9, Math.floor(q.pH * 10));
    bins[bi].n++; bins[bi].p += q.pH; bins[bi].hit += yH;
    // pick = resultado con mayor prob del blend (sin empates como pick: H o A)
    const pick = q.pH >= q.pA ? { p: q.pH, hit: yH === 1 } : { p: q.pA, hit: yA === 1 };
    for (const [k, thr] of [['t55', 0.55], ['t60', 0.6], ['t65', 0.65], ['t70', 0.7]]) {
      if (pick.p >= thr) { tiers[k].n++; tiers[k].p += pick.p; if (pick.hit) tiers[k].hit++; }
    }
  }

  // ── estrategia de valor (TEST, con blend): apostar donde p_blend - p_mercado > umbral ──
  const roi = {};
  for (const thr of [0.02, 0.03, 0.05]) {
    let staked = 0, ret = 0, bets = 0, wins = 0;
    for (const { m, p, mk } of testRows) {
      if (!mk) continue;
      const q = {
        pH: alpha * p.pH + (1 - alpha) * mk.pH,
        pD: alpha * p.pD + (1 - alpha) * mk.pD,
        pA: alpha * p.pA + (1 - alpha) * mk.pA,
      };
      const sides = [
        { pm: q.pH, pk: mk.pH, odds: m.odds_h, hit: m.res === 'H' },
        { pm: q.pD, pk: mk.pD, odds: m.odds_d, hit: m.res === 'D' },
        { pm: q.pA, pk: mk.pA, odds: m.odds_a, hit: m.res === 'A' },
      ];
      let best = null;
      for (const s of sides) {
        const edge = s.pm - s.pk;
        if (s.odds && edge > thr && (!best || edge > best.edge)) best = { ...s, edge };
      }
      if (!best) continue;
      staked += 1; bets++;
      if (best.hit) { ret += best.odds - 1; wins++; } else ret -= 1;
    }
    roi[`thr_${thr}`] = { bets, wins, roi_pct: staked ? Math.round(ret / staked * 1000) / 10 : null };
  }

  const tierOut = {};
  for (const [k, v] of Object.entries(tiers)) {
    tierOut[k] = v.n ? { n: v.n, hit_pct: Math.round(v.hit / v.n * 1000) / 10, pred_pct: Math.round(v.p / v.n * 1000) / 10 } : { n: 0 };
  }

  return {
    league: name, rho: Math.round(rho * 1000) / 1000, alpha,
    tune_season: tuneSeason, evaluated_test: nBoth,
    brier_model: Math.round(bModel / nBoth * 10000) / 10000,
    brier_market: Math.round(bMkt / nBoth * 10000) / 10000,
    brier_blend: Math.round(bBlend / nBoth * 10000) / 10000,
    logloss_model: Math.round(llModel / nBoth * 10000) / 10000,
    logloss_market: Math.round(llMkt / nBoth * 10000) / 10000,
    logloss_blend: Math.round(llBlend / nBoth * 10000) / 10000,
    tiers: tierOut,
    calibration: bins.map((b, i) => b.n ? { bin: `${i * 10}-${i * 10 + 10}%`, n: b.n, pred: Math.round(b.p / b.n * 1000) / 10, real: Math.round(b.hit / b.n * 1000) / 10 } : null).filter(Boolean),
    value_roi: roi,
  };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const cmd = process.argv[2] || 'backtest';
if (cmd === 'backtest') {
  const only = process.argv[3];
  const leagues = only ? [only] : LEAGUES;
  const out = { generated_at: new Date().toISOString(), xi: XI, burn_seasons: BURN_SEASONS, leagues: [] };
  for (const lg of leagues) {
    if (!existsSync(join(DATA, `${lg}.json`))) { console.warn(`(sin datos: ${lg})`); continue; }
    const t0 = Date.now();
    const r = backtestLeague(lg);
    out.leagues.push(r);
    console.log(`${lg}: α=${r.alpha} n=${r.evaluated_test} | Brier blend ${r.brier_blend} vs mercado ${r.brier_market} (modelo ${r.brier_model}) | ` +
      `tiers 60/65/70: ${JSON.stringify([r.tiers.t60, r.tiers.t65, r.tiers.t70])} | ${Date.now() - t0}ms`);
  }
  // agregado
  const tot = out.leagues.reduce((acc, r) => {
    acc.n += r.evaluated_test;
    acc.bb += r.brier_blend * r.evaluated_test;
    acc.bk += r.brier_market * r.evaluated_test;
    for (const k of ['t55', 't60', 't65', 't70']) {
      acc.tiers[k].n += r.tiers[k].n || 0;
      acc.tiers[k].hit += Math.round((r.tiers[k].hit_pct || 0) / 100 * (r.tiers[k].n || 0));
    }
    return acc;
  }, { n: 0, bb: 0, bk: 0, tiers: { t55: { n: 0, hit: 0 }, t60: { n: 0, hit: 0 }, t65: { n: 0, hit: 0 }, t70: { n: 0, hit: 0 } } });
  const tierPct = (t) => t.n ? Math.round(t.hit / t.n * 1000) / 10 : null;
  out.overall = {
    n_test: tot.n,
    brier_blend: Math.round(tot.bb / tot.n * 10000) / 10000,
    brier_market: Math.round(tot.bk / tot.n * 10000) / 10000,
    gate_brier: tot.bb / tot.n <= tot.bk / tot.n + 0.002,
    tiers: {
      't55': { n: tot.tiers.t55.n, hit_pct: tierPct(tot.tiers.t55) },
      't60': { n: tot.tiers.t60.n, hit_pct: tierPct(tot.tiers.t60) },
      't65': { n: tot.tiers.t65.n, hit_pct: tierPct(tot.tiers.t65) },
      't70': { n: tot.tiers.t70.n, hit_pct: tierPct(tot.tiers.t70) },
    },
  };
  console.log('\nOVERALL:', JSON.stringify(out.overall));
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, 'soccer_backtest.json'), JSON.stringify(out, null, 2));
  console.log(`→ ${join(DATA, 'soccer_backtest.json')}`);
}
