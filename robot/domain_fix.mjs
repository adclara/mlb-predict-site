// AA Sports — conecta aasport.net a la APP (Pages) y lo desconecta del
// Worker, vía la API de Cloudflare. Idempotente: si ya está bien, lo dice.
//
// Pasos:
//   1. Quitar aasport.net / www del Worker aa-sports-api (si están ahí).
//   2. Dejar el DNS apuntando al proyecto de Pages (CNAME proxied).
//   3. Registrar ambos hostnames como custom domains del proyecto de Pages.
//   4. VERIFICAR: pedir https://aasport.net y comprobar que devuelve la app.
//
// Si el token no alcanza para algún paso, lo reporta con el permiso exacto
// que falta y sigue con lo demás. Uso: node robot/domain_fix.mjs

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DOMAIN = 'aasport.net';
const HOSTS = [DOMAIN, `www.${DOMAIN}`];
const PAGES_PROJECT = 'aa-sports';
const PAGES_TARGET = 'aa-sports-5ap.pages.dev';
const WORKER = 'aa-sports-api';
const CF = 'https://api.cloudflare.com/client/v4';

if (!API_TOKEN) { console.log('Sin CLOUDFLARE_API_TOKEN.'); process.exit(1); }

let failures = 0;
async function cf(method, path, body) {
  const res = await fetch(CF + path, {
    method,
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok && j.success !== false, status: res.status, result: j.result, errors: j.errors || [] };
}
const errTxt = (r) => `${r.status} ${JSON.stringify(r.errors).slice(0, 220)}`;

/* ── 1) worker: quitar los custom domains ── */
console.log('— Paso 1: dominios del Worker —');
const wd = await cf('GET', `/accounts/${ACCOUNT_ID}/workers/domains`);
if (!wd.ok) {
  console.log(`  ✗ no pude listar (${errTxt(wd)}) — permiso que falta: "Account · Workers Scripts · Edit"`);
  failures++;
} else {
  const mine = (wd.result || []).filter((d) => HOSTS.includes(d.hostname) && d.service === WORKER);
  if (!mine.length) console.log('  ✓ el Worker no tiene estos dominios (bien)');
  for (const d of mine) {
    const del = await cf('DELETE', `/accounts/${ACCOUNT_ID}/workers/domains/${d.id}`);
    console.log(del.ok ? `  ✓ quitado del Worker: ${d.hostname}` : `  ✗ no pude quitar ${d.hostname} (${errTxt(del)})`);
    if (!del.ok) failures++;
  }
}

/* ── 2) DNS: CNAME proxied hacia el proyecto de Pages ── */
console.log('— Paso 2: DNS de la zona —');
const zres = await cf('GET', `/zones?name=${DOMAIN}`);
const zone = zres.ok && zres.result && zres.result[0];
if (!zone) {
  console.log(`  ✗ no veo la zona ${DOMAIN} (${errTxt(zres)}) — permiso que falta: "Zone · Zone · Read" (+ "Zone · DNS · Edit")`);
  failures++;
} else {
  for (const host of HOSTS) {
    const list = await cf('GET', `/zones/${zone.id}/dns_records?name=${host}`);
    if (!list.ok) { console.log(`  ✗ no pude leer DNS de ${host} (${errTxt(list)}) — falta "Zone · DNS · Edit"`); failures++; continue; }
    const recs = (list.result || []).filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
    const good = recs.find((r) => r.type === 'CNAME' && r.content === PAGES_TARGET);
    for (const r of recs) {
      if (good && r.id === good.id) continue;
      const del = await cf('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
      console.log(del.ok ? `  ✓ DNS viejo eliminado: ${host} ${r.type}→${String(r.content).slice(0, 40)}` : `  ✗ no pude borrar DNS de ${host} (${errTxt(del)})`);
      if (!del.ok) failures++;
    }
    if (good) { console.log(`  ✓ ${host} ya apunta a la app`); continue; }
    const add = await cf('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: host, content: PAGES_TARGET, proxied: true, ttl: 1 });
    console.log(add.ok ? `  ✓ ${host} → ${PAGES_TARGET} (proxied)` : `  ✗ no pude crear CNAME de ${host} (${errTxt(add)})`);
    if (!add.ok) failures++;
  }
}

/* ── 3) Pages: registrar los custom domains ── */
console.log('— Paso 3: dominios del proyecto de Pages —');
for (const host of HOSTS) {
  const add = await cf('POST', `/accounts/${ACCOUNT_ID}/pages/projects/${PAGES_PROJECT}/domains`, { name: host });
  if (add.ok) console.log(`  ✓ ${host} registrado en Pages`);
  else if (JSON.stringify(add.errors).includes('already')) console.log(`  ✓ ${host} ya estaba registrado en Pages`);
  else { console.log(`  ✗ no pude registrar ${host} (${errTxt(add)}) — permiso que falta: "Account · Cloudflare Pages · Edit"`); failures++; }
}

/* ── 4) verificación real ── */
console.log('— Paso 4: verificación —');
await new Promise((r) => setTimeout(r, 20000)); // certificado/propagación
for (const host of HOSTS) {
  try {
    const res = await fetch(`https://${host}/`, { headers: { 'user-agent': 'aa-sports-check/1.0' }, redirect: 'follow' });
    const body = await res.text();
    const isApp = body.includes('AA Sports') && body.includes('<!doctype html');
    const isApi = body.includes('aa-sports-api');
    console.log(`  ${isApp ? '✅' : '✗'} https://${host} → ${res.status} ${isApp ? 'sirve la APP' : isApi ? 'sigue sirviendo la API (mal)' : 'contenido inesperado: ' + body.slice(0, 80)}`);
    if (!isApp) failures++;
  } catch (e) {
    console.log(`  ✗ https://${host} no responde aún (${e.message}) — puede tardar unos minutos más`);
    failures++;
  }
}

console.log(failures === 0 ? '\n🎉 DOMINIO CONECTADO: https://aasport.net sirve la app.' : `\n⚠️ Quedaron ${failures} pasos con problema (ver arriba).`);
process.exit(0); // el log es el reporte; no rompemos el workflow
