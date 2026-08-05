// Nexus Pro — Service Worker
// Aufgabe: Push-Nachrichten empfangen (auch wenn die App nicht offen ist),
// als System-Benachrichtigung anzeigen UND in den Chat der App einspeisen.
// Ist die App gerade offen, geht die Nachricht direkt per postMessage an
// das Fenster. Ist sie zu, wird sie in einer Warteschlange geparkt und
// beim naechsten Oeffnen nachgeliefert.

const PUSH_CACHE = 'nexus-push-v1';
const QUEUE_URL = '/__nexus_push_queue__';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Alle Queue-Zugriffe werden serialisiert. Sonst kann die App die Queue
// auslesen und leeren, waehrend ein Push gerade hineingeschrieben wird —
// der Eintrag geht dann verloren bzw. taucht erst beim naechsten Oeffnen auf.
let queueLock = Promise.resolve();
function withQueue(fn){
  const run = queueLock.then(fn, fn);
  queueLock = run.then(() => {}, () => {});
  return run;
}

async function readQueue(){
  try{
    const c = await caches.open(PUSH_CACHE);
    const r = await c.match(QUEUE_URL);
    if (!r) return [];
    const arr = await r.json();
    return Array.isArray(arr) ? arr : [];
  }catch(e){ return []; }
}

async function writeQueue(arr){
  try{
    const c = await caches.open(PUSH_CACHE);
    await c.put(QUEUE_URL, new Response(JSON.stringify(arr.slice(-50)), {
      headers: { 'Content-Type': 'application/json' }
    }));
  }catch(e){ /* ignorieren */ }
}

async function deliver(item){
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // Nur die App selbst zaehlt als Empfaenger. Andere Seiten derselben Domain
  // (z. B. ein offener /sw.js-Tab) sind zwar sichtbar, koennen die Nachricht
  // aber nicht anzeigen — sie ging dadurch verloren.
  const appClients = clientList.filter((c) => {
    try { const p = new URL(c.url).pathname; return p === '/' || p === '/index.html'; }
    catch (e) { return false; }
  });
  const live = appClients.filter((c) => c.visibilityState === 'visible');
  if (live.length > 0){
    // App ist offen und sichtbar -> direkt in den Chat
    live.forEach((c) => c.postMessage({ type: 'nexus-push', payload: item }));
    return;
  }
  // App ist zu oder im Hintergrund -> parken (atomar)
  await withQueue(async () => {
    const q = await readQueue();
    q.push(item);
    await writeQueue(q);
  });
}// Eingehende Push-Nachricht anzeigen
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Nexus Pro', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Nexus Pro';
  const body = data.body || '';
  const options = {
    body: body,
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    data: { url: data.url || '/' },
    tag: data.tag || 'nexus-pro-notification',
    renotify: true,
    vibrate: [80, 40, 80]
  };

  const item = { title: title, body: body, ts: Date.now() };
  item.id = title + '|' + body + '|' + item.ts;

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    deliver(item)
  ]));
});

// Die App fragt beim Start bzw. beim Zurueckkehren nach geparkten Nachrichten
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type !== 'nexus-drain') return;
  event.waitUntil((async () => {
    const q = await withQueue(async () => {
      const cur = await readQueue();
      if (cur.length) await writeQueue([]);
      return cur;
    });
    const port = event.ports && event.ports[0];
    if (port){
      port.postMessage({ type: 'nexus-drain-result', items: q });
    } else if (event.source){
      event.source.postMessage({ type: 'nexus-drain-result', items: q });
    }
  })());
});

// Klick auf die Benachrichtigung: App oeffnen bzw. in den Vordergrund holen
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
