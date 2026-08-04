# Push-Benachrichtigungen einrichten

## Was du hochladen musst

1. **`index.html`** wie gewohnt bei GitHub ersetzen.
2. **`sw.js`** NEU bei GitHub hochladen — muss im selben Ordner (Root) wie
   `index.html` liegen, NICHT umbenennen.
3. Für die Netlify-Funktion (damit Make.com wirklich Push-Nachrichten
   auslösen kann):
   - Im GitHub-Repo einen neuen Ordner `netlify/functions/` anlegen.
   - `send-push.js` dort hineinlegen.
   - `package.json` ins Root-Verzeichnis des Repos legen (neben `index.html`).

## Netlify-Konfiguration

1. Bei Netlify → euer Projekt → **Project configuration → Environment
   variables**.
2. Zwei neue Variablen anlegen:
   - `VAPID_PUBLIC_KEY` = `BKKg_BlxSEL_H6ajVYtfavKfuDPMtvY4uwRoXyDyIOlGhVbSJIB4bmWURMDuEb4f-4hhogK-tqp_k5ts1vT1UGQ`
   - `VAPID_PRIVATE_KEY` = `LJZ7My04-r-z6iuG2chjRMMITbyLzxsN3uz63RRAfII`
3. Netlify erkennt `netlify/functions/send-push.js` automatisch und
   installiert beim Deploy die `web-push`-Abhängigkeit aus der
   `package.json`.
4. Nach dem Deploy ist die Funktion erreichbar unter:
   `https://gleeful-blini-3792f0.netlify.app/.netlify/functions/send-push`

**Wichtig:** Die privaten Schlüssel niemals in der `index.html` selbst
verwenden oder öffentlich teilen — nur der **öffentliche** Schlüssel
(`VAPID_PUBLIC_KEY`) ist bereits im App-Code enthalten, das ist so
vorgesehen und unbedenklich.

## Wie der Ablauf funktioniert

1. Nutzer tippt auf das Glocken-Symbol im Header → Browser fragt nach
   Erlaubnis für Benachrichtigungen.
2. Bei Erlaubnis meldet sich die App beim Push-Dienst des Browsers an
   und schickt das Abo (eine technische Kennung, keine persönlichen
   Daten) zusammen mit der `session_id` an euren bestehenden
   Make.com-Webhook — als neues Feld `type: "push_subscription"`.
3. In Make.com müsst ihr diesen Fall (an `type` erkennbar) separat
   behandeln: das Abo zusammen mit der `session_id` in einer Tabelle/
   einem Datenspeicher ablegen (z. B. Google Sheets, Airtable, oder
   Make's eigener Datenspeicher), damit ihr später weißt, wen ihr
   benachrichtigen könnt.
4. Um tatsächlich eine Push-Nachricht zu senden: In Make.com ein
   HTTP-Modul einbauen, das die Netlify-Funktion aufruft:
   - URL: `https://gleeful-blini-3792f0.netlify.app/.netlify/functions/send-push`
   - Methode: POST
   - Body (JSON):
     ```json
     {
       "subscription": "<< das gespeicherte Abo des Nutzers >>",
       "title": "Nexus Pro",
       "body": "Deine Anfrage wurde bearbeitet."
     }
     ```

## iOS-Einschränkung (wichtig)

Push-Benachrichtigungen funktionieren auf dem iPhone nur:
- ab **iOS 16.4**
- wenn die App über **"Zum Home-Bildschirm hinzufügen"** installiert wurde
- NICHT im normalen Safari-Browser-Tab

Das ist eine Vorgabe von Apple selbst, keine technische Lücke in eurem
Code. Falls jemand die App nur im Browser offen hat, zeigt die App beim
Antippen der Glocke einen Hinweis, dass er sie erst zum Home-Bildschirm
hinzufügen muss.

## Testen

1. App zum Home-Bildschirm hinzufügen (auf einem echten iPhone, iOS 16.4+).
2. App öffnen, Glocke antippen, Erlaubnis geben.
3. In Make.com prüfen, ob der Webhook-Request mit `type: "push_subscription"`
   ankommt und das Abo enthält.
4. Testweise über Postman/Make.com die Netlify-Funktion mit dem
   gespeicherten Abo aufrufen und prüfen, ob die Benachrichtigung
   auf dem Handy ankommt (auch wenn die App geschlossen ist).
