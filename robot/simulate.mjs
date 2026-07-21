// 🔬 Simulación / entrenamiento walk-forward del algoritmo MLB sobre TODO el
// histórico acumulado. Todo out-of-sample (OOS): para cada día se entrena solo
// con el pasado y se predice ese día — nunca se ve el futuro. Reporta:
//   1. Precisión probabilística (Brier/log-loss/acierto) del modelo clásico vs
//      el APRENDIDO vs el combinado, con intervalos por bootstrap.
//   2. Calibración (¿cuando digo X% ocurre X%?).
//   3. Backtest de SELECCIÓN: cobertura y acierto por confianza. ROI/unidades
//      se calculan únicamente si existe un precio pregame auditable; jamás se
//      supone −110 para una moneyline cuyo precio real no fue capturado.
//   4. Comparación honesta vs el mercado (de learning.json).
//
// Uso: node robot/simulate.mjs   (no necesita red; usa data/history)

import fs from 'node:fs';
import { join } from 'node:path';
import { walkForwardEnsemble, bootstrapStability, probMetrics, reliability, FORMULA_VERSION, prepareTrainingRows } from './learn.js';
import { marketLabReport } from './market_lab.mjs';
import { hasAuditableOpening } from './odds.js';

const DATA = process.env.DATA_DIR || join(process.cwd(), 'data');
const GAMES = join(DATA, 'history', 'games');
const LEARN = join(DATA, 'history', 'learning.json');
const OUT = join(process.cwd(), 'docs', 'MLB_SIMULATION.md');
const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const KV_NAMESPACE_ID = '683aa2f8846643bf8a6a8b606e5bf0b7';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;

const pctf = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '%');
const r3 = (x) => (x == null ? '—' : x.toFixed(3));

// ── cargar TODAS las filas de juegos ────────────────────────────────────────
const files = fs.readdirSync(GAMES).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const rows = [];
for (const f of files) { try { for (const r of (JSON.parse(fs.readFileSync(join(GAMES, f), 'utf8')).games || [])) rows.push(r); } catch { /* skip */ } }
const graded = prepareTrainingRows(rows).filter((r) => r.formula_version === FORMULA_VERSION);
console.log(`\n🔬 SIMULACIÓN MLB — walk-forward sobre ${files.length} días`);
console.log(`   filas totales: ${rows.length} · gradadas (formula ${FORMULA_VERSION}): ${graded.length}`);

// ── 1) walk-forward probabilístico ──────────────────────────────────────────
const run = walkForwardEnsemble(rows, { market: 'ml', minTrain: 100 });
const pr = run._pairs;
console.log(`\n══ 1) Precisión probabilística OOS (n=${run.n}, ${run.first_date}→${run.last_date}) ══`);
const showModel = (name, m) => console.log(`   ${name.padEnd(10)} acierto ${pctf(m.acc)} · log-loss ${r3(m.logloss)} · Brier ${r3(m.brier)}`);
showModel('clásico', run.classic);
showModel('aprendido', run.learned);
showModel('combinado', run.combined);
const boot = bootstrapStability(pr.y, { classic: pr.classic, combined: pr.combined }, { B: 1000, blocks: pr.dates });
const dLL = boot.delta && boot.delta.logloss;
const dLo = dLL && dLL.ci ? dLL.ci[0] : null;
const dHi = dLL && dLL.ci ? dLL.ci[1] : null;
if (dLL) console.log(`   Δ log-loss (combinado − clásico): ${r3(dLL.mean)}  IC95% [${r3(dLo)}, ${r3(dHi)}]  ${dHi < 0 ? '→ el aprendizaje AYUDA (CI<0)' : dLo > 0 ? '→ empeora' : '→ empate (CI cruza 0)'}`);

// ── 2) calibración del modelo combinado ─────────────────────────────────────
const rel = reliability(pr.y.map((y, i) => ({ y, p: pr.combined[i] })), (r) => r.p, (r) => r.y, { bins: 10 });
const ece = rel.ece;
console.log(`\n══ 2) Calibración (modelo combinado OOS) ══`);
console.log(`   ECE ${pctf(ece)} ${ece <= 0.03 ? '(excelente)' : ece <= 0.06 ? '(buena)' : '(mejorable — por eso el % mostrado se calibra hacia abajo)'}`);

// ── 3) backtest de SELECCIÓN (cobertura/acierto + precio real si existe) ─────
console.log(`\n══ 3) Backtest de selección OOS (sin fabricar precio −110) ══`);
console.log(`   umbral · picks · acierto · precios auditables · ROI real · IC95% acierto`);
const americanProfit = (price) => price > 0 ? price / 100 : 100 / Math.abs(price);
function selAt(thr) {
  let n = 0, w = 0, pricedN = 0, units = 0;
  for (let i = 0; i < pr.combined.length; i++) {
    const p = pr.combined[i]; const conf = Math.max(p, 1 - p);
    if (conf < thr) continue;
    const pickHome = p >= 0.5; const win = (pickHome && pr.y[i] === 1) || (!pickHome && pr.y[i] === 0);
    n++; if (win) w++;
    const row = pr.rows?.[i], odds = row?.odds;
    const price = hasAuditableOpening(odds, 'ml')
      ? Number(pickHome ? odds.ml_home_open : odds.ml_away_open) : null;
    if (Number.isFinite(price) && price !== 0) {
      pricedN++; units += win ? americanProfit(price) : -1;
    }
  }
  const rate = n ? w / n : null;
  const se = n ? Math.sqrt(rate * (1 - rate) / n) : null;
  return { thr, n, w, rate, lo: rate != null ? rate - 1.96 * se : null, hi: rate != null ? rate + 1.96 * se : null,
    priced_n: pricedN, units: pricedN ? units : null, roi: pricedN ? units / pricedN : null };
}
const selRows = [];
for (const thr of [0.53, 0.55, 0.58, 0.60, 0.62, 0.65]) {
  const s = selAt(thr); selRows.push(s);
  console.log(`   ≥${(thr * 100).toFixed(0)}%  ·  ${String(s.n).padStart(4)}  ·  ${pctf(s.rate)}  ·  ${s.priced_n}/${s.n}  ·  ${pctf(s.roi)}  ·  [${pctf(s.lo)}, ${pctf(s.hi)}]`);
}

// ── 4) comparación vs mercado (de learning.json) ────────────────────────────
let mvm = null;
try { const L = JSON.parse(fs.readFileSync(LEARN, 'utf8')); mvm = L.market_vs_model || (L.odds && L.odds.market_vs_model); } catch { /* */ }
const mvmValid = Number.isFinite(Number(mvm?.model?.acc)) && Number.isFinite(Number(mvm?.market?.acc));
console.log(`\n══ 4) Modelo vs mercado (acierto global) ══`);
if (mvmValid) console.log(`   modelo ${pctf(mvm.model.acc)} · mercado ${pctf(mvm.market.acc)} → ${mvm.verdict}. La selección es una hipótesis en validación forward, no una ventaja demostrada.`);
else console.log('   (sin cohorte auditable modelo-vs-mercado en learning.json)');

// ── 5) mercados secundarios pedidos: todavía en sombra ─────────────────────
const lab = marketLabReport(rows);
console.log(`\n══ 5) Laboratorio Over / F5 (top 2 por día; corte ${lab.cut}) ══`);
for (const [key, x] of Object.entries(lab.markets)) {
  console.log(`   ${key.padEnd(11)} train ${x.train.wins}-${x.train.losses} (${pctf(x.train.rate)}) · test histórico ${x.test.wins}-${x.test.losses} (${pctf(x.test.rate)}, IC95% ${pctf(x.test.lo)}–${pctf(x.test.hi)}) · forward n=${x.forward.n} · gate ${x.gate.passes ? 'PASA' : 'NO PASA: ' + x.gate.reason}`);
}

// ── reporte a docs/ ─────────────────────────────────────────────────────────
const best = selRows.filter((s) => s.n >= 30).sort((a, b) => (b.rate || -9) - (a.rate || -9))[0];
const md = `# 🔬 Simulación MLB — walk-forward (${run.first_date} → ${run.last_date})

Entrenamiento y validación **out-of-sample**: cada día se entrena solo con el
pasado y se predice ese día. Datos: **${graded.length} juegos** en ${files.length} días.

## 1 · Precisión probabilística OOS (n=${run.n})
| modelo | acierto | log-loss | Brier |
|---|---|---|---|
| clásico | ${pctf(run.classic.acc)} | ${r3(run.classic.logloss)} | ${r3(run.classic.brier)} |
| aprendido | ${pctf(run.learned.acc)} | ${r3(run.learned.logloss)} | ${r3(run.learned.brier)} |
| combinado | ${pctf(run.combined.acc)} | ${r3(run.combined.logloss)} | ${r3(run.combined.brier)} |

Δ log-loss (combinado − clásico): **${r3(dLL && dLL.mean)}** IC95% [${r3(dLo)}, ${r3(dHi)}] — ${dHi != null && dHi < 0 ? 'el aprendizaje **ayuda** (mejora la probabilidad).' : 'empate estadístico.'}

## 2 · Calibración
ECE **${pctf(ece)}** — ${ece <= 0.06 ? 'razonable' : 'con exceso de confianza, por eso el % mostrado ya se calibra hacia abajo.'}

## 3 · Backtest de selección (OOS)
El acierto se mide sobre toda la cohorte. Unidades y ROI solo aparecen cuando la
fila conserva el precio moneyline pregame real de ambos lados; no se supone −110.

| umbral confianza | picks | acierto | con precio real | unidades | ROI real |
|---|---|---|---|---|---|
${selRows.map((s) => `| ≥${(s.thr * 100).toFixed(0)}% | ${s.n} | ${pctf(s.rate)} | ${s.priced_n}/${s.n} | ${s.units != null ? `${s.units >= 0 ? '+' : ''}${s.units.toFixed(1)}u` : '—'} | ${pctf(s.roi)} |`).join('\n')}

${best ? `La franja de mayor acierto medida fue ≥${(best.thr * 100).toFixed(0)}%: ${pctf(best.rate)} sobre ${best.n} juegos. Esto describe acierto, no rentabilidad; sin precios auditables suficientes no se afirma ventaja apostable.` : 'No hay una franja con muestra suficiente.'}

## 4 · Modelo vs mercado
${mvmValid ? `Acierto global: modelo ${pctf(mvm.model.acc)} vs mercado ${pctf(mvm.market.acc)} → **${mvm.verdict}**. La selección permanece como hipótesis y necesita validación forward; no se presenta como ventaja demostrada.` : 'Sin una cohorte auditable modelo-vs-mercado.'}

## 5 · Laboratorio de nuevos mercados (NO publicados)
Corte cronológico 70/30: **${lab.cut}**. Se eligen como máximo dos candidatos por
día; no se rellenan cupos. Over se evalúa contra la línea O/U disponible; F5 es
equipo arriba al terminar cinco entradas (empate = push), no victoria del pitcher.

| mercado sombra | train | test histórico | IC95% test | forward real | gate |
|---|---:|---:|---:|---:|---|
${Object.entries(lab.markets).map(([k, x]) => `| ${k} | ${x.train.wins}-${x.train.losses} (${pctf(x.train.rate)}) | ${x.test.wins}-${x.test.losses} (${pctf(x.test.rate)}) | ${pctf(x.test.lo)}–${pctf(x.test.hi)} | n=${x.forward.n} | ${x.gate.passes ? 'PASA' : `NO: ${x.gate.reason}`} |`).join('\n')}

**Decisión:** permanecen en sombra. El test histórico usa la línea disponible al
cierre de captura y sirve solo para exploración. Over empieza ahora su muestra
forward con la apertura preservada; F5 no dispone de precio/línea real para medir
valor. La app no los vende como boletos hasta que sus gates pasen.

---
*Honesto por diseño: todo out-of-sample, nada de sobreajuste; se muestra lo que hay, gane o pierda. Generado por robot/simulate.mjs.*
`;
try { fs.mkdirSync(join(process.cwd(), 'docs'), { recursive: true }); fs.writeFileSync(OUT, md); console.log(`\n📄 Reporte: docs/MLB_SIMULATION.md`); } catch (e) { console.log('no pude escribir el reporte:', e.message); }

// ── publicar blob compacto a KV `mlb:simulation` (para el Cerebro AA) ─────────
const p1 = (x) => (x == null ? null : Math.round(x * 1000) / 10);   // fracción → % 1 decimal
const doc = {
  updated_at: new Date().toISOString(),
  first_date: run.first_date, last_date: run.last_date,
  n_games: graded.length, n_oos: run.n,
  oos: {
    classic: { acc: p1(run.classic.acc), ll: run.classic.logloss, brier: run.classic.brier },
    learned: { acc: p1(run.learned.acc), ll: run.learned.logloss, brier: run.learned.brier },
    combined: { acc: p1(run.combined.acc), ll: run.combined.logloss, brier: run.combined.brier },
  },
  delta_ll: dLL ? { mean: dLL.mean, lo: dLo, hi: dHi, helps: dHi != null && dHi < 0 } : null,
  ece: p1(ece),
  selection: selRows.map((s) => ({ thr: Math.round(s.thr * 100), n: s.n, rate: p1(s.rate),
    priced_n: s.priced_n, units: s.units == null ? null : Math.round(s.units * 10) / 10,
    roi: p1(s.roi), lo: p1(s.lo), hi: p1(s.hi), edge: false,
    accuracy_signal: s.n >= 30 && s.lo != null && s.lo > 0.5 })),
  market: mvmValid ? { model_acc: p1(mvm.model.acc), market_acc: p1(mvm.market.acc), verdict: mvm.verdict || null,
    selection_hypothesis: true, proven_edge: false } : null,
  market_lab: lab,
  attribution: 'Validación out-of-sample del propio modelo AA sobre todo el histórico. Cada día se entrena solo con el pasado. El algoritmo es privado.',
};
if (!API_TOKEN) console.log('Sin CLOUDFLARE_API_TOKEN; no publico a KV (reporte local generado).');
else {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent('mlb:simulation')}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
  console.log(res.ok ? '✅ KV mlb:simulation publicado (REST)' : `⚠️ KV falló: ${res.status} ${(await res.text()).slice(0, 200)}`);
}
