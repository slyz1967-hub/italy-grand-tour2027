/* Italy Grand Tour 2027 — service worker
 *
 * Bump SHELL_VERSION whenever index.html or any vendored asset changes.
 * Tiles and API responses live in separate caches so a version bump
 * doesn't throw away megabytes of downloaded map tiles.
 */
const SHELL_VERSION = 'v22';
const SHELL_CACHE = `italy-tour-shell-${SHELL_VERSION}`;
const TILE_CACHE = 'italy-tour-tiles';
const API_CACHE = 'italy-tour-api';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

const TILE_HOSTS = ['tile.openstreetmap.org'];
const API_HOSTS = ['api.frankfurter.dev', 'api.frankfurter.app', 'api.open-meteo.com'];

// Keep the tile cache from growing without bound
const MAX_TILES = 1200;

/* ---------- Install ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll() fails the whole install if any single file 404s.
      // Add them individually so one missing icon can't brick the app.
      Promise.all(APP_SHELL.map((url) =>
        cache.add(url).catch((err) => console.warn('[sw] could not precache', url, err))
      ))
    )
  );
  // Note: we deliberately do NOT skipWaiting here. The page decides when to
  // activate a new version, so assets never swap out mid-session.
});

/* ---------- Activate ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('italy-tour') && key !== SHELL_CACHE && key !== TILE_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* ---------- Message: page asked us to take over ---------- */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ---------- Helpers ---------- */
function trimCache(cacheName, maxEntries) {
  caches.open(cacheName).then((cache) =>
    cache.keys().then((keys) => {
      if (keys.length <= maxEntries) return;
      return Promise.all(keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)));
    })
  );
}

// Cache-first — for immutable assets and map tiles
function cacheFirst(req, cacheName, opts) {
  return caches.match(req).then((cached) => {
    if (cached) return cached;
    return fetch(req).then((res) => {
      if (res && (res.status === 200 || res.type === 'opaque')) {
        const clone = res.clone();
        caches.open(cacheName).then((cache) => {
          cache.put(req, clone);
          if (opts && opts.max) trimCache(cacheName, opts.max);
        });
      }
      return res;
    });
  });
}

// Network-first with cache fallback — for data that goes stale
function networkFirst(req, cacheName) {
  return fetch(req)
    .then((res) => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(cacheName).then((cache) => cache.put(req, clone));
      }
      return res;
    })
    .catch(() => caches.match(req));
}

/* ---------- Fetch ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1. Map tiles — cache-first, capped, survives version bumps
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(
      cacheFirst(req, TILE_CACHE, { max: MAX_TILES })
        .catch(() => new Response('', { status: 504, statusText: 'Tile unavailable offline' }))
    );
    return;
  }

  // 2. Weather / currency APIs — network-first, fall back to last good response.
  //    The page keeps its own copy in localStorage too, so this is belt and braces.
  if (API_HOSTS.includes(url.hostname)) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }

  // 3. The HTML shell — network-first so updates land when online.
  //    Shortcut launches arrive as index.html?view=today etc. We strip the
  //    query string for cache purposes, so all four shortcuts share one entry
  //    instead of storing four near-identical copies of the page.
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    const shellKey = url.origin + url.pathname;
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(shellKey, clone));
          return res;
        })
        .catch(() =>
          caches.match(shellKey)
            .then((res) => res || caches.match('./index.html'))
        )
    );
    return;
  }

  // 4. Everything else (our own CSS/JS/fonts/icons) — cache-first
  event.respondWith(
    cacheFirst(req, SHELL_CACHE).catch(() => caches.match(req))
  );
});
