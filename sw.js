const CACHE = "nibrasgpt-shell-2";
const SHELL = ["./", "./index.html", "./workspace.css", "./workspace-ui.js", "./manifest.webmanifest", "./icon-192.webp", "./icon-512.webp"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith("nibrasgpt-") && key !== CACHE).map(key => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  const isShell = SHELL.some(path => new URL(path, self.registration.scope).pathname === url.pathname);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !isShell) return;
  event.respondWith(fetch(event.request).then(async response => {
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(event.request, response.clone());
    }
    return response;
  }).catch(async () => (await caches.match(event.request)) ||
    (event.request.mode === "navigate" ? await caches.match("./index.html") : Response.error())));
});
