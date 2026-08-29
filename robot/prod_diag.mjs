// Diagnóstico de producción: consulta aasport.net y la API para saber QUÉ está
// sirviendo realmente (¿llegó el último deploy? ¿los datos están calibrados?
// ¿la prob en vivo?). Corre en Actions (con red), solo lectura, sin secretos.
const SITE = 'https://aasport.net/';
const API = 'https://aa-sports-api.opsmira9.workers.dev';
const UA = { 'user-agent': 'aa-sports-diag/1.0', 'cache-control': 'no-cache' };
const get = async (u) => { try { const r = await fetch(u, { headers: UA }); return { status: r.status, text: await r.text(), ct: r.headers.get('content-type'), cc: r.headers.get('cache-control'), age: r.headers.get('age'), cf: r.headers.get('cf-cache-status') }; } catch (e) { return { status: 0, text: String(e) }; } };
const MARKET_KINDS = ['winner', 'total', 'players', 'combos'];
const PRIVATE_MARKET_FIELDS = ['pick', 'side', 'prob', 'prob_pct', 'line', 'price', 'edge', 'projection', 'market_prob', 'items'];
let marketContractFailures = 0;

async function diagnoseMarkets(sport) {
  const [todayRaw, simulationRaw, historyRaw, healthRaw] = await Promise.all([
    get(`${API}/v1/${sport}/today`), get(`${API}/v1/${sport}/simulation`),
    get(`${API}/v1/${sport}/history?days=30`), get(`${API}/v1/${sport}/pipeline-health`),
  ]);
  try {
    const today = JSON.parse(todayRaw.text), simulation = JSON.parse(simulationRaw.text);
    const history = JSON.parse(historyRaw.text), health = JSON.parse(healthRaw.text);
    const missing = MARKET_KINDS.filter((kind) => !today.markets?.[kind]);
    const blocks = [
      ...MARKET_KINDS.map((kind) => [`documento/${kind}`, today.markets?.[kind]]),
      ...(today.events || []).flatMap((event) => MARKET_KINDS.map((kind) => [
        `${event.espn_id || event.event_id || event.id || 'evento'}/${kind}`, event.markets?.[kind],
      ])),
    ];
    const leaks = blocks.filter(([, block]) => block?.state !== 'public'
      && PRIVATE_MARKET_FIELDS.some((field) => Object.hasOwn(block || {}, field)));
    const routesOk = [todayRaw, simulationRaw, historyRaw, healthRaw].every((row) => row.status === 200);
    const safe = routesOk && !missing.length && !leaks.length && !(today.training && (today.top2 || []).length);
    if (!safe) marketContractFailures++;
    console.log(`${safe ? '✅' : '❌'} ${sport.toUpperCase()} mercados:`,
      `eventos=${(today.events || []).length}`, `faltantes=${missing.join(',') || '0'}`,
      `filtraciones=${leaks.length}`, `top2=${(today.top2 || []).length}`,
      `simulation=${simulation.state || 'training'}`, `history=${history.count ?? (history.predictions || []).length ?? 0}`,
      `pipeline=${health.state || '—'}`);
  } catch (error) {
    marketContractFailures++;
    console.log(`❌ ${sport.toUpperCase()} contrato no-json/error:`, String(error).slice(0, 180));
  }
}

console.log('== HTML de aasport.net ==');
const h = await get(SITE);
console.log('status', h.status, '| cache-control:', h.cc, '| cf-cache:', h.cf, '| age:', h.age);
const has = (s) => h.text.includes(s);
console.log('  ¿tiene "Aviso legal" (cambio MÁS reciente)?:', has('Aviso legal'));
console.log('  ¿tiene "Probabilidad en vivo" (Fase 2)?:', has('Probabilidad en vivo'));
console.log('  ¿tiene calibratedProb/win_prob (marcadores nuevos)?:', has('win_prob_home') || has('liveWpHome'));
console.log('  ¿tiene "Fijos" en el récord (Fase 3)?:', has('trChip') || has('Fijos'));
console.log('  ¿tiene Central AA multifuente?:', has('Central de Jugadas AA') && has('/v1/intelligence/today'));
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

console.log('\n== /v1/mlb/simulation (¿validación OOS publicada?) ==');
const sim = await get(`${API}/v1/mlb/simulation`);
try {
  const s = JSON.parse(sim.text);
  if (s.note) console.log('nota:', s.note, '(aún sin publicar; corre poke-sim)');
  else console.log('juegos:', s.n_games, '| acierto OOS combinado:', s.oos && s.oos.combined && s.oos.combined.acc, '% | ECE:', s.ece,
    '% | aprende:', s.delta_ll && s.delta_ll.helps, '| selección filas:', (s.selection || []).length, '| cache:', sim.cc);
} catch (e) { console.log('no-json / error:', sim.status, sim.text.slice(0, 200)); }

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

console.log('\n== /v1/mlb/pipeline-health (captura cada 20 min) ==');
try {
  const ph = JSON.parse((await get(`${API}/v1/mlb/pipeline-health`)).text);
  console.log('estado:', ph.state, '| fresh:', ph.fresh ?? '—', '| edad s:', ph.age_seconds ?? '—',
    '| juegos:', ph.latest?.n_games ?? '—', '| capturado:', ph.latest?.captured_at || '—');
  console.log('  fuentes:', JSON.stringify(ph.latest?.sources || {}), '| missingness:', JSON.stringify(ph.latest?.missingness || {}));
  console.log('  Aprende:', ph.learning?.fresh ? '✅ fresco' : '⚠️ atrasado', '| actualizado:', ph.learning?.updated_at || '—',
    '| último juego:', ph.learning?.last_date || '—', '| n:', ph.learning?.n_graded ?? '—');
} catch (e) { console.log('no-json:', String(e).slice(0, 160)); }

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
console.log('\n== /v1/mlb/standings (posiciones por división) ==');
try {
  const st = JSON.parse((await get(`${API}/v1/mlb/standings`)).text);
  const secs = st.sections || [];
  const rows = secs.reduce((n, s) => n + (s.rows || []).length, 0);
  console.log('secciones:', secs.length, '| equipos:', rows, '| temporada:', st.season || '—', rows ? '' : '→ ⚠️ tabla vacía (revisar shape ESPN)');
  console.log('  secciones:', secs.map((s) => `${s.name} (${(s.rows || []).length})`).join(' · ') || '—');
  const s0 = secs[0]; const r0 = s0 && (s0.rows || [])[0];
  if (r0) console.log(`  ej: ${s0.name} → ${r0.name || r0.code} ${r0.w}-${r0.l} (${r0.pct})`);
  console.log('  vista:', secs.length >= 4 ? '✅ por DIVISIÓN' : secs.length ? 'por liga (fallback)' : '⚠️ vacía');
} catch (e) { console.log('no-json:', String(e).slice(0, 120)); }
console.log('\n== /v1/wnba/live + standings (feed factual) ==');
try {
  const wnbaLive = JSON.parse((await get(`${API}/v1/wnba/live`)).text);
  const wnbaStandings = JSON.parse((await get(`${API}/v1/wnba/standings`)).text);
  const wnbaBrain = JSON.parse((await get(`${API}/v1/wnba/learning`)).text);
  const rows = (wnbaStandings.sections || []).reduce((n, section) => n + (section.rows || []).length, 0);
  console.log('juegos hoy:', (wnbaLive.games || []).length, '| fuente:', wnbaLive.source || '—', wnbaLive.note ? '| note: ' + wnbaLive.note : '');
  console.log('posiciones:', rows, 'equipos en', (wnbaStandings.sections || []).length, 'secciones', wnbaStandings.note ? '| note: ' + wnbaStandings.note : '');
  console.log('Cerebro:', wnbaBrain.state || '—', '| histórico OOS:', wnbaBrain.historical?.n ?? '—',
    '| forward:', wnbaBrain.forward?.n ?? '—', '| gate público:', wnbaBrain.gate?.public === true ? 'ABIERTO' : 'cerrado');
} catch (e) { console.log('no-json:', String(e).slice(0, 120)); }
console.log('\n== Contrato de mercados WNBA/NFL (4 módulos, fail-closed) ==');
await diagnoseMarkets('wnba');
await diagnoseMarkets('nfl');
console.log('\n== Frontera QA privada (anónimo nunca ve shadow) ==');
const qaApi = await get(`${API}/v1/qa/nfl/today`);
const qaSite = await get('https://qa.aasport.net/?prod-diag=1');
const qaApiClosed = qaApi.status === 401;
const qaSiteReady = qaSite.status === 200 && qaSite.text.includes('qaRequested') && qaSite.text.includes('qaBanner');
console.log(qaApiClosed ? '✅ API QA exige sesión autenticada (401)' : `❌ API QA anónima respondió ${qaApi.status}`);
console.log(qaSiteReady ? '✅ qa.aasport.net sirve la interfaz QA' : `⚠️ qa.aasport.net aún propagando (status ${qaSite.status})`);
if (!qaApiClosed) marketContractFailures++;
console.log('\n== /v1/poly/radar + /v1/poly/alerts (Radar de wallets) ==');
console.log('\n== /v1/intelligence/today (Central AA, sin alertas) ==');
try {
  const intelRaw = await get(`${API}/v1/intelligence/today`);
  const intel = JSON.parse(intelRaw.text);
  const safe = intelRaw.status === 200 && intel.version === 'intelligence_v1'
    && (intel.slate || []).length <= 7 && intel.combos?.state === 'closed'
    && !Object.hasOwn(intel.combos || {}, 'items') && intel.alerts === false && intel.telegram === false;
  console.log(safe ? '✅ contrato seguro' : '❌ contrato inválido', '| estado:', intel.state,
    '| slate:', (intel.slate || []).length, '| Poly:', intel.sources?.polymarket?.ok,
    '| Kalshi:', intel.sources?.kalshi?.ok, '| as_of:', intel.as_of || '—');
  if (!safe) marketContractFailures++;
} catch (error) { console.log('❌ intelligence no-json/error:', String(error).slice(0, 160)); marketContractFailures++; }

const pr = await get(`${API}/v1/poly/radar`);
let polyPaused = false;
try {
  const d = JSON.parse(pr.text);
  if (d.paused === true) {
    polyPaused = true;
    const [pa, pt] = await Promise.all([get(`${API}/v1/poly/alerts`), get(`${API}/v1/poly/track`)]);
    const ad = JSON.parse(pa.text); const td = JSON.parse(pt.text);
    const stopped = ad.paused === true && td.paused === true;
    console.log(stopped ? '✅ Radar pausado: rutas sin datos, vigía/Telegram detenidos' : '❌ pausa incompleta en rutas Poly');
    if (!stopped) marketContractFailures++;
  } else {
  console.log('wallets:', (d.wallets || []).length, '| vigiladas:', (d.watchlist || []).length, '| top_trades:', (d.top_trades || []).length, '| actualizado:', d.ran_at || '—');
  const w0 = (d.wallets || [])[0];
  if (w0) console.log('  top1:', w0.pseudonym || (w0.w || '').slice(0, 8), '| ganó $' + (w0.pnl_usd || 0).toLocaleString(), '|', Math.round(100 * (w0.win_rate || 0)) + '% aciertos', '| gana entrando ANTES:', w0.pre_win_share != null ? Math.round(100 * w0.pre_win_share) + '%' : 'sin hora', '| best_trades:', (w0.best_trades || []).length, '| tipo:', w0.kind || '—', '| acumulado: $' + (w0.cum_now || 0).toLocaleString(), '| curva:', (w0.equity_curve || []).length + ' pts');
  const t0 = (d.top_trades || [])[0];
  if (t0) console.log('  mejor trade: +$' + t0.profit.toLocaleString(), '—', (t0.who || t0.w.slice(0, 8)), '| timing:', t0.timing || 'sin hora de inicio');
  const withPf = (d.wallets || []).filter((w) => w.portfolio_usd != null).length;
  if (w0) console.log('  cartera (valor actual): top1 ' + (w0.portfolio_usd != null ? '$' + w0.portfolio_usd.toLocaleString() + (w0.positions_open != null ? ' · ' + w0.positions_open + ' posiciones' : '') : 'sin dato') + ` | resuelta en ${withPf}/${(d.wallets || []).length} wallets`);
  }
} catch (e) { console.log('no-json:', pr.status, pr.text.slice(0, 120)); }
if (!polyPaused) {
  const pa = await get(`${API}/v1/poly/alerts`);
  try { const d = JSON.parse(pa.text); console.log('alertas en KV:', (d.alerts || []).length, '| updated:', d.updated_at || '—'); } catch (e) { console.log('no-json:', pa.status); }
  const pt = await get(`${API}/v1/poly/track`);
  try {
    const d = JSON.parse(pt.text); const p = d.persistence;
    console.log('poly:track:', d.ok === false ? 'acumulando historial (aún sin snapshots suficientes)'
      : (p ? `persistencia viva ${Math.round(100 * p.overlap)}% (${p.stayed}/${p.then_n} vigiladas siguen) | nuevas: ${(d.new_wallets || []).length} | días: ${(d.history || []).length}`
        : `sin persistencia aún | nuevas: ${(d.new_wallets || []).length} | días: ${(d.history || []).length}`));
  } catch (e) { console.log('no-json:', pt.status, pt.text.slice(0, 120)); }
}

console.log('\n████ fin diagnóstico ████');
if (marketContractFailures) {
  console.error(`❌ ${marketContractFailures} contrato(s) WNBA/NFL fallaron la frontera pública`);
  process.exitCode = 1;
}
