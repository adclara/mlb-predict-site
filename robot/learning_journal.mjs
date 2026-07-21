// 🧠 Cerebro AA — diario de aprendizaje del modelo MLB.
//
// El modelo YA se re-ajusta cada día: robot/daily.mjs (con learn.js) reajusta los
// coeficientes (ml.fit.beta), re-mide su calibración y audita qué señales predicen.
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

const r2 = (x) => Math.round(x * 1000) / 10;   // fracción → % con 1 decimal
const pp = (x) => Math.round(x * 1000) / 10;   // idem para "puntos porcentuales"

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

  const seg = (L.segments || []).find((s) => s.id === 'all') || {};
  const gap = seg.gap ?? null;                                   // exceso de confianza global
  const curve = (L.ml && L.ml.calibration && L.ml.calibration.curve) || [];
  const ece = eceOf(curve);
  const mvm = L.market_vs_model || (L.odds && L.odds.market_vs_model) || null;
  const modelAcc = mvm && mvm.model ? mvm.model.acc : null;
  const marketAcc = mvm && mvm.market ? mvm.market.acc : null;
  const lockGate = L.lock_gate || null;

  // Señales que el modelo APRENDIÓ que sí predicen (auditoría robusta, mayor ventaja)
  const signals = (L.signal_audit && L.signal_audit.list || [])
    .filter((s) => s.verdict === 'robusto' && s.gap != null)
    .sort((a, b) => b.gap - a.gap).slice(0, 5)
    .map((s) => ({ label: s.label, edge_pp: pp(s.gap), verdict: s.verdict, fav_rate: r2(s.fav_rate) }));

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
    const top = signals.slice(0, 3).map((s) => `${s.label} (+${s.edge_pp} pts)`).join(', ');
    push(`Aprendí qué señales SÍ predicen de verdad: ${top}. Cuando coinciden, mi acierto sube de forma medible.`,
         `I've learned which signals truly predict: ${top}. When they line up, my hit rate rises measurably.`);
  }
  if (lockGate?.gate?.passes && lockGate.all?.n) {
    push(`Encontré una combinación más selectiva para ORO: favorito del mercado + 5 factores AA + mejor ERA reciente del abridor. En el replay cronológico hizo ${lockGate.all.wins}-${lockGate.all.losses} (${r2(lockGate.all.p)}%); ahora me abstengo si falta una de las tres.`,
         `I found a more selective GOLD combination: market favorite + 5 AA factors + the better recent starter ERA. Its chronological replay went ${lockGate.all.wins}-${lockGate.all.losses} (${r2(lockGate.all.p)}%); I now abstain when any of the three is missing.`);
  }
  if (modelAcc != null && marketAcc != null) {
    const win = modelAcc > marketAcc;
    push(win
      ? `En acierto global voy parejo o mejor que el mercado (${r2(modelAcc)}% vs ${r2(marketAcc)}%).`
      : `Sigo honesto: en acierto global el mercado todavía me gana (${r2(marketAcc)}% vs ${r2(modelAcc)}%). Mi ventaja real vive en la SELECCIÓN (fijos y gemas), no en el promedio.`,
      win
      ? `On raw accuracy I'm at or above the market (${r2(modelAcc)}% vs ${r2(marketAcc)}%).`
      : `Staying honest: on raw accuracy the market still beats me (${r2(marketAcc)}% vs ${r2(modelAcc)}%). My real edge lives in SELECTION (locks and gems), not the average.`);
  }
  const miss = (L.misses || [])[0];
  if (miss && Array.isArray(miss.misled_factors) && miss.misled_factors.length) {
    const facs = miss.misled_factors.slice(0, 2).map((f) => f.factor).join(' y ');
    push(`De mi último error (${miss.matchup} ${miss.final}): me fié de ${facs} y no funcionó. Lo peso en la próxima re-calibración.`,
         `From my latest miss (${miss.matchup} ${miss.final}): I leaned on ${facs} and it didn't pan out. I weigh that into the next re-calibration.`);
  }

  // ── Log con fecha (append-only): registra cambios notables entre corridas ──
  const log = Array.isArray(prev.log) ? prev.log.slice(0, 40) : [];
  const addLog = (es, en) => log.unshift({ date: L.last_date, es, en });
  const pSnap = prev.cal || {};
  if (prev.n_graded == null) {
    addLog('Empecé a llevar mi diario de aprendizaje.', 'I started keeping my learning journal.');
  } else {
    if (prev.formula_version && prev.formula_version !== L.formula_version)
      addLog(`Cambié de fórmula: ${prev.formula_version} → ${L.formula_version}.`, `Switched formula: ${prev.formula_version} → ${L.formula_version}.`);
    if (pSnap.gap != null && gap != null) {
      const d = r2(gap) - pSnap.gap;
      if (Math.abs(d) >= 0.3)
        addLog(`Mi calibración ${d < 0 ? 'mejoró' : 'se ensanchó'}: el hueco de confianza pasó de ${pSnap.gap}% a ${r2(gap)}%.`,
               `My calibration ${d < 0 ? 'improved' : 'widened'}: the confidence gap moved from ${pSnap.gap}% to ${r2(gap)}%.`);
    }
    if (typeof prev.n_graded === 'number' && L.n_graded - prev.n_graded >= 1)
      addLog(`Sumé ${L.n_graded - prev.n_graded} predicciones medidas nuevas.`, `Added ${L.n_graded - prev.n_graded} newly measured predictions.`);
  }

  // ── Histórico para la gráfica de calibración en el tiempo (cap 120, dedupe por fecha) ──
  const history = Array.isArray(prev.history) ? prev.history.filter((h) => h.date !== snap.date) : [];
  history.push(snap);
  history.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  while (history.length > 120) history.shift();

  return {
    updated_at: new Date().toISOString(),
    n_graded: L.n_graded, n_total: L.n_total, first_date: L.first_date, last_date: L.last_date,
    formula_version: L.formula_version,
    cal: { gap: gap != null ? r2(gap) : null, ece: ece != null ? r2(ece) : null, says: r2(seg.says), hits: r2(seg.hits),
      curve: curve.map((b) => ({ conf: r2(b.conf), emp: r2(b.emp), n: b.n })) },
    market: mvm ? { model_acc: r2(modelAcc), market_acc: r2(marketAcc), verdict: mvm.verdict || null } : null,
    lock_gate: lockGate ? {
      rule: lockGate.rule, passes: !!lockGate.gate?.passes, cut: lockGate.cut,
      n: lockGate.all?.n ?? 0, wins: lockGate.all?.wins ?? 0, losses: lockGate.all?.losses ?? 0,
      rate: lockGate.all?.p != null ? r2(lockGate.all.p) : null,
    } : null,
    signals, state_es, state_en,
    log: log.slice(0, 20),
    history,
    attribution: 'Aprendizaje medido del propio modelo AA (calibración, auditoría de señales, errores). El algoritmo es privado.',
  };
}

async function publish(doc) {
  if (!API_TOKEN) { console.log('Sin CLOUDFLARE_API_TOKEN; no publico a KV (solo escribí el JSON local).'); return; }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent('mlb:learning')}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
  console.log(res.ok ? '✅ KV mlb:learning publicado (REST)' : `⚠️ KV falló: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const doc = build();
if (doc) {
  writeFileSync(JOURNAL, JSON.stringify(doc, null, 2));
  console.log(`🧠 Diario de aprendizaje: ${doc.n_graded} predicciones · gap ${doc.cal.gap}% · ECE ${doc.cal.ece}% · ${doc.state_es.length} aprendizajes · ${doc.history.length} días en el histórico`);
  for (const s of doc.state_es) console.log('  •', s);
  await publish(doc);
}
