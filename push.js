// Telefon ve tarayici bildirimleri.
// - Tarayici (Web Push): anahtar cifti ilk acilista uretilir ve veritabaninda saklanir; boylece
//   yedekten geri gelince eski abonelikler calismaya devam eder.
// - Android uygulamasi (Firebase): FCM_SERVICE_ACCOUNT ortam degiskenindeki hizmet hesabiyla gider.
import webpush from 'web-push';
import { createSign } from 'node:crypto';
import * as db from './db.js';

let keys = db.vapidKeys();
if (!keys) {
  keys = webpush.generateVAPIDKeys();
  db.saveVapidKeys(keys);
}
webpush.setVapidDetails('mailto:lafellodestek@gmail.com', keys.publicKey, keys.privateKey);

export const publicKey = keys.publicKey;

// ---------- Firebase ----------

let fcmAccount = null;
try {
  const raw = (process.env.FCM_SERVICE_ACCOUNT || '').trim();
  // Duz metin ya da base64 olarak verilebilir.
  if (raw) fcmAccount = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  if (fcmAccount && !(fcmAccount.client_email && fcmAccount.private_key && fcmAccount.project_id)) fcmAccount = null;
} catch {
  fcmAccount = null;
}
if (process.env.FCM_SERVICE_ACCOUNT && !fcmAccount) console.error('FCM_SERVICE_ACCOUNT okunamadi; Android bildirimleri kapali.');

export const fcmEnabled = () => !!fcmAccount;

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
let fcmToken = { value: null, until: 0 };

// Hizmet hesabiyla imzali istekten bir saatlik erisim anahtari alinir ve saklanir.
async function fcmAccess() {
  if (fcmToken.value && fcmToken.until > Date.now()) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: fcmAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(fcmAccount.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('fcm auth');
  fcmToken = { value: data.access_token, until: Date.now() + (data.expires_in - 300) * 1000 };
  return fcmToken.value;
}

async function sendFcm(t, msg) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${fcmAccount.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await fcmAccess()}`, 'Content-Type': 'application/json' },
    // Yalniz veri gonderilir; bildirimi uygulama kendisi gosterir ve dokununca ilgili yere gider.
    body: JSON.stringify({ message: { token: t.token, data: msg, android: { priority: 'high', ttl: '21600s' } } }),
  });
  if (res.ok) return true;
  // Uygulama silinmis ya da anahtar gecersizse listeden cikar.
  if (res.status === 404 || res.status === 400) db.removeFcmToken(t.token);
  return false;
}

// ---------- Gonderim ----------

// Bildirim metni abonenin diline gore secilir: payload { tr: {...}, en: {...}, url, tag }.
const textFor = (payload, lang) => payload[lang] || payload.tr;

async function sendTo(subs, tokens, payload) {
  let sent = 0;
  for (let i = 0; i < subs.length; i += 100) {
    await Promise.all(
      subs.slice(i, i + 100).map(async (s) => {
        const text = textFor(payload, s.lang);
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
  if (!fcmAccount) return sent;
  for (let i = 0; i < tokens.length; i += 100) {
    await Promise.all(
      tokens.slice(i, i + 100).map(async (t) => {
        const text = textFor(payload, t.lang);
        try {
          if (await sendFcm(t, { title: text.title, body: text.body, url: payload.url || '/', tag: payload.tag || '' })) sent++;
        } catch {}
      }),
    );
  }
  return sent;
}

export const pushToUser = (userId, payload) => sendTo(db.pushSubsFor(userId), db.fcmTokensFor(userId), payload).catch(() => 0);
export const pushToAll = (payload) => sendTo(db.allPushSubs(), db.allFcmTokens(), payload);
