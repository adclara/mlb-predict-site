// AA Sports — conecta radar.aasport.net a la APP (Pages) vía la API de Cloudflare.
// Mismo método (probado) con el que domain_fix.mjs conectó aasport.net:
//   1. DNS: CNAME radar.aasport.net → el proyecto de Pages (proxied).
//   2. Pages: registrar radar.aasport.net como custom domain del proyecto.
//   3. VERIFICAR: pedir https://radar.aasport.net y comprobar que sirve la app.
// Idempotente. Si el token no alcanza para un paso, reporta el permiso que falta.
// Uso: node robot/subdomain_radar.mjs   (CLOUDFLARE_API_TOKEN)

const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ZONE_DOMAIN = 'aasport.net';
const HOST = 'radar.aasport.net';
const PAGES_PROJECT = 'aa-sports';
const PAGES_TARGET = 'aa-sports-5ap.pages.dev';
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

/* ── 1) DNS: CNAME radar → proyecto de Pages ── */
console.log('— Paso 1: DNS de la zona —');
const zres = await cf('GET', `/zones?name=${ZONE_DOMAIN}`);
const zone = zres.ok && zres.result && zres.result[0];
if (!zone) {
  console.log(`  ✗ no veo la zona ${ZONE_DOMAIN} (${errTxt(zres)}) — falta "Zone · Zone · Read" (+ "Zone · DNS · Edit")`);
  failures++;
} else {
  const list = await cf('GET', `/zones/${zone.id}/dns_records?name=${HOST}`);
  if (!list.ok) { console.log(`  ✗ no pude leer DNS de ${HOST} (${errTxt(list)}) — falta "Zone · DNS · Edit"`); failures++; }
  else {
    const recs = (list.result || []).filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
    const good = recs.find((r) => r.type === 'CNAME' && r.content === PAGES_TARGET);
    for (const r of recs) {
      if (good && r.id === good.id) continue;
      const del = await cf('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
      console.log(del.ok ? `  ✓ DNS viejo eliminado: ${HOST} ${r.type}` : `  ✗ no pude borrar DNS de ${HOST} (${errTxt(del)})`);
      if (!del.ok) failures++;
    }
    if (good) console.log(`  ✓ ${HOST} ya apunta a la app`);
    else {
      const add = await cf('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: HOST, content: PAGES_TARGET, proxied: true, ttl: 1 });
      console.log(add.ok ? `  ✓ ${HOST} → ${PAGES_TARGET} (proxied)` : `  ✗ no pude crear CNAME de ${HOST} (${errTxt(add)}) — falta "Zone · DNS · Edit"`);
      if (!add.ok) failures++;
    }
  }
}

/* ── 2) Pages: registrar el custom domain ── */
console.log('— Paso 2: dominio del proyecto de Pages —');
const add = await cf('POST', `/accounts/${ACCOUNT_ID}/pages/projects/${PAGES_PROJECT}/domains`, { name: HOST });
if (add.ok) console.log(`  ✓ ${HOST} registrado en Pages`);
else if (JSON.stringify(add.errors).includes('already')) console.log(`  ✓ ${HOST} ya estaba registrado en Pages`);
else { console.log(`  ✗ no pude registrar ${HOST} (${errTxt(add)}) — falta "Account · Cloudflare Pages · Edit"`); failures++; }

/* ── 3) verificación real (certificado puede tardar) ── */
console.log('— Paso 3: verificación —');
await new Promise((r) => setTimeout(r, 25000));
try {
  const res = await fetch(`https://${HOST}/`, { headers: { 'user-agent': 'aa-sports-check/1.0' }, redirect: 'follow' });
  const body = await res.text();
  const isApp = body.includes('AA Sports') && body.toLowerCase().includes('<!doctype html');
  console.log(`  ${isApp ? '✅' : '✗'} https://${HOST} → ${res.status} ${isApp ? 'sirve la APP (abre en Radar)' : 'aún no sirve la app (el certificado puede tardar 1-3 min)'}`);
  if (!isApp) failures++;
} catch (e) {
  console.log(`  ⏳ https://${HOST} no responde aún (${e.message}) — el certificado de Cloudflare suele tardar 1-3 min; vuelve a correr para re-verificar.`);
}

console.log(failures === 0 ? `\n🎉 SUBDOMINIO LISTO: https://${HOST} sirve la app y abre en el Radar.` : `\n⚠️ Quedaron ${failures} pasos con problema (ver arriba). Si es de permisos, añade el scope indicado al token y re-corre.`);
process.exit(0);
