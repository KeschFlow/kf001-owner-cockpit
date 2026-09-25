const CACHE_NAME = 'kf001-owner-cockpit-v15-instant-shell';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './app-icon.svg',
  './governance-config.js',
  './owner-auth.js',
  './adapters.js',
  './governance.js',
  './radar-ui.js',
  './truth-ui-fix.js',
  './slim-owner-ui.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data?.json(); } catch { return; }
    if (!payload || payload.type !== 'OWNER_GATE' || !payload.title || !payload.body) return;
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: './app-icon.svg',
      badge: './app-icon.svg',
      tag: payload.caseId ? `owner-gate-${payload.caseId}` : 'owner-gate',
      data: { url: payload.url || './', testOnly: false }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.focus();
      if ('navigate' in existing) await existing.navigate(target);
      return;
    }
    await clients.openWindow(target);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match('./index.html');
      const refresh = fetch(event.request, { cache: 'no-store' })
        .then((response) => {
          if (response.ok) cache.put('./index.html', response.clone());
          return response;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }
      return (await refresh) || new Response(
        '<!doctype html><html><body style="margin:0;background:#0f172a;color:#fff;font-family:system-ui;padding:24px"><h1>KF001 FALLRADAR</h1><p>Offline-Start nicht verfügbar. Bitte erneut öffnen.</p></body></html>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    })());
    return;
  }

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const refresh = fetch(event.request, { cache: 'no-store' })
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }
      return (await refresh) || new Response('', { status: 504 });
    })());
    return;
  }

  event.respondWith(fetch(event.request));
});
