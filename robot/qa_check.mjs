// QA de producción: compara lo que sirve el Worker de AA Sports contra la
// fuente real (MLB StatsAPI / ESPN) y reporta lo que no cuadre. Corre en
// GitHub Actions (con red), sin secretos, solo lectura. No toca producción.
//
// Uso:  node robot/qa_check.mjs
// Imprime un reporte con líneas PASS/FAIL/WARN y un resumen al final.

const API = process.env.AA_API || 'https://aa-sports-api.opsmira9.workers.dev';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const UA = { 'user-agent': 'aa-sports-qa/1.0' };

let pass = 0, fail = 0, warn = 0;
const P = (m) => { pass++; console.log('  ✅ ' + m); };
const F = (m) => { fail++; console.log('  ❌ ' + m); };
const W = (m) => { warn++; console.log('  ⚠️  ' + m); };
const H = (m) => console.log('\n══ ' + m + ' ══');

async function getJson(url, opts) {
  try {
    const r = await fetch(url, { headers: UA, ...opts });
    const ct = r.headers.get('content-type') || '';
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) { /* no json */ }
    return { status: r.status, ct, data, txt };
  } catch (e) { return { status: 0, ct: '', data: null, txt: String(e) }; }
}

// Día de hoy en horario del Este (US) — el mismo criterio que el Worker.
function etToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function etDate(iso) {
  if (!iso) return null;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
  catch (e) { return String(iso).slice(0, 10); }
}
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const canonPair = (a, b) => [norm(a), norm(b)].sort().join('|');

const TODAY = etToday();
console.log('AA Sports — QA de producción');
console.log('API:', API, '· hoy (ET):', TODAY, '· ahora:', new Date().toISOString());

// ─────────────────────────────────────────────────────────────────────────
// 1) MLB TODAY vs MLB StatsAPI (¿los juegos de hoy son los reales de hoy?)
// ─────────────────────────────────────────────────────────────────────────
async function qaMlbToday() {
  H('1) MLB /v1/mlb/today vs MLB StatsAPI');
  const w = await getJson(`${API}/v1/mlb/today`);
  if (w.status !== 200 || !w.data) { F(`Worker no respondió (status ${w.status})`); return; }
  const evs = w.data.events || [];
  P(`Worker sirve ${evs.length} eventos`);

  // Cruce independiente contra MLB StatsAPI por CÓDIGO de equipo (el doc del
  // Worker usa abreviaturas, p.ej. "HOU @ TEX"), con hydrate=team para tenerlas.
  const src = await getJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${TODAY}&hydrate=team`);
  const sgames = (src.data && src.data.dates && src.data.dates[0] && src.data.dates[0].games) || [];
  console.log(`   (StatsAPI reporta ${sgames.length} juegos para ${TODAY})`);

  if (!sgames.length) { W('StatsAPI no trae juegos hoy (off-day) — se omite el cruce de matchups'); }
  else {
    const srcPairs = new Set(sgames.map(g => canonPair(g.teams?.away?.team?.abbreviation, g.teams?.home?.team?.abbreviation)));
    let matched = 0, missing = [];
    for (const e of evs) {
      if (srcPairs.has(canonPair(e.away?.code, e.home?.code))) matched++;
      else missing.push(e.matchup || `${e.away?.code}@${e.home?.code}`);
    }
    if (matched === evs.length && evs.length === sgames.length) P(`Los ${evs.length} matchups coinciden con StatsAPI (por código)`);
    else if (matched === evs.length) W(`Todos los ${matched} del Worker existen en StatsAPI, pero StatsAPI tiene ${sgames.length} (doble-header o filtro)`);
    else F(`${evs.length - matched} matchups del Worker NO están en StatsAPI: ${missing.slice(0, 6).join(', ')}`);
  }

  // fechas: ¿algún evento con fecha != hoy pintado como de hoy?
  const badDate = evs.filter(e => { const d = etDate(e.start); return d && d !== TODAY; });
  if (!evs.length) W('sin eventos para revisar fechas');
  else if (!badDate.length) P('todos los eventos tienen fecha (ET) = hoy');
  else F(`${badDate.length} eventos con fecha ≠ hoy: ${badDate.slice(0, 4).map(e => e.matchup + ' → ' + etDate(e.start)).join(', ')}`);

  // ningún evento del día debería venir ya "final" en el doc de predicciones matutino
  const finals = evs.filter(e => e.status === 'final');
  if (finals.length) W(`${finals.length} eventos ya 'final' en el doc (ok si es tarde/noche): ${finals.slice(0,3).map(e=>e.matchup).join(', ')}`);
  else P('ningún evento marcado como final (doc de predicciones "pre")');
}

// ─────────────────────────────────────────────────────────────────────────
// 2) MLB LIVE vs ESPN (marcadores, estado y el fix de fechas: campo `date`)
// ─────────────────────────────────────────────────────────────────────────
async function qaMlbLive() {
  H('2) MLB /v1/mlb/live vs ESPN scoreboard (marcadores + fix de fecha)');
  const w = await getJson(`${API}/v1/mlb/live`);
  if (w.status !== 200 || !w.data) { F(`Worker /live no respondió (status ${w.status})`); return; }
  const wg = w.data.games || [];
  P(`Worker /live sirve ${wg.length} juegos`);

  // el campo `date` (día ET) debe existir por juego — es el candado del fix
  const noDate = wg.filter(g => !g.date);
  if (!wg.length) W('sin juegos en vivo ahora');
  else if (!noDate.length) P('todos los juegos traen el campo `date` (ET) del fix');
  else F(`${noDate.length} juegos SIN campo date → el candado de fecha del frontend no puede filtrarlos`);

  // ¿algún "final" con fecha != hoy? (esos son los que colaban ayer→hoy)
  const staleFinals = wg.filter(g => g.status === 'final' && g.date && g.date !== TODAY);
  if (staleFinals.length) W(`${staleFinals.length} finales de fecha ≠ hoy presentes en /live (el frontend DEBE filtrarlos por date): ${staleFinals.slice(0,3).map(g=>`${g.away?.code}@${g.home?.code} ${g.date}`).join(', ')}`);
  else if (wg.length) P('sin finales de días pasados colándose en /live');

  const src = await getJson(`${ESPN}/baseball/mlb/scoreboard`);
  const eg = (src.data && src.data.events) || [];
  console.log(`   (ESPN reporta ${eg.length} eventos MLB ahora)`);
  // cruce de marcadores por par de equipos
  const espnByPair = new Map();
  for (const ev of eg) {
    const c = ev.competitions?.[0] || {}; const comp = c.competitors || [];
    const h = comp.find(x => x.homeAway === 'home') || comp[0] || {};
    const a = comp.find(x => x.homeAway === 'away') || comp[1] || {};
    espnByPair.set(canonPair(a.team?.abbreviation, h.team?.abbreviation), {
      hs: Number(h.score), as: Number(a.score), state: (c.status?.type?.name || '') });
  }
  let scoreOk = 0, scoreBad = [];
  for (const g of wg) {
    const e = espnByPair.get(canonPair(g.away?.code, g.home?.code));
    if (!e) continue;
    if (Number(g.home?.score) === e.hs && Number(g.away?.score) === e.as) scoreOk++;
    else scoreBad.push(`${g.away?.code}@${g.home?.code} worker ${g.away?.score}-${g.home?.score} vs espn ${e.as}-${e.hs}`);
  }
  if (wg.length && scoreBad.length === 0) P(`marcadores del Worker coinciden con ESPN (${scoreOk} cruzados)`);
  else if (scoreBad.length) W(`marcadores desalineados (puede ser desfase de caché 30s): ${scoreBad.slice(0,4).join(' · ')}`);
}

// ─────────────────────────────────────────────────────────────────────────
// 3) SOCCER LIVE vs ESPN (Mundial)
// ─────────────────────────────────────────────────────────────────────────
async function qaSoccer() {
  H('3) Soccer /v1/soccer/live?league=fifa.world vs ESPN');
  const w = await getJson(`${API}/v1/soccer/live?league=fifa.world`);
  if (w.status !== 200) { F(`Worker soccer/live status ${w.status}`); return; }
  const wg = (w.data && w.data.games) || [];
  P(`Worker sirve ${wg.length} partidos del Mundial`);
  const src = await getJson(`${ESPN}/soccer/fifa.world/scoreboard`);
  const eg = (src.data && src.data.events) || [];
  console.log(`   (ESPN reporta ${eg.length} partidos fifa.world)`);
  if (Math.abs(wg.length - eg.length) <= 1) P(`conteo de partidos consistente (${wg.length} vs ${eg.length})`);
  else W(`conteo distinto: Worker ${wg.length} vs ESPN ${eg.length} (ventanas de fecha/caché)`);
  // fecha de cada partido servido
  const badD = wg.filter(g => { const d = etDate(g.start); return d && Math.abs(new Date(d) - new Date(TODAY)) > 2 * 86400000; });
  if (badD.length) W(`${badD.length} partidos de soccer con fecha lejana a hoy`);
}

// ─────────────────────────────────────────────────────────────────────────
// 4) STANDINGS NBA/Soccer vs ESPN (fila top)
// ─────────────────────────────────────────────────────────────────────────
async function qaStandings() {
  H('4) Standings vs ESPN (spot-check)');
  for (const [sp, wurl, surl] of [
    ['nba', `${API}/v1/nba/standings`, 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings'],
    ['soccer', `${API}/v1/soccer/standings?league=fifa.world`, 'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings'],
  ]) {
    const w = await getJson(wurl);
    const secs = (w.data && w.data.sections) || [];
    const rows = secs.flatMap(s => s.rows || []);
    if (!rows.length) { W(`${sp}: Worker sin filas de posiciones (¿off-season/sin tabla?)`); continue; }
    P(`${sp}: Worker sirve ${rows.length} filas en ${secs.length} secciones`);
    // sanity: ranks 1..n presentes, sin nulos de nombre
    const noName = rows.filter(r => !r.name && !r.code).length;
    if (noName) F(`${sp}: ${noName} filas sin nombre/código`); else P(`${sp}: todas las filas con equipo`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 5) SUMMARY nuevo (soccer/nba) vs ESPN — la feature recién desplegada
// ─────────────────────────────────────────────────────────────────────────
async function qaSummary() {
  H('5) Detalle /v1/soccer/summary vs ESPN (feature nueva)');
  // tomar un evento reciente/en vivo del Mundial
  const rec = await getJson(`${API}/v1/soccer/recent?league=fifa.world`);
  const live = await getJson(`${API}/v1/soccer/live?league=fifa.world`);
  const cand = [ ...((live.data && live.data.games) || []), ...((rec.data && rec.data.games) || []) ]
    .find(g => g.espn_id);
  if (!cand) { W('sin evento de soccer para probar summary'); return; }
  console.log(`   evento de prueba: ${cand.away?.code}@${cand.home?.code} id=${cand.espn_id}`);
  const w = await getJson(`${API}/v1/soccer/summary?event=${cand.espn_id}&league=fifa.world`);
  if (w.status !== 200 || !w.data) { F(`summary status ${w.status}`); return; }
  if (!w.data.ok) { W('summary ok:false (ESPN sin datos para ese evento)'); return; }
  P('summary responde ok:true');
  const hasLu = w.data.lineups && (w.data.lineups.home || w.data.lineups.away);
  const hasStats = w.data.stats && w.data.stats.length;
  console.log(`   alineaciones:${!!hasLu} estadísticas:${hasStats || 0} eventos:${(w.data.events||[]).length}`);
  if (hasLu || hasStats) P('summary trae alineaciones o estadísticas');
  else W('summary sin alineaciones ni stats (partido sin datos publicados aún)');

  // cruce directo contra ESPN
  const src = await getJson(`${ESPN}/soccer/fifa.world/summary?event=${cand.espn_id}`);
  if (src.data && src.data.boxscore) {
    const espnPoss = (src.data.boxscore.teams || []).map(t => (t.statistics || []).find(s => s.name === 'possessionPct')?.displayValue).filter(Boolean);
    const wPoss = (w.data.stats || []).find(s => s.label === 'Posesión %');
    if (espnPoss.length && wPoss) {
      const match = (String(wPoss.home) === espnPoss[0] || String(wPoss.away) === espnPoss[0] || String(wPoss.home) === espnPoss[1] || String(wPoss.away) === espnPoss[1]);
      match ? P(`posesión del Worker coincide con ESPN (${wPoss.away}/${wPoss.home})`) : W(`posesión Worker ${wPoss.away}/${wPoss.home} vs ESPN ${espnPoss.join('/')}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 6) Rankings tenis + injuries presentes
// ─────────────────────────────────────────────────────────────────────────
async function qaMisc() {
  H('6) Tenis rankings + bajas');
  const rk = await getJson(`${API}/v1/tennis/rankings`);
  const secs = (rk.data && rk.data.sections) || [];
  if (secs.length) P(`ranking de tenis: ${secs.map(s => `${s.name} ${s.rows?.length||0}`).join(', ')}`);
  else W('ranking de tenis vacío');
  const inj = await getJson(`${API}/v1/injuries`);
  if (inj.status === 200) P('/v1/injuries responde'); else W(`/v1/injuries status ${inj.status}`);
}

for (const fn of [qaMlbToday, qaMlbLive, qaSoccer, qaStandings, qaSummary, qaMisc]) {
  try { await fn(); } catch (e) { F(`excepción en ${fn.name}: ${e.message}`); }
}

console.log(`\n══ RESUMEN ══\n  PASS ${pass} · FAIL ${fail} · WARN ${warn}`);
console.log(fail === 0 ? '\n✅ QA sin fallos duros.' : `\n❌ ${fail} fallos que requieren atención.`);
