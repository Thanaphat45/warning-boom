// Offline support: the app shell is cached so the schedule opens without internet.
// Pages use network-first (always fresh when online), libraries/holidays use stale-while-revalidate.
const CACHE = 'duty-app-v2';
const SHELL = ['./', './index.html', './app.js', './styles.css', './manifest.webmanifest', './icon.svg', './holidays.json'];
const SUPABASE_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE)
    .then(cache => Promise.all([...SHELL, SUPABASE_LIB].map(url => cache.add(url).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // App code and styles (versioned with ?v=): network first, cached copy when offline.
  if (sameOrigin && /\/(app\.js|styles\.css)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok) cache.put(url.pathname.endsWith('.js') ? './app.js' : './styles.css', response.clone());
        return response;
      } catch (_) {
        return (await cache.match(request)) || (await cache.match(url.pathname.endsWith('.js') ? './app.js' : './styles.css')) || Response.error();
      }
    })());
    return;
  }

  // App page: try the network first (3.5 s), fall back to the cached copy when offline.
  if (request.mode === 'navigate' || (sameOrigin && url.pathname.endsWith('/index.html'))) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await Promise.race([
          fetch(request),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500))
        ]);
        if (response.ok && !url.search) cache.put('./index.html', response.clone());
        return response;
      } catch (_) {
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Static files and the Supabase library: answer from cache, refresh in the background.
  if ((sameOrigin && /\.(svg|webmanifest|json)$/.test(url.pathname)) || request.url.startsWith(SUPABASE_LIB)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request).then(response => { if (response.ok) cache.put(request, response.clone()); return response; }).catch(() => cached);
      return cached || network;
    })());
  }
  // Everything else (Supabase API, weather) goes straight to the network.
});

self.addEventListener('push', event => {
  let message = { title: 'ตารางหน้าที่พยาบาล', body: 'มีหน้าที่ตามกำหนดการ' };
  try { if (event.data) message = { ...message, ...event.data.json() }; }
  catch (_) { if (event.data) message.body = event.data.text(); }

  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body,
    icon: new URL('./icon.svg', self.registration.scope).href,
    badge: new URL('./icon.svg', self.registration.scope).href,
    tag: message.tag || 'nursing-duty-reminder',
    renotify: false,
    data: { url: message.url || './' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'ok') return; // "รับทราบ" just dismisses
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    for (const client of clients) {
      if (client.url.startsWith(self.registration.scope) && 'focus' in client) return client.focus();
    }
    return self.clients.openWindow(target);
  }));
});
