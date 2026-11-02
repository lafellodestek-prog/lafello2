// Hediye katalogu, jeton paketleri ve oyun kurallari. Istemci bunlari /api/config ile alir.

export const GIFTS = [
  { id: 'rose', emoji: '🌹', coins: 1 },
  { id: 'heart', emoji: '💖', coins: 10 },
  { id: 'star', emoji: '⭐', coins: 50 },
  { id: 'crown', emoji: '👑', coins: 199 },
  { id: 'rocket', emoji: '🚀', coins: 499 },
  { id: 'castle', emoji: '🏰', coins: 1999 },
];

// Fiyatlar ornek. Gercek odeme baglanana kadar satin alma deneme modunda calisir.
export const PACKS = [
  { id: 'p100', coins: 100, usd: '0.99', try: '39,99' },
  { id: 'p550', coins: 550, usd: '4.99', try: '199,99' },
  { id: 'p1200', coins: 1200, usd: '9.99', try: '399,99' },
  { id: 'p6500', coins: 6500, usd: '49.99', try: '1.999,99' },
];

// Yayincinin hediyeden aldigi pay (elmas olarak). Kalan kisim platformda kalir.
export const HOST_SHARE = 0.6;

export const PK_SECONDS = 180;
export const VOICE_SEATS = 8;
export const SIGNUP_BONUS = 50;

// Odullu reklam: izleyen kullanici jeton kazanir (gunde en fazla AD_DAILY kez).
export const AD_REWARD = 10;
export const AD_DAILY = 5;

// Google ile giris icin web istemci kimligi (gizli degildir, sayfada zaten gorunur).
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
