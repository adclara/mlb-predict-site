// Sonda de tenis v2: busca estadísticas de PARTIDO en torneos GRANDES
// (Grand Slam / Wimbledon en curso), donde ESPN suele traer más datos que en
// los ATP/WTA 250. Prueba summary, playbyplay, la core API y sub-recursos de
// estadísticas. Solo lectura, sin secretos. Vuelca formas al log.

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://sports.core.api.espn.com/v2/sports/tennis/leagues';
const UA = { 'user-agent': 'aa-sports/1.0' };
const ymd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
const BIG = /wimbledon|us open|roland|french|australian|slam|masters|olympic|finals/i;

async function grab(url) {
  try {
    const r = await fetch(url, { headers: UA });
    const ct = r.headers.get('content-type') || '';
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    return { status: r.status, ct, data, txt };
  } catch (e) { return { status: 0, ct: '', data: null, txt: String(e) }; }
}
const cut = (o, n = 1200) => JSON.stringify(o).slice(0, n);

for (const tour of ['atp', 'wta']) {
  console.log(`\n██████ TOUR ${tour.toUpperCase()} ██████`);
  const to = new Date(), from = new Date(Date.now() - 25 * 86400000);
  const sb = await grab(`${ESPN}/tennis/${tour}/scoreboard?dates=${ymd(from)}-${ymd(to)}&limit=300`);
  if (!sb.data) { console.log('scoreboard sin JSON, status', sb.status); continue; }
  const events = sb.data.events || [];
  console.log('torneos vistos:', [...new Set(events.map(e => e.name || e.shortName))].join(' | '));

  // reunir todos los partidos terminados, marcando si son de torneo grande
  const matches = [];
  for (const e of events) {
    const comps = e.competitions || (e.groupings || []).flatMap(g => g.competitions || []);
    for (const c of comps) {
      const st = (c.status && c.status.type) || {};
      const isFinal = String(st.name || '').toUpperCase().includes('FINAL') || st.completed;
      if ((c.competitors || []).length >= 2 && isFinal) matches.push({ e, c, big: BIG.test(e.name || '') });
    }
  }
  const chosen = matches.find(m => m.big) || matches[0];
  if (!chosen) { console.log('sin partido terminado'); continue; }
  const { e: ev, c: comp } = chosen;
  console.log(`elegido: "${ev.name}" ${chosen.big ? '(GRANDE)' : '(menor)'}  eventId=${ev.id} compId=${comp.id}`);
  const c0 = comp.competitors[0] || {};
  console.log('-- competitor[0].statistics:', cut(c0.statistics, 1500));
  console.log('-- competitor[0].linescores:', cut(c0.linescores, 700));

  // A) summary por competitionId
  for (const [tag, id] of [['eventId', ev.id], ['compId', comp.id]]) {
    const s = await grab(`${ESPN}/tennis/${tour}/summary?event=${id}`);
    console.log(`[summary ${tag}=${id}] status ${s.status} ct=${s.ct}`, s.data ? 'keys:' + Object.keys(s.data).join(',') : 'no-json:' + s.txt.slice(0, 120).replace(/\n/g, ' '));
    if (s.data && s.data.boxscore) console.log('   ★ boxscore:', cut(s.data.boxscore, 1600));
  }

  // B) playbyplay
  const pbp = await grab(`${ESPN}/tennis/${tour}/playbyplay?event=${comp.id}`);
  console.log(`[playbyplay compId] status ${pbp.status}`, pbp.data ? 'keys:' + Object.keys(pbp.data).join(',') : 'no-json');

  // C) core: dump completo de la competition, buscar cualquier link "statistic"
  const core = await grab(`${CORE}/${tour}/events/${ev.id}/competitions/${comp.id}`);
  if (core.data) {
    const refs = JSON.stringify(core.data).match(/"\$ref":"[^"]*statistic[^"]*"/gi) || [];
    console.log('[core competition] statsSource=', core.data.statsSource, ' refs con statistic:', refs.slice(0, 4).join(' | ') || 'ninguna');
    // seguir el $ref del primer competidor y buscar statistics adentro
    const cref = core.data.competitors && core.data.competitors[0] && core.data.competitors[0].$ref;
    if (cref) {
      const cc = await grab(cref);
      if (cc.data) {
        const sref = JSON.stringify(cc.data).match(/"statistics":\{"\$ref":"([^"]+)"/);
        console.log('   competitor core keys:', Object.keys(cc.data).join(','));
        if (sref) {
          const stat = await grab(sref[1]);
          console.log('   ★★ competitor.statistics $ref → status', stat.status, stat.data ? cut(stat.data, 2000) : stat.txt.slice(0, 160));
        } else console.log('   sin $ref de statistics en el competidor core');
      }
    }
  } else console.log('[core competition] status', core.status);
}
console.log('\n████ fin sonda tenis v2 ████');
