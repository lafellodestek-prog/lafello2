// GameDistribution oyun katalogu: telefonda oynanabilecek oyunlar secilir ve 6 saat saklanir.
// Oyunlar kendi sunucularindan cerceve icinde acilir; oyun icindeki reklam geliri GameDistribution
// yayinci hesabina baglanir.

const CATEGORIES = ['Casual', 'Puzzle', 'Match-3', 'Racing & Driving', 'Sports', 'Agility', 'Boardgames', 'Dress-up'];
const BLOCKED = /casino|gambl|slot machine|poker|blackjack|roulette|horror|gore|zombie/i;
const KEYS_ONLY = /\b(wasd|arrow keys?|space ?bar|keyboard|ctrl|shift)\b/i;
const TOUCH = /\b(tap|touch|swipe|drag|click|mouse|finger)\b/i;
const CACHE_MS = 6 * 3600 * 1000;

let cache = { games: [], at: 0 };
let loading = null;

const catalogUrl = (cat) =>
  `https://catalog.api.gamedistribution.com/api/v2.0/rss/All/?collection=all&categories=${encodeURIComponent(cat)}&tags=All&subType=all&type=all&mobile=all&rewarded=all&amount=100&page=1&format=json`;

// Klavyesiz oynanabilir (dokunma/fare) ve uygunsuz icerik barindirmayan oyunlar.
function playable(g) {
  const text = `${g.Title} ${g.Description} ${(g.Tag || []).join(' ')} ${(g.Category || []).join(' ')}`;
  if (BLOCKED.test(text) || (g.Tag || []).some((t) => /^blood$/i.test(t))) return false;
  if (!g.Https || !g.Md5) return false;
  if (g.Mobile === 'true' || g.Mobile === true) return true;
  const how = g.Instructions || '';
  return TOUCH.test(how) || !KEYS_ONLY.test(how);
}

async function load() {
  // Katalog ayni anda gelen cok istegi bos donduruyor; kategoriler sirayla istenir.
  const lists = [];
  for (const cat of CATEGORIES) {
    let list = [];
    for (let tries = 0; tries < 2 && !list.length; tries++) {
      list = await fetch(catalogUrl(cat), { signal: AbortSignal.timeout(15000) })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []);
    }
    lists.push(list);
  }
  const seen = new Set();
  const games = [];
  lists.forEach((list, i) => {
    for (const g of Array.isArray(list) ? list : []) {
      if (seen.has(g.Md5) || !playable(g)) continue;
      seen.add(g.Md5);
      games.push({
        id: g.Md5,
        title: String(g.Title).slice(0, 60),
        cat: CATEGORIES[i],
        thumb: (g.Asset || []).find((a) => a.includes('512x384')) || g.Asset?.[0] || '',
        // Dikey oyunlar telefonda daha rahat oynanir; listede one alinir.
        portrait: Number(g.Height) >= Number(g.Width),
      });
    }
  });
  games.sort((a, b) => b.portrait - a.portrait);
  return games;
}

export async function gameList() {
  if (cache.games.length && Date.now() - cache.at < CACHE_MS) return cache.games;
  loading ||= load()
    .then((games) => {
      if (games.length) cache = { games, at: Date.now() };
      return cache.games;
    })
    .finally(() => (loading = null));
  return loading;
}

export const gameCategories = CATEGORIES;
