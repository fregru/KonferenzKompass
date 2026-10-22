// Service worker for the public pages, served as /sw.js with VERSION and ASSETS filled in (src/pwa.ts).
// Pages: network first, the last copy when offline (live.js then marks it "Offline · Stand hh:mm").
// Versioned /static files and uploads never change under their URL: cache first.
// Admin pages, /api/live and anything that is not a GET are never touched, so nothing stale is ever acted on.
const VERSION = "__VERSION__";
const ASSETS = [/* __ASSETS__ */];
const CACHE = `kk-${VERSION}`;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    // navigation preload: the browser requests the page while it is still starting this worker, instead of after
    await self.registration.navigationPreload?.enable();
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  const path = url.pathname;
  if ((path.startsWith("/static/") && url.searchParams.has("v")) || path.startsWith("/uploads/")) e.respondWith(cacheFirst(e));
  else if (req.mode === "navigate" && !path.startsWith("/admin") && path !== "/health") e.respondWith(networkFirst(e));
});

// waitUntil: the browser may stop the worker right after the response, before the copy is stored
async function cacheFirst(e) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(e.request);
  if (hit) return hit;
  const res = await fetch(e.request);
  if (res.ok) e.waitUntil(cache.put(e.request, res.clone()));
  return res;
}

async function networkFirst(e) {
  const req = e.request;
  try {
    const res = (await e.preloadResponse) || (await fetch(req));
    if (res.ok) {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
    }
    return res;
  } catch {
    return (await caches.match(req, { cacheName: CACHE })) ?? offlinePage();
  }
}

const offlinePage = () =>
  new Response(
    `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta name="color-scheme" content="light dark">` +
      `<title>Offline</title><body style="font:1rem/1.5 system-ui,sans-serif;margin:2rem auto;max-width:30rem;padding:0 1rem">` +
      `<h1 style="font-size:1.3rem">Keine Verbindung</h1><p>Diese Seite war auf diesem Gerät noch nicht geöffnet. ` +
      `Sobald wieder Netz da ist, lädt sie normal.</p><p><a href="/">Zur Startseite</a></p></body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
