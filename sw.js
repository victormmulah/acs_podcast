const CACHE_NAME = 'african-stories-shell-v3';
const ASSETS = [
  '/', '/index.html', '/styles.css', '/app.js', '/manifest.json',
  '/assets/icons/icon-192.png', '/assets/icons/icon-96.png',
  '/assets/images/placeholder-baobab.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', ev => {
  ev.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', ev => {
  ev.respondWith(
    fetch(ev.request).then(resp => {
      return resp;
    }).catch(() => {
      return caches.match(ev.request).then(cached => {
        if(cached) return cached;
        if(ev.request.mode === 'navigate') return caches.match('/index.html');
      });
    })
  );
});
