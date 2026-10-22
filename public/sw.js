// Service worker for the public pages, served as /sw.js with CONFIG filled in (src/pwa.ts).
// On install it stores the static files, every public page and their images, so one visit is enough for the whole
// site to work offline. Pages: network first, but after NETWORK_WAIT the stored copy (venue Wi-Fi without internet
// often hangs instead of failing); live.js/site.js then mark it "Offline · Stand hh:mm". Once offline, that state is
// kept (OFFLINE_FLAG, shared with site.js): every further page comes from the store at once, the network is only
// tried in the background, and only an answer from it switches back. Versioned /static files and uploads never
// change under their URL: cache first. Admin pages, /api/live, /health and anything that is not a GET are never
// touched, so nothing stale is ever acted on.
const CONFIG = {/* __CONFIG__ */};
const { VERSION, ASSETS, PAGES, UPLOADS } = CONFIG;
const CACHE = `kk-${VERSION}`; // static files and pages, replaced with every version
const IMAGES = "kk-uploads"; // uploads keep their URL forever, so they survive versions (pruned on activate)
const STATE = "kk-state"; // OFFLINE_FLAG, survives versions; site.js reads and writes it too
const OFFLINE_FLAG = "/__offline";
const NETWORK_WAIT = 3000;
const NETWORK_GIVE_UP = 30000; // a background request that hangs this long is dropped

const isOffline = async () => !!(await (await caches.open(STATE)).match(OFFLINE_FLAG));
const setOffline = async (off) => {
  const state = await caches.open(STATE);
  await (off ? state.put(OFFLINE_FLAG, new Response("1")) : state.delete(OFFLINE_FLAG));
};

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
    // best effort: a page or image that fails must not stop the rest from working offline
    await Promise.allSettled(PAGES.map((url) => cache.add(url)));
    const images = await caches.open(IMAGES);
    await Promise.allSettled(UPLOADS.map(async (url) => (await images.match(url)) || images.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (![CACHE, IMAGES, STATE].includes(key)) await caches.delete(key);
    const images = await caches.open(IMAGES);
    const keep = new Set(UPLOADS.map((url) => new URL(url, location.origin).href));
    for (const req of await images.keys()) if (!keep.has(req.url)) await images.delete(req);
    // no navigation preload: when its request fails, Firefox fails the whole page load even though this worker
    // answers with the stored copy (offline would show nothing). disable() also turns it off where an older version
    // of this worker had enabled it.
    await self.registration.navigationPreload?.disable();
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  const path = url.pathname;
  if (path.startsWith("/static/") && url.searchParams.has("v")) e.respondWith(cacheFirst(e, CACHE));
  else if (path.startsWith("/uploads/")) e.respondWith(cacheFirst(e, IMAGES));
  else if (req.mode === "navigate" && !path.startsWith("/admin") && path !== "/health") e.respondWith(networkFirst(e));
});

// waitUntil: the browser may stop the worker right after the response, before the copy is stored
async function cacheFirst(e, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(e.request);
  if (hit) return hit;
  // offline and not stored: fail at once instead of waiting for a network that is not there
  if (await isOffline()) return Response.error();
  const res = await fetch(e.request);
  if (res.ok) e.waitUntil(cache.put(e.request, res.clone()));
  return res;
}

async function networkFirst(e) {
  const req = e.request;
  const offline = await isOffline();
  let stored;
  const network = (async () => {
    try {
      const res = await fetch(req, { signal: AbortSignal.timeout(NETWORK_GIVE_UP) });
      if (res.ok) stored = caches.open(CACHE).then((cache) => cache.put(req, res.clone()));
      // any answer means the server is reachable (again), also after this page was too slow and marked offline
      await setOffline(false);
      return res;
    } catch (err) {
      await setOffline(true);
      throw err;
    }
  })();
  // a fresh copy that arrives after the stored one was shown is still kept for next time
  e.waitUntil(network.then(() => stored, () => {}));

  if (!offline) {
    const first = await Promise.race([network.catch(() => null), new Promise((r) => setTimeout(r, NETWORK_WAIT))]);
    if (first) return first;
    // too slow counts as offline for the following pages, until an answer arrives (see network above)
    e.waitUntil(setOffline(true));
  }
  // offline, failed or too slow: the stored copy of this page, else of the same page without query (e.g. a Lageplan
  // room link); only without any copy is the network still waited for
  const cached = (await caches.match(req, { cacheName: CACHE })) ?? (await caches.match(req, { cacheName: CACHE, ignoreSearch: true }));
  if (cached) return fromStore(cached);
  return network.catch(offlinePage);
}

/**
 * Marks a stored page (html[data-from-store]), so site.js shows the offline bar before anything else runs – also
 * when the network came back in the meantime, the page itself is still the old copy.
 */
async function fromStore(res) {
  const html = (await res.text()).replace("<html ", "<html data-from-store ");
  const headers = new Headers(res.headers);
  headers.delete("Content-Length"); // the body is a few bytes longer now
  headers.delete("Content-Encoding"); // and no longer compressed
  return new Response(html, { status: res.status, statusText: res.statusText, headers });
}

const offlinePage = () =>
  new Response(
    `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta name="color-scheme" content="light dark">` +
      `<title>Offline</title><body style="font:1rem/1.5 system-ui,sans-serif;margin:2rem auto;max-width:30rem;padding:0 1rem">` +
      `<h1 style="font-size:1.3rem">Keine Verbindung</h1><p>Diese Seite ist auf diesem Gerät nicht gespeichert. ` +
      `Sobald wieder Netz da ist, lädt sie normal.</p><p><a href="/">Zur Startseite</a></p></body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
