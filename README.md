# Lafello: canlı yayın uygulaması (ilk sürüm)

Bigo / TikTok Live tarzı, internet sitesi olarak çalışan canlı yayın uygulaması.

## Özellikler
- Hesap açma ve giriş (18 yaş onayı ile), Türkçe / İngilizce arayüz
- Görüntülü canlı yayın ve canlı sohbet
- Jeton cüzdanı ve 6 çeşit hediye (gül, kalp, yıldız, taç, roket, şato) ile animasyonlar
- Yayıncı hediyenin %60'ını elmas olarak kazanır (`config.js` içinden değiştirilebilir)
- PK: iki yayıncı 3 dakika yarışır, hediye puanı yüksek olan kazanır
- Sesli oda: 8 koltuk, oturan herkes konuşur, koltuktaki kişiye hediye atılabilir
- Odada en çok hediye atan 3 kişi, yayıncının izleyiciyi çıkarması, şikayet sistemi
- Yazılı sohbet odası, özel mesaj ve engelleme
- Yönetim paneli (`/admin`): genel durum, canlı yayınlar, kullanıcılar, şikayetler, kapatılan hesaplar ve
  deneme hesapları (test için tek tıkla açılıp silinen, istatistiklere sayılmayan hesaplar)

## Araçlar
- Node.js 22.13+ (yerleşik SQLite), Express, Socket.IO
- Görüntü ve ses tarayıcılar arasında doğrudan WebRTC ile akar
- Arayüz: tek sayfa, saf HTML/CSS/JS (`public/`)

## Çalıştırma
```
npm install
npm start
```
Sonra `http://localhost:3000` açılır. Kamera bulunmazsa uygulama hareketli bir deneme görüntüsü kullanır.

## Bu sürümün sınırları (canlıya almadan önce yapılacaklar)
1. **Ödeme:** Jeton satın alma deneme modunda, para alınmıyor. iyzico / Stripe bağlanacak.
2. **Görüntü altyapısı:** Yayıncı her izleyiciye ayrı bağlantı açıyor. 10-20 izleyiciye kadar iyi çalışır.
   Daha fazlası için LiveKit / ZEGOCLOUD gibi bir görüntü hizmetine geçilmeli. Farklı ağlardaki kullanıcılar için TURN sunucusu gerekir.
3. **Güvenli bağlantı:** Kamera başka cihazlarda yalnız https ile açılır; canlıya alırken https gerekir.
4. **Denetim:** Şikayetler veritabanına yazılıyor, bakacak bir yönetim ekranı henüz yok.
5. **Para çekme:** Elmasların paraya çevrilmesi henüz yok.
6. Odalar sunucu belleğinde tutulur; sunucu yeniden başlarsa açık yayınlar kapanır.
