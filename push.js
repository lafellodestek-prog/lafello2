// Telefon ve tarayici bildirimleri (Web Push). Anahtar cifti ilk acilista uretilir ve
// veritabaninda saklanir; boylece yedekten geri gelince eski abonelikler calismaya devam eder.
import webpush from 'web-push';
import * as db from './db.js';

let keys = db.vapidKeys();
if (!keys) {
  keys = webpush.generateVAPIDKeys();
  db.saveVapidKeys(keys);
}
webpush.setVapidDetails('mailto:lafellodestek@gmail.com', keys.publicKey, keys.privateKey);

export const publicKey = keys.publicKey;

// Bildirim metni abonenin diline gore secilir: payload { tr: {...}, en: {...}, url, tag }.
async function sendTo(subs, payload) {
  let sent = 0;
  for (let i = 0; i < subs.length; i += 100) {
    await Promise.all(
      subs.slice(i, i + 100).map(async (s) => {
        const text = payload[s.lang] || payload.tr;
        const body = JSON.stringify({ title: text.title, body: text.body, url: payload.url || '/', tag: payload.tag });
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 6 * 3600 });
          sent++;
        } catch (e) {
          // Abonelik artik gecersizse (uygulama silinmis, izin geri alinmis) listeden cikar.
          if (e.statusCode === 404 || e.statusCode === 410) db.removePushSub(s.endpoint);
        }
      }),
    );
  }
  return sent;
}

export const pushToUser = (userId, payload) => sendTo(db.pushSubsFor(userId), payload).catch(() => 0);
export const pushToAll = (payload) => sendTo(db.allPushSubs(), payload);
