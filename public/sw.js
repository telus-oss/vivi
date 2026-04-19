// __BUILD_ID__ is substituted by the server (see server/index.ts and
// vite.config.ts). A fresh value per deploy makes the SW bytes change, which
// is what actually triggers the browser to install the new worker.
const CACHE_NAME = "vivi-__BUILD_ID__";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(["/", "/index.html"]))
  );
});

// Allow the app to trigger skipWaiting when the user clicks "Reload"
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API, WebSocket, or cross-origin requests
  if (
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/ws") ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  // Cache-first for static assets, network-first for navigation
  if (event.request.mode === "navigate") {
    event.respondWith(
      // cache: "no-store" bypasses the browser HTTP cache so we always see the
      // freshest index.html (and therefore freshest hashed asset URLs).
      fetch(event.request, { cache: "no-store" })
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match("/index.html")))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((resp) => {
          if (resp.ok && event.request.method === "GET") {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return resp;
        })
    )
  );
});
