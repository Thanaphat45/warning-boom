self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
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
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    for (const client of clients) {
      if (client.url.startsWith(self.registration.scope) && 'focus' in client) return client.focus();
    }
    return self.clients.openWindow(target);
  }));
});
