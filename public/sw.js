// Lafello hizmet calisani: uygulamanin telefona yuklenebilmesi icin gerekir.
// Canli yayin cevrim ici calistigi icin onbellek yalniz baglanti yokken gosterilecek sayfa icindir.
const CACHE = 'lafello-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Sayfa istekleri her zaman sunucuya gider; baglanti yoksa cevrim disi sayfasi gosterilir.
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});

// Telefon bildirimi: uygulama kapaliyken sunucudan gelir.
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data.json();
  } catch {}
  e.waitUntil(
    self.registration.showNotification(d.title || 'Lafello', {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/favicon-48.png',
      tag: d.tag,
      data: { url: d.url || '/' },
    }),
  );
});

// Bildirime dokununca acik uygulama one gelir ve ilgili yere gider; acik degilse yeni pencere acilir.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        open.postMessage({ open: url });
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
