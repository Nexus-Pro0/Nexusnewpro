// nexus-sync.js — Mehrgeraete-Sync + Chat-Bedienung
//
// Wird NACH dem Haupt-Script geladen und haengt sich an dessen globale
// Funktionen an. Aufgaben:
//   1. Kunden-Code abfragen und merken
//   2. Text-Verlauf mit dem Server abgleichen (Handy <-> Laptop)
//   3. Den Code beim Push-Abo mitschicken, damit Make an ALLE Geraete
//      des Kunden pushen kann
//   4. Langer Druck auf eine Nachricht -> Menue "Kopieren / Loeschen"
//   5. Papierkorb-Knopf oben rechts -> kompletten Chat leeren (mit Rueckfrage)
//   6. Fluessiges Scrollen ans Ende statt der bisherigen Sprünge
//
// Sprachnachrichten bleiben bewusst lokal — nur Text wandert mit.

(function () {
  'use strict';

  var CODE_KEY = 'nexus_kunde_code';
  var HIST_KEY = 'nexus_chat_history';
  var DEL_KEY = 'nexus_chat_deleted';
  var RESET_KEY = 'nexus_chat_reset_at';
  var API = '/.netlify/functions/chat-history';
  var CODE_RE = /^[A-Za-z0-9_-]{6,40}$/;
  var SYNC_INTERVAL_MS = 60000;
  var MAX_AGE_MS = 48 * 60 * 60 * 1000;
  var LONGPRESS_MS = 480;

  // ── Code lesen / schreiben ─────────────────────────────────
  function readCode() {
    try {
      var c = localStorage.getItem(CODE_KEY);
      return c && CODE_RE.test(c) ? c : null;
    } catch (e) {
      return null;
    }
  }

  function writeCode(c) {
    try {
      localStorage.setItem(CODE_KEY, c);
    } catch (e) { /* privater Modus: laeuft dann nur diese Sitzung */ }
  }

  var kundenCode = readCode();
  window.getKundenCode = function () { return kundenCode; };

  // ── Lokaler Verlauf ────────────────────────────────────────
  function loadLocal() {
    try {
      var raw = localStorage.getItem(HIST_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveLocal(list) {
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(list));
    } catch (e) { /* Speicher voll: Verlauf laeuft nur in dieser Sitzung */ }
  }

  function keyOf(e) {
    return e.ts + '|' + (e.direction === 'out' ? 'out' : 'in') + '|' + (e.text || '');
  }

  // ── Grabsteine: was hier drin steht, kommt nie wieder ──────
  // Ohne das wuerde das zweite Geraet eine geloeschte Nachricht beim
  // naechsten Abgleich einfach wieder hochschieben.
  function loadDeleted() {
    try {
      var raw = localStorage.getItem(DEL_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      var cutoff = Date.now() - MAX_AGE_MS;
      return parsed.filter(function (d) {
        return d && typeof d.k === 'string' && typeof d.ts === 'number' && d.ts >= cutoff;
      });
    } catch (e) {
      return [];
    }
  }

  function saveDeleted(list) {
    try {
      localStorage.setItem(DEL_KEY, JSON.stringify(list.slice(-400)));
    } catch (e) { /* egal */ }
  }

  function mergeDeleted(a, b) {
    var seen = {};
    var out = [];
    [a, b].forEach(function (list) {
      (list || []).forEach(function (d) {
        if (!d || typeof d.k !== 'string' || seen[d.k]) return;
        seen[d.k] = true;
        out.push({ k: d.k, ts: Number(d.ts) || 0 });
      });
    });
    return out;
  }

  function loadResetAt() {
    try {
      return Number(localStorage.getItem(RESET_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function saveResetAt(v) {
    try {
      localStorage.setItem(RESET_KEY, String(v));
    } catch (e) { /* egal */ }
  }

  // Lokalen Verlauf gegen Grabsteine und Leer-Marke filtern.
  function filtern(list, deleted, resetAt) {
    var tot = {};
    (deleted || []).forEach(function (d) { tot[d.k] = true; });
    return (list || []).filter(function (e) {
      if (!e || typeof e !== 'object') return false;
      if (resetAt && Number(e.ts) <= resetAt) return false;
      if (e.type === 'text' && tot[keyOf(e)]) return false;
      return true;
    });
  }

  // ── Abgleich mit dem Server ────────────────────────────────
  var syncLaeuft = false;

  // erzwingen=true (nur beim manuellen Refresh-Button): rendert auch dann
  // neu, wenn die Diff-Erkennung nichts Neues fand, und wirft Fehler nach
  // aussen weiter, statt sie stillschweigend zu schlucken - genau wie ein
  // kompletter Neustart der App sich verhaelt.
  async function sync(nachRendern, erzwingen) {
    if (!kundenCode || syncLaeuft) return;
    syncLaeuft = true;
    try {
      var local = loadLocal();
      var deleted = loadDeleted();
      var resetAt = loadResetAt();

      var eigeneTexte = local
        .filter(function (e) { return e && e.type === 'text' && e.text; })
        .slice(-40);

      // Ohne Zeitlimit haengt der Sync bei schlechtem Netz unbegrenzt und
      // blockiert jeden weiteren Durchgang (laeuft-Flag bleibt gesetzt).
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var abbruch = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
      var res;
      try {
        res = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: kundenCode,
            entries: eigeneTexte,
            deleted: deleted
          }),
          signal: ctrl ? ctrl.signal : undefined
        });
      } finally {
        if (abbruch) clearTimeout(abbruch);
      }
      if (!res.ok) {
        if (erzwingen) throw new Error('chat-history Antwort: ' + res.status);
        return;
      }

      var data = await res.json();
      var server = (data && Array.isArray(data.items)) ? data.items : [];
      var serverDeleted = (data && Array.isArray(data.deleted)) ? data.deleted : [];
      var serverReset = Number(data && data.resetAt) || 0;

      // Was der Server als geloescht kennt, gilt auch hier.
      var neueDeleted = mergeDeleted(deleted, serverDeleted);
      if (neueDeleted.length !== deleted.length) saveDeleted(neueDeleted);
      if (serverReset > resetAt) { resetAt = serverReset; saveResetAt(resetAt); }

      var gefiltert = filtern(local, neueDeleted, resetAt);
      var etwasWeg = gefiltert.length !== local.length;

      // Was kennt der Server, das dieses Geraet noch nicht hat?
      var bekannt = {};
      gefiltert.forEach(function (e) {
        if (e && e.type === 'text') bekannt[keyOf(e)] = true;
      });
      var neu = server.filter(function (e) { return !bekannt[keyOf(e)]; });

      if (!neu.length && !etwasWeg) {
        // Beim manuellen Refresh trotzdem neu zeichnen: falls die
        // Diff-Erkennung mal etwas uebersieht, zeigt ein erzwungenes
        // Neuaufbauen aus dem lokalen Speicher es trotzdem zuverlaessig an.
        if (nachRendern && erzwingen) neuAufbauen();
        return;
      }

      // Audio-Eintraege bleiben unberuehrt, Texte werden zusammengefuehrt
      var zusammen = gefiltert.concat(neu);
      zusammen.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      saveLocal(zusammen);

      if (nachRendern) neuAufbauen();
    } catch (e) {
      // Server nicht erreichbar: die App laeuft mit dem lokalen Verlauf
      // ganz normal weiter, beim naechsten Versuch wird nachgeholt. Beim
      // erzwungenen manuellen Refresh soll der Aufrufer davon aber
      // erfahren, um es dem Nutzer sichtbar zu machen.
      if (erzwingen) throw e;
    } finally {
      syncLaeuft = false;
    }
  }

  // Oeffentlicher Zugriff auf sync() fuer den manuellen Refresh-Button in
  // index.html: gleicht mit dem Server ab UND zeichnet den Chat bei neuen
  // Eintraegen sauber neu (inkl. Scroll-Position-Erhalt, siehe neuAufbauen).
  // Ohne kundenCode (Zugangscode noch nicht hinterlegt) ist das ein No-op,
  // sync() faengt das selbst ab.
  // Ein zuvor haengengebliebener Sync- oder Render-Versuch darf einen
  // bewussten manuellen Klick nicht dauerhaft blockieren.
  window.nexusResync = function () {
    renderLaeuft = false;
    syncLaeuft = false;
    return sync(true, true);
  };

  // Chat neu zeichnen, damit die Reihenfolge stimmt. Nur die Bubbles
  // werden entfernt — der Empty-State bleibt als Element erhalten.
  var renderLaeuft = false;
  function neuAufbauen() {
    if (renderLaeuft) return;
    try {
      var chatEl = document.getElementById('chat');
      if (!chatEl || typeof restoreChatHistory !== 'function') return;
      renderLaeuft = true;
      // Position merken: wer oben liest, soll nach dem Neuaufbau an
      // derselben Stelle stehen und nicht ans Ende geworfen werden.
      var warUnten = (chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight) < 240;
      var vonUnten = chatEl.scrollHeight - chatEl.scrollTop;
      chatEl.classList.add('nx-ohne-fx');
      var rows = chatEl.querySelectorAll('.row');
      for (var i = 0; i < rows.length; i++) rows[i].remove();
      Promise.resolve(restoreChatHistory())
        .catch(function () {})
        .then(function () {
          renderLaeuft = false;
          leerZustandPruefen();
          requestAnimationFrame(function () {
            if (warUnten) chatEl.scrollTop = chatEl.scrollHeight - chatEl.clientHeight;
            else chatEl.scrollTop = chatEl.scrollHeight - vonUnten;
            requestAnimationFrame(function () { chatEl.classList.remove('nx-ohne-fx'); });
          });
        });
    } catch (e) {
      renderLaeuft = false;
    }
  }

  // ── Jeden neuen Eintrag sofort hochschieben ────────────────
  if (typeof window.appendToChatHistory === 'function') {
    var originalAppend = window.appendToChatHistory;
    window.appendToChatHistory = function (entry) {
      originalAppend(entry);
      if (kundenCode && entry && entry.type === 'text') {
        fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: kundenCode, entries: [entry] })
        }).catch(function () { /* wird beim naechsten Sync nachgeholt */ });
      }
    };
  }

  // ── Kunden-Code beim Push-Abo mitschicken ──────────────────
  // Ersetzt den Original-Aufruf, statt einen zweiten zu senden: Make
  // bekommt genau EINEN Webhook-Call wie bisher, nur mit einem Feld mehr.
  if (typeof window.sendSubscriptionToMake === 'function') {
    var originalSub = window.sendSubscriptionToMake;
    window.sendSubscriptionToMake = async function (subscription) {
      if (!kundenCode) return originalSub(subscription);
      try {
        var fd = new FormData();
        fd.append('type', 'push_subscription');
        fd.append('session_id', typeof SESSION_ID !== 'undefined' ? SESSION_ID : '');
        fd.append('kunde_code', kundenCode);
        fd.append('subscription', JSON.stringify(subscription));
        fd.append('timestamp', new Date().toISOString());
        if (typeof window.sendToN8nFireAndForget === 'function') window.sendToN8nFireAndForget(fd);
        await fetch(WEBHOOK_URL, { method: 'POST', body: fd });
      } catch (e) {
        // Notfalls den alten Weg gehen, damit das Abo nicht verloren geht
        try { await originalSub(subscription); } catch (e2) { /* ignorieren */ }
      }
    };
  }

  // ══════════════════════════════════════════════════════════
  //  Ab hier: Bedienung (Scrollen, Nachrichtenmenue, Leeren)
  // ══════════════════════════════════════════════════════════

  var chatEl = document.getElementById('chat');

  // ── 1. Fluessiges Scrollen ─────────────────────────────────
  // Bisher wurde scrollTop mehrfach hart gesetzt (0/60/150/250/400 ms),
  // waehrend das CSS gleichzeitig eine eigene weiche Animation fuhr —
  // die beiden haben sich gegenseitig abgewuergt, daher das Ruckeln.
  // Jetzt laeuft eine einzige Animation, die das Ziel in jedem Bild neu
  // liest. Dadurch klebt der Chat am unteren Rand, auch waehrend die
  // Tastatur hochfaehrt oder eine Bubble noch einwaechst.
  var folgenBis = 0;
  var folgtGerade = false;
  var letzterFrame = 0;
  // Solange die Tastatur auf- oder zufaehrt, wird NICHT eigenstaendig
  // animiert. Der Chat klebt dann in jedem Bild exakt am Ziel und folgt
  // damit 1:1 der Hoehen-Transition des Containers. Zwei unabhaengige
  // Animationen uebereinander waren genau das, was abgehackt aussah.
  var klebenBis = 0;
  // Sobald der Finger (oder das Mausrad) selbst scrollt, hat der Nutzer
  // Vorrang: jede laufende Animation wird sofort abgebrochen. Sonst
  // zieht die Animation gegen den Finger — das war das Haken und das
  // ploetzliche Zurueckspringen beim Hochscrollen.
  var nutzerAktiv = false;
  var NAH_AM_ENDE = 240;

  function abstandZumEnde() {
    if (!chatEl) return 0;
    return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
  }

  function animationAus() {
    klebenBis = 0;
    folgenBis = 0;
    folgtGerade = false;
    letzterFrame = 0;
  }

  function scrollZielJetzt() {
    return Math.max(0, chatEl.scrollHeight - chatEl.clientHeight);
  }

  function folgeSchritt(zeit) {
    if (!chatEl) { folgtGerade = false; return; }
    if (nutzerAktiv) { animationAus(); return; }
    var dt = letzterFrame ? Math.min(64, zeit - letzterFrame) : 16;
    letzterFrame = zeit;

    var ziel = scrollZielJetzt();
    var diff = ziel - chatEl.scrollTop;
    var jetzt = Date.now();

    if (jetzt < klebenBis) {
      // Tastaturphase: hart ans Ziel, jedes Bild neu.
      if (Math.abs(diff) > 0.5) chatEl.scrollTop = ziel;
    } else if (Math.abs(diff) > 0.5) {
      // Zeitkonstante 70 ms -> nach ca. 250 ms praktisch angekommen,
      // unabhaengig davon, ob der Bildschirm mit 60 oder 120 Hz laeuft.
      chatEl.scrollTop += diff * (1 - Math.exp(-dt / 70));
    }

    if (jetzt < klebenBis) { requestAnimationFrame(folgeSchritt); return; }

    if (Math.abs(ziel - chatEl.scrollTop) <= 0.5 && Date.now() > folgenBis) {
      chatEl.scrollTop = ziel;
      folgtGerade = false;
      letzterFrame = 0;
      return;
    }
    requestAnimationFrame(folgeSchritt);
  }

  function scrollToBottomWeich() {
    if (!chatEl) return;
    // Wer weiter oben liest, wird nicht nach unten gerissen — genau wie
    // in WhatsApp. Erst wenn man wieder unten steht, folgt der Chat.
    if (nutzerAktiv || abstandZumEnde() > NAH_AM_ENDE) return;
    var ziel = scrollZielJetzt();
    var diff = ziel - chatEl.scrollTop;

    // Beim ersten Aufbau (kompletter Verlauf auf einmal) nicht durch den
    // halben Chat animieren, sondern direkt unten stehen.
    if (diff > chatEl.clientHeight * 2) {
      chatEl.scrollTop = ziel;
      return;
    }

    // Nachlauf: deckt die Tastatur-Animation ab, ohne sie zu unterbrechen.
    folgenBis = Date.now() + 450;
    if (folgtGerade) return;
    folgtGerade = true;
    letzterFrame = 0;
    requestAnimationFrame(folgeSchritt);
  }

  function loopStarten() {
    if (folgtGerade) return;
    folgtGerade = true;
    letzterFrame = 0;
    requestAnimationFrame(folgeSchritt);
  }

  // Die Tastatur laeuft in etwa 250-300 ms. Wir kleben etwas laenger,
  // damit auch das Nachfedern von iOS noch abgedeckt ist.
  // vorrang=true nur dort, wo der Nutzer selbst ins Eingabefeld getippt
  // hat. Beim Schliessen der Tastatur (blur) darf das Kleben NICHT gegen
  // einen Finger arbeiten, der gerade im Chat nach oben zieht.
  function tastaturphase(ms, vorrang) {
    if (vorrang) nutzerAktiv = false;
    if (nutzerAktiv) return;
    klebenBis = Date.now() + (ms || 800);
    folgenBis = klebenBis;
    loopStarten();
  }

  if (chatEl) {
    chatEl.style.scrollBehavior = 'auto'; // wir animieren selbst
    window.scrollToBottom = scrollToBottomWeich;

    var ruheTimer = null;
    function nutzerBeginnt() {
      nutzerAktiv = true;
      animationAus();
      clearTimeout(ruheTimer);
    }
    function nutzerEndetGleich() {
      clearTimeout(ruheTimer);
      // Momentum laeuft nach dem Loslassen noch weiter — erst danach
      // darf wieder automatisch gefolgt werden.
      ruheTimer = setTimeout(function () { nutzerAktiv = false; }, 700);
    }
    chatEl.addEventListener('touchstart', nutzerBeginnt, { passive: true });
    chatEl.addEventListener('touchend', nutzerEndetGleich, { passive: true });
    chatEl.addEventListener('touchcancel', nutzerEndetGleich, { passive: true });
    chatEl.addEventListener('wheel', function () {
      nutzerBeginnt();
      nutzerEndetGleich();
    }, { passive: true });

    var eingabe = document.getElementById('notes');
    if (eingabe) {
      eingabe.addEventListener('focus', function () { tastaturphase(900, true); });
      eingabe.addEventListener('blur', function () { tastaturphase(700, false); });
      // Beim Tippen waechst das Textfeld mit -> Chat wird kuerzer.
      eingabe.addEventListener('input', function () { tastaturphase(220, true); });
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { tastaturphase(500, false); });
    }
  }

  // ── 2. Bubbles markieren, damit man sie zuordnen kann ──────
  function markiere(res, typ, direction, atDate, text) {
    try {
      if (!res || !res.row) return res;
      res.row.dataset.nxTyp = typ;
      res.row.dataset.nxDir = direction === 'out' ? 'out' : 'in';
      res.row.dataset.nxTs = String(atDate ? atDate.getTime() : Date.now());
      if (typ === 'text') res.row.dataset.nxText = text || '';
    } catch (e) { /* egal */ }
    return res;
  }

  // Mehrzeilige Antworten (z. B. Kundendaten mit ~10 Feldern) sollen sich
  // zeilenweise kopieren lassen - Telefonnummer oder E-Mail einzeln, statt
  // immer die ganze Nachricht. Dafuer bekommt jede Zeile ein eigenes
  // Block-Element, damit der lange Druck (touchstart, siehe weiter unten)
  // genau erkennen kann, auf welcher Zeile der Finger lag.
  function bubbleZeilenAufbauen(bubbleEl, text) {
    if (!bubbleEl) return;
    var zeilen = String(text || '').split('\n');
    if (zeilen.length <= 1) return;
    bubbleEl.textContent = '';
    zeilen.forEach(function (zeile) {
      var div = document.createElement('div');
      div.className = 'bubble-line';
      div.textContent = zeile;
      bubbleEl.appendChild(div);
    });
  }

  if (typeof window.addTextBubble === 'function') {
    var origText = window.addTextBubble;
    window.addTextBubble = function (text, direction, atDate) {
      var res = origText(text, direction, atDate);
      try {
        bubbleZeilenAufbauen(res && res.row && res.row.querySelector('.bubble'), text);
      } catch (e) { /* egal */ }
      return markiere(res, 'text', direction, atDate, text);
    };
  }

  if (typeof window.addVoiceBubble === 'function') {
    var origVoice = window.addVoiceBubble;
    window.addVoiceBubble = function (blobUrl, peaks, direction, atDate) {
      return markiere(origVoice(blobUrl, peaks, direction, atDate), 'audio', direction, atDate, '');
    };
  }

  // ── 3. Styles fuer Menue, Knopf und Dialog ─────────────────
  function stileEinfuegen() {
    var css = [
      /* Auf Touch-Geraeten schluckt der lange Druck die native Auswahl,
         damit stattdessen unser Menue aufgeht. Am Laptop bleibt das
         normale Markieren erhalten, dort geht das Menue per Rechtsklick. */
      /* Nur .chat zu sperren hat nicht gereicht: WebKit sucht sich dann
         den naechsten auswaehlbaren Vorfahren und markiert dessen ganzen
         Textbereich — genau das gemeldete "markiert die komplette Seite".
         Deshalb wird auf Touch alles gesperrt und nur das Eingabefeld
         wieder freigegeben (dort braucht der Cursor die Auswahl). */
      '@media (hover:none){',
      '  html, body, .app, .chat, .chat *{-webkit-touch-callout:none!important;',
      '    -webkit-user-select:none!important;-moz-user-select:none!important;',
      '    -ms-user-select:none!important;user-select:none!important;}',
      '  #notes{-webkit-user-select:text!important;user-select:text!important;',
      '    -webkit-touch-callout:default!important;}',
      '}',
      /* Hier stand eine !important-Transition auf .app{height}. Sie hat
         die Aenderung in index.html ueberschrieben und war der eigentliche
         Grund fuer das Ruckeln: height ist eine Layout-Eigenschaft, jeder
         Frame reflowte die komplette Chatliste. Die Tastatur laeuft jetzt
         ueber --kb am Composer (transform, kein Reflow). */
      '.chat{scroll-behavior:auto!important;-webkit-overflow-scrolling:touch;',
      '  overscroll-behavior:contain;}',
      /* Beim Neuaufbau sollen nicht alle Zeilen gleichzeitig einfliegen —
         das sah aus wie ein Ruckler. */
      '.chat.nx-ohne-fx .row{animation:none!important;}',
      '.row.nx-gedrueckt > div > .bubble{filter:brightness(1.18);transition:filter .12s ease;}',
      '.bubble-line{border-radius:6px;padding:1px 4px;margin:0 -4px;transition:background .12s ease;}',
      '.bubble-line.nx-gedrueckt{background:rgba(255,255,255,.16);}',
      '.row.nx-weg{opacity:0;transform:translateX(24px) scale(.96);transition:opacity .18s ease,transform .18s ease;}',
      '.nx-back{position:fixed;inset:0;z-index:99998;background:transparent;}',
      '.nx-menu{position:fixed;z-index:99999;min-width:168px;padding:6px;',
      '  background:#1b2038;border:1px solid rgba(255,255,255,.13);border-radius:14px;',
      '  box-shadow:0 18px 46px rgba(0,0,0,.55);',
      '  opacity:0;transform:scale(.94);transform-origin:var(--nx-orig,50% 100%);',
      '  transition:opacity .13s ease,transform .13s cubic-bezier(.2,.8,.2,1);}',
      '.nx-menu.nx-auf{opacity:1;transform:scale(1);}',
      '.nx-menu button{display:flex;align-items:center;gap:10px;width:100%;padding:11px 12px;',
      '  border:0;background:transparent;color:#e8ecf8;font:inherit;font-size:14.5px;',
      '  text-align:left;border-radius:10px;cursor:pointer;}',
      '.nx-menu button:active{background:rgba(255,255,255,.09);}',
      '.nx-menu button.nx-rot{color:#ff7b7b;}',
      '.nx-menu svg{width:17px;height:17px;flex-shrink:0;}',
      '.nx-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(8px);',
      '  z-index:100000;padding:9px 16px;border-radius:999px;background:rgba(20,24,42,.95);',
      '  border:1px solid rgba(255,255,255,.12);color:#e8ecf8;font-size:13.5px;',
      '  opacity:0;transition:opacity .2s ease,transform .2s ease;pointer-events:none;}',
      '.nx-toast.nx-auf{opacity:1;transform:translateX(-50%) translateY(0);}',
      '.nx-dlg-back{position:fixed;inset:0;z-index:99999;background:rgba(8,10,20,.78);',
      '  backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:24px;',
      '  opacity:0;transition:opacity .16s ease;}',
      '.nx-dlg-back.nx-auf{opacity:1;}',
      '.nx-dlg{width:100%;max-width:330px;background:#151a2e;border:1px solid rgba(255,255,255,.12);',
      '  border-radius:18px;padding:22px;color:#e8ecf8;box-shadow:0 20px 60px rgba(0,0,0,.5);',
      '  transform:scale(.95);transition:transform .16s cubic-bezier(.2,.8,.2,1);}',
      '.nx-dlg-back.nx-auf .nx-dlg{transform:scale(1);}',
      '.nx-dlg h3{margin:0 0 8px;font-size:17px;font-weight:600;}',
      '.nx-dlg p{margin:0 0 20px;font-size:13.5px;line-height:1.55;opacity:.72;}',
      '.nx-dlg-btns{display:flex;gap:10px;}',
      '.nx-dlg-btns button{flex:1;padding:12px;border:0;border-radius:12px;font:inherit;',
      '  font-size:14.5px;font-weight:600;cursor:pointer;}',
      '.nx-dlg-btns .nx-ab{background:rgba(255,255,255,.08);color:#e8ecf8;}',
      '.nx-dlg-btns .nx-ok{background:linear-gradient(135deg,#e05252,#c23b3b);color:#fff;}',
      '.nx-trash{margin-left:8px;position:relative;width:38px;height:38px;border-radius:12px;',
      '  border:none;background:var(--surface);color:var(--text-muted);display:flex;',
      '  align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;',
      '  transition:background .15s ease,color .15s ease;}',
      '.nx-trash:active{transform:scale(.94);}',
      '.nx-trash svg{width:18px;height:18px;}'
    ].join('\n');
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }
  stileEinfuegen();

  // ── 4. Kleine Helfer ───────────────────────────────────────
  function tippen() {
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* egal */ }
  }

  var toastEl = null;
  var toastTimer = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'nx-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    requestAnimationFrame(function () { toastEl.classList.add('nx-auf'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl) toastEl.classList.remove('nx-auf');
    }, 1600);
  }

  function kopieren(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('Kopiert'); })
          .catch(function () { kopierenFallback(text); });
        return;
      }
    } catch (e) { /* weiter unten */ }
    kopierenFallback(text);
  }

  function kopierenFallback(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      document.execCommand('copy');
      ta.remove();
      toast('Kopiert');
    } catch (e) {
      toast('Kopieren nicht möglich');
    }
  }

  function bestaetigen(titel, text, okText) {
    return new Promise(function (fertig) {
      var back = document.createElement('div');
      back.className = 'nx-dlg-back';
      var dlg = document.createElement('div');
      dlg.className = 'nx-dlg';

      var h = document.createElement('h3');
      h.textContent = titel;
      var p = document.createElement('p');
      p.textContent = text;
      var reihe = document.createElement('div');
      reihe.className = 'nx-dlg-btns';

      var ab = document.createElement('button');
      ab.type = 'button';
      ab.className = 'nx-ab';
      ab.textContent = 'Abbrechen';
      var ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'nx-ok';
      ok.textContent = okText;

      function schliessen(wert) {
        back.classList.remove('nx-auf');
        setTimeout(function () { back.remove(); }, 180);
        fertig(wert);
      }

      ab.addEventListener('click', function () { schliessen(false); });
      ok.addEventListener('click', function () { schliessen(true); });
      back.addEventListener('click', function (ev) {
        if (ev.target === back) schliessen(false);
      });

      reihe.appendChild(ab);
      reihe.appendChild(ok);
      dlg.appendChild(h);
      dlg.appendChild(p);
      dlg.appendChild(reihe);
      back.appendChild(dlg);
      document.body.appendChild(back);
      requestAnimationFrame(function () { back.classList.add('nx-auf'); });
    });
  }

  function leerZustandPruefen() {
    try {
      if (!chatEl) return;
      if (chatEl.querySelector('.row')) return;
      var es = document.getElementById('emptyState');
      var wm = document.getElementById('watermark');
      if (es) es.style.display = '';
      if (wm) wm.classList.remove('show');
    } catch (e) { /* egal */ }
  }

  // ── 5. Eintrag zu einer Bubble finden und loeschen ─────────
  function eintragIndex(list, typ, dir, text, ts) {
    var idx = -1;
    var best = Infinity;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || e.type !== typ) continue;
      if ((e.direction === 'out' ? 'out' : 'in') !== dir) continue;
      if (typ === 'text' && (e.text || '') !== text) continue;
      var d = Math.abs((Number(e.ts) || 0) - ts);
      if (d < best) { best = d; idx = i; }
    }
    return idx;
  }

  function nachrichtLoeschen(row) {
    var typ = row.dataset.nxTyp || 'text';
    var dir = row.dataset.nxDir === 'out' ? 'out' : 'in';
    var text = row.dataset.nxText || '';
    var ts = Number(row.dataset.nxTs) || 0;

    var local = loadLocal();
    var idx = eintragIndex(local, typ, dir, text, ts);

    if (idx >= 0) {
      var eintrag = local[idx];
      local.splice(idx, 1);
      saveLocal(local);

      if (eintrag.type === 'text') {
        var grab = { k: keyOf(eintrag), ts: Number(eintrag.ts) || Date.now() };
        var deleted = mergeDeleted(loadDeleted(), [grab]);
        saveDeleted(deleted);
        if (kundenCode) {
          fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: kundenCode, entries: [], deleted: [grab] })
          }).catch(function () { /* holt der naechste Sync nach */ });
        }
      }
    }

    row.classList.add('nx-weg');
    setTimeout(function () {
      row.remove();
      leerZustandPruefen();
    }, 190);
  }

  // ── 6. Nachrichtenmenue ────────────────────────────────────
  var menuOffen = null;

  function menuSchliessen() {
    if (!menuOffen) return;
    var m = menuOffen.menu;
    var b = menuOffen.back;
    menuOffen = null;
    m.classList.remove('nx-auf');
    setTimeout(function () { m.remove(); b.remove(); }, 150);
  }

  function knopf(label, iconPfad, rot, aktion) {
    var b = document.createElement('button');
    b.type = 'button';
    if (rot) b.className = 'nx-rot';
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', iconPfad);
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.8');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    var t = document.createElement('span');
    t.textContent = label;
    b.appendChild(svg);
    b.appendChild(t);
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      menuSchliessen();
      aktion();
    });
    return b;
  }

  var ICON_KOPIE = 'M9 9V6.5A1.5 1.5 0 0 1 10.5 5h7A1.5 1.5 0 0 1 19 6.5v7A1.5 1.5 0 0 1 17.5 15H15M6.5 9h7A1.5 1.5 0 0 1 15 10.5v7A1.5 1.5 0 0 1 13.5 19h-7A1.5 1.5 0 0 1 5 17.5v-7A1.5 1.5 0 0 1 6.5 9Z';
  var ICON_MUELL = 'M5 7h14M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7m-7 0 .8 11.1A1.5 1.5 0 0 0 9.3 19.5h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7';

  function auswahlWeg() {
    try {
      var sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    } catch (e) { /* egal */ }
  }

  function menuOeffnen(row, x, y, line) {
    menuSchliessen();
    auswahlWeg();
    tippen();

    var back = document.createElement('div');
    back.className = 'nx-back';
    var menu = document.createElement('div');
    menu.className = 'nx-menu';

    var typ = row.dataset.nxTyp || 'text';
    if (typ === 'text') {
      var vollText = row.dataset.nxText || '';
      var zeilenText = line ? (line.textContent || '').trim() : '';
      // Nur zwei Optionen anbieten, wenn die Zeile tatsaechlich nur ein
      // Teil der Nachricht ist (mehrzeilig) - bei einzeiligen Nachrichten
      // waere "Zeile kopieren" identisch zu "Kopieren" und nur verwirrend.
      if (zeilenText && zeilenText !== vollText) {
        // Zeilen aus Kundendaten & Co. haben das Format "Label: Wert"
        // (teils mit Emoji davor, z. B. "✉️ E-Mail: max@example.com").
        // Kopiert werden soll nur der Wert nach dem ersten Doppelpunkt,
        // nicht das Label selbst - das ist der eigentliche Zweck dieser
        // Option (Telefonnummer/E-Mail direkt weiterverwendbar).
        var inhaltText = zeilenText.replace(/^[^:：]{1,40}[:：]\s*/, '');
        if (!inhaltText) inhaltText = zeilenText;
        menu.appendChild(knopf('Inhalt kopieren', ICON_KOPIE, false, function () {
          kopieren(inhaltText);
        }));
        menu.appendChild(knopf('Ganze Nachricht kopieren', ICON_KOPIE, false, function () {
          kopieren(vollText);
        }));
      } else {
        menu.appendChild(knopf('Kopieren', ICON_KOPIE, false, function () {
          kopieren(vollText);
        }));
      }
    }
    menu.appendChild(knopf('Löschen', ICON_MUELL, true, function () {
      nachrichtLoeschen(row);
    }));

    document.body.appendChild(back);
    document.body.appendChild(menu);

    // Platzieren: bevorzugt ueber der Bubble, sonst darunter.
    var r = menu.getBoundingClientRect();
    var rr = row.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var links = Math.min(Math.max(8, (x || rr.left) - r.width / 2), vw - r.width - 8);
    var oben;
    var origin;
    if (rr.top - r.height - 10 > 8) {
      oben = rr.top - r.height - 10;
      origin = '50% 100%';
    } else {
      oben = Math.min(rr.bottom + 10, vh - r.height - 8);
      origin = '50% 0%';
    }
    menu.style.setProperty('--nx-orig', origin);
    menu.style.left = Math.round(links) + 'px';
    menu.style.top = Math.round(oben) + 'px';

    back.addEventListener('click', menuSchliessen);
    back.addEventListener('contextmenu', function (ev) { ev.preventDefault(); menuSchliessen(); });
    requestAnimationFrame(function () { menu.classList.add('nx-auf'); });

    menuOffen = { menu: menu, back: back };
  }

  // Langer Druck (Touch) / Rechtsklick (Laptop)
  if (chatEl) {
    var druckTimer = null;
    var druckRow = null;
    var druckLine = null;
    var startX = 0;
    var startY = 0;
    var geoeffnet = false;

    function druckAbbrechen() {
      clearTimeout(druckTimer);
      druckTimer = null;
      if (druckLine) druckLine.classList.remove('nx-gedrueckt');
      else if (druckRow) druckRow.classList.remove('nx-gedrueckt');
      druckRow = null;
      druckLine = null;
    }

    chatEl.addEventListener('touchstart', function (ev) {
      if (menuOffen) return;
      var t = ev.target;
      // Auf dem Abspielknopf einer Sprachnachricht nicht stoeren.
      if (t.closest && t.closest('.voice-play-btn')) return;
      var row = t.closest ? t.closest('.row') : null;
      if (!row || !row.dataset.nxTyp) return;

      var p = ev.touches && ev.touches[0];
      startX = p ? p.clientX : 0;
      startY = p ? p.clientY : 0;
      druckRow = row;
      // Bei mehrzeiligen Nachrichten (siehe bubbleZeilenAufbauen oben)
      // steht hier die konkrete Zeile unter dem Finger - damit kann das
      // Menue spaeter gezielt nur diese Zeile zum Kopieren anbieten.
      druckLine = t.closest ? t.closest('.bubble-line') : null;
      geoeffnet = false;
      if (druckLine) druckLine.classList.add('nx-gedrueckt');
      else row.classList.add('nx-gedrueckt');

      druckTimer = setTimeout(function () {
        geoeffnet = true;
        var r = row.getBoundingClientRect();
        if (druckLine) druckLine.classList.remove('nx-gedrueckt');
        else row.classList.remove('nx-gedrueckt');
        menuOeffnen(row, startX || (r.left + r.width / 2), startY || r.top, druckLine);
        druckRow = null;
        druckLine = null;
        druckTimer = null;
      }, LONGPRESS_MS);
    }, { passive: true });

    // Frueher stand hier eine "selectstart"-Bremse gegen die native
    // Textauswahl. iOS Safari feuert dieses Ereignis beim langen Druck
    // gar nicht — die Bremse war wirkungslos, und es lagen zwei Menues
    // uebereinander plus eine blaue Markierung ueber der ganzen Seite.
    // Unterbunden wird das jetzt in CSS (-webkit-touch-callout und
    // user-select auf #chat .row). Hier bleibt nur das Aufraeumen einer
    // eventuell doch entstandenen Auswahl.
    chatEl.addEventListener('touchend', function () {
      setTimeout(auswahlWeg, 0);
    }, { passive: true });

    chatEl.addEventListener('touchmove', function (ev) {
      if (!druckTimer) return;
      var p = ev.touches && ev.touches[0];
      if (!p) return druckAbbrechen();
      if (Math.abs(p.clientX - startX) > 10 || Math.abs(p.clientY - startY) > 10) druckAbbrechen();
    }, { passive: true });

    chatEl.addEventListener('touchend', druckAbbrechen, { passive: true });
    chatEl.addEventListener('touchcancel', druckAbbrechen, { passive: true });

    // Der Klick direkt nach dem langen Druck darf nichts ausloesen.
    chatEl.addEventListener('click', function (ev) {
      if (geoeffnet) {
        geoeffnet = false;
        ev.stopPropagation();
        ev.preventDefault();
      }
    }, true);

    chatEl.addEventListener('contextmenu', function (ev) {
      var row = ev.target.closest ? ev.target.closest('.row') : null;
      if (!row || !row.dataset.nxTyp) return;
      ev.preventDefault();
      var line = ev.target.closest ? ev.target.closest('.bubble-line') : null;
      menuOeffnen(row, ev.clientX, ev.clientY, line);
    });

    window.addEventListener('resize', menuSchliessen);
    chatEl.addEventListener('scroll', function () {
      if (menuOffen) menuSchliessen();
    }, { passive: true });
  }

  // ── 7. Kompletten Chat leeren ──────────────────────────────
  // Loescht lokal UND auf dem Server. Die Leer-Marke sorgt dafuer, dass
  // das zweite Geraet den alten Verlauf nicht wieder hochschiebt.
  window.neuerChat = async function () {
    var marke = Date.now();
    try {
      if (kundenCode) {
        var res = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: kundenCode, reset: true })
        });
        var d = await res.json();
        if (d && Number(d.resetAt) > marke) marke = Number(d.resetAt);
      }
    } catch (e) { /* lokal trotzdem leeren */ }
    saveResetAt(marke);
    saveDeleted([]);
    saveLocal([]);
    if (chatEl) {
      var rows = chatEl.querySelectorAll('.row');
      for (var i = 0; i < rows.length; i++) rows[i].remove();
    }
    leerZustandPruefen();
    return true;
  };

  function trashKnopfEinbauen() {
    var header = document.querySelector('.header');
    if (!header || document.querySelector('.nx-trash')) return;

    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'nx-trash';
    b.tabIndex = -1;
    b.setAttribute('aria-label', 'Chat leeren');
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="' + ICON_MUELL + '" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>';

    b.addEventListener('click', async function () {
      tippen();
      var ja = await bestaetigen(
        'Chat leeren?',
        'Der komplette Verlauf wird gelöscht — auch auf deinen anderen Geräten. Das lässt sich nicht rückgängig machen.',
        'Leeren'
      );
      if (!ja) return;
      await window.neuerChat();
      toast('Chat geleert');
    });

    var notif = document.getElementById('notifBtn');
    if (notif && notif.parentNode === header) header.insertBefore(b, notif.nextSibling);
    else header.appendChild(b);
  }
  trashKnopfEinbauen();

  // ── 8. Abfrage-Overlay beim ersten Start ───────────────────
  function overlayZeigen() {
    var back = document.createElement('div');
    back.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:99999',
      'background:rgba(8,10,20,.92)', 'backdrop-filter:blur(6px)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:24px', 'font-family:inherit'
    ].join(';'));

    var box = document.createElement('div');
    box.setAttribute('style', [
      'width:100%', 'max-width:340px', 'background:#151a2e',
      'border:1px solid rgba(255,255,255,.12)', 'border-radius:18px',
      'padding:24px', 'color:#e8ecf8', 'box-shadow:0 20px 60px rgba(0,0,0,.5)'
    ].join(';'));

    var h = document.createElement('div');
    h.textContent = 'Zugangscode';
    h.setAttribute('style', 'font-size:19px;font-weight:600;margin-bottom:8px');

    var p = document.createElement('div');
    p.textContent = 'Bitte den Code eingeben, den du von uns bekommen hast. Du brauchst ihn nur einmal pro Gerät.';
    p.setAttribute('style', 'font-size:13px;line-height:1.5;opacity:.7;margin-bottom:18px');

    var input = document.createElement('input');
    input.type = 'text';
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'z. B. nx-1a2b3c4d5e';
    input.setAttribute('style', [
      'width:100%', 'box-sizing:border-box', 'padding:13px 14px',
      'border-radius:12px', 'border:1px solid rgba(255,255,255,.18)',
      'background:rgba(255,255,255,.06)', 'color:#fff', 'font-size:16px',
      'outline:none', 'margin-bottom:10px'
    ].join(';'));

    var fehler = document.createElement('div');
    fehler.setAttribute('style', 'font-size:12px;color:#ff8b8b;min-height:16px;margin-bottom:10px');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Weiter';
    btn.setAttribute('style', [
      'width:100%', 'padding:13px', 'border:0', 'border-radius:12px',
      'background:linear-gradient(135deg,#6d5cff,#8b5cf6)', 'color:#fff',
      'font-size:15px', 'font-weight:600', 'cursor:pointer'
    ].join(';'));

    function uebernehmen() {
      var v = (input.value || '').trim();
      if (!CODE_RE.test(v)) {
        fehler.textContent = 'Der Code sieht nicht richtig aus. Bitte prüfen.';
        return;
      }
      kundenCode = v;
      writeCode(v);
      back.remove();
      sync(true);
      starteIntervall();
    }

    btn.addEventListener('click', uebernehmen);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') uebernehmen();
    });

    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(input);
    box.appendChild(fehler);
    box.appendChild(btn);
    back.appendChild(box);
    document.body.appendChild(back);
    setTimeout(function () { input.focus(); }, 100);
  }

  // ── 9. Start ───────────────────────────────────────────────

  // Der Verlauf wird vom Haupt-Script gezeichnet, BEVOR diese Datei
  // geladen ist. Diese Bubbles tragen die Markierung also noch nicht
  // und waeren nicht antippbar. Sie werden hier nachtraeglich zugeordnet
  // — die Reihenfolge im Chat entspricht exakt der Reihenfolge im
  // gespeicherten Verlauf. Passt die Anzahl nicht, wird neu gezeichnet.
  function nachtaggen() {
    try {
      if (!chatEl) return;
      var offen = chatEl.querySelectorAll('.row:not([data-nx-typ])');
      if (!offen.length) return;

      var rows = chatEl.querySelectorAll('.row');
      var hist = loadLocal();
      if (rows.length !== hist.length) { neuAufbauen(); return; }

      for (var i = 0; i < rows.length; i++) {
        var e = hist[i];
        if (!e) continue;
        rows[i].dataset.nxTyp = e.type === 'audio' ? 'audio' : 'text';
        rows[i].dataset.nxDir = e.direction === 'out' ? 'out' : 'in';
        rows[i].dataset.nxTs = String(Number(e.ts) || 0);
        if (e.type === 'text') rows[i].dataset.nxText = e.text || '';
      }
    } catch (e) { neuAufbauen(); }
  }
  setTimeout(nachtaggen, 900);

  var intervallId = null;
  function starteIntervall() {
    if (intervallId) return;
    intervallId = setInterval(function () { sync(true); }, SYNC_INTERVAL_MS);
  }
  function stoppeIntervall() {
    if (!intervallId) return;
    clearInterval(intervallId);
    intervallId = null;
  }

  // Im Hintergrund braucht niemand den Sync — das spart auf dem Handy
  // Akku und Netz. Beim Zurueckkommen wird sofort einmal abgeglichen.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (kundenCode) { starteIntervall(); sync(true); }
    } else {
      stoppeIntervall();
    }
  });

  if (!kundenCode) {
    overlayZeigen();
  } else {
    // Kurz warten, damit der lokale Verlauf zuerst steht — sonst
    // wuerde zweimal hintereinander gezeichnet.
    setTimeout(function () { sync(true); }, 400);
    starteIntervall();
  }
})();

/* ============================================================
   Aufnahme-Visualizer ("Strahl")
   ------------------------------------------------------------
   Ersetzt optisch die 32 Balken in #recLiveWave durch ein
   durchgehendes, fliessendes Band mit wanderndem Farbverlauf.

   Wichtig: index.html wird NICHT angefasst. Die Original-Balken
   laufen unveraendert weiter, sie werden nur per CSS versteckt.
   Faellt hier irgendetwas aus, bleibt die alte Darstellung
   sichtbar — die Aufnahme selbst kann dieser Code nicht stoeren,
   weil er nur einen zusaetzlichen AnalyserNode an den Stream
   haengt und sonst nichts veraendert.
   ============================================================ */
(function () {
  'use strict';

  var wave = document.getElementById('recLiveWave');
  if (!wave || !window.requestAnimationFrame) return;

  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;

  var md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') return;

  // ---------- Aussehen ----------
  var HOEHE      = 30;    // CSS-Hoehe des Bandes
  var PUNKTE     = 96;    // Stuetzpunkte der Kurve
  var TAKT_MS    = 30;    // wie oft ein neuer Wert nachrueckt
  var ATTACK     = 0.34;  // schnell hoch
  var RELEASE    = 0.09;  // langsam runter
  var RUHE       = 0.65;  // halbe Dicke bei Stille (px)
  var DICKE      = 0.52;  // wie viel der halben Hoehe max. gefuellt wird
  var WANDER     = 0.00042; // Tempo des wandernden Verlaufs
  var WELLE_A    = 0.30;  // Ausschlag der Grundwelle (Anteil halbe Hoehe)
  var WELLE_T    = 0.00075; // Tempo der Grundwelle

  var stil = document.createElement('style');
  stil.textContent =
    '.rec-wave.nx-beam{display:block;position:relative;height:' + HOEHE + 'px;overflow:visible;}' +
    '.rec-wave.nx-beam > span{display:none !important;}' +
    '.rec-wave.nx-beam > canvas{display:block;width:100%;height:100%;}';
  document.head.appendChild(stil);

  var canvas = document.createElement('canvas');
  var ctx = null;
  try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
  if (!ctx) return;
  wave.appendChild(canvas);

  var breiteCss = 0, hoeheCss = 0, dpr = 1;

  function groesseSetzen() {
    var r = wave.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width));
    var h = Math.max(1, Math.round(r.height)) || HOEHE;
    var d = Math.min(3, window.devicePixelRatio || 1);
    if (w === breiteCss && h === hoeheCss && d === dpr) return;
    breiteCss = w; hoeheCss = h; dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  if (window.ResizeObserver) {
    try { new ResizeObserver(groesseSetzen).observe(wave); } catch (e) {}
  }
  window.addEventListener('orientationchange', function () { setTimeout(groesseSetzen, 250); });
  window.addEventListener('resize', groesseSetzen);

  // ---------- Farben aus dem Theme ----------
  function cssFarbe(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }
  var FARBE_A = cssFarbe('--accent-a', '#5b6ef5');
  var FARBE_B = cssFarbe('--accent-b', '#8c5cff');
  var FARBE_C = cssFarbe('--accent-c', '#34d8c4');

  // ---------- Zustand ----------
  var pegel = new Array(PUNKTE);
  for (var i = 0; i < PUNKTE; i++) pegel[i] = 0;

  var aktuell = 0;        // geglaetteter Momentanpegel
  var audioCtx = null;
  var analyser = null;
  var daten = null;
  var quelle = null;
  var spur = null;        // MediaStreamTrack
  var rafId = null;
  var letzterTakt = 0;
  var laeuft = false;
  var wacht = null;

  function sichtbar() {
    return !!(wave.offsetParent || wave.getClientRects().length);
  }

  // ---------- Zeichnen ----------
  // Halbe Dicke je Stuetzpunkt, raeumlich geglaettet.
  // Ohne diese Glaettung entstehen durch schnelles Attack /
  // langsames Release "Haifischflossen" statt runder Wellen.
  var hoehen = new Array(PUNKTE);
  var mitten = new Array(PUNKTE);

  // Die Mittellinie ist keine Gerade, sondern eine wandernde Welle aus
  // zwei ueberlagerten Sinus. Dadurch wirkt das Band wie ein Band aus
  // Licht, nicht wie ein Balkendiagramm. Der Ausschlag waechst mit dem
  // Pegel, bleibt bei Stille aber minimal sichtbar.
  function bahnenBauen(ts) {
    var m = hoeheCss / 2;
    var maxDick = Math.max(1.6, (m - 1.5) * DICKE);
    var maxWelle = (m - 1.5) * WELLE_A;
    var ph = ts * WELLE_T;

    for (var i = 0; i < PUNKTE; i++) {
      var a = pegel[i === 0 ? 0 : i - 1];
      var b = pegel[i];
      var c = pegel[i === PUNKTE - 1 ? i : i + 1];
      var mittel = (a + 2 * b + c) / 4;

      var t = i / (PUNKTE - 1);
      // Enden auslaufen lassen, damit der Strahl wie ein Band wirkt
      var fenster = Math.pow(Math.sin(Math.PI * t), 0.6);

      hoehen[i] = RUHE + mittel * maxDick * fenster;

      var welle =
        Math.sin(t * 6.1 - ph * 2.2) * 0.62 +
        Math.sin(t * 10.4 + ph * 1.5) * 0.38;
      mitten[i] = m + welle * maxWelle * fenster * (0.22 + mittel * 0.78);
    }
  }

  function kante(oben) {
    var w = breiteCss, n = PUNKTE;
    var vz = oben ? -1 : 1;
    var xs = [], ys = [];
    for (var i = 0; i < n; i++) {
      var idx = oben ? i : (n - 1 - i);
      xs.push((idx / (n - 1)) * w);
      ys.push(mitten[idx] + vz * hoehen[idx]);
    }
    ctx.lineTo(xs[0], ys[0]);
    for (var j = 0; j < n - 1; j++) {
      var cx = (xs[j] + xs[j + 1]) / 2;
      var cy = (ys[j] + ys[j + 1]) / 2;
      ctx.quadraticCurveTo(xs[j], ys[j], cx, cy);
    }
    ctx.lineTo(xs[n - 1], ys[n - 1]);
  }

  function zeichnen(ts) {
    ctx.clearRect(0, 0, breiteCss, hoeheCss);
    bahnenBauen(ts);

    var w = breiteCss;
    // wandernder Verlauf: der Farbblock schiebt sich seitlich durch
    var off = ((ts * WANDER) % 2) - 1;
    var g = ctx.createLinearGradient(off * w, 0, (off + 2) * w, 0);
    g.addColorStop(0.00, FARBE_A);
    g.addColorStop(0.25, FARBE_C);
    g.addColorStop(0.50, FARBE_B);
    g.addColorStop(0.75, FARBE_C);
    g.addColorStop(1.00, FARBE_A);

    ctx.beginPath();
    ctx.moveTo(0, mitten[0] - hoehen[0]);
    kante(true);
    kante(false);
    ctx.closePath();

    ctx.shadowColor = FARBE_C;
    ctx.shadowBlur = 9;
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  function takt(ts) {
    if (!laeuft) return;
    rafId = requestAnimationFrame(takt);

    if (!sichtbar()) return;
    groesseSetzen();

    // Pegel lesen und glaetten
    var ziel = 0;
    if (analyser && daten) {
      analyser.getByteTimeDomainData(daten);
      var summe = 0;
      for (var i = 0; i < daten.length; i++) {
        var v = (daten[i] - 128) / 128;
        summe += v * v;
      }
      ziel = Math.min(1, Math.sqrt(summe / daten.length) * 4.2);
    }
    var k = ziel > aktuell ? ATTACK : RELEASE;
    aktuell += (ziel - aktuell) * k;

    if (!letzterTakt) letzterTakt = ts;
    if (ts - letzterTakt >= TAKT_MS) {
      letzterTakt = ts;
      // leichtes Atmen, damit bei Stille kein toter Strich steht
      var atem = 0.045 + 0.03 * Math.sin(ts / 380);
      pegel.push(Math.max(atem, aktuell));
      pegel.shift();
    }

    zeichnen(ts);
  }

  // ---------- Start / Stop ----------
  function stoppen() {
    laeuft = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (wacht) { clearInterval(wacht); wacht = null; }
    try { if (quelle) quelle.disconnect(); } catch (e) {}
    try { if (audioCtx) audioCtx.close(); } catch (e) {}
    audioCtx = null; analyser = null; daten = null; quelle = null; spur = null;
    aktuell = 0;
    for (var i = 0; i < PUNKTE; i++) pegel[i] = 0;
    try { ctx.clearRect(0, 0, breiteCss, hoeheCss); } catch (e) {}
    wave.classList.remove('nx-beam');
  }

  function starten(stream) {
    try {
      var spuren = stream.getAudioTracks ? stream.getAudioTracks() : [];
      if (!spuren.length) return;

      // Ein evtl. noch offener Lauf wird zuerst hart beendet.
      stoppen();

      spur = spuren[0];
      audioCtx = new AC();
      quelle = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      quelle.connect(analyser);
      daten = new Uint8Array(analyser.fftSize);

      wave.classList.add('nx-beam');
      groesseSetzen();

      laeuft = true;
      letzterTakt = 0;
      rafId = requestAnimationFrame(takt);

      // stop() feuert kein "ended" — deshalb zusaetzlich pollen.
      try { spur.addEventListener('ended', stoppen); } catch (e) {}
      wacht = setInterval(function () {
        if (!laeuft) { clearInterval(wacht); wacht = null; return; }
        if (!spur || spur.readyState === 'ended') stoppen();
      }, 400);
    } catch (e) {
      // Kein AudioContext moeglich (z. B. Autoplay-Policy):
      // Klasse wieder runter -> die Original-Balken bleiben sichtbar.
      stoppen();
    }
  }

  // ---------- Original-Balken stilllegen ----------
  // Solange der Strahl laeuft, schreibt der Original-Code sonst weiter
  // 32 style.height pro Frame in Spans, die niemand sieht. Der
  // Original-Analyser darf laufen, das kostet fast nichts; nur das
  // Zeichnen wird uebersprungen.
  if (typeof window.renderLiveWave === 'function') {
    var origRender = window.renderLiveWave;
    window.renderLiveWave = function () {
      if (wave.classList.contains('nx-beam')) return;
      return origRender.apply(this, arguments);
    };
  }

  // ---------- Am Stream haengen ----------
  var original = md.getUserMedia.bind(md);
  md.getUserMedia = function (constraints) {
    var p = original(constraints);
    try {
      if (constraints && constraints.audio) {
        p.then(function (stream) {
          try { starten(stream); } catch (e) {}
          return stream;
        }, function () {});
      }
    } catch (e) {}
    return p;
  };
})();
