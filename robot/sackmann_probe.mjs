// Sonda-gate de Tennis Abstract (Jeff Sackmann). Corre en Actions (con red),
// solo lectura. Confirma que los CSV de partidos del año en curso existen, con
// qué columnas, cuántas filas, qué tan FRESCOS son (último tourney_date) y una
// fila de ejemplo — antes de construir el pipeline. Sin secretos.

const RAW = 'https://raw.githubusercontent.com/JeffSackmann';
const UA = { 'user-agent': 'aa-sports/1.0' };
const YEAR = new Date().getUTCFullYear();

async function grab(url) {
  try {
    const r = await fetch(url, { headers: UA });
    const txt = await r.text();
    return { status: r.status, txt };
  } catch (e) { return { status: 0, txt: String(e) }; }
}
// Parser CSV mínimo (los datos de Sackmann no llevan comas dentro de campos).
function parseCsv(txt) {
  const lines = txt.split(/\r?\n/).filter((l) => l.length);
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((l) => {
    const cells = l.split(',');
    const o = {};
    header.forEach((h, i) => { o[h] = cells[i]; });
    return o;
  });
  return { header, rows };
}

// Descubre qué archivos atp/wta_matches_*.csv existen realmente y en qué rama.
async function discover(repo, prefix) {
  // 1) intentar la API de contents (lista el repo)
  for (const branch of ['master', 'main']) {
    const r = await grab(`https://api.github.com/repos/JeffSackmann/${repo}/contents?ref=${branch}`);
    if (r.status === 200) {
      try {
        const files = JSON.parse(r.txt).map((x) => x.name).filter((n) => new RegExp(`^${prefix}_matches_\\d{4}\\.csv$`).test(n));
        if (files.length) { files.sort(); console.log(`  [${repo}@${branch}] años:`, files.map((f) => f.match(/(\d{4})/)[1]).join(',')); return { branch, files }; }
      } catch (e) { /* no json */ }
    }
  }
  // 2) fallback: probar años descendentes en ambas ramas
  for (const branch of ['master', 'main']) {
    for (let y = YEAR; y >= YEAR - 2; y--) {
      const f = `${prefix}_matches_${y}.csv`;
      const r = await grab(`${RAW}/${repo}/${branch}/${f}`);
      console.log(`  probe ${repo}@${branch}/${f} → ${r.status}`);
      if (r.status === 200) return { branch, files: [f] };
    }
  }
  return null;
}

for (const [tour, repo, prefix] of [
  ['ATP', 'tennis_atp', 'atp'],
  ['WTA', 'tennis_wta', 'wta'],
]) {
  console.log(`\n██████ ${tour} — ${repo} ██████`);
  const disc = await discover(repo, prefix);
  if (!disc) { console.log('NO se encontró ningún CSV de partidos.'); continue; }
  const file = disc.files[disc.files.length - 1];              // año más reciente disponible
  const url = `${RAW}/${repo}/${disc.branch}/${file}`;
  console.log('usando:', url);
  const res = await grab(url);
  if (res.status !== 200) { console.log('NO DISPONIBLE. primeros 120:', res.txt.slice(0, 120)); continue; }

  const { header, rows } = parseCsv(res.txt);
  console.log('filas:', rows.length);
  console.log('columnas:', header.join(','));
  // ¿están las columnas de stats que necesitamos?
  const need = ['winner_name', 'loser_name', 'tourney_name', 'round', 'score', 'tourney_date',
    'w_ace', 'w_df', 'w_svpt', 'w_1stIn', 'w_1stWon', 'w_2ndWon', 'w_SvGms', 'w_bpSaved', 'w_bpFaced'];
  const missing = need.filter((c) => !header.includes(c));
  console.log('columnas necesarias faltantes:', missing.length ? missing.join(',') : 'NINGUNA ✅');

  // frescura: mayor tourney_date (YYYYMMDD)
  const dates = rows.map((r) => r.tourney_date).filter(Boolean).sort();
  const maxD = dates[dates.length - 1] || 'n/a';
  console.log('tourney_date más reciente:', maxD, '(hoy:', new Date().toISOString().slice(0, 10).replaceAll('-', ''), ')');
  // cuántos partidos con stats no vacías
  const withStats = rows.filter((r) => r.w_ace && r.w_ace !== '').length;
  console.log('partidos con stats (w_ace no vacío):', withStats, '/', rows.length);

  // torneos presentes (últimos por fecha)
  const tourneys = [...new Set(rows.map((r) => r.tourney_name))];
  console.log('torneos:', tourneys.slice(-12).join(' | '));

  // fila ejemplo: preferir Wimbledon; si no, la más reciente con stats
  const wim = rows.find((r) => /wimbledon/i.test(r.tourney_name || '') && r.w_ace);
  const sample = wim || rows.filter((r) => r.w_ace).slice(-1)[0];
  if (sample) {
    console.log('★ ejemplo:', sample.tourney_name, sample.round, '|', sample.winner_name, 'def.', sample.loser_name, '|', sample.score);
    console.log('   ganador: aces', sample.w_ace, 'df', sample.w_df, 'svpt', sample.w_svpt,
      '1stIn', sample.w_1stIn, '1stWon', sample.w_1stWon, '2ndWon', sample.w_2ndWon,
      'bpSaved', sample.w_bpSaved, 'bpFaced', sample.w_bpFaced, 'SvGms', sample.w_SvGms);
    console.log('   perdedor: aces', sample.l_ace, 'df', sample.l_df, 'svpt', sample.l_svpt,
      '1stIn', sample.l_1stIn, '1stWon', sample.l_1stWon, '2ndWon', sample.l_2ndWon,
      'bpSaved', sample.l_bpSaved, 'bpFaced', sample.l_bpFaced);
  }
}

// LICENSE (para el crédito correcto)
const lic = await grab(`${RAW}/tennis_atp/master/README.md`);
if (lic.status === 200) {
  const m = lic.txt.match(/licen[sc]e[\s\S]{0,300}/i);
  console.log('\n-- README (licencia) --\n', m ? m[0].slice(0, 300) : lic.txt.slice(0, 300));
}
console.log('\n████ fin sonda Sackmann ████');
