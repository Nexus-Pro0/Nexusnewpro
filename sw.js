// Nexus Pro — Service Worker
// Aufgabe: Push-Nachrichten empfangen (auch wenn die App nicht offen ist),
// als System-Benachrichtigung anzeigen UND in den Chat der App einspeisen.

const PUSH_CACHE = 'nexus-push-v1';
const QUEUE_URL = '/__nexus_push_queue__';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

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
  const live = clientList.filter((c) => c.visibilityState === 'visible');
  if (live.length > 0){
    live.forEach((c) => c.postMessage({ type: 'nexus-push', payload: item }));
    return;
  }
  await withQueue(async () => {
    const q = await readQueue();
    q.push(item);
    await writeQueue(q);
  });
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
}
