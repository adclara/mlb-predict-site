// Read-only production watchdog for the four new AA Sports verticals.
// No secret and no writes: it verifies API shape, exact ET slate dates and the
// 20-minute factual pipeline. Empty off-season slates are valid.

const API = process.env.AA_API || 'https://aa-sports-api.opsmira9.workers.dev';
const SPORTS = ['nfl', 'ncaaf', 'nhl', 'ncaam'];
const ET_TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

let failed = 0;
async function get(path) {
  const response = await fetch(`${API}${path}`, { headers: { 'user-agent': 'aa-sports-us-qa/1.0' } });
  const text = await response.text();
  let body = null; try { body = JSON.parse(text); } catch (e) { /* reported below */ }
  return { response, body, text };
}

for (const sport of SPORTS) {
  console.log(`\n== ${sport.toUpperCase()} ==`);
  try {
    const live = await get(`/v1/${sport}/live`);
    if (!live.response.ok || !Array.isArray(live.body?.games)) throw new Error(`live contract ${live.response.status}: ${live.text.slice(0, 120)}`);
    const wrongDay = live.body.games.filter((game) => game.start && new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(game.start)) !== ET_TODAY);
    if (wrongDay.length) throw new Error(`${wrongDay.length} live events are not ET today`);
    console.log(`✅ live: ${live.body.games.length} juegos de ${ET_TODAY}`);

    const today = await get(`/v1/${sport}/today`);
    if (!today.response.ok || today.body?.sport !== sport || !Array.isArray(today.body?.events) || !Array.isArray(today.body?.top2)) {
      throw new Error(`today contract ${today.response.status}: ${today.text.slice(0, 120)}`);
    }
    if (today.body.training && today.body.top2.length) throw new Error('training state leaked public Top 2 picks');
    console.log(`✅ today: gate=${today.body.gate?.state || 'closed'} top2=${today.body.top2.length}`);

    const health = await get(`/v1/${sport}/pipeline-health`);
    if (!health.response.ok || health.body?.sport !== sport) throw new Error(`pipeline contract ${health.response.status}`);
    if (!health.body.ok) throw new Error(`pipeline ${health.body.state || 'unknown'} age=${health.body.age_seconds ?? 'n/a'}s`);
    console.log(`✅ ingesta 20m: ${health.body.latest?.n_games ?? 0} juegos · ${health.body.age_seconds}s`);
  } catch (error) {
    failed++;
    console.error(`❌ ${error.message}`);
  }
}

if (failed) {
  console.error(`\nUS Sports QA: ${failed}/${SPORTS.length} deportes con fallo`);
  process.exit(1);
}
console.log('\nUS Sports QA: todo verde');
