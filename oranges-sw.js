/* Oranges to Oranges service worker: makes the game work with no signal.
   Bump VERSION whenever you change files, so phones drop the old copies. */
const VERSION = 'v1';
const CACHE = `oc-${VERSION}`;

// Must cache, or installation fails (the game can't run offline without them).
const ESSENTIAL = ['./oranges.html', 'oranges-cards.json'];

// Cached if present; a missing file (e.g. a missing font file) is simply skipped.
const OPTIONAL = [
  'qrcode.js',
  'oranges.webmanifest',
  'AppFiles/Icons/favicon.ico',
  'AppFiles/Logos/AppIcon192px.png',
  'AppFiles/Logos/AppIcon512px.png',
  'AppFiles/Fonts/big-shoulders-display-600.woff2',
  'AppFiles/Fonts/big-shoulders-display-800.woff2',
  'AppFiles/Fonts/source-sans-3-400.woff2',
  'AppFiles/Fonts/source-sans-3-600.woff2',
  'AppFiles/Fonts/source-sans-3-700.woff2'
];

const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ESSENTIAL.map(url => cache.add(new Request(url, { cache: 'reload' }))));
    await Promise.allSettled(OPTIONAL.map(url => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('oc-') && n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Pages and card data: try the network first (so every phone gets the same,
// newest oranges-cards.json when online), fall back to the cache after a short wait.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const update = fetch(request).then(response => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  });
  try {
    return await Promise.race([
      update,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS))
    ]);
  } catch (e) {
    update.catch(() => {}); // let a slow request still refresh the cache
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const page = await cache.match('oranges.html');
      if (page) return page;
    }
    return Response.error();
  }
}

// Fonts, icons, QR library, sound: serve the cached copy instantly and
// refresh it quietly in the background.
async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const refresh = fetch(event.request).then(response => {
    if (response && response.ok) cache.put(event.request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  return refresh;
}

// Safari asks for audio in byte ranges, which a plain cache hit can't answer.
async function rangeResponse(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request.url);
  if (!cached) return fetch(request);

  const buffer = await cached.arrayBuffer();
  const size = buffer.byteLength;
  const match = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  let start = match && match[1] ? Number(match[1]) : 0;
  let end = match && match[2] ? Number(match[2]) : size - 1;
  if (match && !match[1] && match[2]) { start = Math.max(0, size - Number(match[2])); end = size - 1; }
  end = Math.min(end, size - 1);

  return new Response(buffer.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1)
    }
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.headers.has('range')) {
    event.respondWith(rangeResponse(request));
    return;
  }

  const isPage = request.mode === 'navigate' || url.pathname.endsWith('/oranges.html');
  const isCards = url.pathname.endsWith('/oranges-cards.json');
  event.respondWith(isPage || isCards ? networkFirst(request) : staleWhileRevalidate(event));
});
