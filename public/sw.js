/* Build-time injected by the local Vite plugin. This worker never caches runtime requests. */
const BUILD_ID = '__BUILD_ID__';
const CACHE_PREFIX = 'smart-expense-tracker-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const PRECACHE_PATHS = /*__PRECACHE_MANIFEST__*/ [];
const PRECACHE_URLS = new Set(PRECACHE_PATHS.map((path) => new URL(path, self.registration.scope).href));
const SHELL_URL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // "reload" skips the HTTP cache: GitHub Pages sends max-age=600, so a plain fetch right after a
    // deploy could cache the previous index.html (pointing at deleted hashed assets) under the new build ID.
    await cache.addAll([...PRECACHE_URLS].map((url) => (typeof Request === 'function' ? new Request(url, { cache: 'reload' }) : url)));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(SHELL_URL)) || fetch(request);
    })());
    return;
  }

  if (!PRECACHE_URLS.has(requestUrl.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request)) || fetch(request);
  })());
});
