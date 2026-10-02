const CACHE = "lume-browser-v1";
const VERSION = "__BUILD_VERSION__";
const base = new URL("./", self.location.href);
const shell = ["./", "index.html", `static/styles.css?v=${VERSION}`, "static/favicon.svg", `static/app.js?v=${VERSION}`, `static/browser.js?v=${VERSION}`, "vendor/pdf/pdf.worker.min.mjs"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(shell.map((path) => new URL(path, base).href))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("lume-browser-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  // Tesseract stores language models in its own IndexedDB cache. Do not keep a
  // second full copy, or save documents as service-worker responses.
  if (url.pathname.includes("/models/") || url.pathname.includes("/api/")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (event.request.mode === "navigate") {
      try {
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request, response.clone());
        return response;
      } catch {
        return (await cache.match(event.request)) || cache.match(new URL("index.html", base).href);
      }
    }
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) await cache.put(event.request, response.clone());
    return response;
  })());
});
