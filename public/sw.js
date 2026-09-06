// Minimal service worker: enables "Add to Home Screen" / install prompts
// on desktop and mobile. Deliberately does NOT cache API responses, so the
// live data from Supabase is never served stale from a cache.
const SHELL_CACHE = "matchday-shell-v1";
const SHELL_FILES = ["/", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Only handle same-origin navigations; let all data requests (Supabase,
  // fonts, etc.) go straight to the network untouched.
  const url = new URL(event.request.url);
  if (event.request.mode === "navigate" && url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/"))
    );
  }
});
