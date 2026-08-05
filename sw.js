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
  const live = clientList.filter((c) => c.visibilityState === 'visible');
  if (live.length > 0){
    // App ist offen und sichtbar -> direkt in den Chat
    live.forEach((c) => c.postMessage({ type: 'nexus-push', payload: item }));
    return;
  }
  // App ist zu oder im Hintergrund -> parken (atomar)
  await withQueue(async () => {
    const q =
