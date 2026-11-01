// Lafello sunucusu: hesap islemleri, canli oda yonetimi, sohbet, hediye, PK ve sesli oda.
// Goruntu ve ses tarayicilar arasinda dogrudan (WebRTC) akar; sunucu yalnizca baglanti mesajlarini tasir.
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as db from './db.js';
import * as push from './push.js';
import { gameList, gameCategories } from './games.js';
import { attachArena, arenaSocket, arenaDisconnect } from './arena.js';
import { GIFTS, PACKS, HOST_SHARE, PK_SECONDS, VOICE_SEATS, AD_REWARD, AD_DAILY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

app.use(express.json({ limit: '10kb' }));
// extensions: /gizlilik gibi adresler gizlilik.html sayfasini acar.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function auth(req, res, next) {
  const user = db.userByToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!user) return res.status(401).json({ error: 'auth' });
  req.user = user;
  req.token = req.headers.authorization.slice(7);
  next();
}

app.get('/api/config', (req, res) => {
  res.json({ gifts: GIFTS, packs: PACKS, hostShare: HOST_SHARE, pkSeconds: PK_SECONDS, voiceSeats: VOICE_SEATS });
});

app.post('/api/register', (req, res) => {
  const { name, pass, adult } = req.body || {};
  const err = db.validateNew(name, pass);
  if (err) return res.status(400).json({ error: err });
  if (adult !== true) return res.status(400).json({ error: 'adult' });
  try {
    const user = db.createUser(name.trim(), pass);
    res.json({ token: db.createSession(user.id), user });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'taken' });
    throw e;
  }
});

app.post('/api/login', (req, res) => {
  const user = db.checkLogin(req.body?.name, req.body?.pass);
  if (!user) return res.status(400).json({ error: 'login' });
  if (user.banned) return res.status(403).json({ error: 'banned' });
  res.json({ token: db.createSession(user.id), user });
});

app.post('/api/logout', auth, (req, res) => {
  db.deleteSession(req.token);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// Kullanici kendi hesabini siler (Google Play zorunlulugu). Sifre tekrar sorulur.
app.post('/api/account/delete', auth, (req, res) => {
  const check = db.checkLogin(req.user.name, req.body?.pass);
  if (!check || check.banned) return res.status(400).json({ error: 'pass' });
  closeConnections(req.user.id);
  db.deleteUserData(req.user.id);
  res.json({ ok: true });
});

app.post('/api/buy', auth, (req, res) => {
  const pack = PACKS.find((p) => p.id === req.body?.pack);
  if (!pack) return res.status(400).json({ error: 'pack' });
  const user = db.buyCoins(req.user.id, pack);
  pushWallet(user);
  res.json({ user });
});

app.get('/api/rooms', (req, res) => res.json({ rooms: roomList() }));

app.get('/api/games', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=600');
  res.json({ games: await gameList(), cats: gameCategories });
});

// ---------- Ozel mesajlar ----------

function emitToUser(userId, event, payload) {
  for (const id of userSockets.get(userId) || []) io.to(id).emit(event, payload);
}

app.get('/api/dm', auth, (req, res) => {
  res.json({ conversations: db.listConversations(req.user.id), unread: db.unreadTotal(req.user.id) });
});

app.get('/api/dm/:name', auth, (req, res) => {
  const other = db.dmTarget(req.params.name);
  if (!other) return res.status(404).json({ error: 'nouser' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'self' });
  db.markRead(req.user.id, other.id);
  emitToUser(req.user.id, 'dm:unread', db.unreadTotal(req.user.id));
  res.json({
    user: other,
    messages: db.getThread(req.user.id, other.id),
    iBlocked: db.hasBlocked(req.user.id, other.id),
    blocked: db.isBlocked(req.user.id, other.id),
  });
});

const lastDm = new Map();
// ---------- Bildirimler ----------

app.get('/api/push/key', (req, res) => res.json({ key: push.publicKey, fcm: push.fcmEnabled() }));

app.post('/api/push/fcm', auth, (req, res) => {
  const token = req.body?.token;
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return res.status(400).json({ error: 'token' });
  db.addFcmToken(req.user.id, token, req.body?.lang);
  res.json({ ok: true });
});

app.post('/api/push/fcm/remove', auth, (req, res) => {
  if (db.fcmTokensFor(req.user.id).some((t) => t.token === req.body?.token)) db.removeFcmToken(req.body.token);
  res.json({ ok: true });
});

app.post('/api/push/subscribe', auth, (req, res) => {
  const sub = req.body?.sub;
  if (typeof sub?.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string')
    return res.status(400).json({ error: 'sub' });
  db.addPushSub(req.user.id, sub, req.body?.lang);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', auth, (req, res) => {
  const mine = db.pushSubsFor(req.user.id).find((x) => x.endpoint === req.body?.endpoint);
  if (mine) db.removePushSub(mine.endpoint);
  res.json({ ok: true });
});

// Uygulamasi onunde olmayan kullaniciya telefon bildirimi gider (onunde olana uygulama icinde gosterilir).
// Arka plana alinan uygulama baglantisini bir sure korur; bu yuzden "away" bilgisine de bakilir.
function notifyIfAway(userId, payload) {
  const here = [...(userSockets.get(userId) || [])].some((id) => sock(id) && !sock(id).data.away);
  if (!here) push.pushToUser(userId, payload);
}

app.post('/api/dm/:name', auth, (req, res) => {
  const other = db.dmTarget(req.params.name);
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!other) return res.status(404).json({ error: 'nouser' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'self' });
  if (!text) return res.status(400).json({ error: 'text' });
  if (db.isBlocked(req.user.id, other.id)) return res.status(403).json({ error: 'blocked' });
  if (Date.now() - (lastDm.get(req.user.id) || 0) < 300) return res.status(429).json({ error: 'slow' });
  lastDm.set(req.user.id, Date.now());
  const m = db.sendDm(req.user.id, other.id, text);
  emitToUser(other.id, 'dm', { from: req.user.name, text: m.text, at: m.at, id: m.id });
  notifyIfAway(other.id, {
    tr: { title: `${req.user.name} sana mesaj gönderdi`, body: m.text.slice(0, 120) },
    en: { title: `${req.user.name} sent you a message`, body: m.text.slice(0, 120) },
    url: `/?dm=${encodeURIComponent(req.user.name)}`,
    tag: `dm-${req.user.name}`,
  });
  emitToUser(other.id, 'dm:unread', db.unreadTotal(other.id));
  emitToUser(req.user.id, 'dm:sent', { to: other.name, text: m.text, at: m.at, id: m.id });
  res.json({ message: { id: m.id, mine: true, text: m.text, at: m.at } });
});

// ---------- Profil ve takip ----------

app.get('/api/u/:name/avatar', (req, res) => {
  const a = db.getAvatar(req.params.name);
  // Fotografi olmayanlarda istemci bas harfi gosterir; bos cevap kisa sure onbellekte tutulur.
  if (!a) return res.set('Cache-Control', 'public, max-age=120').status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' }).send(Buffer.from(a.img));
});

app.get('/api/u/:name', auth, (req, res) => {
  const p = db.getProfile(req.params.name, req.user.id);
  if (!p) return res.status(404).json({ error: 'nouser' });
  const live = [...rooms.values()].find((r) => r.hostId === p.id);
  const u = db.getUser(p.id);
  res.json({
    profile: {
      ...p,
      id: undefined,
      me: p.id === req.user.id,
      live: live ? { id: live.id, title: live.title, type: live.type } : null,
      level: u.level,
      xp: u.xp,
      levelFrom: u.levelFrom,
      levelTo: u.levelTo,
    },
  });
});

app.post('/api/u/:name/follow', auth, (req, res) => {
  const p = db.getProfile(req.params.name, req.user.id);
  if (!p || p.id === req.user.id) return res.status(400).json({ error: 'nouser' });
  db.setFollow(req.user.id, p.id, req.body?.follow !== false);
  res.json({ profile: { ...db.getProfile(req.params.name, req.user.id), id: undefined } });
});

app.get('/api/leaderboard', auth, (req, res) => {
  res.json(db.leaderboard(req.query.period === 'week' ? 'week' : 'day'));
});

app.get('/api/daily', auth, (req, res) => res.json(db.dailyStatus(req.user.id)));

app.post('/api/daily/claim', auth, (req, res) => {
  const r = db.claimDaily(req.user.id);
  if (!r) return res.status(400).json({ error: 'claimed' });
  pushWallet(r.user);
  res.json(r);
});

// ---------- Odullu reklam (Android uygulamasi) ----------
// Reklam baslarken tek kullanimlik bir bilet alinir; reklam bitince bilet en erken 10 saniye sonra
// jetona cevrilir. Gunluk sinir ve bilet sayesinde sahte isteklerle sinirsiz jeton alinamaz.
const adTickets = new Map(); // bilet -> { userId, at }

app.get('/api/ads', auth, (req, res) => res.json({ left: db.adsLeft(req.user.id, AD_DAILY), reward: AD_REWARD, daily: AD_DAILY }));

app.post('/api/ads/start', auth, (req, res) => {
  if (db.adsLeft(req.user.id, AD_DAILY) <= 0) return res.status(400).json({ error: 'limit' });
  for (const [k, v] of adTickets) if (v.userId === req.user.id || Date.now() - v.at > 10 * 60 * 1000) adTickets.delete(k);
  const ticket = randomBytes(12).toString('hex');
  adTickets.set(ticket, { userId: req.user.id, at: Date.now() });
  res.json({ ticket });
});

app.post('/api/ads/claim', auth, (req, res) => {
  const t = adTickets.get(String(req.body?.ticket || ''));
  if (!t || t.userId !== req.user.id || Date.now() - t.at < 10000) return res.status(400).json({ error: 'ticket' });
  adTickets.delete(String(req.body.ticket));
  const user = db.claimAdReward(req.user.id, AD_REWARD, AD_DAILY);
  if (!user) return res.status(400).json({ error: 'limit' });
  pushWallet(user);
  res.json({ reward: AD_REWARD, left: db.adsLeft(req.user.id, AD_DAILY), user });
});

app.get('/api/following', auth, (req, res) => res.json({ names: db.followingNames(req.user.id) }));

app.post('/api/me/bio', auth, (req, res) => {
  db.setBio(req.user.id, req.body?.bio);
  res.json({ ok: true });
});

// Profil fotografi: istemci 256x256 JPEG'e kucultup ham olarak gonderir (en fazla 300 KB).
app.post('/api/me/avatar', auth, express.raw({ type: 'image/jpeg', limit: '300kb' }), (req, res) => {
  const buf = req.body;
  // JPEG dosyalari FF D8 baytlariyla baslar; baska bir sey kabul edilmez.
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'image' });
  res.json({ version: db.setAvatar(req.user.id, buf) });
});

// ---------- Baglanti yardimcisi (TURN) ----------
// Farkli aglardaki (ozellikle mobil internet) cihazlarin goruntu baglantisi icin aktarma sunuculari.
// Cloudflare anahtari varsa gecici kimlik bilgisi uretilir; yoksa TURN_URLS ile sabit sunucu kullanilir.
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
let iceCache = { at: 0, servers: null };

async function iceServers() {
  if (iceCache.servers && Date.now() - iceCache.at < 6 * 3600 * 1000) return iceCache.servers;
  let extra = [];
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (r.ok) extra = (await r.json()).iceServers || [];
      else console.error('TURN bilgisi alinamadi:', r.status);
    } catch (e) {
      console.error('TURN bilgisi alinamadi:', e.message);
    }
  } else if (process.env.TURN_URLS) {
    extra = [{ urls: process.env.TURN_URLS.split(',').map((u) => u.trim()), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }];
  }
  iceCache = { at: Date.now(), servers: [...STUN, ...extra] };
  return iceCache.servers;
}

app.get('/api/ice', auth, async (req, res) => res.json({ iceServers: await iceServers() }));

// Aktarma hizmetinin calisip calismadigini gosterir (gizli bilgi icermez).
app.get('/api/turn-status', async (req, res) => {
  const servers = await iceServers();
  res.json({ turn: servers.some((x) => [].concat(x.urls).some((u) => String(u).startsWith('turn'))) });
});

app.post('/api/block/:name', auth, (req, res) => {
  const other = db.dmTarget(req.params.name);
  if (!other || other.id === req.user.id) return res.status(404).json({ error: 'nouser' });
  db.setBlock(req.user.id, other.id, req.body?.blocked !== false);
  res.json({ iBlocked: db.hasBlocked(req.user.id, other.id) });
});

// ---------- Canli odalar (bellekte) ----------

const rooms = new Map();
const userSockets = new Map(); // userId -> Set<socketId>
let nextRoomId = 1;

const rk = (id) => `room:${id}`;
const sock = (id) => io.sockets.sockets.get(id);

function pushWallet(user) {
  for (const id of userSockets.get(user.id) || []) io.to(id).emit('wallet', user);
}

function pkSide(r) {
  return { roomId: r.id, hostSocket: r.hostSocket, hostName: r.hostName, title: r.title };
}

function pkState(pk) {
  const a = rooms.get(pk.a);
  const b = rooms.get(pk.b);
  return { a: pkSide(a), b: pkSide(b), scores: pk.scores, endsIn: Math.max(0, pk.endsAt - Date.now()) };
}

// Odadaki diger kisi sayisi (ev sahibi haric). Demo odada deneme hesaplari da sayilir.
const othersIn = (r) => Math.max(0, r.members.size - 1 + (r.demo ? r.demoCount : 0));

function topList(r) {
  return [...r.top.values()].sort((x, y) => y.coins - x.coins).slice(0, 3);
}

function roomState(r) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    hostId: r.hostId,
    hostName: r.hostName,
    hostSocket: r.hostSocket,
    demo: !!r.demo,
    count: othersIn(r),
    pk: r.pk ? pkState(r.pk) : null,
    seats: r.seats,
    top: topList(r),
  };
}

function roomList() {
  return [...rooms.values()].map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    hostName: r.hostName,
    count: othersIn(r),
    inPk: !!r.pk,
    demo: !!r.demo,
    speakers: r.seats ? r.seats.filter(Boolean).length : 0,
  }));
}

const broadcastRooms = () => io.emit('rooms', roomList());

function emitBoth(r, event, payload) {
  io.to(rk(r.id)).emit(event, payload);
  if (r.pk) {
    const other = rooms.get(r.pk.a === r.id ? r.pk.b : r.pk.a);
    if (other) io.to(rk(other.id)).emit(event, payload);
  }
}

function systemChat(r, key, name) {
  io.to(rk(r.id)).emit('chat', { system: key, name });
}

function startPk(a, b) {
  const pk = { a: a.id, b: b.id, scores: { [a.id]: 0, [b.id]: 0 }, endsAt: Date.now() + PK_SECONDS * 1000 };
  pk.timer = setTimeout(() => endPk(pk), PK_SECONDS * 1000);
  a.pk = b.pk = pk;
  emitBoth(a, 'pk:start', pkState(pk));
  broadcastRooms();
}

function endPk(pk) {
  clearTimeout(pk.timer);
  const { a, b, scores } = pk;
  const winner = scores[a] === scores[b] ? null : scores[a] > scores[b] ? a : b;
  for (const id of [a, b]) {
    const r = rooms.get(id);
    if (r && r.pk === pk) {
      r.pk = null;
      io.to(rk(id)).emit('pk:end', { scores, winner });
    }
  }
  broadcastRooms();
}

function endRoom(r, byAdmin = false) {
  if (r.pk) endPk(r.pk);
  io.to(rk(r.id)).emit('room:ended', { byAdmin });
  for (const id of r.members) {
    const s = sock(id);
    if (s) {
      s.leave(rk(r.id));
      s.data.roomId = null;
    }
  }
  rooms.delete(r.id);
  broadcastRooms();
}

function leaveRoom(socket) {
  const r = rooms.get(socket.data.roomId);
  socket.data.roomId = null;
  if (!r) return;
  socket.leave(rk(r.id));
  r.members.delete(socket.id);
  io.emit('peer:left', { socketId: socket.id });
  if (r.hostSocket === socket.id) return endRoom(r);
  if (r.seats) {
    const i = r.seats.findIndex((s) => s?.socketId === socket.id);
    if (i >= 0) {
      r.seats[i] = null;
      io.to(rk(r.id)).emit('seats', r.seats);
    }
  }
  io.to(rk(r.id)).emit('room:count', othersIn(r));
  broadcastRooms();
}

function joinRoom(socket, r) {
  socket.join(rk(r.id));
  socket.data.roomId = r.id;
  r.members.add(socket.id);
}

attachArena({ io, db, userSockets, pushWallet });

io.use((socket, next) => {
  const user = db.userByToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('auth'));
  socket.data.user = { id: user.id, name: user.name };
  next();
});

io.on('connection', (socket) => {
  const me = socket.data.user;
  if (!userSockets.has(me.id)) userSockets.set(me.id, new Set());
  userSockets.get(me.id).add(socket.id);
  socket.emit('rooms', roomList());
  socket.emit('dm:unread', db.unreadTotal(me.id));

  const ack = (fn) => (typeof fn === 'function' ? fn : () => {});
  const myRoom = () => rooms.get(socket.data.roomId);
  const isHost = (r) => r && r.hostSocket === socket.id;

  socket.on('room:create', ({ type, title } = {}, cb) => {
    cb = ack(cb);
    if (!['video', 'voice', 'chat'].includes(type)) return cb({ error: 'type' });
    leaveRoom(socket);
    const r = {
      id: String(nextRoomId++),
      type,
      title: String(title || '').trim().slice(0, 40) || me.name,
      hostId: me.id,
      hostName: me.name,
      hostSocket: socket.id,
      startedAt: Date.now(),
      members: new Set(),
      banned: new Set(),
      top: new Map(),
      pk: null,
      seats: type === 'voice' ? Array(VOICE_SEATS).fill(null) : null,
    };
    if (r.seats) r.seats[0] = { socketId: socket.id, userId: me.id, name: me.name, muted: false };
    rooms.set(r.id, r);
    joinRoom(socket, r);
    for (const fid of db.followerIds(me.id)) {
      emitToUser(fid, 'follow:live', { name: me.name, roomId: r.id, title: r.title, type: r.type });
      notifyIfAway(fid, {
        tr: { title: `${me.name} şu an canlıda!`, body: r.title },
        en: { title: `${me.name} is live now!`, body: r.title },
        url: `/?room=${r.id}`,
        tag: `live-${me.id}`,
      });
    }
    broadcastRooms();
    cb({ room: roomState(r) });
  });

  socket.on('room:join', ({ roomId } = {}, cb) => {
    cb = ack(cb);
    const r = rooms.get(String(roomId));
    if (!r) return cb({ error: 'gone' });
    if (r.banned.has(me.id)) return cb({ error: 'banned' });
    if (socket.data.roomId !== r.id) {
      leaveRoom(socket);
      joinRoom(socket, r);
      systemChat(r, 'joined', me.name);
      demoGreet(r, me.name);
      io.to(rk(r.id)).emit('room:count', othersIn(r));
      broadcastRooms();
    }
    cb({ room: roomState(r) });
  });

  socket.on('room:leave', () => leaveRoom(socket));
  arenaSocket(socket);
  socket.on('presence', ({ away } = {}) => (socket.data.away = !!away));

  let lastChat = 0;
  socket.on('chat', ({ text } = {}) => {
    const r = myRoom();
    const clean = String(text || '').trim().slice(0, 200);
    if (!r || !clean || Date.now() - lastChat < 400) return;
    lastChat = Date.now();
    io.to(rk(r.id)).emit('chat', { name: me.name, text: clean, host: r.hostId === me.id, level: db.getUser(me.id)?.level });
  });

  socket.on('gift', ({ giftId, targetRoomId, seat } = {}, cb) => {
    cb = ack(cb);
    const r = myRoom();
    const gift = GIFTS.find((g) => g.id === giftId);
    if (!r || !gift) return cb({ error: 'bad' });
    if (r.demo) return cb({ error: 'demo' });
    let target = r;
    if (r.pk && targetRoomId && [r.pk.a, r.pk.b].includes(String(targetRoomId))) target = rooms.get(String(targetRoomId)) || r;
    let to = { id: target.hostId, name: target.hostName };
    if (r.seats && Number.isInteger(seat) && r.seats[seat]) to = { id: r.seats[seat].userId, name: r.seats[seat].name };
    if (to.id === me.id) return cb({ error: 'self' });

    const res = db.sendGift(me.id, to.id, gift);
    if (!res) return cb({ error: 'coins' });
    pushWallet(res.from);
    pushWallet(res.to);

    const entry = target.top.get(me.id) || { name: me.name, coins: 0 };
    entry.coins += gift.coins;
    target.top.set(me.id, entry);
    io.to(rk(target.id)).emit('room:top', topList(target));

    const payload = { from: me.name, to: to.name, gift: gift.id, roomId: target.id };
    if (r.pk) {
      r.pk.scores[target.id] += gift.coins;
      emitBoth(r, 'gift', payload);
      emitBoth(r, 'pk:score', r.pk.scores);
    } else {
      io.to(rk(r.id)).emit('gift', payload);
    }
    cb({ ok: true });
  });

  // Goruntu/ses baglantisi: bir izleyici yayincidan akis ister, teklif ve cevaplar burada aktarilir.
  socket.on('stream:request', ({ target, tag } = {}) => {
    if (sock(target)) io.to(target).emit('stream:request', { from: socket.id, tag });
  });
  socket.on('signal', ({ to, tag, dir, data } = {}) => {
    if (sock(to)) io.to(to).emit('signal', { from: socket.id, tag, dir, data });
  });

  socket.on('pk:invite', ({ targetRoomId } = {}, cb) => {
    cb = ack(cb);
    const r = myRoom();
    const t = rooms.get(String(targetRoomId));
    if (!isHost(r) || r.type !== 'video' || r.pk) return cb({ error: 'bad' });
    if (!t || t === r || t.type !== 'video' || t.pk) return cb({ error: 'busy' });
    io.to(t.hostSocket).emit('pk:invite', { fromRoomId: r.id, fromHost: r.hostName, fromTitle: r.title });
    cb({ ok: true });
  });

  socket.on('pk:answer', ({ fromRoomId, accept } = {}) => {
    const r = myRoom();
    const from = rooms.get(String(fromRoomId));
    if (!isHost(r) || !from) return;
    if (!accept) return io.to(from.hostSocket).emit('pk:declined', { host: r.hostName });
    if (r.pk || from.pk) return;
    startPk(from, r);
  });

  socket.on('seat:take', ({ index } = {}, cb) => {
    cb = ack(cb);
    const r = myRoom();
    if (!r?.seats || !Number.isInteger(index) || index < 1 || index >= r.seats.length) return cb({ error: 'bad' });
    if (r.seats[index] || r.seats.some((s) => s?.socketId === socket.id)) return cb({ error: 'taken' });
    r.seats[index] = { socketId: socket.id, userId: me.id, name: me.name, muted: false };
    io.to(rk(r.id)).emit('seats', r.seats);
    broadcastRooms();
    cb({ ok: true });
  });

  socket.on('seat:leave', () => {
    const r = myRoom();
    if (!r?.seats || isHost(r)) return;
    const i = r.seats.findIndex((s) => s?.socketId === socket.id);
    if (i < 1) return;
    r.seats[i] = null;
    io.emit('peer:left', { socketId: socket.id, tag: 'voice' });
    io.to(rk(r.id)).emit('seats', r.seats);
    broadcastRooms();
  });

  socket.on('seat:mute', ({ muted } = {}) => {
    const r = myRoom();
    const s = r?.seats?.find((x) => x?.socketId === socket.id);
    if (!s) return;
    s.muted = !!muted;
    io.to(rk(r.id)).emit('seats', r.seats);
  });

  socket.on('seat:kick', ({ index } = {}) => {
    const r = myRoom();
    if (!isHost(r) || !r.seats || !Number.isInteger(index) || index < 1) return;
    const s = r.seats[index];
    if (!s) return;
    r.seats[index] = null;
    io.to(s.socketId).emit('seat:removed');
    io.emit('peer:left', { socketId: s.socketId, tag: 'voice' });
    io.to(rk(r.id)).emit('seats', r.seats);
    broadcastRooms();
  });

  socket.on('room:kick', ({ name } = {}) => {
    const r = myRoom();
    if (!isHost(r)) return;
    for (const id of r.members) {
      const s = sock(id);
      if (s && s.id !== socket.id && s.data.user.name === name) {
        r.banned.add(s.data.user.id);
        s.emit('kicked');
        leaveRoom(s);
      }
    }
  });

  socket.on('report', ({ reason } = {}, cb) => {
    const r = myRoom();
    if (r) db.addReport(me.id, r.hostId, reason || 'unspecified');
    ack(cb)({ ok: true });
  });

  socket.on('disconnect', () => {
    arenaDisconnect(socket);
    leaveRoom(socket);
    io.emit('peer:left', { socketId: socket.id });
    const set = userSockets.get(me.id);
    set?.delete(socket.id);
    if (set && !set.size) userSockets.delete(me.id);
  });
});

// ---------- Yonetim paneli (/admin) ----------

const adminTokens = new Map(); // token -> son gecerlilik zamani
const ADMIN_TTL = 12 * 60 * 60 * 1000;
const loginFails = new Map(); // ip -> { count, until }

// Cloudflare tuneli uzerinden gelen istekler bu basliklari tasir; yalniz bu bilgisayardan gelenler "yerel" sayilir.
const isLocal = (req) =>
  !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
// Render gibi bir aracinin arkasinda gercek adres x-forwarded-for basligindadir.
const clientIp = (req) =>
  req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function adminAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const exp = adminTokens.get(token);
  if (!exp || exp < Date.now()) {
    adminTokens.delete(token);
    return res.status(401).json({ error: 'auth' });
  }
  next();
}

function issueAdminToken() {
  const token = randomBytes(32).toString('hex');
  adminTokens.set(token, Date.now() + ADMIN_TTL);
  return token;
}

// Canli sunucuda panele bu bilgisayardan girilemez; ilk sifre ADMIN_PASSWORD ortam degiskeninden gelir.
if (process.env.ADMIN_PASSWORD && !db.hasAdminPassword()) db.setAdminPassword(process.env.ADMIN_PASSWORD);

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/admin/status', (req, res) => res.json({ setup: db.hasAdminPassword(), local: isLocal(req) }));

// Ilk sifre yalniz bu bilgisayardan belirlenebilir; boylece adresi bulan biri paneli ele geciremez.
app.post('/api/admin/setup', (req, res) => {
  if (db.hasAdminPassword()) return res.status(400).json({ error: 'exists' });
  if (!isLocal(req)) return res.status(403).json({ error: 'local' });
  const pass = req.body?.pass;
  if (typeof pass !== 'string' || pass.length < 8) return res.status(400).json({ error: 'short' });
  db.setAdminPassword(pass);
  res.json({ token: issueAdminToken() });
});

app.post('/api/admin/login', (req, res) => {
  const ip = clientIp(req);
  const f = loginFails.get(ip);
  if (f && f.count >= 5 && f.until > Date.now()) return res.status(429).json({ error: 'wait' });
  if (!db.checkAdminPassword(req.body?.pass)) {
    const next = f && f.until > Date.now() ? f.count + 1 : 1;
    loginFails.set(ip, { count: next, until: Date.now() + 10 * 60 * 1000 });
    return res.status(400).json({ error: 'login' });
  }
  loginFails.delete(ip);
  res.json({ token: issueAdminToken() });
});

app.post('/api/admin/logout', adminAuth, (req, res) => {
  adminTokens.delete(req.headers.authorization.slice(7));
  res.json({ ok: true });
});

app.get('/api/admin/overview', adminAuth, (req, res) => {
  const live = [...rooms.values()].map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    hostId: r.hostId,
    hostName: r.hostName,
    viewers: othersIn(r),
    inPk: !!r.pk,
    startedAt: r.startedAt,
    giftCoins: [...r.top.values()].reduce((s, x) => s + x.coins, 0),
  }));
  res.json({
    stats: { ...db.adminStats(), online: userSockets.size, liveRooms: live.length, viewers: live.reduce((s, r) => s + r.viewers, 0) },
    rooms: live,
    reports: db.listReports(req.query.reports === 'resolved' ? 'resolved' : 'open'),
    banned: db.listBanned(),
  });
});

app.post('/api/admin/rooms/:id/close', adminAuth, (req, res) => {
  const r = rooms.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'gone' });
  endRoom(r, true);
  res.json({ ok: true });
});

app.post('/api/admin/reports/resolve', adminAuth, (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  db.resolveReports(ids);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/ban', adminAuth, (req, res) => {
  const id = Number(req.params.id);
  const banned = req.body?.banned !== false;
  db.setBanned(id, banned);
  if (banned) {
    db.resolveReportsForTarget(id);
    // Acik yayinini kapat, tum baglantilarini kes.
    for (const r of [...rooms.values()]) if (r.hostId === id) endRoom(r, true);
    for (const sid of userSockets.get(id) || []) {
      const s = sock(sid);
      s?.emit('banned');
      s?.disconnect(true);
    }
  }
  res.json({ ok: true });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
  const result = db.listUsers(req.query.q, Number(req.query.page) || 0);
  for (const u of result.users) u.online = userSockets.has(u.id);
  res.json(result);
});

app.post('/api/admin/users/:id/coins', adminAuth, (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000000) return res.status(400).json({ error: 'amount' });
  const user = db.adjustCoins(Number(req.params.id), amount);
  if (!user) return res.status(404).json({ error: 'gone' });
  pushWallet(user);
  res.json({ user });
});

// ---------- Yoneticiden toplu bildirim ----------

let lastBroadcast = 0;
app.post('/api/admin/push', adminAuth, async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 60);
  const body = String(req.body?.body || '').trim().slice(0, 180);
  if (!title || !body) return res.status(400).json({ error: 'text' });
  if (Date.now() - lastBroadcast < 30000) return res.status(429).json({ error: 'wait' });
  lastBroadcast = Date.now();
  const text = { title, body };
  res.json(await push.pushToAll({ tr: text, en: text, url: '/', tag: `admin-${Date.now()}` }));
});

// ---------- Deneme hesaplari ----------

app.get('/api/admin/demo', adminAuth, (req, res) => {
  res.json({ users: db.listDemoUsers().map((u) => ({ ...u, online: userSockets.has(u.id) })), chat: db.demoChatEnabled() });
});

app.post('/api/admin/demo', adminAuth, (req, res) => {
  const count = Number(req.body?.count);
  const coins = Number(req.body?.coins);
  if (!Number.isInteger(count) || count < 1 || count > 20) return res.status(400).json({ error: 'count' });
  if (!Number.isInteger(coins) || coins < 0 || coins > 100000) return res.status(400).json({ error: 'coins' });
  res.json({ created: db.createDemoUsers(count, coins) });
});

// Silinen deneme hesabinin acik yayini kapanir, baglantisi kesilir.
function closeConnections(id) {
  for (const r of [...rooms.values()]) if (r.hostId === id) endRoom(r, true);
  for (const sid of userSockets.get(id) || []) {
    const s = sock(sid);
    s?.emit('account:deleted');
    s?.disconnect(true);
  }
}

function removeDemo(id) {
  closeConnections(id);
  return db.deleteDemoUser(id);
}

app.post('/api/admin/demo/:id/delete', adminAuth, (req, res) => {
  if (!removeDemo(Number(req.params.id))) return res.status(404).json({ error: 'gone' });
  res.json({ ok: true });
});

app.post('/api/admin/demo/delete-all', adminAuth, (req, res) => {
  const users = db.listDemoUsers();
  for (const u of users) removeDemo(u.id);
  res.json({ deleted: users.length });
});

// ---------- Demo sohbet ----------
// Yonetici acinca deneme hesaplari "Demo sohbet" odasinda hazir kisa konusmalarla yazisir.
// Oda ve mesajlar herkese "Demo" etiketiyle gorunur, bu odada hediye gonderilemez.

const DEMO_TALKS = [
  [[0, 'Selam herkese 👋'], [1, 'Selam! Nasılsın?'], [0, 'İyiyim, sen nasılsın?'], [1, 'Ben de iyiyim, çay demledim ☕']],
  [[0, 'Bu akşam ne izliyorsunuz?'], [1, 'Bir dizi başladım, çok sardı'], [2, 'Ben maç izleyeceğim ⚽'], [0, 'Kim oynuyor?'], [2, 'Derbi var, kaçmaz!']],
  [[1, 'Hava bugün çok güzeldi'], [0, 'Evet, sonunda güneş çıktı ☀️'], [1, 'Yürüyüşe çıktım, iyi geldi']],
  [[2, 'Yemekte ne var?'], [0, 'Mercimek çorbası 🍲'], [1, 'Bizde makarna var'], [2, 'İkisi de güzelmiş, acıktım 😄']],
  [[0, 'Sesli odaları denediniz mi?'], [1, 'Evet, koltuğa oturup konuşabiliyorsun'], [0, 'Süper, akşam bir oda açarım 🎙️']],
  [[1, 'Bir şarkı önerin bana 🎵'], [2, 'Eski bir Barış Manço şarkısı aç'], [1, 'Güzel fikir, hemen açıyorum'], [0, 'Ben de dinliyorum şimdi']],
  [[0, 'Günlük ödülü aldınız mı bugün?'], [1, 'Aldım, serim 3 gün oldu 🎁'], [2, 'Ben unutmuşum, hemen alıyorum']],
  [[2, 'Hafta sonu planınız var mı?'], [0, 'Pikniğe gideceğiz'], [1, 'Ben evde dinleneceğim'], [2, 'İkisi de güzel plan 😊']],
  [[1, 'Kitap okuyan var mı burada? 📚'], [0, 'Ben bir roman okuyorum'], [1, 'Bitince anlatırsın'], [0, 'Tabii, söz']],
  [[0, 'PK yarışmalarını izlediniz mi?'], [2, 'Dün bir tane izledim, çok heyecanlıydı'], [0, 'Son saniyede kazandı galiba'], [2, 'Aynen 😄']],
  [[1, 'Günaydın millet ☀️'], [0, 'Günaydın!'], [2, 'Kahvemi aldım, güne hazırım ☕']],
  [[2, 'Hangi şehirdensiniz?'], [0, 'Ben İzmir'], [1, 'Ben de Ankara'], [2, 'Ben İstanbul, selamlar 👋']],
  [[0, 'Sizce en güzel hediye hangisi?'], [1, 'Bence roket 🚀'], [2, 'Şato daha havalı 🏰'], [0, 'Gül de tatlı ama 🌹']],
  [[1, 'Ben biraz çıkıyorum, sonra görüşürüz'], [0, 'Görüşürüz, kendine iyi bak'], [2, 'Bay bay 👋']],
  [[0, 'Bugün çok yorulduk ya'], [2, 'Haklısın, uzun bir gündü'], [1, 'Bir film izleyip dinlenin bence 🎬']],
];

const DEMO_GREETS = ['Hoş geldin {name} 👋', 'Selam {name}!', '{name} hoş geldin, nasılsın?'];

const demo = { room: null, timer: null, queue: [] };
const rand = (n) => Math.floor(Math.random() * n);
const demoUsers = () => db.listDemoUsers().filter((u) => !u.banned);

function demoSay(r, user, text) {
  io.to(rk(r.id)).emit('chat', { name: user.name, text, host: r.hostId === user.id, level: db.getUser(user.id)?.level, demo: true });
}

function openDemoRoom(host, count) {
  const r = {
    id: String(nextRoomId++),
    type: 'chat',
    demo: true,
    demoCount: count,
    title: 'Demo sohbet ☕',
    hostId: host.id,
    hostName: host.name,
    hostSocket: null,
    startedAt: Date.now(),
    members: new Set(),
    banned: new Set(),
    top: new Map(),
    pk: null,
    seats: null,
  };
  rooms.set(r.id, r);
  broadcastRooms();
  return r;
}

function stopDemoChat() {
  clearTimeout(demo.timer);
  demo.timer = null;
  demo.queue = [];
  if (demo.room && rooms.get(demo.room.id) === demo.room) endRoom(demo.room);
  demo.room = null;
}

function demoTick() {
  demo.timer = null;
  const users = demoUsers();
  if (!db.demoChatEnabled() || users.length < 2) return stopDemoChat();
  let r = demo.room && rooms.get(demo.room.id) === demo.room ? demo.room : null;
  if (r && !users.some((u) => u.id === r.hostId)) {
    stopDemoChat();
    r = null;
  }
  if (!r) r = demo.room = openDemoRoom(users[0], users.length);
  if (r.demoCount !== users.length) {
    r.demoCount = users.length;
    broadcastRooms();
  }
  let pause = 0;
  if (!demo.queue.length) {
    // Yeni konusma: roller karisik siradaki deneme hesaplarina dagitilir.
    const cast = [...users].sort(() => Math.random() - 0.5);
    demo.queue = DEMO_TALKS[rand(DEMO_TALKS.length)].map(([role, text]) => ({ user: cast[role % cast.length], text }));
  }
  const line = demo.queue.shift();
  demoSay(r, line.user, line.text);
  if (!demo.queue.length) pause = 20000 + rand(25000);
  demo.timer = setTimeout(demoTick, pause || 3000 + rand(5000));
}

function startDemoChat() {
  if (!demo.timer) demo.timer = setTimeout(demoTick, 1000);
}

function demoGreet(r, name) {
  if (!r.demo || demo.room !== r) return;
  const users = demoUsers().filter((u) => u.name !== name);
  if (!users.length) return;
  const text = DEMO_GREETS[rand(DEMO_GREETS.length)].replace('{name}', name);
  setTimeout(() => rooms.get(r.id) === r && demoSay(r, users[rand(users.length)], text), 1500 + rand(2000));
}

app.post('/api/admin/demo/chat', adminAuth, (req, res) => {
  const on = req.body?.on === true;
  if (on && demoUsers().length < 3) db.createDemoUsers(3 - demoUsers().length, 1000);
  db.setDemoChat(on);
  if (on) startDemoChat();
  else stopDemoChat();
  res.json({ on });
});

if (db.demoChatEnabled()) setTimeout(startDemoChat, 3000);

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`\nLafello zaten acik gorunuyor (${PORT} numarali kapi kullanimda).`);
  console.error('Acik kalan eski Lafello penceresini kapatip tekrar dene.\n');
  process.exit(1);
});

server.listen(PORT, () => console.log(`Lafello hazir: http://localhost:${PORT}`));
