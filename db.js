// Kalici veri: kullanicilar, oturumlar, hediye ve satin alma kayitlari, sikayetler.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_SHARE, SIGNUP_BONUS } from './config.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.DB_PATH || path.join(dataDir, 'sahne.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass TEXT NOT NULL,
    salt TEXT NOT NULL,
    coins INTEGER NOT NULL DEFAULT 0,
    diamonds10 INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gifts (
    id INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    gift TEXT NOT NULL,
    coins INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    pack TEXT NOT NULL,
    coins INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dms (
    id INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS dms_pair ON dms (from_id, to_id, id);
  CREATE INDEX IF NOT EXISTS dms_to ON dms (to_id, read);
  CREATE TABLE IF NOT EXISTS blocks (
    user_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
  );
`);

// Sonradan eklenen sutunlar: eski veritabanlarina da eklenir.
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('users', 'banned', 'INTEGER NOT NULL DEFAULT 0');
addColumn('reports', 'status', "TEXT NOT NULL DEFAULT 'open'");
addColumn('users', 'is_bot', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'bot_style', 'TEXT');
addColumn('users', 'bot_active', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'avatar', 'TEXT');
addColumn('users', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'demo_pass', 'TEXT');

// Bot ozelligi kaldirildi; onceki surumden kalan bot hesaplari silinir.
db.exec('DELETE FROM users WHERE is_bot = 1');

const q = {
  insertUser: db.prepare('INSERT INTO users (name, pass, salt, coins, created_at) VALUES (?, ?, ?, ?, ?)'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE name = ?'),
  userByToken: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.banned = 0'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  spend: db.prepare('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?'),
  addCoins: db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?'),
  addDiamonds: db.prepare('UPDATE users SET diamonds10 = diamonds10 + ? WHERE id = ?'),
  insertGift: db.prepare('INSERT INTO gifts (from_id, to_id, gift, coins, at) VALUES (?, ?, ?, ?, ?)'),
  insertPurchase: db.prepare('INSERT INTO purchases (user_id, pack, coins, at) VALUES (?, ?, ?, ?)'),
  insertReport: db.prepare('INSERT INTO reports (from_id, target_id, reason, at) VALUES (?, ?, ?, ?)'),
};

const hash = (pass, salt) => scryptSync(pass, salt, 64).toString('hex');

export function publicUser(u) {
  return u && { id: u.id, name: u.name, coins: u.coins, diamonds: u.diamonds10 / 10 };
}

export function validateNew(name, pass) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_.]{3,20}$/u.test(name.trim())) return 'name';
  if (typeof pass !== 'string' || pass.length < 6 || pass.length > 100) return 'pass';
  return null;
}

export function createUser(name, pass) {
  const salt = randomBytes(16).toString('hex');
  const { lastInsertRowid } = q.insertUser.run(name, hash(pass, salt), salt, SIGNUP_BONUS, Date.now());
  return getUser(Number(lastInsertRowid));
}

export function checkLogin(name, pass) {
  const u = typeof name === 'string' && q.userByName.get(name.trim());
  if (!u || u.is_bot || typeof pass !== 'string') return null;
  const ok = timingSafeEqual(Buffer.from(hash(pass, u.salt), 'hex'), Buffer.from(u.pass, 'hex'));
  if (!ok) return null;
  return u.banned ? { banned: true } : publicUser(u);
}

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  q.insertSession.run(token, userId, Date.now());
  return token;
}

export const deleteSession = (token) => q.deleteSession.run(token);
export const getUser = (id) => publicUser(q.userById.get(id));
export const userByToken = (token) => (typeof token === 'string' && token ? publicUser(q.userByToken.get(token)) : null);

// Odeme baglanana kadar paketler dogrudan hesaba eklenir.
export function buyCoins(userId, pack) {
  q.addCoins.run(pack.coins, userId);
  q.insertPurchase.run(userId, pack.id, pack.coins, Date.now());
  return getUser(userId);
}

// Jetonu gonderenden duser, yayinciya elmas olarak payini ekler. Bakiye yetmezse null.
export function sendGift(fromId, toId, gift) {
  db.exec('BEGIN');
  try {
    if (q.spend.run(gift.coins, fromId, gift.coins).changes !== 1) {
      db.exec('ROLLBACK');
      return null;
    }
    q.addDiamonds.run(Math.round(gift.coins * HOST_SHARE * 10), toId);
    q.insertGift.run(fromId, toId, gift.id, gift.coins, Date.now());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { from: getUser(fromId), to: getUser(toId) };
}

export function addReport(fromId, targetId, reason) {
  q.insertReport.run(fromId, targetId, String(reason).slice(0, 300), Date.now());
}

// ---------- Ozel mesajlar ve engelleme ----------

// Mesajlasilabilecek gercek ve acik bir hesap (bot ya da kapali hesap degil).
export function dmTarget(name) {
  const u = typeof name === 'string' && q.userByName.get(name.trim());
  return u && !u.is_bot && !u.banned ? { id: u.id, name: u.name } : null;
}

export function isBlocked(a, b) {
  return !!db.prepare('SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)').get(a, b, b, a);
}

export const hasBlocked = (userId, otherId) => !!db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(userId, otherId);

export function setBlock(userId, otherId, blocked) {
  if (blocked) db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)').run(userId, otherId);
  else db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(userId, otherId);
}

export function sendDm(fromId, toId, text) {
  const at = Date.now();
  const { lastInsertRowid } = db.prepare('INSERT INTO dms (from_id, to_id, text, at) VALUES (?, ?, ?, ?)').run(fromId, toId, text, at);
  return { id: Number(lastInsertRowid), fromId, toId, text, at };
}

// Her konusma icin son mesaj ve okunmamis sayisi; en yeni konusma once.
export function listConversations(userId) {
  return db
    .prepare(
      `SELECT other, u.name, m.text, m.at, m.from_id = ? AS mine,
              (SELECT COUNT(*) FROM dms WHERE from_id = other AND to_id = ? AND read = 0) AS unread
       FROM (SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS other, MAX(id) AS last
             FROM dms WHERE from_id = ? OR to_id = ? GROUP BY other) c
       JOIN dms m ON m.id = c.last JOIN users u ON u.id = c.other
       ORDER BY m.id DESC LIMIT 100`,
    )
    .all(userId, userId, userId, userId, userId)
    .map((c) => ({ name: c.name, text: c.text, at: c.at, mine: !!c.mine, unread: c.unread }));
}

export function getThread(userId, otherId) {
  return db
    .prepare(
      `SELECT * FROM (SELECT id, from_id = ? AS mine, text, at FROM dms
         WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY id DESC LIMIT 200)
       ORDER BY id`,
    )
    .all(userId, userId, otherId, otherId, userId)
    .map((m) => ({ ...m, mine: !!m.mine }));
}

export function markRead(userId, otherId) {
  db.prepare('UPDATE dms SET read = 1 WHERE to_id = ? AND from_id = ? AND read = 0').run(userId, otherId);
}

export const unreadTotal = (userId) => db.prepare('SELECT COUNT(*) AS n FROM dms WHERE to_id = ? AND read = 0').get(userId).n;

// ---------- Yonetim paneli ----------

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

export const hasAdminPassword = () => getSetting('admin_pass') !== null;

export function setAdminPassword(pass) {
  const salt = randomBytes(16).toString('hex');
  setSetting('admin_pass', `${salt}:${hash(pass, salt)}`);
}

export function checkAdminPassword(pass) {
  const stored = getSetting('admin_pass');
  if (!stored || typeof pass !== 'string') return false;
  const [salt, h] = stored.split(':');
  return timingSafeEqual(Buffer.from(hash(pass, salt), 'hex'), Buffer.from(h, 'hex'));
}

// Deneme hesaplarinin hareketleri istatistiklere karismasin.
const REAL = (col) => `${col} NOT IN (SELECT id FROM users WHERE is_demo = 1)`;

export function adminStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = today.getTime();
  const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args))[0] ?? 0;
  return {
    users: one('SELECT COUNT(*) FROM users WHERE is_bot = 0 AND is_demo = 0'),
    usersToday: one('SELECT COUNT(*) FROM users WHERE is_bot = 0 AND is_demo = 0 AND created_at >= ?', since),
    coinsSold: one(`SELECT COALESCE(SUM(coins), 0) FROM purchases WHERE ${REAL('user_id')}`),
    coinsSoldToday: one(`SELECT COALESCE(SUM(coins), 0) FROM purchases WHERE ${REAL('user_id')} AND at >= ?`, since),
    giftCoins: one(`SELECT COALESCE(SUM(coins), 0) FROM gifts WHERE ${REAL('from_id')}`),
    giftCoinsToday: one(`SELECT COALESCE(SUM(coins), 0) FROM gifts WHERE ${REAL('from_id')} AND at >= ?`, since),
    giftsToday: one(`SELECT COUNT(*) FROM gifts WHERE ${REAL('from_id')} AND at >= ?`, since),
    demoUsers: one('SELECT COUNT(*) FROM users WHERE is_demo = 1'),
    openReports: one("SELECT COUNT(*) FROM reports WHERE status = 'open'"),
    banned: one('SELECT COUNT(*) FROM users WHERE banned = 1'),
  };
}

export function listReports(status) {
  return db
    .prepare(
      `SELECT r.id, r.reason, r.at, r.status, r.target_id AS targetId,
              f.name AS fromName, t.name AS targetName, t.banned AS targetBanned,
              (SELECT COUNT(*) FROM reports x WHERE x.target_id = r.target_id) AS targetReports
       FROM reports r JOIN users f ON f.id = r.from_id JOIN users t ON t.id = r.target_id
       WHERE r.status = ? ORDER BY r.at DESC LIMIT 200`,
    )
    .all(status);
}

export function resolveReports(ids) {
  const stmt = db.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?");
  for (const id of ids) stmt.run(id);
}

export function resolveReportsForTarget(targetId) {
  db.prepare("UPDATE reports SET status = 'resolved' WHERE target_id = ? AND status = 'open'").run(targetId);
}

export function setBanned(userId, banned) {
  db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, userId);
  if (banned) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Panelde tum hesaplar: en yeni once, isimle arama, sayfa basina 50.
export function listUsers(search, page) {
  const like = `%${String(search || '').trim()}%`;
  const limit = 50;
  const offset = Math.max(0, page | 0) * limit;
  const where = 'WHERE u.is_bot = 0 AND u.name LIKE ?';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).get(like).n;
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.coins, u.diamonds10, u.banned, u.is_demo AS demo, u.created_at AS createdAt,
              (SELECT COALESCE(SUM(coins), 0) FROM purchases WHERE user_id = u.id) AS bought,
              (SELECT COALESCE(SUM(coins), 0) FROM gifts WHERE from_id = u.id) AS spent,
              (SELECT COALESCE(SUM(coins), 0) FROM gifts WHERE to_id = u.id) AS received,
              (SELECT COUNT(*) FROM reports WHERE target_id = u.id) AS reports
       FROM users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    )
    .all(like, limit, offset)
    .map((u) => ({ ...u, diamonds: u.diamonds10 / 10, diamonds10: undefined, banned: !!u.banned, demo: !!u.demo }));
  return { total, page: Math.max(0, page | 0), pages: Math.max(1, Math.ceil(total / limit)), users: rows };
}

// Yonetici elle jeton ekler ya da duser; bakiye sifirin altina inmez.
export function adjustCoins(userId, amount) {
  db.prepare('UPDATE users SET coins = MAX(0, coins + ?) WHERE id = ? AND is_bot = 0').run(amount, userId);
  return getUser(userId);
}

export function listBanned() {
  return db.prepare('SELECT id, name FROM users WHERE banned = 1 ORDER BY name').all();
}

// ---------- Deneme hesaplari ----------
// Yonetici panelden acar; sifreleri panelde gorunsun diye acik olarak da saklanir.
// Kendiliginden bir sey yapmazlar, arkalarinda hep onlari kullanan bir insan olur.

const DEMO_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

export function createDemoUsers(count, coins) {
  const created = [];
  let n = 1;
  for (let k = 0; k < count; k++) {
    while (q.userByName.get(`demo${n}`)) n++;
    const pass = Array.from({ length: 8 }, () => DEMO_CHARS[randomBytes(1)[0] % DEMO_CHARS.length]).join('');
    const salt = randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users (name, pass, salt, coins, created_at, is_demo, demo_pass) VALUES (?, ?, ?, ?, ?, 1, ?)').run(`demo${n}`, hash(pass, salt), salt, coins, Date.now(), pass);
    created.push(`demo${n}`);
  }
  return created;
}

export function listDemoUsers() {
  return db.prepare('SELECT id, name, demo_pass AS pass, coins, banned, created_at AS createdAt FROM users WHERE is_demo = 1 ORDER BY id').all().map((u) => ({ ...u, banned: !!u.banned }));
}

export function deleteDemoUser(id) {
  const u = db.prepare('SELECT id FROM users WHERE id = ? AND is_demo = 1').get(id);
  if (!u) return false;
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM dms WHERE from_id = ? OR to_id = ?').run(id, id);
  db.prepare('DELETE FROM blocks WHERE user_id = ? OR blocked_id = ?').run(id, id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return true;
}

// ---------- Yedekleme ----------

// Bu baglantinin acilistan beri yaptigi toplam degisiklik; yedek gerekip gerekmedigini anlamak icin.
export const totalChanges = () => db.prepare('SELECT total_changes() AS n').get().n;

// Veritabaninin tutarli bir kopyasini verilen dosyaya yazar.
export function snapshot(file) {
  rmSync(file, { force: true });
  db.prepare('VACUUM INTO ?').run(file);
}
