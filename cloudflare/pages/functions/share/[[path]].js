// Pages Function: tarjetas para compartir con OpenGraph dinámico.
// /share/mlb/<event_id>  · /share/soccer/<espn_id> · /share/radar/<wallet>
// Devuelve HTML con og:title/description por partido/perfil (imagen de marca
// og.png) y redirige a la app con deep-link. Así los links se ven bien al
// pegarlos en WhatsApp/X/Slack. $0 (Pages Functions). Honesto: sin números
// inventados; si no encuentra el evento, cae a la tarjeta de marca genérica.
const API = 'https://aa-sports-api.opsmira9.workers.dev';
const SITE = 'https://aasport.net';
const OG_IMG = SITE + '/assets/og.png';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page({ title, desc, redirect }) {
  const t = esc(title), d = esc(desc), r = esc(redirect);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="AA Sports">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${esc(OG_IMG)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${r}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${esc(OG_IMG)}">
<link rel="canonical" href="${r}">
<meta http-equiv="refresh" content="0; url=${r}">
<script>location.replace(${JSON.stringify(redirect)})</script>
</head><body style="background:#0b0e14;color:#e7edf5;font-family:system-ui,sans-serif;text-align:center;padding:40px">
<p>${t}</p><p><a href="${r}" style="color:#19DE9F">Abrir AA Sports →</a></p>
</body></html>`;
}

async function getJson(path) {
  try { const res = await fetch(API + path, { headers: { 'user-agent': 'aa-share/1.0' } }); return res.ok ? await res.json() : null; }
  catch { return null; }
}

// Construye la tarjeta (título/desc/redirect) para el recurso pedido. Exportada
// para poder testearla con fetch simulado.
export async function buildCard(kind, id) {
  if (kind === 'mlb' && id) {
    const d = await getJson('/v1/mlb/today');
    const ev = d && (d.events || []).find((e) => String(e.event_id) === String(id));
    if (ev) {
      const p = ev.prediction || {};
      const mu = `${ev.away?.code || ''} @ ${ev.home?.code || ''}`.trim();
      const pk = p.pick && p.prob_pct != null ? ` · AA ${p.pick} ${p.prob_pct}%` : '';
      return { title: `${mu}${pk} — AA Sports`, desc: 'Predicción calibrada, métricas y contexto para que decidas. Datos honestos, algoritmo privado. 18/21+.', redirect: `${SITE}/?g=${encodeURIComponent(id)}` };
    }
    return { title: 'MLB en AA Sports', desc: 'Predicciones AA calibradas + marcadores en vivo. Los datos deciden.', redirect: `${SITE}/` };
  }
  if (kind === 'soccer' && id) {
    const d = await getJson('/v1/soccer/today');
    const g = d && d.by_id && d.by_id[String(id)];
    if (g) {
      const pk = g.pick && g.prob != null ? ` · AA ${g.pick} ${Math.round(g.prob * 100)}%` : '';
      return { title: `${g.away || ''} @ ${g.home || ''}${pk} — AA Sports`.trim(), desc: 'Probabilidad calibrada (validada en 16k partidos) + contexto. AA informa, no apuesta. 18/21+.', redirect: `${SITE}/?tab=soccer&sc=${encodeURIComponent(id)}` };
    }
    return { title: 'Fútbol en AA Sports', desc: 'Predicciones AA de fútbol, validadas en backtest. Los datos deciden.', redirect: `${SITE}/?tab=soccer` };
  }
  if (kind === 'radar' && /^0x[0-9a-fA-F]{40}$/.test(id || '')) {
    return { title: 'Radar AA — perfil de wallet', desc: 'Observatorio de wallets de Polymarket: qué hacen, cuándo y cómo. Descriptivo, no recomendación.', redirect: `${SITE}/?w=${encodeURIComponent(id)}` };
  }
  return { title: 'AA Sports — Los datos deciden', desc: 'Predicciones deportivas con IA, marcadores en vivo y el Radar de Polymarket. Datos honestos y medidos.', redirect: `${SITE}/` };
}

export async function onRequestGet(context) {
  const seg = (context.params && context.params.path) || [];
  const kind = (Array.isArray(seg) ? seg[0] : '') || '';
  const id = (Array.isArray(seg) ? seg[1] : '') || '';
  const card = await buildCard(kind, id);
  return new Response(page(card), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}
