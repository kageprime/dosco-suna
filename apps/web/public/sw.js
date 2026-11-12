/*
 * Kortix service worker: Web Push (KRTX-1742) + the app shell (KRTX-4719).
 *
 * The API encrypts one JSON message per notification:
 *   { title, body, tag, url, notificationId, kind, type, projectId, sessionId, triggerSlug }
 * `url` is an app path ("/projects/<id>/sessions/<id>?notification=<id>", opened as /workspaces/...). It
 * resolves against this origin, and any other origin falls back to "/".
 *
 * The shell layer makes the app installable and offline-tolerant. Two versioned
 * caches, both bounded: `SHELL_CACHE` holds the offline fallback page and the
 * latest HTML of visited routes (served only when the network is dead), and
 * `STATIC_CACHE` holds same-origin static assets stale-while-revalidate. Only
 * GET, only same-origin, only `status === 200 && type === 'basic'`: the API is
 * cross-origin, and RSC/data fetches carry no asset destination, so auth
 * responses and per-user data are never cached. Bump SHELL_VERSION to ship a
 * new worker; the page shows the update toast and swaps only on reload.
 *
 * Tested by apps/web/src/features/notifications/service-worker.test.ts.
 */

/** Bump to ship a new shell. The old caches die at activate. */
const SHELL_VERSION = 'v3';
const SHELL_CACHE = `kortix-shell-${SHELL_VERSION}`;
const STATIC_CACHE = `kortix-static-${SHELL_VERSION}`;
const CURRENT_CACHES = new Set([SHELL_CACHE, STATIC_CACHE]);
/** The offline fallback page, precached at install. */
const OFFLINE_URL = '/offline.html';
/** Cache entries per cache. FIFO: the oldest entry dies when the bound is hit. */
// ponytail: FIFO bound, not LRU — the static set is content-hashed, so the
// oldest entries are the dead ones already; measure hit rates before an LRU.
const SHELL_CACHE_MAX = 8;
const STATIC_CACHE_MAX = 60;
/** Request destinations the stale-while-revalidate layer serves. */
const STATIC_DESTINATIONS = new Set(['style', 'script', 'image', 'font']);

/** A same-tag notification shown this recently is the same event's other copy. */
const SAME_EVENT_MS = 30000;

/** The app path a message or a notification points at, on this origin only. */
function appUrl(path) {
  const origin = self.location.origin;
  try {
    const url = new URL(typeof path === 'string' && path ? path : '/', origin);
    if (url.origin !== origin) return new URL('/', origin);
    // Payloads keep the pre-2026-11-06 `/projects/…` path (push-payload.ts);
    // the page is `/workspaces/…`, so an open tab on it is found and focused.
    url.pathname = url.pathname.replace(/^\/projects(?=\/|$)/, '/workspaces');
    return url;
  } catch {
    return new URL('/', origin);
  }
}

function windowClients() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

/**
 * Whether a notification alerts again when it replaces `existing`, the
 * same-tag notifications on screen. A browser replaces a same-tag notification
 * silently unless `renotify` is set. An older one is an earlier event, such as
 * the last turn of this session: alert. One from the last 30 s is this event's
 * other copy (an open tab raised it, or the push did): replace it quietly.
 * `alertsAgain` in packages/ui/src/internal/lib/web-notifications.ts applies the same rule.
 */
function alertsAgain(existing) {
  const now = Date.now();
  return (
    existing.length > 0 &&
    existing.every((notification) => !(notification.data && now - notification.data.at < SAME_EVENT_MS))
  );
}

/** Cache `response` and keep the cache within `max` entries (oldest dies). */
async function putBounded(cache, request, response, max) {
  await cache.put(request, response);
  const keys = await cache.keys();
  let excess = keys.length - max;
  for (let i = 0; excess > 0 && i < keys.length; i++) {
    // The offline page is the oldest entry by construction and it is the one
    // the dead network needs: it never dies under the bound.
    if (new URL(keys[i].url).pathname === OFFLINE_URL) continue;
    await cache.delete(keys[i]);
    excess--;
  }
}

/** A same-origin 200. Everything else (auth redirects, errors, opaque) never caches. */
function cacheable(response) {
  return response.status === 200 && response.type === 'basic';
}

/**
 * Navigations: network-first. Online, the page is always fresh. Offline, the
 * route's cached HTML boots the shell (same pathname, any query); nothing
 * cached, the branded offline page answers.
 */
async function networkFirstNavigation(event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(event.request);
    if (cacheable(response)) {
      await putBounded(cache, event.request, response.clone(), SHELL_CACHE_MAX);
    }
    return response;
  } catch {
    return (
      (await cache.match(event.request, { ignoreSearch: true })) ||
      (await cache.match(OFFLINE_URL)) ||
      Response.error()
    );
  }
}

/**
 * Same-origin static assets: stale-while-revalidate. The cache answers at
 * once, the network refreshes the entry in the background. Misses fall
 * through to the network.
 */
async function staleWhileRevalidate(event) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(event.request);
  const refresh = fetch(event.request)
    .then((response) =>
      cacheable(response)
        ? putBounded(cache, event.request, response.clone(), STATIC_CACHE_MAX).then(() => response)
        : response,
    )
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const response = await refresh;
  return response || Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // The API and every other origin pass through: nothing cross-origin caches.
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
  } else if (STATIC_DESTINATIONS.has(request.destination)) {
    // Destination `''` (RSC prefetches, /api/* fetches) is not on the list, so
    // per-user data never caches.
    event.respondWith(staleWhileRevalidate(event));
  }
});

// Precache the offline fallback. A failure must not fail the install: the
// push lane works without it, and the next registration retries.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .catch(() => undefined),
  );
});

// The PAGE decides when a new version takes over: it shows the update toast
// and posts SKIP_WAITING, and the swap lands only on the reload it triggers.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  // The page asks for this on a signed-out surface. The shell cache is keyed by
  // URL only, so it holds the previous identity's route HTML — including the
  // server-rendered session title — and nothing in the sign-out path can reach
  // the Cache API. `/offline.html` stays: it is the fallback the dead network
  // needs, and it is only precached at install.
  if (event.data && event.data.type === 'PURGE_SHELL') {
    event.waitUntil(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const keys = await cache.keys();
        await Promise.all(
          keys
            .filter((key) => new URL(key.url).pathname !== OFFLINE_URL)
            .map((key) => cache.delete(key)),
        );
      }),
    );
  }
});

// Old versions' caches die here. `claim` lets `navigate` reach tabs that
// loaded before this worker was registered.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith('kortix-') && !CURRENT_CACHES.has(name)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = (event.data && event.data.json()) || {};
  } catch {
    message = {};
  }
  const url = appUrl(message.url);
  const tag = message.tag || undefined;
  // Every push shows a notification, also over a focused tab on this page:
  // Safari removes the subscription after 3 pushes that show none. The API
  // sends no push while a tab that shows its own alerts is present.
  event.waitUntil(
    (tag ? self.registration.getNotifications({ tag }) : Promise.resolve([]))
      .catch(() => [])
      .then((existing) =>
        self.registration.showNotification(message.title || 'Kortix', {
          body: message.body || '',
          tag,
          renotify: alertsAgain(existing),
          data: { url: url.href, at: Date.now() },
          icon: '/favicon.svg',
        }),
      ),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = appUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    windowClients().then(async (clients) => {
      const sameOrigin = clients.filter((client) => new URL(client.url).origin === url.origin);
      const onPage = sameOrigin.find((client) => new URL(client.url).pathname === url.pathname);
      if (onPage) {
        // The tab keeps its state, so it never sees `?notification=<id>`: it
        // marks the notification read from this message.
        try {
          onPage.postMessage({ type: 'kortix:notification-open', url: url.href });
        } catch {
          // The tab is closing.
        }
        return onPage.focus();
      }
      const client = sameOrigin[0];
      if (client) {
        // `navigate` spends no window-interaction token. `focus` and
        // `openWindow` share the click's only one, so only one of them runs.
        // An uncontrolled tab (after Shift+Reload) rejects `navigate`.
        const navigated = await client.navigate(url.href).catch(() => undefined);
        if (navigated) return navigated.focus();
        // null: the tab navigated, but away from this origin.
        if (navigated === null) return undefined;
      }
      return self.clients.openWindow(url.href);
    }),
  );
});
