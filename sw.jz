// Nexus Pro — Service Worker
// Aufgabe: Push-Nachrichten empfangen (auch wenn die App nicht offen ist)
// und als System-Benachrichtigung anzeigen. Sonst greift der Service
// Worker nicht in den normalen App-Betrieb ein.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Eingehende Push-Nachricht anzeigen
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Nexus Pro', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Nexus Pro';
  const options = {
    body: data.body || '',
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    data: { url: data.url || '/' },
    tag: data.tag || 'nexus-pro-notification',
    renotify: true,
    vibrate: [80, 40, 80]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Klick auf die Benachrichtigung: App öffnen bzw. in den Vordergrund holen
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
