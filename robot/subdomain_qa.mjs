// Conecta qa.aasport.net al proyecto Pages de AA Sports. Idempotente y limitado
// al hostname exacto: no toca ningún otro DNS ni custom domain.
const ACCOUNT_ID = 'f02574feb7272a1da2818e35e0ff4342';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ZONE_DOMAIN = 'aasport.net';
const HOST = 'qa.aasport.net';
const PROJECT = 'aa-sports';
const TARGET = 'aa-sports-5ap.pages.dev';
const CF = 'https://api.cloudflare.com/client/v4';

if (!API_TOKEN) throw new Error('QA subdomain: falta CLOUDFLARE_API_TOKEN');

async function cf(method, path, body) {
  const response = await fetch(CF + path, {
    method, headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload.errors || []).slice(0, 300)}`);
  }
  return payload.result;
}

const zones = await cf('GET', `/zones?name=${ZONE_DOMAIN}`);
const zone = Array.isArray(zones) && zones[0];
if (!zone?.id) throw new Error(`QA subdomain: no se encontró la zona ${ZONE_DOMAIN}`);

const records = await cf('GET', `/zones/${zone.id}/dns_records?name=${HOST}`);
const exact = (records || []).filter((record) => record.name === HOST && ['A', 'AAAA', 'CNAME'].includes(record.type));
const good = exact.find((record) => record.type === 'CNAME' && record.content === TARGET && record.proxied === true);
if (good) console.log(`✅ DNS ${HOST} ya apunta a ${TARGET}`);
else if (exact.length === 0) {
  await cf('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: HOST, content: TARGET, proxied: true, ttl: 1 });
  console.log(`✅ DNS ${HOST} → ${TARGET}`);
} else if (exact.length === 1) {
  await cf('PUT', `/zones/${zone.id}/dns_records/${exact[0].id}`, { type: 'CNAME', name: HOST, content: TARGET, proxied: true, ttl: 1 });
  console.log(`✅ DNS ${HOST} corregido → ${TARGET}`);
} else {
  throw new Error(`QA subdomain: hay ${exact.length} registros conflictivos para ${HOST}; no se borró ninguno automáticamente`);
}

const domains = await cf('GET', `/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT}/domains`);
if ((domains || []).some((domain) => domain.name === HOST)) console.log(`✅ Pages ya reconoce ${HOST}`);
else {
  await cf('POST', `/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT}/domains`, { name: HOST });
  console.log(`✅ Pages registró ${HOST}`);
}

// El certificado puede tardar varios minutos. El alta API/DNS sí es obligatoria;
// la verificación HTTPS se informa sin volver frágil el deploy por propagación.
try {
  const response = await fetch(`https://${HOST}/?qa-domain-check=1`, { redirect: 'follow', headers: { 'user-agent': 'aa-sports-qa-domain-check/1.0' } });
  const html = await response.text();
  if (response.ok && html.includes('qaRequested') && html.includes('AA Sports')) console.log(`✅ https://${HOST} sirve la app QA`);
  else console.log(`⚠️ ${HOST} registrado; HTTPS todavía propagando (${response.status})`);
} catch (error) {
  console.log(`⚠️ ${HOST} registrado; certificado/DNS todavía propagando: ${error.message}`);
}
