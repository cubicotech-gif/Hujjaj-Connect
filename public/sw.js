// Minimal app-shell cache. Network-first so data is always fresh.
const C = "hujjaj-v2";
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(C).then((c) => c.addAll(["/"])));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((k) => Promise.all(k.filter((x) => x !== C).map((x) => caches.delete(x))))
  );
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    fetch(r)
      .then((res) => {
        const cp = res.clone();
        caches.open(C).then((c) => c.put(r, cp));
        return res;
      })
      .catch(() => caches.match(r).then((m) => m || caches.match("/")))
  );
});
