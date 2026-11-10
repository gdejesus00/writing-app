// Offline support: load the app from the network when possible, and from the cache when not.
// Change CACHE whenever files are added, so every device picks up the new set.
const CACHE = 'writing-app-v4';
// Big files that never change at the same address (the grammar engine). Kept once, loaded from the cache.
const VENDOR_CACHE = 'writing-app-vendor-v1';
const APP_FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'store.js',
  'prefs.js',
  'dictation.js',
  'readaloud.js',
  'grammar.js',
  'plot.js',
  'companion.js',
  'drive.js',
  'driveerrors.js',
  'sync.js',
  'config.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', event => {
  // 'reload' asks the network for fresh copies, so a new version never installs old files from the browser's cache.
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(APP_FILES.map(file => cache.add(new Request(file, { cache: 'reload' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE && key !== VENDOR_CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  // VoiceStudio calls always go straight to the local server, never to the cache.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/voicestudio/')) return;
  if (url.pathname.includes('/vendor/')) {
    event.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // 'no-cache' checks with the server every time (a quick "unchanged" answer when nothing changed),
      // so updates show up the next time the app opens instead of after the browser's cache runs out.
      const response = await fetch(request, { cache: 'no-cache' });
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === 'navigate') return (await cache.match('index.html')) ?? Response.error();
      return Response.error();
    }
  })());
});
