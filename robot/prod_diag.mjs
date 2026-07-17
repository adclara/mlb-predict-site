// Diagnóstico de producción: consulta aasport.net y la API para saber QUÉ está
// sirviendo realmente (¿llegó el último deploy? ¿los datos están calibrados?
// ¿la prob en vivo?). Corre en Actions (con red), solo lectura, sin secretos.
const SITE = 'https://aasport.net/';
const API = 'https://aa-sports-api.opsmira9.workers.dev';
const UA = { 'user-agent': 'aa-sports-diag/1.0', 'cache-control': 'no-cache' };
const get = async (u) => { try { const r = await fetch(u, { headers: UA }); return { status: r.status, text: await r.text(), ct: r.headers.get('content-type'), cc: r.headers.get('cache-control'), age: r.headers.get('age'), cf: r.headers.get('cf-cache-status') }; } catch (e) { return { status: 0, text: String(e) }; } };

console.log('== HTML de aasport.net ==');
const h = await get(SITE);
console.log('status', h.status, '| cache-control:', h.cc, '| cf-cache:', h.cf, '| age:', h.age);
const has = (s) => h.text.includes(s);
console.log('  ¿tiene "Aviso legal" (cambio MÁS reciente)?:', has('Aviso legal'));
console.log('  ¿tiene "Probabilidad en vivo" (Fase 2)?:', has('Probabilidad en vivo'));
console.log('  ¿tiene calibratedProb/win_prob (marcadores nuevos)?:', has('win_prob_home') || has('liveWpHome'));
console.log('  ¿tiene "Fijos" en el récord (Fase 3)?:', has('trChip') || has('Fijos'));
const m = h.text.match(/AA Sports/); console.log('  longitud del HTML:', h.text.length, 'bytes');

console.log('\n== /v1/mlb/today (¿datos calibrados?) ==');
const t = await get(`${API}/v1/mlb/today`);
try {
  const d = JSON.parse(t.text);
  console.log('updated_at:', d.updated_at, '| eventos:', (d.events || []).length, '| cache:', t.cc);
  console.log('record:', JSON.stringify(d.record));
  const probs = (d.events || []).filter(e => e.prediction && e.prediction.prob_pct != null).map(e => ({ m: e.matchup, p: e.prediction.prob_pct }));
  console.log('probs mostradas:', JSON.stringify(probs.slice(0, 8)));
  const maxP = Math.max(0, ...probs.map(x => x.p));
  console.log('máx prob_pct:', maxP, maxP > 66 ? '→ ⚠️ AÚN INFLADA (no calibrada)' : '→ ✅ en rango calibrado');
} catch (e) { console.log('no-json / error:', t.status, t.text.slice(0, 200)); }

console.log('\n== /v1/mlb/live (¿en vivo + win_prob_home?) ==');
const lv = await get(`${API}/v1/mlb/live`);
let liveDoc = null;
try {
  const d = JSON.parse(lv.text); liveDoc = d;
  const games = d.games || [];
  const byStatus = games.reduce((a, g) => { a[g.status] = (a[g.status] || 0) + 1; return a; }, {});
  console.log('updated_at:', d.updated_at, '| juegos:', games.length, '| por estado:', JSON.stringify(byStatus), d.note ? '| note: ' + d.note : '');
  const liveG = games.filter(g => g.status === 'live');
  console.log('en vivo:', liveG.length, '| con win_prob_home:', liveG.filter(g => g.win_prob_home != null).length);
  if (liveG[0]) console.log('ejemplo live:', liveG[0].away?.code, liveG[0].away?.score, '-', liveG[0].home?.score, liveG[0].home?.code, '| wp_home:', liveG[0].win_prob_home);
  console.log('  fechas ET del feed:', JSON.stringify([...new Set(games.map(g => g.date))]));
  console.log('  llaves live (away@home):', JSON.stringify(games.slice(0, 6).map(g => `${g.away?.code}@${g.home?.code}`)));
} catch (e) { console.log('no-json:', lv.status, lv.text.slice(0, 160)); }

// ── Diagnóstico del JOIN en vivo (por qué el marcador no aparece) ──
console.log('\n== JOIN live↔today (raíz del bug "todo Por jugar") ==');
try {
  const doc = JSON.parse(t.text);
  console.log('fecha del doc (today.date):', doc.date, '| fecha ET real hoy:', new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
  const docKeys = (doc.events || []).map(e => `${e.away?.code}@${e.home?.code}`);
  console.log('  llaves doc (away@home):', JSON.stringify(docKeys.slice(0, 6)));
  if (liveDoc) {
    const liveKeys = new Set((liveDoc.games || []).map(g => `${g.away?.code}@${g.home?.code}`));
    const matches = docKeys.filter(k => liveKeys.has(k)).length;
    const liveDates = new Set((liveDoc.games || []).map(g => g.date));
    console.log(`  coincidencias directas de llave: ${matches}/${docKeys.length}`, matches === 0 && (liveDoc.games || []).length ? '→ ⚠️ CÓDIGOS NO CASAN (causa 2)' : '');
    console.log('  ¿la fecha del doc está en las fechas del feed?:', liveDates.has(doc.date), liveDates.has(doc.date) ? '' : '→ ⚠️ posible off-by-one de fecha (causa 3)');
    if (!(liveDoc.games || []).length) console.log('  → ⚠️ /live vacío (causa 1: ESPN caído/cambiado)');
  }
} catch (e) { console.log('no se pudo cruzar:', String(e).slice(0, 120)); }
console.log('\n== /v1/poly/radar + /v1/poly/alerts (Radar de wallets) ==');
const pr = await get(`${API}/v1/poly/radar`);
try {
  const d = JSON.parse(pr.text);
  console.log('wallets:', (d.wallets || []).length, '| vigiladas:', (d.watchlist || []).length, '| top_trades:', (d.top_trades || []).length, '| actualizado:', d.ran_at || '—');
  const w0 = (d.wallets || [])[0];
  if (w0) console.log('  top1:', w0.pseudonym || (w0.w || '').slice(0, 8), '| ganó $' + (w0.pnl_usd || 0).toLocaleString(), '|', Math.round(100 * (w0.win_rate || 0)) + '% aciertos', '| gana entrando ANTES:', w0.pre_win_share != null ? Math.round(100 * w0.pre_win_share) + '%' : 'sin hora', '| best_trades:', (w0.best_trades || []).length);
  const t0 = (d.top_trades || [])[0];
  if (t0) console.log('  mejor trade: +$' + t0.profit.toLocaleString(), '—', (t0.who || t0.w.slice(0, 8)), '| timing:', t0.timing || 'sin hora de inicio');
} catch (e) { console.log('no-json:', pr.status, pr.text.slice(0, 120)); }
const pa = await get(`${API}/v1/poly/alerts`);
try { const d = JSON.parse(pa.text); console.log('alertas en KV:', (d.alerts || []).length, '| updated:', d.updated_at || '—'); } catch (e) { console.log('no-json:', pa.status); }

console.log('\n████ fin diagnóstico ████');
