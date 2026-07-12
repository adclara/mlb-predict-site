// Sonda de tenis: encuentra el endpoint correcto de estadísticas de PARTIDO
// (aces, dobles faltas, % primer saque, winners, break points…). El summary
// falló antes porque se usó el id del TORNEO, no el del partido (competition).
// Corre en Actions (con red), sin secretos, solo lectura. Vuelca formas al log.

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://sports.core.api.espn.com/v2/sports/tennis/leagues';
const UA = { 'user-agent': 'aa-sports/1.0' };
const ymd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');

async function grab(url) {
  try {
    const r = await fetch(url, { headers: UA });
    const ct = r.headers.get('content-type') || '';
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    return { status: r.status, ct, data, txt };
  } catch (e) { return { status: 0, ct: '', data: null, txt: String(e) }; }
}
const cut = (o, n = 900) => JSON.stringify(o).slice(0, n);

for (const tour of ['atp', 'wta']) {
  console.log(`\n██████ TOUR ${tour.toUpperCase()} ██████`);
  const to = new Date(), from = new Date(Date.now() - 30 * 86400000);
  const sb = await grab(`${ESPN}/tennis/${tour}/scoreboard?dates=${ymd(from)}-${ymd(to)}&limit=150`);
  if (!sb.data) { console.log('scoreboard sin JSON, status', sb.status); continue; }
  const events = sb.data.events || [];
  console.log(`eventos (torneos): ${events.length}`);

  // encontrar un PARTIDO terminado (competition con 2 competidores, final)
  let ev = null, comp = null;
  for (const e of events) {
    const comps = e.competitions || (e.groupings || []).flatMap(g => g.competitions || []);
    for (const c of comps) {
      const pl = c.competitors || [];
      const st = (c.status && c.status.type) || {};
      const isFinal = String(st.name || '').toUpperCase().includes('FINAL') || st.completed;
      if (pl.length >= 2 && isFinal) { ev = e; comp = c; break; }
    }
    if (comp) break;
  }
  if (!comp) { console.log('sin partido terminado en 30 días'); continue; }

  console.log(`torneo: ${ev.name || ev.id}  ·  eventId=${ev.id}  ·  competitionId=${comp.id}`);
  console.log('-- competition.keys:', Object.keys(comp).join(', '));
  const c0 = comp.competitors[0] || {};
  console.log('-- competitor[0].keys:', Object.keys(c0).join(', '));
  console.log('-- competitor[0] (recorte):', cut(c0, 1200));
  if (c0.statistics) console.log('★ competitor.statistics YA en scoreboard:', cut(c0.statistics, 1500));
  if (c0.linescores) console.log('-- competitor.linescores (sets):', cut(c0.linescores, 600));

  // A) summary con eventId (torneo)
  const sEv = await grab(`${ESPN}/tennis/${tour}/summary?event=${ev.id}`);
  console.log(`\n[A] summary?event=${ev.id} (torneo) → status ${sEv.status} ct=${sEv.ct}`);
  if (sEv.data) console.log('    keys:', Object.keys(sEv.data).join(', '));
  else console.log('    NO-JSON, primeros 200:', sEv.txt.slice(0, 200).replace(/\n/g, ' '));

  // B) summary con competitionId (partido)
  const sCp = await grab(`${ESPN}/tennis/${tour}/summary?event=${comp.id}`);
  console.log(`\n[B] summary?event=${comp.id} (partido) → status ${sCp.status} ct=${sCp.ct}`);
  if (sCp.data) {
    console.log('    ★ keys:', Object.keys(sCp.data).join(', '));
    if (sCp.data.boxscore) console.log('    boxscore:', cut(sCp.data.boxscore, 1800));
    if (sCp.data.statistics) console.log('    statistics:', cut(sCp.data.statistics, 1800));
    if (sCp.data.rosters) console.log('    rosters:', cut(sCp.data.rosters, 1200));
  } else console.log('    NO-JSON, primeros 200:', sCp.txt.slice(0, 200).replace(/\n/g, ' '));

  // C) core API: estadísticas por competidor
  const cId = c0.id || (c0.athlete && c0.athlete.id);
  const coreUrl = `${CORE}/${tour}/events/${ev.id}/competitions/${comp.id}/competitors/${cId}/statistics`;
  const sCore = await grab(coreUrl);
  console.log(`\n[C] core competitor statistics → status ${sCore.status} ct=${sCore.ct}`);
  console.log('    url:', coreUrl);
  if (sCore.data) console.log('    ★', cut(sCore.data, 2000));
  else console.log('    NO-JSON/err, primeros 160:', sCore.txt.slice(0, 160).replace(/\n/g, ' '));

  // D) core API: la competition entera (a veces lista los links de stats)
  const sComp = await grab(`${CORE}/${tour}/events/${ev.id}/competitions/${comp.id}`);
  console.log(`\n[D] core competition → status ${sComp.status}`);
  if (sComp.data) {
    console.log('    keys:', Object.keys(sComp.data).join(', '));
    if (sComp.data.competitors) console.log('    competitors[0].keys:', Object.keys(sComp.data.competitors[0] || {}).join(', '));
  }
}
console.log('\n████ fin sonda tenis ████');
