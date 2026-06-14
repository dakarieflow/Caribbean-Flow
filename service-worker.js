/* ============================================================
   CaribFlow — service-worker.js
   Cache-First PWA Strategy + Background Sync Queue
   ============================================================ */

const CF_SW_VERSION   = "caribflow-v1.0.0";
const CACHE_STATIC    = `${CF_SW_VERSION}-static`;
const CACHE_DYNAMIC   = `${CF_SW_VERSION}-dynamic`;
const CACHE_IMAGES    = `${CF_SW_VERSION}-images`;

/* ── STATIC ASSETS TO PRE-CACHE ON INSTALL ────────────────── */
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./dashboard.html",
  "./profile.html",
  "./offline.html",
  "./manifest.json",
  "./css/variables.css",
  "./css/main.css",
  "./css/components.css",
  "./css/profile.css",
  "./css/responsive.css",
  "./js/supabase-client.js",
  "./js/auth.js",
  "./js/app.js",
  "./js/ai-engine.js",
  "./js/gamification.js",
  "./data/csec_syllabus.json",
  "./data/cape_syllabus.json",
  "./data/question_banks.json"
];

/* ── INSTALL EVENT: pre-cache all static assets ───────────── */
self.addEventListener("install", event => {
  console.log(`[CaribFlow SW] Installing ${CF_SW_VERSION}…`);
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => {
        console.log("[CaribFlow SW] Pre-caching static assets…");
        return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: "reload" })));
      })
      .then(() => {
        console.log("[CaribFlow SW] Pre-cache complete. Skipping waiting.");
        return self.skipWaiting();
      })
      .catch(err => {
        console.warn("[CaribFlow SW] Pre-cache partial failure:", err.message);
        // Don't block install if some assets fail (e.g., audio not yet created)
        return self.skipWaiting();
      })
  );
});

/* ── ACTIVATE EVENT: clean up old caches ─────────────────── */
self.addEventListener("activate", event => {
  console.log(`[CaribFlow SW] Activating ${CF_SW_VERSION}…`);
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key.startsWith("caribflow-") && key !== CACHE_STATIC && key !== CACHE_DYNAMIC && key !== CACHE_IMAGES)
          .map(key => {
            console.log(`[CaribFlow SW] Deleting old cache: ${key}`);
            return caches.delete(key);
          })
      );
    }).then(() => {
      console.log("[CaribFlow SW] Claiming clients…");
      return self.clients.claim();
    })
  );
});

/* ── FETCH EVENT: Routing Strategy ───────────────────────── */
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and Supabase API calls (network only)
  if (request.method !== "GET") return;
  if (url.hostname.includes("supabase.co") || url.hostname.includes("supabase.com")) return;
  if (url.pathname.includes("/rest/v1/") || url.pathname.includes("/auth/v1/")) return;
  if (url.hostname.includes("cdn.jsdelivr.net")) {
    event.respondWith(networkFirstStrategy(request, CACHE_DYNAMIC));
    return;
  }

  // Determine strategy by resource type
  const dest = request.destination;

  if (dest === "image") {
    event.respondWith(cacheFirstStrategy(request, CACHE_IMAGES));
  } else if (STATIC_ASSETS.some(asset => url.pathname.endsWith(asset.replace("./", "")))) {
    event.respondWith(cacheFirstStrategy(request, CACHE_STATIC));
  } else if (dest === "document") {
    event.respondWith(networkFirstWithOfflineFallback(request));
  } else {
    event.respondWith(staleWhileRevalidate(request, CACHE_DYNAMIC));
  }
});

/* ══════════════════════════════════════════════════════════════
   CACHING STRATEGIES
   ══════════════════════════════════════════════════════════════ */

/**
 * Cache First: serve from cache, fall back to network, update cache.
 */
async function cacheFirstStrategy(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response("Resource unavailable offline.", { status: 503 });
  }
}

/**
 * Network First: try network, fall back to cache.
 */
async function networkFirstStrategy(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response("Offline — resource unavailable.", { status: 503 });
  }
}

/**
 * Stale While Revalidate: serve cache immediately, update in background.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  return cached || fetchPromise || new Response("Offline.", { status: 503 });
}

/**
 * Network first for HTML documents — serve offline.html if network fails.
 */
async function networkFirstWithOfflineFallback(request) {
  const cache = await caches.open(CACHE_STATIC);
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;

    // Serve offline page for navigation requests
    const offline = await cache.match("./offline.html");
    return offline || new Response(
      `<!DOCTYPE html><html><head><title>Offline — CaribFlow</title></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#000;color:#fff;"><h1>🌊 CaribFlow</h1><p>You are offline. Please reconnect to access CaribFlow.</p></body></html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }
}

/* ══════════════════════════════════════════════════════════════
   BACKGROUND SYNC — Supabase write queue
   ══════════════════════════════════════════════════════════════ */

self.addEventListener("sync", event => {
  if (event.tag === "cf-sync-queue") {
    console.log("[CaribFlow SW] Background sync triggered.");
    event.waitUntil(processOfflineQueue());
  }
});

async function processOfflineQueue() {
  // Signal all clients to run cloud sync
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(client => {
    client.postMessage({ type: "CF_SYNC_REQUEST" });
  });
}

/* ══════════════════════════════════════════════════════════════
   PUSH NOTIFICATIONS (future — placeholder)
   ══════════════════════════════════════════════════════════════ */

self.addEventListener("push", event => {
  const data = event.data ? event.data.json() : {};
  const title   = data.title   || "CaribFlow";
  const body    = data.body    || "You have a new notification.";
  const icon    = data.icon    || "./assets/images/brand/icon-192.png";
  const badge   = data.badge   || "./assets/images/brand/icon-72.png";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      vibrate:  [200, 100, 200],
      tag:      "caribflow-notification",
      renotify: true,
      data:     { url: data.url || "./dashboard.html" }
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow(event.notification.data?.url || "./dashboard.html")
  );
});

/* ══════════════════════════════════════════════════════════════
   MESSAGE HANDLER
   ══════════════════════════════════════════════════════════════ */

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data?.type === "CF_CACHE_CLEAR") {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
  }
});

console.log(`[CaribFlow SW] ${CF_SW_VERSION} script loaded.`);
