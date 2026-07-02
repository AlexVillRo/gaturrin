// Service worker de Gaturrin: red primero con fallback a cache.
// La API nunca se cachea (datos en vivo); el shell queda disponible offline.
var CACHE = 'gaturrin-v1';

self.addEventListener('install', function() { self.skipWaiting(); });

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
      })
      .then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // API siempre a la red
  e.respondWith(
    fetch(e.request)
      .then(function(r) {
        if (r.ok && url.origin === location.origin) {
          var copy = r.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, copy); });
        }
        return r;
      })
      .catch(function() { return caches.match(e.request); })
  );
});
