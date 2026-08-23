const CACHE_NAME = "florist-calculator-pro-v1";

const CORE = [
  "/",
  "/manifest.webmanifest"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  if (
    url.hostname.includes("supabase.co") ||
    url.hostname.includes("squareup.com") ||
    url.hostname.includes("square.link") ||
    url.pathname.startsWith("/.netlify/functions/")
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();

        caches.open(CACHE_NAME)
          .then(cache => cache.put(event.request, copy));

        return response;
      })
      .catch(() =>
        caches.match(event.request)
          .then(response => response || caches.match("/"))
      )
  );
});
