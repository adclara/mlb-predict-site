// Sonda-gate de la API de tenis (SportDevs, plan gratis con clave). Corre en
// Actions con el secreto TENNIS_API_KEY. Confirma alcance/auth, baja partidos
// recientes terminados, pide sus estadísticas y VERIFICA que el free tier trae
// aces/dobles faltas/%saque/break points (no solo marcador) — antes de construir
// la UI. Vuelca el shape exacto (endpoints, campos, cómo cruzar con ESPN).
//
// SportDevs es PostgREST-style: filtros como ?status_type=eq.finished y
// ?date_time=gte.2026-06-20; auth por Authorization: Bearer <key>.

const KEY = process.env.TENNIS_API_KEY || '';
const BASE = 'https://tennis.sportdevs.com';
const YMD = (d) => d.toISOString().slice(0, 10);

async function get(path) {
  const url = BASE + path;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    return { status: r.status, data, txt, url };
  } catch (e) { return { status: 0, data: null, txt: String(e), url }; }
}
const cut = (o, n = 1400) => { try { return JSON.stringify(o).slice(0, n); } catch (e) { return String(o).slice(0, n); } };
const keysOf = (o) => (o && typeof o === 'object') ? Object.keys(o).join(', ') : String(o);

if (!KEY) {
  console.log('⚠️  Falta el secreto TENNIS_API_KEY. Configúralo en GitHub (Settings → Secrets →');
  console.log('    Actions → New secret → nombre: TENNIS_API_KEY) y vuelve a disparar el QA.');
  console.log('    La sonda está lista; solo espera la clave.');
  process.exit(0);
}

console.log('██████ Sonda SportDevs Tennis ██████  base:', BASE);

// 1) ¿auth OK? probar un endpoint simple (matches recientes)
const to = new Date(), from = new Date(Date.now() - 20 * 86400000);
// PostgREST: intentamos varias formas de "partidos terminados recientes".
const candidates = [
  `/matches?status_type=eq.finished&date_time=gte.${YMD(from)}&order=date_time.desc&limit=20`,
  `/matches?date_time=gte.${YMD(from)}&order=date_time.desc&limit=20`,
  `/matches?limit=20&order=date_time.desc`,
];
let matches = null, usedPath = null;
for (const p of candidates) {
  const r = await get(p);
  console.log(`\n[matches] ${p}\n  → status ${r.status}`);
  if (r.status === 401 || r.status === 403) { console.log('  AUTH falló:', r.txt.slice(0, 200)); break; }
  if (r.status === 200 && Array.isArray(r.data) && r.data.length) { matches = r.data; usedPath = p; break; }
  if (r.data) console.log('  respuesta:', cut(r.data, 300));
}
if (!matches) { console.log('\nNo se pudo listar partidos. Revisa el plan/endpoints. Fin.'); process.exit(0); }

console.log(`\n✅ ${matches.length} partidos. Claves del primero:\n  `, keysOf(matches[0]));
console.log('  primer partido (recorte):', cut(matches[0], 1200));

// buscar un partido de Wimbledon (o el más reciente con id)
const wim = matches.find((m) => JSON.stringify(m).toLowerCase().includes('wimbledon')) || matches[0];
const mid = wim.id ?? wim.match_id ?? wim.matchId;
console.log(`\nPartido elegido id=${mid}:`, cut({ ...wim }, 500));

// 2) estadísticas del partido — probar variantes de endpoint
const statPaths = [
  `/matches-statistics?match_id=eq.${mid}`,
  `/matches/statistics?match_id=eq.${mid}`,
  `/statistics?match_id=eq.${mid}`,
  `/matches-statistics?id=eq.${mid}`,
];
let stats = null;
for (const p of statPaths) {
  const r = await get(p);
  console.log(`\n[stats] ${p}\n  → status ${r.status}`);
  if (r.status === 200 && r.data && (Array.isArray(r.data) ? r.data.length : Object.keys(r.data).length)) { stats = r.data; console.log('  ★ shape:', cut(r.data, 2200)); break; }
  if (r.data) console.log('  respuesta:', cut(r.data, 300));
}
if (!stats) {
  console.log('\n⚠️  No se encontraron estadísticas de partido por los endpoints probados.');
  console.log('    Puede que el free tier NO incluya statistics (muchos las esconden tras pago),');
  console.log('    o que el endpoint tenga otro nombre. Revisar docs.sportdevs.com/docs/category/tennis.');
  process.exit(0);
}

// 3) ¿trae stats de saque? buscar aces / double faults / first serve / break points
const flat = JSON.stringify(stats).toLowerCase();
const has = (w) => flat.includes(w);
console.log('\n== ¿free tier con stats de saque? ==');
console.log('  aces:', has('ace'), '| dobles faltas:', has('double') || has('fault'),
  '| primer saque:', has('first serve') || has('1st') || has('first_serve'),
  '| break points:', has('break') );
console.log('\nSi salen TRUE → construimos el panel. Si no, pasamos al fallback (RapidAPI tennis).');
console.log('\n████ fin sonda SportDevs ████');
