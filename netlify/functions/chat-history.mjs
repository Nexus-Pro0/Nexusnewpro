// netlify/functions/chat-history.mjs
//
// Zentraler Chatverlauf pro Kunden-Code.
// Ein Kunde kann damit auf mehreren Geraeten (Handy + Laptop) denselben
// Verlauf sehen. Der Code ist der Schluessel — zwei Kunden mit zwei Codes
// bekommen sich gegenseitig nie zu sehen.
//
// POST { code, entries: [...], deleted: [{k,ts}] }  -> merged Liste zurueck
// POST { code, reset: true }                        -> Verlauf loeschen (Chat leeren)
// GET  ?code=xxx                                    -> nur lesen
//
// Es werden AUSSCHLIESSLICH Text-Eintraege gespeichert. Sprachnachrichten
// bleiben lokal auf dem Geraet — sie sind als Base64 viel zu gross und
// wuerden Speicher und Bandbreite sprengen.
//
// Gleichzeitiges Schreiben von zwei Geraeten:
// Geschrieben wird ausschliesslich mit "onlyIfMatch" gegen den ETag, den
// wir vorher gelesen haben. Hat in der Zwischenzeit ein anderes Geraet
// geschrieben, schlaegt der Write fehl, wir lesen neu und mischen erneut.
// Dadurch kann kein Eintrag ueberschrieben werden. Gelesen wird mit
// strong consistency, damit wir nie auf einem veralteten Stand mischen.
//
// Loeschen einzelner Nachrichten und "Chat leeren":
// Beides braucht ein Gedaechtnis, sonst schiebt das zweite Geraet die
// geloeschte Nachricht beim naechsten Sync einfach wieder hoch. Deshalb
// liegt neben der Liste ein zweiter Blob (<code>.meta) mit
//   { resetAt: <ms>, deleted: [{k,ts}] }
// Ein Eintrag zaehlt als geloescht, wenn sein Schluessel in "deleted"
// steht oder sein Zeitstempel aelter/gleich "resetAt" ist. Der Punkt im
// Schluesselnamen kann nie mit einem Kunden-Code kollidieren, weil Codes
// nur [A-Za-z0-9_-] enthalten duerfen.

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'nexus-chat';
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // gleiche 48h wie in der App
const MAX_ENTRIES = 300;
const MAX_DELETED = 400;
const MAX_TEXT_LEN = 4000;
const MAX_INCOMING = 100;
const WRITE_VERSUCHE = 6;
const CODE_RE = /^[A-Za-z0-9_-]{6,40}$/;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

function metaKey(code) {
  return code + '.meta';
}

function leereMeta() {
  return { resetAt: 0, deleted: [] };
}

// Meta normalisieren: alte Grabsteine wegwerfen, entdoppeln, kappen.
function mergeMeta(lists) {
  const cutoff = Date.now() - MAX_AGE_MS;
  let resetAt = 0;
  const seen = new Set();
  const deleted = [];

  for (const m of lists) {
    if (!m || typeof m !== 'object') continue;
    const r = Number(m.resetAt);
    if (Number.isFinite(r) && r > resetAt) resetAt = r;
    if (!Array.isArray(m.deleted)) continue;
    for (const d of m.deleted) {
      if (!d || typeof d !== 'object') continue;
      const k = typeof d.k === 'string' ? d.k : '';
      const ts = Number(d.ts);
      if (!k || !Number.isFinite(ts) || ts < cutoff) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      deleted.push({ k, ts });
    }
  }

  deleted.sort((a, b) => a.ts - b.ts);
  return { resetAt, deleted: deleted.slice(-MAX_DELETED) };
}

// Zusammenfuehren, entdoppeln, Geloeschtes raus, nach Zeit sortieren, kappen.
function merge(lists, meta) {
  const cutoff = Date.now() - MAX_AGE_MS;
  const resetAt = meta && Number.isFinite(Number(meta.resetAt)) ? Number(meta.resetAt) : 0;
  const tot = new Set((meta && Array.isArray(meta.deleted) ? meta.deleted : []).map((d) => d.k));
  const seen = new Set();
  const out = [];

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      if (e.type !== 'text') continue;
      if (typeof e.text !== 'string' || !e.text) continue;
      const ts = Number(e.ts);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      if (ts <= resetAt) continue;
      const direction = e.direction === 'out' ? 'out' : 'in';
      const text = e.text.slice(0, MAX_TEXT_LEN);
      const key = ts + '|' + direction + '|' + text;
      if (tot.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: 'text', direction, text, ts });
    }
  }

  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-MAX_ENTRIES);
}

// Lesen mit ETag. Strong consistency, sonst koennte ein zweites Geraet
// einen veralteten Stand sehen und beim Mischen etwas verschlucken.
async function lesen(store, key) {
  try {
    const res = await store.getWithMetadata(key, {
      type: 'json',
      consistency: 'strong'
    });
    if (!res) return { data: null, etag: null };
    return { data: res.data, etag: res.etag || null };
  } catch (e) {
    // Noch nie geschrieben oder Store kurz nicht erreichbar:
    // leerer Stand ist besser als ein Fehler in der App.
    return { data: null, etag: null };
  }
}

// Lesen -> mischen -> bedingt schreiben. Bei Kollision von vorne.
// bauen(alt) liefert den neuen Wert; gleich (alt, neu) sagt, ob
// ueberhaupt geschrieben werden muss.
async function casSchreiben(store, key, bauen) {
  for (let versuch = 0; versuch < WRITE_VERSUCHE; versuch++) {
    const { data, etag } = await lesen(store, key);
    const { vorher, nachher } = bauen(data);

    // Nichts Neues dabei: kein Schreibzugriff, spart Credits.
    if (JSON.stringify(vorher) === JSON.stringify(nachher)) {
      return { wert: nachher, ok: true };
    }

    try {
      const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      const { modified } = await store.setJSON(key, nachher, opts);
      if (modified) return { wert: nachher, ok: true };
      // modified === false: ein anderes Geraet war schneller.
      // Schleife laeuft weiter, liest neu und mischt gegen den neuen Stand.
    } catch (e) {
      return { wert: nachher, ok: false };
    }
  }

  // Sollte praktisch nie passieren. Der Client behaelt seine lokale Kopie
  // und schickt sie beim naechsten Sync erneut mit, es geht nichts verloren.
  const { data } = await lesen(store, key);
  return { wert: bauen(data).nachher, ok: false };
}

async function metaSchreiben(store, code, eingehendDeleted, resetAt) {
  const res = await casSchreiben(store, metaKey(code), (alt) => {
    const basis = mergeMeta([alt || leereMeta()]);
    const zusatz = { resetAt: resetAt || 0, deleted: eingehendDeleted || [] };
    return { vorher: basis, nachher: mergeMeta([basis, zusatz]) };
  });
  return res.wert;
}

async function listeSchreiben(store, code, incoming, meta) {
  const res = await casSchreiben(store, code, (alt) => {
    const data = Array.isArray(alt) ? alt : [];
    return {
      vorher: merge([data], meta),
      nachher: merge([data, incoming], meta)
    };
  });
  return res;
}

export default async (req) => {
  if (req.method === 'GET') {
    const code = new URL(req.url).searchParams.get('code') || '';
    if (!CODE_RE.test(code)) return json({ ok: false, error: 'bad code' }, 400);
    const store = getStore(STORE_NAME);
    const [liste, met] = await Promise.all([
      lesen(store, code),
      lesen(store, metaKey(code))
    ]);
    const meta = mergeMeta([met.data || leereMeta()]);
    return json({
      ok: true,
      items: merge([Array.isArray(liste.data) ? liste.data : []], meta),
      deleted: meta.deleted,
      resetAt: meta.resetAt
    });
  }

  if (req.method === 'POST') {
    let payload;
    try {
      payload = await req.json();
    } catch (e) {
      return json({ ok: false, error: 'bad json' }, 400);
    }

    const code = String((payload && payload.code) || '');
    if (!CODE_RE.test(code)) return json({ ok: false, error: 'bad code' }, 400);

    const store = getStore(STORE_NAME);

    // Chat leeren: Liste weg, Marke setzen. Die Marke ist noetig, damit
    // das zweite Geraet den alten Verlauf nicht wieder hochschiebt.
    if (payload.reset === true) {
      try {
        const meta = await metaSchreiben(store, code, [], Date.now());
        try { await store.delete(code); } catch (e) { /* war evtl. nie da */ }
        return json({ ok: true, items: [], deleted: meta.deleted, resetAt: meta.resetAt, reset: true });
      } catch (e) {
        return json({ ok: false, error: 'reset failed' }, 500);
      }
    }

    // Einzelne geloeschte Nachrichten zuerst festhalten, damit sie im
    // selben Durchgang schon aus der Liste herausgefiltert werden.
    const eingehendDeleted = (Array.isArray(payload.deleted) ? payload.deleted : [])
      .slice(-MAX_DELETED);
    const meta = await metaSchreiben(store, code, eingehendDeleted, 0);

    const incoming = (Array.isArray(payload.entries)
      ? payload.entries
      : (payload.entry ? [payload.entry] : [])
    ).slice(-MAX_INCOMING);

    const result = await listeSchreiben(store, code, incoming, meta);
    return json({
      ok: result.ok,
      items: result.wert,
      deleted: meta.deleted,
      resetAt: meta.resetAt
    });
  }

  return json({ ok: false, error: 'method not allowed' }, 405);
};
