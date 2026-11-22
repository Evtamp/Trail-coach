// Trail Coach — service worker
// Stratégie : network-first pour index.html (pour recevoir les mises à jour),
// cache-first pour le reste.
const CACHE = "trailcoach-v13";
const SHELL = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Ne jamais mettre en cache les appels Firebase
  if (url.hostname.includes("firebase") || url.hostname.includes("googleapis")) return;
  // Ni les API Strava / Anthropic (données personnelles, toujours fraîches)
  if (url.hostname.includes("strava.com") || url.hostname.includes("anthropic.com")) return;
  // Ni Home Assistant (ou tout appel authentifié), ni les tuiles de carte
  if (e.request.headers.get("Authorization") || url.pathname.startsWith("/api/")) return;
  if (url.hostname.endsWith("tile.openstreetmap.org")) return;

  // Les scripts de l'app suivent la même règle que index.html : réseau
  // d'abord, sinon une mise à jour resterait bloquée sur l'ancienne version.
  const sameOriginScript = url.origin === self.location.origin && url.pathname.endsWith(".js");
  const isDoc = e.request.mode === "navigate" || url.pathname.endsWith("index.html") || sameOriginScript;

  if (isDoc) {
    e.respondWith(
      // cache: "no-cache" : GitHub Pages autorise 10 min de cache navigateur,
      // ce qui retardait l'arrivée des mises à jour.
      fetch(e.request, { cache: "no-cache" })
        .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
        .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return resp;
      }).catch(() => r))
    );
  }
});
