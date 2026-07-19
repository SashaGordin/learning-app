// Learning Backlog — service worker.
// Strategy: network-first for navigations, stale-while-revalidate for assets.
// Versioned cache so deploys invalidate cleanly.

const CACHE_VERSION = "v6";
const CACHE_NAME = `learning-backlog-${CACHE_VERSION}`;
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Bypass the SW entirely for Supabase / esm.sh / any non-GET — go straight to network.
  if (e.request.method !== "GET") return;
  if (url.hostname.endsWith("supabase.co") || url.hostname === "esm.sh") return;

  // App launches and page refreshes must prefer the network. The previous
  // cache-first navigation strategy could serve an old index.html once after
  // every deploy, which was enough to submit recall with obsolete logic.
  if (url.origin === location.origin && e.request.mode === "navigate") {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(e.request);
        if (response?.status === 200) await cache.put("./index.html", response.clone());
        return response;
      } catch {
        return (await cache.match(e.request)) || (await cache.match("./index.html"));
      }
    })());
    return;
  }

  // Static assets remain fast and offline-friendly.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(e.request);
      const network = fetch(e.request).then(resp => {
        if (resp && resp.status === 200) cache.put(e.request, resp.clone());
        return resp;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});
