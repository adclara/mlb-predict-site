// AA Sports — service worker mínimo para PWA instalable + arranque offline.
// Regla de oro: NUNCA cachear datos/predicciones. Solo el "shell" estático.
//  · navegación (HTML): red primero (así un deploy trae JS nuevo), shell offline de respaldo.
//  · estáticos del mismo origen (iconos, vendor, css): caché primero.
//  · API (/v1/* en el Worker, otro origen) y terceros: red directa, sin caché.
const V = 'aa-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/assets/icon-192.png', '/assets/icon-512.png', '/assets/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url; try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;            // API del Worker + terceros → red directa
  if (url.pathname.startsWith('/v1/')) return;           // por si algún día hay API mismo-origen

  if (req.mode === 'navigate') {                          // HTML: red primero, shell offline de respaldo
    e.respondWith(
      fetch(req).then((r) => { const cp = r.clone(); caches.open(V).then((c) => c.put('/', cp)); return r; })
        .catch(() => caches.match('/').then((r) => r || caches.match('/index.html')))
    );
    return;
  }
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico|js|css|json|woff2?|webmanifest)$/.test(url.pathname)) { // estáticos: caché primero
    e.respondWith(
      caches.match(req).then((c) => c || fetch(req).then((r) => {
        if (r && r.ok) { const cp = r.clone(); caches.open(V).then((ca) => ca.put(req, cp)); }
        return r;
      }))
    );
  }
});
