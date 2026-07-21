// 🧠 Cerebro AA — diario de aprendizaje del modelo MLB.
//
// El modelo se re-ajusta una vez al día: robot/mlb_learn_daily.mjs (con learn.js)
// reajusta los coeficientes, re-mide calibración y audita qué señales predicen.
// Este módulo NO cambia el modelo: LEE learning.json, lo compara con la corrida
// anterior y traduce el aprendizaje real a lenguaje simple ("estoy aprendiendo
// que…") + guarda un histórico para la gráfica de calibración en el tiempo, y lo
// publica a KV `mlb:learning` para que la app lo muestre. Honesto: todo sale de
// datos MEDIDOS; el algoritmo sigue siendo privado, aquí se ve su aprendizaje.
//
// Uso: node robot/learning_journal.mjs   (CLOUDFLARE_API_TOKEN para publicar KV)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA = process.env.DATA_DIR || join(process.cwd(), 'data');
const LEARN = join(DATA, 'history', 'learning.json');
const JOURNAL = join(DATA, 'history', 'learning_journal.json');
const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const KV_NAMESPACE_ID = '683aa2f8846643bf8a6a8b606e5bf0b7';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;
const JOURNAL_COHORT_VERSION = 'causal_ledger_v2';

const r2 = (x) => Math.round(x * 1000) / 10;   // fracción → % con 1 decimal
const pp = (x) => Math.round(x * 1000) / 10;   // idem para "puntos porcentuales"

const SIGNAL_EN = {
  market: 'Matches the market favorite',
  agree5: '5+ factors agree with the pick',
  prob60: 'Pick probability at or above 60%',
  pitcher: 'Better recent starter ERA',
  streak3: 'Pick team winning streak of 3+',
  news: 'News/injuries favor the pick',
  aux_rest: 'Real rest advantage for the pick (1+ day)',
  aux_dens: 'Fresher schedule (games in last 7 days)',
  aux_haf: 'Better venue-specific form',
  aux_pyth: 'Better Pythagorean record over last 20',
  aux_tze: 'Opponent traveled east by 2+ time zones',
  platoon: 'Platoon advantage versus starter handedness',
};

const FACTOR_LABELS = {
  momentum: { es: 'momento reciente', en: 'recent form' },
  pitching: { es: 'pitcheo', en: 'pitching' },
  f5: { es: 'primeras cinco entradas', en: 'first-five innings' },
  bats: { es: 'bateo', en: 'offense' },
  schedule: { es: 'calendario y descanso', en: 'schedule and rest' },
  manager: { es: 'manejo y banquillo', en: 'management and bench' },
};

// ECE (error de calibración esperado): promedio ponderado de |confianza − real|.
function eceOf(curve) {
  if (!Array.isArray(curve) || !curve.length) return null;
  const N = curve.reduce((s, b) => s + (b.n || 0), 0) || 1;
  return curve.reduce((s, b) => s + (b.n || 0) / N * Math.abs((b.conf ?? 0) - (b.emp ?? 0)), 0);
}

function build() {
  if (!existsSync(LEARN)) { console.log('No hay learning.json — nada que hacer.'); return null; }
  const L = JSON.parse(readFileSync(LEARN, 'utf8'));
  const prev = existsSync(JOURNAL) ? JSON.parse(readFileSync(JOURNAL, 'utf8')) : {};
  // The causal-ledger migration reduced the eligible cohort. Trend points from
  // the older mutable policy are not comparable and must never remain on the
  // same chart or generate fake "new predictions" deltas.
  const cohortReset = prev.n_graded != null && prev.cohort_version !== JOURNAL_COHORT_VERSION;
  const prior = prev.cohort_version === JOURNAL_COHORT_VERSION ? prev : {};

  const seg = (L.segments || []).find((s) => s.id === 'all') || {};
  const gap = seg.gap ?? null;                                   // exceso de confianza global
  const curve = (L.ml && L.ml.calibration && L.ml.calibration.curve) || [];
  const ece = eceOf(curve);
  const mvm = L.market_vs_model || (L.odds && L.odds.market_vs_model) || null;
  const marketComparisonAuditable = mvm?.auditable === true;
  const modelAcc = marketComparisonAuditable && mvm.model ? mvm.model.acc : null;
  const marketAcc = marketComparisonAuditable && mvm.market ? mvm.market.acc : null;
  const lockGate = L.lock_gate || null;

  // Hipótesis que superaron el filtro histórico. Siguen en validación forward;
  // un gap retrospectivo no se presenta como ventaja futura demostrada.
  const signals = (L.signal_audit && L.signal_audit.list || [])
    .filter((s) => s.verdict === 'robusto' && s.gap != null)
    .filter((s) => s.id !== 'market' || L.signal_audit?.market_cohort === 'auditable_open_only')
    .sort((a, b) => b.gap - a.gap).slice(0, 5)
    .map((s) => ({ id: s.id, label: s.label, label_en: SIGNAL_EN[s.id] || s.label,
      edge_pp: pp(s.gap), verdict: s.verdict, fav_rate: r2(s.fav_rate) }));

  // Snapshot compacto para la tendencia histórica
  const snap = { date: L.last_date, n: L.n_graded, gap: gap != null ? r2(gap) : null,
    ece: ece != null ? r2(ece) : null, model_acc: modelAcc != null ? r2(modelAcc) : null,
    market_acc: marketAcc != null ? r2(marketAcc) : null };

  // ── Diario "qué estoy aprendiendo" (regenerado cada corrida) ──────────────
  const state_es = [], state_en = [];
  const push = (es, en) => { state_es.push(es); state_en.push(en); };

  push(`Ya llevo ${L.n_graded} predicciones medidas (desde ${L.first_date}). Todo lo que aprendo sale de mis propios aciertos y errores.`,
       `I've now measured ${L.n_graded} predictions (since ${L.first_date}). Everything I learn comes from my own hits and misses.`);

  if (gap != null) {
    push(`Sé que soy algo sobre-confiado: cuando digo ~65% en promedio, ocurre ~${r2(seg.hits)}% (hueco de ${r2(gap)} pts). Por eso el número que muestro ya viene calibrado hacia abajo.`,
         `I know I run a bit overconfident: when I say ~65% on average, it happens ~${r2(seg.hits)}% (a ${r2(gap)}-pt gap). That's why the number I show is already calibrated downward.`);
  }
  if (signals.length) {
    const topEs = signals.slice(0, 3).map((s) => `${s.label} (+${s.edge_pp} pts)`).join(', ');
    const topEn = signals.slice(0, 3).map((s) => `${s.label_en} (+${s.edge_pp} pts)`).join(', ');
    push(`Estas hipótesis pasaron el filtro histórico: ${topEs}. Son diferencias medidas en el replay y siguen en validación forward; todavía no prueban una ventaja futura.`,
         `These hypotheses passed the historical screen: ${topEn}. They are measured replay differences and remain under forward validation; they do not yet prove a future edge.`);
  }
  if (lockGate?.gate?.passes && lockGate.all?.n) {
    push(`La hipótesis ORO con apertura auditable + 5 factores AA + mejor ERA reciente pasó su gate: replay ${lockGate.all.wins}-${lockGate.all.losses} (${r2(lockGate.all.p)}%). Se reporta como evidencia medida, nunca como apuesta segura.`,
         `The GOLD hypothesis using an auditable opener + 5 AA factors + better recent ERA passed its gate: ${lockGate.all.wins}-${lockGate.all.losses} (${r2(lockGate.all.p)}%) in replay. It is measured evidence, never a sure bet.`);
  }
  if (mvm?.auditable === true && modelAcc != null && marketAcc != null) {
    const win = modelAcc > marketAcc;
    push(win
      ? `En la cohorte de aperturas auditables, el acierto medido del modelo es ${r2(modelAcc)}% y el de la apertura ${r2(marketAcc)}%; esta comparación sigue sujeta al intervalo y al gate.`
      : `En la cohorte de aperturas auditables, el acierto medido de la apertura es ${r2(marketAcc)}% y el del modelo ${r2(modelAcc)}%; no afirmo ventaja sobre el mercado.`,
      win
      ? `In the auditable-opening cohort, measured model accuracy is ${r2(modelAcc)}% versus ${r2(marketAcc)}% for the opener; this comparison remains subject to its interval and gate.`
      : `In the auditable-opening cohort, measured opener accuracy is ${r2(marketAcc)}% versus ${r2(modelAcc)}% for the model; I do not claim an edge over the market.`);
  } else if (mvm?.auditable === true) {
    push(`La comparación contra el mercado está en espera: hay ${mvm.n ?? 0} aperturas auditables y el gate exige ${mvm.min_n ?? 40}. Los precios legacy de hora desconocida no cuentan.`,
         `The market comparison is pending: there are ${mvm.n ?? 0} auditable openers and the gate requires ${mvm.min_n ?? 40}. Legacy prices with unknown timing do not count.`);
  }
  const miss = (L.misses || [])[0];
  if (miss && Array.isArray(miss.misled_factors) && miss.misled_factors.length) {
    const factors = miss.misled_factors.slice(0, 2).map((f) => FACTOR_LABELS[f.factor] || { es: f.factor, en: f.factor });
    const facsEs = factors.map((f) => f.es).join(' y ');
    const facsEn = factors.map((f) => f.en).join(' and ');
    push(`De mi último error (${miss.matchup} ${miss.final}): me fié de ${facsEs} y no funcionó. Lo peso en la próxima re-calibración.`,
         `From my latest miss (${miss.matchup} ${miss.final}): I leaned on ${facsEn} and it didn't pan out. I weigh that into the next re-calibration.`);
  }

  // ── Log con fecha (append-only): registra cambios notables entre corridas ──
  const log = Array.isArray(prior.log) ? prior.log.slice(0, 40) : [];
  const addLog = (es, en, date = L.last_date) => log.unshift({ date, es, en });
  const pSnap = prior.cal || {};
  if (cohortReset) {
    const resetDate = String(L.updated_at || new Date().toISOString()).slice(0, 10);
    addLog('Reinicié la tendencia con el ledger causal v2; los puntos de la cohorte mutable anterior no eran comparables.',
      'I restarted the trend with causal ledger v2; points from the previous mutable cohort were not comparable.', resetDate);
  } else if (prior.n_graded == null) {
    addLog('Empecé a llevar mi diario de aprendizaje.', 'I started keeping my learning journal.');
  } else {
    if (prior.formula_version && prior.formula_version !== L.formula_version)
      addLog(`Cambié de fórmula: ${prior.formula_version} → ${L.formula_version}.`, `Switched formula: ${prior.formula_version} → ${L.formula_version}.`);
    if (pSnap.gap != null && gap != null) {
      const d = r2(gap) - pSnap.gap;
      if (Math.abs(d) >= 0.3)
        addLog(`Mi calibración ${d < 0 ? 'mejoró' : 'se ensanchó'}: el hueco de confianza pasó de ${pSnap.gap}% a ${r2(gap)}%.`,
               `My calibration ${d < 0 ? 'improved' : 'widened'}: the confidence gap moved from ${pSnap.gap}% to ${r2(gap)}%.`);
    }
    if (typeof prior.n_graded === 'number' && L.n_graded - prior.n_graded >= 1)
      addLog(`Sumé ${L.n_graded - prior.n_graded} predicciones medidas nuevas.`, `Added ${L.n_graded - prior.n_graded} newly measured predictions.`);
  }

  // ── Histórico para la gráfica de calibración en el tiempo (cap 120, dedupe por fecha) ──
  const history = Array.isArray(prior.history) ? prior.history.filter((h) => h.date !== snap.date) : [];
  history.push({ ...snap, cohort_version: JOURNAL_COHORT_VERSION });
  history.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  while (history.length > 120) history.shift();

  return {
    updated_at: new Date().toISOString(),
    cohort_version: JOURNAL_COHORT_VERSION,
    n_graded: L.n_graded, n_total: L.n_total, first_date: L.first_date, last_date: L.last_date,
    formula_version: L.formula_version,
    cal: { gap: gap != null ? r2(gap) : null, ece: ece != null ? r2(ece) : null, says: r2(seg.says), hits: r2(seg.hits),
      curve: curve.map((b) => ({ conf: r2(b.conf), emp: r2(b.emp), n: b.n })) },
    market: mvm ? { model_acc: modelAcc != null ? r2(modelAcc) : null,
      market_acc: marketAcc != null ? r2(marketAcc) : null,
      verdict: marketComparisonAuditable ? (mvm.verdict || null) : 'sin dato',
      auditable: marketComparisonAuditable, n: marketComparisonAuditable ? (mvm.n ?? 0) : 0,
      min_n: marketComparisonAuditable ? (mvm.min_n ?? null) : null } : null,
    lock_gate: lockGate ? {
      rule: lockGate.rule, passes: !!lockGate.gate?.passes, cut: lockGate.cut,
      n: lockGate.all?.n ?? 0, wins: lockGate.all?.wins ?? 0, losses: lockGate.all?.losses ?? 0,
      rate: lockGate.all?.p != null ? r2(lockGate.all.p) : null,
    } : null,
    signals, state_es, state_en,
    log: log.slice(0, 20),
    history,
    attribution: 'Aprendizaje medido del modelo AA (calibración, hipótesis en validación y errores). El algoritmo es privado.',
  };
}

async function publish(doc, { required = false } = {}) {
  if (!API_TOKEN) {
    if (required) throw new Error('Falta CLOUDFLARE_API_TOKEN para publicar el diario persistido.');
    console.log('Sin CLOUDFLARE_API_TOKEN; no publico a KV (solo escribí el JSON local).');
    return;
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent('mlb:learning')}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
  if (!res.ok) throw new Error(`KV mlb:learning falló: ${res.status} ${(await res.text()).slice(0, 200)}`);
  console.log('✅ KV mlb:learning publicado (REST)');
}

if (process.argv.includes('--publish-existing')) {
  if (!existsSync(JOURNAL)) throw new Error('No existe learning_journal.json persistido para publicar.');
  const persisted = JSON.parse(readFileSync(JOURNAL, 'utf8'));
  await publish(persisted, { required: true });
} else {
  const doc = build();
  if (doc) {
    writeFileSync(JOURNAL, JSON.stringify(doc, null, 2));
    console.log(`🧠 Diario de aprendizaje: ${doc.n_graded} predicciones · gap ${doc.cal.gap}% · ECE ${doc.cal.ece}% · ${doc.state_es.length} aprendizajes · ${doc.history.length} días en el histórico`);
    for (const s of doc.state_es) console.log('  •', s);
    if (process.env.AA_SKIP_PUBLISH === '1') console.log('AA_SKIP_PUBLISH=1; diario persistido sin publicar.');
    else await publish(doc);
  }
}
