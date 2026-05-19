const SHELL_CACHE = 'even-tutor-shell-v1';
const SHELL_URLS = ['/', '/ask', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_URLS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Network-first for /api/*: don't cache RAG responses
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  // Cache-first for everything else
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then((cached) =>
        cached || fetch(e.request).then((resp) => {
          if (resp.ok && resp.type !== 'opaque') {
            const clone = resp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(e.request, clone).catch(() => {}));
          }
          return resp;
        }).catch(() => cached)
      )
    );
  }
});
