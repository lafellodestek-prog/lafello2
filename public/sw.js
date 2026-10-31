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
