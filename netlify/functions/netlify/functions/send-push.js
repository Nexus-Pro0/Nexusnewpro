// netlify/functions/send-push.js
//
// Zweck: Make.com (oder ein anderer Dienst) ruft diese Funktion per HTTP-POST
// auf, um eine Push-Benachrichtigung an einen bestimmten Nutzer zu schicken.
//
// Erwarteter Request-Body (JSON):
// {
//   "subscription": { ... },   // Der gespeicherte Push-Subscription-Datensatz des Nutzers
//   "title": "Nexus Pro",
//   "body": "Deine Anfrage wurde bearbeitet.",
//   "url": "/"                 // optional: welche Seite beim Antippen geöffnet wird
// }
//
// Benötigt zwei Umgebungsvariablen bei Netlify (Project configuration ->
// Environment variables): VAPID_PUBLIC_KEY und VAPID_PRIVATE_KEY.

const webpush = require('web-push');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { subscription, title, body, url } = payload;

  if (!subscription || !subscription.endpoint) {
    return { statusCode: 400, body: 'Missing "subscription" in request body' };
  }

  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

  if (!vapidPublicKey || !vapidPrivateKey) {
    return { statusCode: 500, body: 'VAPID keys not configured on the server' };
  }

  webpush.setVapidDetails(
    'mailto:kontakt@example.com', // ggf. durch eure echte Kontakt-Adresse ersetzen
    vapidPublicKey,
    vapidPrivateKey
  );

  const notificationPayload = JSON.stringify({
    title: title || 'Nexus Pro',
    body: body || '',
    url: url || '/'
  });

  try {
    await webpush.sendNotification(subscription, notificationPayload);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('Push send failed:', err);
    return {
      statusCode: err.statusCode || 500,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
