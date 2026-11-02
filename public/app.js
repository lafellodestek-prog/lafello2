// Lafello istemcisi: giris, yayin listesi, canli oda, hediye, PK ve sesli oda arayuzu.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const store = {
  get(k) { try { return sessionStorage.getItem(k) ?? localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); localStorage.setItem(k, v); } catch {} },
  del(k) { try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch {} },
};

const state = {
  lang: store.get('sahne_lang') || (navigator.language?.startsWith('tr') ? 'tr' : 'en'),
  token: store.get('sahne_token'),
  user: null,
  config: null,
  socket: null,
  rtc: null,
  rooms: [],
  tab: 'all',
  authMode: 'login',
  room: null,
  isHost: false,
  localStream: null,
  micStream: null,
  selectedGift: null,
  giftTarget: null,
  pkTimer: null,
  pkEndsAt: 0,
  goliveType: 'video',
  avatarV: {},
  following: new Set(),
  ice: null,
};

// ---------- Yardimcilar ----------

function t(key, vars = {}) {
  let s = I18N[state.lang][key] ?? I18N.tr[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}
const giftName = (id) => GIFT_NAMES[state.lang][id] || id;
const giftById = (id) => state.config.gifts.find((g) => g.id === id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function hue(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
// Profil fotografi varsa bas harfin ustune biner; yoksa (404) resim kaldirilir ve bas harf gorunur.
const avatarSrc = (name) => `/api/u/${encodeURIComponent(name)}/avatar${state.avatarV[name] ? `?v=${state.avatarV[name]}` : ''}`;
const avatarInner = (name) =>
  `${esc(String(name || '?').charAt(0).toUpperCase())}<img src="${avatarSrc(name)}" alt="" loading="lazy" onerror="this.remove()">`;
function avatar(el, name) {
  el.classList.add('pic');
  el.innerHTML = avatarInner(name);
  el.style.background = `linear-gradient(135deg, hsl(${hue(name)} 80% 60%), hsl(${(hue(name) + 50) % 360} 80% 45%))`;
}
function avatarHtml(name, cls = 'avatar') {
  const h = hue(name);
  return `<span class="${cls} pic" style="background:linear-gradient(135deg,hsl(${h} 80% 60%),hsl(${(h + 50) % 360} 80% 45%))">${avatarInner(name)}</span>`;
}
const fmt = (n) => Number(n).toLocaleString(state.lang === 'tr' ? 'tr-TR' : 'en-US');

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'net'), { code: data.error || 'net', status: res.status });
  return data;
}

function show(view) {
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
}

function openSheet(id) {
  $$('.sheet').forEach((s) => s.classList.add('hidden'));
  $('#backdrop').classList.remove('hidden');
  $(`#sheet-${id}`).classList.remove('hidden');
}
function closeSheets() {
  $$('.sheet').forEach((s) => s.classList.add('hidden'));
  $('#backdrop').classList.add('hidden');
}

function confirmBox(text, yesLabel) {
  return new Promise((resolve) => {
    $('#confirm-text').textContent = text;
    $('#confirm-yes').textContent = yesLabel;
    $('#confirm-no').textContent = t('cancel');
    openSheet('confirm');
    const done = (v) => { closeSheets(); $('#confirm-yes').onclick = $('#confirm-no').onclick = null; resolve(v); };
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = () => done(false);
  });
}

function applyLang() {
  document.documentElement.lang = state.lang;
  $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  $$('[data-action="lang"]').forEach((el) => (el.textContent = state.lang === 'tr' ? 'EN' : 'TR'));
  renderAuth();
  if (state.config) {
    renderGrid();
    renderGifts();
    renderWallet();
  }
  if (state.room) renderRoom();
}

// ---------- Giris ----------

function renderAuth() {
  const reg = state.authMode === 'register';
  $('#auth-submit').textContent = t(reg ? 'register' : 'login');
  $('#auth-switch').textContent = t(reg ? 'haveAccount' : 'noAccount');
  $('#auth-adult-row').classList.toggle('hidden', !reg);
  $('#auth-pass').autocomplete = reg ? 'new-password' : 'current-password';
}

$('#auth-switch').onclick = () => {
  state.authMode = state.authMode === 'login' ? 'register' : 'login';
  $('#auth-error').textContent = '';
  renderAuth();
};

$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const reg = state.authMode === 'register';
  const body = { name: $('#auth-name').value.trim(), pass: $('#auth-pass').value };
  if (reg) body.adult = $('#auth-adult').checked;
  if (reg && !body.adult) return ($('#auth-error').textContent = t('err_adult'));
  try {
    const { token, user } = await api(reg ? '/api/register' : '/api/login', body);
    loggedIn(token, user);
  } catch (err) {
    $('#auth-error').textContent = t(`err_${err.code}`);
  }
};

function loggedIn(token, user) {
  state.token = token;
  store.set('sahne_token', token);
  enterApp(user);
  // Giristen once tiklanan oyun varsa hemen acilir.
  const p = state.pending;
  state.pending = null;
  if (p?.game) openGame(p.game, p.title);
}

// ---------- Misafir ----------
// Giris yapmadan acilinca oyun listesi gorunur; baska her sey giris ister.

function enterGuest() {
  state.user = null;
  document.body.classList.add('guest');
  state.tab = 'games';
  $$('#home-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'games'));
  show('home');
  renderGrid();
}

function openLogin(why) {
  $('#auth-why').classList.toggle('hidden', !why);
  $('.auth-close').classList.toggle('hidden', !document.body.classList.contains('guest'));
  $('#auth-error').textContent = $('#google-error').textContent = '';
  show('auth');
}

const GUEST_OK = '[data-tab="games"], [data-cat], [data-action="lang"], [data-action="login"]';
document.addEventListener(
  'click',
  (e) => {
    if (!document.body.classList.contains('guest') || !e.target.closest('#view-home')) return;
    if (e.target.closest(GUEST_OK)) return;
    e.preventDefault();
    e.stopPropagation();
    const g = e.target.closest('[data-game]');
    state.pending = g ? { game: g.dataset.game, title: g.dataset.title } : null;
    openLogin(true);
  },
  true,
);

// ---------- Google ile giris ----------
// Tarayicida Google'in kendi dugmesi; Android uygulamasinda telefonun Google hesabi kullanilir.

const googleNative = () => typeof window.LafelloApp?.googleSignIn === 'function';
state.googleCred = null;

async function googleLogin(credential) {
  state.googleCred = credential;
  $('#google-error').textContent = '';
  const adult = $('#google-adult').checked;
  try {
    const { token, user } = await api('/api/google', { credential, adult });
    state.googleCred = null;
    loggedIn(token, user);
  } catch (err) {
    if (err.code === 'adult') {
      // Ilk giris: 18 yas onayi isaretlenince ayni Google girisiyle devam edilir.
      $('#google-adult-row').classList.remove('hidden');
      $('#google-error').textContent = t('google_adult');
      return;
    }
    $('#google-error').textContent = t(err.code === 'banned' ? 'err_banned' : 'err_google');
  }
}

$('#google-adult').onchange = () => {
  if ($('#google-adult').checked && state.googleCred) googleLogin(state.googleCred);
};

// Android uygulamasi Google girisini bitirince bu cagrilir.
window.lafelloGoogle = (credential) => {
  if (credential) googleLogin(credential);
  else $('#google-error').textContent = t('err_google');
};

function setupGoogle() {
  const id = state.config?.googleClientId;
  const inApp = !!window.LafelloApp;
  // Google, uygulama icindeki web gorunumunde kendi dugmesine izin vermez.
  const usable = id && (inApp ? googleNative() : true);
  $('#google-box').classList.toggle('hidden', !usable);
  $('#auth-form').classList.toggle('hidden', !!usable);
  $('#auth-switch').classList.toggle('hidden', !!usable);
  if (!usable) return;
  if (inApp) {
    $('#google-btn').innerHTML = `<button class="btn google-native" type="button"><span class="g">G</span>${esc(t('google_continue'))}</button>`;
    $('#google-btn button').onclick = () => window.LafelloApp.googleSignIn();
    return;
  }
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({ client_id: id, callback: (r) => googleLogin(r.credential), ux_mode: 'popup' });
    google.accounts.id.renderButton($('#google-btn'), {
      theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 300, locale: state.lang,
    });
  };
  document.head.appendChild(s);
}

$('#pass-toggle').onclick = () => {
  $('#auth-form').classList.toggle('hidden');
  $('#auth-switch').classList.toggle('hidden');
};

async function logout() {
  if (state.pushOn) await disablePush();
  await api('/api/logout', {}).catch(() => {});
  await leaveRoom(true);
  state.socket?.disconnect();
  state.socket = null;
  state.token = null;
  state.user = null;
  store.del('sahne_token');
  closeSheets();
  enterGuest();
}

// ---------- Ana sayfa ----------

function enterApp(user) {
  state.user = user;
  document.body.classList.remove('guest');
  renderWallet();
  connectSocket();
  show('home');
  // Goruntu baglantisi icin aktarma bilgisi ve takip edilenler arka planda yuklenir.
  api('/api/ice').then((r) => (state.ice = r.iceServers)).catch(() => {});
  setTimeout(() => openDaily(true), 800);
  enablePush(true);
  renderPushBtn();
  if (location.search) {
    openFromUrl(location.href);
    history.replaceState(null, '', '/');
  }
  api('/api/following')
    .then((r) => {
      state.following = new Set(r.names);
      renderGrid();
    })
    .catch(() => {});
}

function renderWallet() {
  const u = state.user;
  if (!u || !state.config) return;
  $('#home-coins').textContent = fmt(u.coins);
  $('#gift-coins').textContent = fmt(u.coins);
  $('#wallet-coins').textContent = fmt(u.coins);
  $('#wallet-diamonds').textContent = fmt(u.diamonds);
  $('#wallet-name').textContent = u.name;
  $('#wallet-level').innerHTML = levelBar(u);
  avatar($('#home-avatar'), u.name);
  avatar($('#wallet-avatar'), u.name);
  $('#earnings-d').textContent = t('earnings_d', { p: Math.round(state.config.hostShare * 100) });
  $('#packs').innerHTML = state.config.packs
    .map((p) => `<button class="pack" data-pack="${p.id}"><b>🪙 ${fmt(p.coins)}</b><span>${state.lang === 'tr' ? `${p.try} TL` : `$${p.usd}`}</span></button>`)
    .join('');
}

$('#packs').onclick = async (e) => {
  const b = e.target.closest('[data-pack]');
  if (!b) return;
  b.disabled = true;
  try {
    const { user } = await api('/api/buy', { pack: b.dataset.pack });
    state.user = user;
    renderWallet();
  } catch {
    toast(t('err_net'));
  }
  b.disabled = false;
};

function renderGrid() {
  $('#game-cats').classList.toggle('hidden', state.tab !== 'games');
  $('#mp-games').classList.toggle('hidden', state.tab !== 'games');
  if (state.tab === 'games') return renderGames();
  const list = state.rooms.filter((r) =>
    state.tab === 'all' ? true : state.tab === 'pk' ? r.inPk : state.tab === 'following' ? state.following.has(r.hostName) : r.type === state.tab,
  );
  $('#room-empty').classList.toggle('hidden', list.length > 0);
  $('#room-grid').innerHTML = list
    .map((r) => {
      const h = hue(r.hostName);
      const meta = r.type === 'voice' ? t('speakers', { n: r.speakers }) : r.type === 'chat' ? t('members', { n: r.count + 1 }) : t('viewers', { n: r.count });
      return `<button class="card" data-room="${r.id}" style="--h:${h}">
        <div class="card-art">${r.type === 'voice' ? '🎙️' : r.type === 'chat' ? '💬' : avatarHtml(r.hostName, 'card-avatar')}</div>
        <div class="badges"><span class="badge live">● LIVE</span>${r.demo ? '<span class="badge demo">Demo</span>' : ''}${r.inPk ? '<span class="badge pk">PK</span>' : ''}${r.type === 'voice' ? `<span class="badge">${esc(t('tab_voice'))}</span>` : r.type === 'chat' ? `<span class="badge">${esc(t('tab_chat'))}</span>` : ''}</div>
        <div class="card-info"><b>${esc(r.title)}</b><small>${esc(r.hostName)} · ${esc(meta)}</small></div>
      </button>`;
    })
    .join('');
}

$('#home-tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  $$('#home-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderGrid();
};

$('#room-grid').onclick = (e) => {
  const g = e.target.closest('[data-game]');
  if (g) return openGame(g.dataset.game, g.dataset.title);
  const c = e.target.closest('[data-room]');
  if (c) joinRoom(c.dataset.room);
};

// ---------- Baglanti ----------

function connectSocket() {
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;

  state.rtc = createRtc(socket, {
    getStream: (tag) => (tag === 'voice' ? state.micStream : state.isHost ? state.localStream : null),
    iceServers: () => state.ice,
    onTrack: attachStream,
    onClose: detachStream,
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'auth') logout();
  });
  socket.on('rooms', (rooms) => {
    state.rooms = rooms;
    renderGrid();
  });
  socket.on('wallet', (user) => {
    if (state.user && user.level > state.user.level) toast(t('level_up', { n: user.level }));
    state.user = user;
    renderWallet();
  });
  socket.on('chat', addChat);
  socket.on('dm', onDm);
  socket.on('follow:live', onFollowLive);
  mpSocket(socket);
  socket.on('dm:sent', onDmSent);
  socket.on('dm:unread', setUnread);
  socket.on('gift', onGift);
  socket.on('room:count', (n) => {
    if (!state.room) return;
    state.room.count = n;
    renderRoomHeader();
  });
  socket.on('room:top', (top) => {
    if (!state.room) return;
    state.room.top = top;
    renderRoomHeader();
  });
  socket.on('room:ended', ({ byAdmin } = {}) => {
    if (state.isHost && !byAdmin) return;
    toast(t(byAdmin ? 'closedByAdmin' : 'roomEnded'));
    leaveRoom(true);
  });
  socket.on('banned', async () => {
    await logout();
    openLogin();
    $('#auth-error').textContent = $('#google-error').textContent = t('err_banned');
  });
  socket.on('account:deleted', async () => {
    await logout();
    toast(t('err_deleted'));
  });
  socket.on('kicked', () => {
    toast(t('kicked'));
    leaveRoom(true);
  });
  socket.on('seats', onSeats);
  socket.on('seat:removed', () => {
    toast(t('seat_removed'));
    stopMic();
  });
  socket.on('pk:invite', onPkInvite);
  socket.on('pk:declined', ({ host }) => toast(t('pk_declined', { name: host })));
  socket.on('pk:start', onPkStart);
  socket.on('pk:score', (scores) => {
    if (!state.room?.pk) return;
    state.room.pk.scores = scores;
    renderPk();
  });
  socket.on('pk:end', onPkEnd);
  socket.on('connect', () => {
    socket.emit('presence', { away: document.hidden });
    // Baglanti koptuysa oda artik gecersizdir; ana sayfaya don.
    if (state.room && state.room._socketId && state.room._socketId !== socket.id) leaveRoom(true);
  });
}

// ---------- Kamera ve mikrofon ----------

function fakeVideoStream(label) {
  const c = document.createElement('canvas');
  c.width = 480;
  c.height = 640;
  const g = c.getContext('2d');
  const h = hue(label);
  let f = 0;
  const draw = () => {
    f++;
    const grd = g.createLinearGradient(0, 0, 480, 640);
    grd.addColorStop(0, `hsl(${(h + f / 2) % 360} 70% 45%)`);
    grd.addColorStop(1, `hsl(${(h + 80 + f / 2) % 360} 70% 25%)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, 480, 640);
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.beginPath();
    g.arc(240, 280 + Math.sin(f / 15) * 12, 80, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = `hsl(${h} 70% 40%)`;
    g.font = 'bold 90px system-ui';
    g.textAlign = 'center';
    g.fillText(label.charAt(0).toUpperCase(), 240, 312 + Math.sin(f / 15) * 12);
    g.fillStyle = '#fff';
    g.font = 'bold 34px system-ui';
    g.fillText(label, 240, 430);
  };
  const timer = setInterval(draw, 1000 / 24);
  draw();
  const stream = c.captureStream(24);
  stream.addTrack(silentAudioTrack());
  stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
  stream._stop = () => clearInterval(timer);
  return stream;
}

function silentAudioTrack() {
  const ctx = new AudioContext();
  const dst = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(dst);
  osc.start();
  return dst.stream.getAudioTracks()[0];
}

async function getCamera() {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { width: 720, height: 1280, facingMode: 'user' }, audio: true });
  } catch {
    toast(t('fakeCam'));
    return fakeVideoStream(state.user.name);
  }
}

async function getMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast(t('fakeMic'));
    return new MediaStream([silentAudioTrack()]);
  }
}

function stopStream(s) {
  if (!s) return;
  s._stop?.();
  s.getTracks().forEach((tr) => tr.stop());
}

function stopMic() {
  state.rtc?.closeOutTag('voice');
  stopStream(state.micStream);
  state.micStream = null;
  renderRoomActions();
}

// ---------- Akislari ekrana baglama ----------

function playVideo(el, stream, muted) {
  el.srcObject = stream;
  el.muted = muted;
  el.play().catch(() => {
    el.muted = true;
    el.play().catch(() => {});
    if (!muted) $('#sound-btn').classList.remove('hidden');
  });
}

$('#sound-btn').onclick = () => {
  $('#v-main').muted = false;
  $('#v-side').muted = false;
  $$('#room audio').forEach((a) => a.play().catch(() => {}));
  $('#sound-btn').classList.add('hidden');
};

function attachStream(from, tag, stream) {
  if (tag === 'main') playVideo($('#v-main'), stream, false);
  else if (tag === 'pk') playVideo($('#v-side'), stream, false);
  else if (tag === 'voice') {
    let a = document.getElementById(`a-${from}`);
    if (!a) {
      a = document.createElement('audio');
      a.id = `a-${from}`;
      a.autoplay = true;
      $('#room').appendChild(a);
    }
    a.srcObject = stream;
    a.play().catch(() => $('#sound-btn').classList.remove('hidden'));
  }
}

function detachStream(from, tag) {
  if (tag === 'voice') document.getElementById(`a-${from}`)?.remove();
  if (tag === 'pk') $('#v-side').srcObject = null;
}

// ---------- Oda ----------

async function goLive() {
  const type = state.goliveType;
  const title = $('#golive-title').value.trim();
  closeSheets();
  if (type === 'video') state.localStream = await getCamera();
  else if (type === 'voice') state.micStream = await getMic();
  state.socket.emit('room:create', { type, title }, (res) => {
    if (res.error) {
      stopStream(state.localStream);
      stopStream(state.micStream);
      state.localStream = state.micStream = null;
      return toast(t('err_net'));
    }
    state.isHost = true;
    enterRoom(res.room);
    if (type === 'video') playVideo($('#v-main'), state.localStream, true);
  });
}

function joinRoom(id) {
  state.socket.emit('room:join', { roomId: id }, (res) => {
    if (res.error === 'banned') return toast(t('kicked'));
    if (res.error) return toast(t('roomEnded'));
    state.isHost = false;
    enterRoom(res.room);
    if (res.room.type === 'video') state.rtc.request(res.room.hostSocket, 'main');
  });
}

function enterRoom(room) {
  state.room = { ...room, _socketId: state.socket.id };
  $('#chat').innerHTML = '';
  $('#gift-banners').innerHTML = '';
  $('#sound-btn').classList.add('hidden');
  state.giftTarget = null;
  state.voiceReq = new Set();
  show('room');
  renderRoom();
  if (room.type === 'voice') onSeats(room.seats);
  if (room.pk) onPkStart(room.pk);
}

async function leaveRoom(silent) {
  if (!state.room) return;
  if (!silent && state.isHost && !(await confirmBox(state.lang === 'tr' ? 'Yayını bitirmek istiyor musun?' : 'End your stream?', t('close')))) return;
  state.socket?.emit('room:leave');
  state.rtc?.closeAll();
  stopStream(state.localStream);
  stopStream(state.micStream);
  state.localStream = state.micStream = null;
  $('#v-main').srcObject = null;
  $('#v-side').srcObject = null;
  $$('#room audio').forEach((a) => a.remove());
  clearInterval(state.pkTimer);
  state.room = null;
  state.isHost = false;
  closeSheets();
  show('home');
}

function renderRoom() {
  const r = state.room;
  const voice = r.type === 'voice';
  const chat = r.type === 'chat';
  $('#room').classList.toggle('voice', voice || chat);
  $('#room').classList.toggle('chatroom', chat);
  $('#screens').classList.toggle('hidden', voice || chat);
  $('#seats').classList.toggle('hidden', !voice);
  renderRoomHeader();
  renderRoomActions();
  renderPk();
}

function renderRoomHeader() {
  const r = state.room;
  avatar($('#room-host-avatar'), r.hostName);
  $('#room-title').textContent = r.title;
  $('#room-count').textContent = `${r.hostName} · ${t('viewers', { n: r.count })}`;
  $('#room-top').innerHTML = (r.top || [])
    .map((f, i) => `<span class="fan" title="${esc(f.name)} · ${fmt(f.coins)}">${avatarHtml(f.name)}<i>${i + 1}</i></span>`)
    .join('');
}

function renderRoomActions() {
  const r = state.room;
  if (!r) return;
  const btns = [];
  if (r.type === 'video' && state.isHost) {
    const cam = state.localStream?.getVideoTracks()[0];
    const mic = state.localStream?.getAudioTracks()[0];
    btns.push(`<button class="round ${cam && !cam.enabled ? 'off' : ''}" data-action="toggle-cam" title="${t('cam')}">📷</button>`);
    btns.push(`<button class="round ${mic && !mic.enabled ? 'off' : ''}" data-action="toggle-mic" title="${t('mute')}">🎤</button>`);
    if (!r.pk) btns.push(`<button class="round pk" data-action="pk" title="PK">PK</button>`);
  }
  if (r.type === 'voice') {
    const mine = r.seats?.find((s) => s?.socketId === state.socket.id);
    if (mine) {
      btns.push(`<button class="round ${mine.muted ? 'off' : ''}" data-action="voice-mute" title="${t(mine.muted ? 'unmute' : 'mute')}">🎤</button>`);
      if (!state.isHost) btns.push(`<button class="round" data-action="seat-leave" title="${t('seat_leave')}">⏏</button>`);
    }
  }
  if (!r.demo) btns.push(`<button class="round gift" data-action="gifts" title="${t('gifts')}">🎁</button>`);
  $('#room-actions').innerHTML = btns.join('');
}

$('.host-chip').onclick = () => state.room && openProfile(state.room.hostName);

$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chat-input').value.trim();
  if (!text) return;
  state.socket.emit('chat', { text });
  $('#chat-input').value = '';
};

function addChat(m) {
  const el = document.createElement('div');
  el.className = 'msg' + (m.system ? ' system' : '') + (m.gift ? ' giftmsg' : '');
  if (m.system === 'joined') el.innerHTML = `<b data-name="${esc(m.name)}">${esc(m.name)}</b> ${esc(t('joined'))}`;
  else if (m.gift) el.innerHTML = `<b data-name="${esc(m.name)}">${esc(m.name)}</b> ${esc(t('sentGift', { gift: giftName(m.gift) }))} ${giftById(m.gift)?.emoji || ''}`;
  else el.innerHTML = `${m.demo ? '<span class="tag demo">Demo</span>' : ''}${m.host && !m.demo ? `<span class="tag">${esc(t('host'))}</span>` : ''}${levelBadge(m.level)}<b data-name="${esc(m.name)}">${esc(m.name)}</b> ${esc(m.text)}`;
  const box = $('#chat');
  box.appendChild(el);
  while (box.children.length > 60) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

// Yayinci sohbetteki bir isme dokunarak o kisiyi yayindan cikarabilir.
// Sohbette bir isme dokununca kisi menusu acilir: mesaj gonder, yayinci icin cikar.
$('#chat').onclick = (e) => {
  const el = e.target.closest('[data-name]');
  if (!el || el.dataset.name === state.user.name) return;
  openUser(el.dataset.name);
};

function openUser(name) {
  openProfile(name);
}

// ---------- Profil ----------

async function openProfile(name) {
  let p;
  try {
    ({ profile: p } = await api(`/api/u/${encodeURIComponent(name)}`));
  } catch {
    return toast(t('dm_nouser'));
  }
  state.profile = p;
  renderProfile();
  openSheet('user');
}

function renderProfile() {
  const p = state.profile;
  $('#user-av').innerHTML = avatarHtml(p.name, 'avatar big-av');
  $('#user-name').textContent = p.name;
  $('#user-level').innerHTML = levelBar(p);
  $('#user-bio').textContent = p.bio || (p.me ? t('no_bio_me') : '');
  $('#user-stats').innerHTML = `<div><b>${fmt(p.followers)}</b><small>${esc(t('followers'))}</small></div><div><b>${fmt(p.following)}</b><small>${esc(t('following_n'))}</small></div><div><b>🪙 ${fmt(p.giftsReceived)}</b><small>${esc(t('gifts_received'))}</small></div>`;
  const btns = [];
  if (p.live && !(state.room && state.room.id === p.live.id)) btns.push(`<button class="btn primary" data-user-act="watch">● ${esc(t('watch_live'))}</button>`);
  if (p.me) {
    btns.push(`<label class="btn ghost">${esc(t('change_photo'))}<input type="file" id="photo-file" accept="image/*" hidden></label>`);
    btns.push(`<textarea id="bio-input" maxlength="150" rows="2" placeholder="${esc(t('bio_ph'))}">${esc(p.bio)}</textarea>`);
    btns.push(`<button class="btn ghost" data-user-act="bio">${esc(t('save_bio'))}</button>`);
  } else {
    btns.push(`<button class="btn ${p.isFollowing ? 'ghost' : 'primary'}" data-user-act="follow">${esc(t(p.isFollowing ? 'unfollow' : 'follow'))}</button>`);
    btns.push(`<button class="btn ghost" data-user-act="dm">${esc(t('dm_send'))}</button>`);
    btns.push(`<button class="btn ghost" data-user-act="play">🎮 ${esc(t('mp_play_with'))}</button>`);
    if (state.isHost && state.room) btns.push(`<button class="btn ghost" data-user-act="kick">${esc(t('kick'))}</button>`);
  }
  $('#user-actions').innerHTML = btns.join('');
  $('#user-actions').dataset.name = p.name;
  const file = $('#photo-file');
  if (file) file.onchange = () => uploadPhoto(file.files[0]);
}

$('#user-actions').onclick = async (e) => {
  const act = e.target.closest('[data-user-act]')?.dataset.userAct;
  const { name } = $('#user-actions').dataset;
  if (act === 'dm') openThread(name);
  if (act === 'play') openMpSheet({ target: name });
  if (act === 'watch') {
    closeSheets();
    joinRoom(state.profile.live.id);
  }
  if (act === 'follow') {
    const follow = !state.profile.isFollowing;
    try {
      const { profile } = await api(`/api/u/${encodeURIComponent(name)}/follow`, { follow });
      state.profile = { ...state.profile, ...profile };
      if (follow) state.following.add(name);
      else state.following.delete(name);
      renderProfile();
      renderGrid();
      if (follow) askNotifyPermission();
    } catch {
      toast(t('err_net'));
    }
  }
  if (act === 'bio') {
    const bio = $('#bio-input').value;
    await api('/api/me/bio', { bio }).catch(() => {});
    state.profile.bio = bio.trim();
    toast(t('saved'));
  }
  if (act === 'kick') {
    closeSheets();
    if (await confirmBox(t('kick_q', { name }), state.lang === 'tr' ? 'Çıkar' : 'Remove')) state.socket.emit('room:kick', { name });
  }
};

// Secilen fotograf kare kirpilip 256 piksellik JPEG'e kucultulur, sonra yuklenir.
async function uploadPhoto(file) {
  if (!file) return;
  try {
    const img = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const s = Math.min(img.width, img.height);
    c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    const res = await fetch('/api/me/avatar', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${state.token}` }, body: blob });
    if (!res.ok) throw new Error('upload');
    state.avatarV[state.user.name] = (await res.json()).version;
    renderProfile();
    renderWallet();
    toast(t('photo_ok'));
  } catch {
    toast(t('photo_fail'));
  }
}

// ---------- Takip edilenin canli bildirimi ----------

function askNotifyPermission() {
  if (!state.pushOn) enablePush(false);
}

function onFollowLive(n) {
  const text = t('live_now', { name: n.name });
  const box = $('#live-alert');
  box.innerHTML = `${avatarHtml(n.name)}<div><b>${esc(text)}</b><small>${esc(n.title)}</small></div><button class="btn primary sm" data-live-room="${n.roomId}">${esc(t('watch_live'))}</button>`;
  box.classList.remove('hidden');
  clearTimeout(state.liveAlertTimer);
  state.liveAlertTimer = setTimeout(() => box.classList.add('hidden'), 12000);
}

$('#live-alert').onclick = (e) => {
  const b = e.target.closest('[data-live-room]');
  $('#live-alert').classList.add('hidden');
  if (b) joinRoom(b.dataset.liveRoom);
};

// ---------- Seviye ----------

// Seviye rozeti: 1-9 mavi, 10-19 yesil, 20-29 mor, 30 ve ustu altin.
function levelBadge(level) {
  if (!level) return '';
  const tier = level >= 30 ? 4 : level >= 20 ? 3 : level >= 10 ? 2 : 1;
  return `<span class="lv lv-${tier}" title="${esc(t('level', { n: level }))}">${level}</span>`;
}

function levelBar(u) {
  const span = Math.max(1, u.levelTo - u.levelFrom);
  const pct = Math.min(100, Math.round(((u.xp - u.levelFrom) / span) * 100));
  return `<div class="lv-row">${levelBadge(u.level)}<b>${esc(t('level', { n: u.level }))}</b><small>${esc(t('xp_next', { n: fmt(u.levelTo - u.xp), l: u.level + 1 }))}</small></div><div class="lv-track"><div class="lv-fill" style="width:${pct}%"></div></div>`;
}

// ---------- Siralama ----------

state.lb = { kind: 'hosts', period: 'day' };

async function openLeaderboard() {
  openSheet('leaderboard');
  $('#lb-list').innerHTML = `<p class="muted tiny">${esc(t('connecting'))}</p>`;
  try {
    const data = await api(`/api/leaderboard?period=${state.lb.period}`);
    const list = data[state.lb.kind];
    $('#lb-list').innerHTML = list.length
      ? list
          .map(
            (r, i) => `<button class="lb-row ${i < 3 ? `top${i + 1}` : ''}" data-profile="${esc(r.name)}">
          <span class="lb-rank">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</span>${avatarHtml(r.name)}
          <span class="lb-name">${esc(r.name)} ${levelBadge(r.level)}</span><span class="lb-coins">🪙 ${fmt(r.coins)}</span></button>`,
          )
          .join('')
      : `<p class="muted tiny">${esc(t('lb_empty'))}</p>`;
  } catch {
    $('#lb-list').innerHTML = `<p class="muted tiny">${esc(t('err_net'))}</p>`;
  }
}

$('#sheet-leaderboard').addEventListener('click', (e) => {
  const kind = e.target.closest('[data-kind]');
  const period = e.target.closest('[data-period]');
  const row = e.target.closest('[data-profile]');
  if (kind) state.lb.kind = kind.dataset.kind;
  if (period) state.lb.period = period.dataset.period;
  if (kind || period) {
    $$('#lb-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === state.lb.kind));
    $$('#lb-period button').forEach((b) => b.classList.toggle('active', b.dataset.period === state.lb.period));
    openLeaderboard();
  }
  if (row) openProfile(row.dataset.profile);
});

// ---------- Gunluk odul ----------

async function openDaily(onlyIfAvailable) {
  let st;
  try {
    st = await api('/api/daily');
  } catch {
    return;
  }
  if (onlyIfAvailable && !st.available) return;
  $('#daily-sub').textContent = t('daily_sub', { n: st.streak });
  $('#daily-days').innerHTML = st.rewards
    .map((r, i) => {
      const cls = i + 1 < st.day || (!st.available && i + 1 === st.day) ? 'done' : i + 1 === st.day ? 'today' : '';
      return `<div class="day ${cls}"><small>${esc(t('daily_day', { n: i + 1 }))}</small><b>🪙</b><span>${r}</span></div>`;
    })
    .join('');
  const btn = $('#daily-claim');
  btn.disabled = !st.available;
  btn.textContent = st.available ? t('daily_claim', { n: st.reward }) : t('daily_done');
  openSheet('daily');
}

$('#daily-claim').onclick = async () => {
  $('#daily-claim').disabled = true;
  try {
    const { reward, user } = await api('/api/daily/claim', {});
    state.user = user;
    renderWallet();
    closeSheets();
    toast(t('daily_ok', { n: reward }));
  } catch {
    $('#daily-claim').disabled = false;
    toast(t('err_net'));
  }
};

// ---------- Ozel mesajlar ----------

const timeShort = (ts) => new Date(ts).toLocaleTimeString(state.lang === 'tr' ? 'tr-TR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
function timeAgo(ts) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? timeShort(ts) : d.toLocaleDateString(state.lang === 'tr' ? 'tr-TR' : 'en-US');
}

function setUnread(n) {
  $$('.dm-badge').forEach((b) => {
    b.textContent = n > 99 ? '99+' : n;
    b.classList.toggle('hidden', !n);
  });
}

async function openInbox() {
  state.dmWith = null;
  openSheet('inbox');
  try {
    const { conversations, unread } = await api('/api/dm');
    setUnread(unread);
    $('#conv-list').innerHTML = conversations.length
      ? conversations
          .map(
            (c) => `<button class="conv ${c.unread ? 'unread' : ''}" data-conv="${esc(c.name)}">${avatarHtml(c.name)}
          <div><b>${esc(c.name)}</b><small>${c.mine ? `${esc(t('you'))}: ` : ''}${esc(c.text)}</small></div>
          <span class="conv-meta"><small>${timeAgo(c.at)}</small>${c.unread ? `<i class="dm-badge">${c.unread}</i>` : ''}</span></button>`,
          )
          .join('')
      : `<p class="muted tiny">${esc(t('dm_empty'))}</p>`;
  } catch {
    toast(t('err_net'));
  }
}

$('#conv-list').onclick = (e) => {
  const c = e.target.closest('[data-conv]');
  if (c) openThread(c.dataset.conv);
};

$('#dm-new').onsubmit = (e) => {
  e.preventDefault();
  const n = $('#dm-new-name').value.trim();
  if (n) openThread(n);
};

function dmBubble(m) {
  return `<div class="bubble ${m.mine ? 'mine' : ''}" data-id="${m.id}">${esc(m.text)}<small>${timeShort(m.at)}</small></div>`;
}

function scrollThread() {
  const box = $('#thread-msgs');
  box.scrollTop = box.scrollHeight;
}

async function openThread(name) {
  try {
    const data = await api(`/api/dm/${encodeURIComponent(name)}`);
    state.dmWith = data.user.name;
    state.dmBlocked = data.blocked;
    state.dmIBlocked = data.iBlocked;
    $('#dm-new-name').value = '';
    $('#thread-av').innerHTML = avatarHtml(data.user.name);
    $('#thread-name').textContent = data.user.name;
    $('#thread-msgs').innerHTML = data.messages.length ? data.messages.map(dmBubble).join('') : `<p class="muted tiny thread-empty">${esc(t('dm_thread_empty'))}</p>`;
    renderThreadBlock();
    openSheet('thread');
    scrollThread();
    $('#dm-input').focus();
  } catch (err) {
    toast(t(err.code === 'self' ? 'dm_self' : err.code === 'nouser' ? 'dm_nouser' : 'err_net'));
  }
}

function renderThreadBlock() {
  $('#thread-block').textContent = t(state.dmIBlocked ? 'unblock' : 'block');
  $('#thread-blocked').textContent = t('dm_blocked');
  $('#thread-blocked').classList.toggle('hidden', !state.dmBlocked);
  $('#dm-form').classList.toggle('hidden', state.dmBlocked);
}

$('#thread-block').onclick = async () => {
  const name = state.dmWith;
  const block = !state.dmIBlocked;
  if (block && !(await confirmBox(t('block_q', { name }), t('block')))) return openThread(name);
  try {
    await api(`/api/block/${encodeURIComponent(name)}`, { blocked: block });
    toast(t(block ? 'blocked_ok' : 'unblocked_ok', { name }));
  } catch {
    toast(t('err_net'));
  }
  openThread(name);
};

function appendBubble(m) {
  if (document.querySelector(`#thread-msgs [data-id="${m.id}"]`)) return;
  $('#thread-msgs .thread-empty')?.remove();
  $('#thread-msgs').insertAdjacentHTML('beforeend', dmBubble(m));
  scrollThread();
}

$('#dm-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#dm-input').value.trim();
  if (!text || !state.dmWith) return;
  $('#dm-input').value = '';
  try {
    const { message } = await api(`/api/dm/${encodeURIComponent(state.dmWith)}`, { text });
    appendBubble(message);
  } catch (err) {
    $('#dm-input').value = text;
    toast(t(err.code === 'blocked' ? 'dm_blocked' : 'err_net'));
  }
};

const threadOpen = () => !$('#sheet-thread').classList.contains('hidden');

function onDm(m) {
  if (threadOpen() && state.dmWith === m.from) {
    appendBubble({ ...m, mine: false });
    api(`/api/dm/${encodeURIComponent(m.from)}`).catch(() => {}); // okundu olarak isaretle
  } else {
    toast(t('dm_new_msg', { name: m.from }));
  }
}

function onDmSent(m) {
  if (threadOpen() && state.dmWith === m.to) appendBubble({ ...m, mine: true });
}

// ---------- Hediyeler ----------

function renderGifts() {
  $('#gift-grid').innerHTML = state.config.gifts
    .map((g) => `<button class="gift ${state.selectedGift === g.id ? 'active' : ''}" data-gift="${g.id}"><span>${g.emoji}</span><b>${esc(giftName(g.id))}</b><small>🪙 ${fmt(g.coins)}</small></button>`)
    .join('');
}

function giftTargets() {
  const r = state.room;
  if (r.pk) return [{ key: r.pk.a.roomId, name: r.pk.a.hostName }, { key: r.pk.b.roomId, name: r.pk.b.hostName }];
  if (r.type === 'voice') return (r.seats || []).map((s, i) => s && s.socketId !== state.socket.id && { key: i, name: s.name }).filter(Boolean);
  return [];
}

function openGifts() {
  const targets = giftTargets();
  if (state.giftTarget == null || !targets.some((x) => x.key === state.giftTarget)) state.giftTarget = targets[0]?.key ?? null;
  $('#gift-to').classList.toggle('hidden', targets.length < 2);
  $('#gift-to').innerHTML = `<span>${esc(t('to'))}</span>` + targets.map((x) => `<button class="${x.key === state.giftTarget ? 'active' : ''}" data-key="${x.key}">${avatarHtml(x.name)}${esc(x.name)}</button>`).join('');
  state.selectedGift ||= state.config.gifts[0].id;
  renderGifts();
  openSheet('gifts');
}

$('#gift-to').onclick = (e) => {
  const b = e.target.closest('[data-key]');
  if (!b) return;
  const k = b.dataset.key;
  state.giftTarget = state.room.type === 'voice' && !state.room.pk ? Number(k) : k;
  $$('#gift-to button').forEach((x) => x.classList.toggle('active', x === b));
};

$('#gift-grid').onclick = (e) => {
  const b = e.target.closest('[data-gift]');
  if (!b) return;
  state.selectedGift = b.dataset.gift;
  renderGifts();
};

$('#gift-send').onclick = () => {
  const r = state.room;
  const payload = { giftId: state.selectedGift };
  if (r.pk) payload.targetRoomId = state.giftTarget;
  else if (r.type === 'voice') payload.seat = state.giftTarget ?? 0;
  state.socket.emit('gift', payload, (res) => {
    if (res.error === 'coins') {
      toast(t('noCoins'));
      openSheet('wallet');
    } else if (res.error === 'self') toast(t('selfGift'));
  });
};

function onGift(p) {
  const g = giftById(p.gift);
  if (!g || !state.room) return;
  addChat({ name: p.from, gift: p.gift });
  const banner = document.createElement('div');
  banner.className = 'gift-banner';
  banner.innerHTML = `${avatarHtml(p.from)}<div><b>${esc(p.from)}</b><small>→ ${esc(p.to)} · ${esc(giftName(g.id))}</small></div><span class="ge">${g.emoji}</span>`;
  $('#gift-banners').appendChild(banner);
  while ($('#gift-banners').children.length > 3) $('#gift-banners').firstChild.remove();
  setTimeout(() => banner.remove(), 3500);
  if (g.coins >= 50) {
    const burst = document.createElement('div');
    burst.className = `burst ${g.coins >= 499 ? 'huge' : ''}`;
    burst.textContent = g.emoji;
    $('#gift-burst').appendChild(burst);
    setTimeout(() => burst.remove(), g.coins >= 499 ? 3200 : 2200);
  }
}

// ---------- PK ----------

function openPkList() {
  const others = state.rooms.filter((r) => r.type === 'video' && !r.inPk && r.id !== state.room.id);
  $('#pk-list').innerHTML = others.length
    ? others.map((r) => `<div class="pk-item">${avatarHtml(r.hostName)}<div><b>${esc(r.title)}</b><small>${esc(r.hostName)} · ${esc(t('viewers', { n: r.count }))}</small></div><button class="btn primary sm" data-pk="${r.id}">${esc(t('pk_invite'))}</button></div>`).join('')
    : `<p class="muted">${esc(t('pk_none'))}</p>`;
  openSheet('pk');
}

$('#pk-list').onclick = (e) => {
  const b = e.target.closest('[data-pk]');
  if (!b) return;
  state.socket.emit('pk:invite', { targetRoomId: b.dataset.pk }, (res) => {
    toast(res.error ? t('pk_busy') : t('pk_sent'));
    closeSheets();
  });
};

async function onPkInvite({ fromRoomId, fromHost }) {
  const accept = await confirmBox(t('pk_invited', { name: fromHost }), t('pk_accept'));
  state.socket.emit('pk:answer', { fromRoomId, accept });
}

// Her odada kendi yayincimiz solda, rakip sagda gorunur.
function pkSides() {
  const pk = state.room.pk;
  const mineIsA = pk.a.roomId === state.room.id;
  return mineIsA ? [pk.a, pk.b] : [pk.b, pk.a];
}

function onPkStart(pk) {
  if (!state.room) return;
  state.room.pk = pk;
  state.pkEndsAt = Date.now() + pk.endsIn;
  const [, other] = pkSides();
  state.rtc.request(other.hostSocket, 'pk');
  clearInterval(state.pkTimer);
  state.pkTimer = setInterval(renderPkTimer, 500);
  renderRoom();
}

function onPkEnd({ winner }) {
  if (!state.room?.pk) return;
  const [mine, other] = pkSides();
  state.rtc.closeIn(other.hostSocket, 'pk');
  if (state.isHost) state.rtc.closeOutTag('pk');
  const w = winner == null ? null : winner === mine.roomId ? mine : other;
  toast(w ? t('pk_win', { name: w.hostName }) : t('pk_draw'));
  clearInterval(state.pkTimer);
  state.room.pk = null;
  renderRoom();
}

function renderPk() {
  const pk = state.room?.pk;
  $('#pkbar').classList.toggle('hidden', !pk);
  $('#screens').classList.toggle('split', !!pk);
  $('#screen-side').classList.toggle('hidden', !pk);
  if (!pk) {
    $('#name-main').textContent = '';
    return;
  }
  const [mine, other] = pkSides();
  const a = pk.scores[mine.roomId] || 0;
  const b = pk.scores[other.roomId] || 0;
  $('#pk-left').textContent = fmt(a);
  $('#pk-right').textContent = fmt(b);
  $('#pk-fill').style.width = `${a + b === 0 ? 50 : Math.max(8, Math.min(92, (a / (a + b)) * 100))}%`;
  $('#name-main').textContent = mine.hostName;
  $('#name-side').textContent = other.hostName;
  renderPkTimer();
}

function renderPkTimer() {
  const s = Math.max(0, Math.ceil((state.pkEndsAt - Date.now()) / 1000));
  $('#pk-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- Sesli oda ----------

function onSeats(seats) {
  const r = state.room;
  if (!r || r.type !== 'voice') return;
  r.seats = seats;
  const now = new Set(seats.filter(Boolean).map((s) => s.socketId));
  const myId = state.socket.id;
  // Yeni konusmacilarin sesini iste, kalkanlarin baglantisini kapat.
  for (const id of now) {
    if (id !== myId && !state.voiceReq.has(id)) {
      state.voiceReq.add(id);
      state.rtc.request(id, 'voice');
    }
  }
  for (const id of [...state.voiceReq]) {
    if (!now.has(id)) {
      state.voiceReq.delete(id);
      state.rtc.closeIn(id, 'voice');
    }
  }
  renderSeats();
  renderRoomActions();
}

function renderSeats() {
  const r = state.room;
  const myId = state.socket.id;
  const seated = r.seats.some((s) => s?.socketId === myId);
  $('#seats').innerHTML = r.seats
    .map((s, i) => {
      if (!s) return `<button class="seat free" data-seat="${i}" ${seated ? 'disabled' : ''}><span class="seat-av">+</span><small>${esc(seated ? t('seat_empty') : t('seat_take'))}</small></button>`;
      return `<button class="seat ${i === 0 ? 'host' : ''} ${s.muted ? 'muted' : ''}" data-seat="${i}">${avatarHtml(s.name, 'seat-av')}<small>${esc(s.name)}</small>${s.muted ? '<i class="mic-off">🔇</i>' : ''}</button>`;
    })
    .join('');
}

$('#seats').onclick = async (e) => {
  const b = e.target.closest('[data-seat]');
  if (!b) return;
  const i = Number(b.dataset.seat);
  const s = state.room.seats[i];
  if (!s) {
    state.micStream = await getMic();
    state.socket.emit('seat:take', { index: i }, (res) => {
      if (res.error) stopMic();
    });
  } else if (state.isHost && i > 0) {
    if (await confirmBox(`${s.name}: ${t('seat_kick')}?`, t('seat_kick'))) state.socket.emit('seat:kick', { index: i });
  } else if (s.socketId !== state.socket.id) {
    state.giftTarget = i;
    openGifts();
  }
};

// ---------- Sikayet ----------

const REASONS = {
  tr: ['Çıplaklık ya da cinsel içerik', 'Şiddet ya da tehlikeli davranış', '18 yaş altı yayıncı', 'Nefret söylemi ya da taciz', 'Dolandırıcılık ya da spam'],
  en: ['Nudity or sexual content', 'Violence or dangerous acts', 'Streamer under 18', 'Hate speech or harassment', 'Scam or spam'],
};

function openReport() {
  $('#report-reasons').innerHTML = REASONS[state.lang].map((r, i) => `<button class="btn ghost" data-reason="${i}">${esc(r)}</button>`).join('');
  openSheet('report');
}

$('#report-reasons').onclick = (e) => {
  const b = e.target.closest('[data-reason]');
  if (!b) return;
  state.socket.emit('report', { reason: REASONS.en[b.dataset.reason] }, () => {
    closeSheets();
    toast(t('report_ok'));
  });
};

// ---------- Genel tiklamalar ----------

document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-action]')?.dataset.action;
  if (!a) return;
  switch (a) {
    case 'login':
      state.pending = null;
      openLogin(false);
      break;
    case 'auth-close':
      enterGuest();
      break;
    case 'lang':
      state.lang = state.lang === 'tr' ? 'en' : 'tr';
      store.set('sahne_lang', state.lang);
      applyLang();
      break;
    case 'wallet':
      refreshAds();
      renderWallet();
      openSheet('wallet');
      break;
    case 'golive':
      openSheet('golive');
      break;
    case 'inbox':
      openInbox();
      break;
    case 'my-profile':
      openProfile(state.user.name);
      break;
    case 'leaderboard':
      openLeaderboard();
      break;
    case 'daily':
      openDaily(false);
      break;
    case 'close-game':
      closeGame();
      break;
    case 'mp-quit':
      quitMp();
      break;
    case 'ad':
      watchRewardedAd();
      break;
    case 'push':
      if (state.pushOn) disablePush(true).then(() => toast(t('push_off')));
      else enablePush(false);
      break;
    case 'delete-account':
      $('#delete-pass').value = '';
      $('#delete-confirm').checked = false;
      $('#delete-pass').classList.toggle('hidden', !!state.user.google);
      $('#delete-confirm-row').classList.toggle('hidden', !state.user.google);
      $('#delete-q').textContent = t(state.user.google ? 'delete_q_google' : 'delete_q');
      $('#delete-error').textContent = '';
      openSheet('delete');
      break;
    case 'close-sheet':
      closeSheets();
      break;
    case 'logout':
      logout();
      break;
    case 'leave':
      leaveRoom();
      break;
    case 'gifts':
      openGifts();
      break;
    case 'pk':
      openPkList();
      break;
    case 'report':
      openReport();
      break;
    case 'toggle-cam':
    case 'toggle-mic': {
      const tr = a === 'toggle-cam' ? state.localStream?.getVideoTracks()[0] : state.localStream?.getAudioTracks()[0];
      if (tr) tr.enabled = !tr.enabled;
      renderRoomActions();
      break;
    }
    case 'voice-mute': {
      const mine = state.room.seats.find((s) => s?.socketId === state.socket.id);
      const tr = state.micStream?.getAudioTracks()[0];
      const muted = !mine?.muted;
      if (tr) tr.enabled = !muted;
      state.socket.emit('seat:mute', { muted });
      break;
    }
    case 'seat-leave':
      state.socket.emit('seat:leave');
      stopMic();
      break;
  }
});

$('#backdrop').onclick = () => {
  if (!$('#sheet-confirm').classList.contains('hidden')) return $('#confirm-no').click();
  closeSheets();
};

$$('#sheet-golive .choice').forEach((b) => {
  b.onclick = () => {
    state.goliveType = b.dataset.type;
    $$('#sheet-golive .choice').forEach((x) => x.classList.toggle('active', x === b));
  };
});
$('#golive-start').onclick = goLive;

$('#delete-yes').onclick = async () => {
  const google = state.user?.google;
  const pass = $('#delete-pass').value;
  if (google ? !$('#delete-confirm').checked : !pass) return;
  try {
    await api('/api/account/delete', google ? { confirm: true } : { pass });
  } catch (err) {
    $('#delete-error').textContent = t(err.code === 'pass' ? 'err_pass_wrong' : 'err_net');
    return;
  }
  await logout();
  toast(t('err_deleted'));
};

// ---------- Oyunlar ----------
// GameDistribution oyunlari: liste sunucudan gelir, oyun tam ekran cercevede acilir.

state.games = null;
state.gameCat = 'all';

async function renderGames() {
  $('#room-empty').classList.add('hidden');
  if (!state.games) {
    $('#room-grid').innerHTML = `<p class="muted tiny">${esc(t('games_loading'))}</p>`;
    try {
      state.games = await api('/api/games');
    } catch {
      $('#room-grid').innerHTML = `<p class="muted tiny">${esc(t('err_net'))}</p>`;
      return;
    }
    if (state.tab !== 'games') return;
  }
  const { games, cats } = state.games;
  $('#game-cats').innerHTML = ['all', ...cats]
    .map((c) => `<button data-cat="${esc(c)}" class="${c === state.gameCat ? 'active' : ''}">${esc(t(`gc_${c}`) || c)}</button>`)
    .join('');
  const list = state.gameCat === 'all' ? games : games.filter((g) => g.cat === state.gameCat);
  $('#room-grid').innerHTML = list.length
    ? list
        .map(
          (g) => `<button class="card game-card" data-game="${esc(g.id)}" data-title="${esc(g.title)}">
        <img src="${esc(g.thumb)}" alt="" loading="lazy">
        <div class="card-info"><b>${esc(g.title)}</b></div>
      </button>`,
        )
        .join('')
    : `<p class="muted tiny">${esc(t('games_empty'))}</p>`;
}

$('#game-cats').onclick = (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  state.gameCat = b.dataset.cat;
  renderGames();
};

function openGame(id, title) {
  $('#game-title').textContent = title;
  const ref = encodeURIComponent(`${location.origin}/oyun/${id}`);
  $('#game-frame').src = `https://html5.gamedistribution.com/${encodeURIComponent(id)}/?gd_sdk_referrer_url=${ref}`;
  $('#game-view').classList.remove('hidden');
  // Telefonda geri tusu oyunu kapatsin.
  history.pushState({ game: id }, '');
}

function closeGame(fromHistory) {
  if ($('#game-view').classList.contains('hidden')) return;
  $('#game-view').classList.add('hidden');
  $('#game-frame').src = 'about:blank';
  maybeInterstitial();
  if (!fromHistory && history.state?.game) history.back();
}

window.addEventListener('popstate', () => closeGame(true));

// ---------- Cok oyunculu oyunlar ----------
// XOX, Dort Bagla ve Tas-Kagit-Makas: rastgele rakip ya da davetle, hamleler sunucuda dogrulanir.

const MP_ICONS = { r: '✊', p: '✋', s: '✌️' };
state.mp = null; // aktif mac
state.mpWait = null; // rakip aranan oyun

const mpName = (game) => t(`mp_${game}`);

function openMpSheet(opts) {
  state.mpSheet = opts;
  renderMpSheet();
  openSheet('mp');
}

function renderMpSheet() {
  const o = state.mpSheet || {};
  const body = $('#mp-sheet-body');
  if (o.target) {
    $('#mp-sheet-title').textContent = t('mp_invite_q', { name: o.target });
    body.innerHTML = ['xox', 'c4', 'rps']
      .map((g) => `<button class="btn ghost" data-mp-invite="${g}" data-name="${esc(o.target)}">${esc(mpName(g))}</button>`)
      .join('');
    return;
  }
  $('#mp-sheet-title').textContent = mpName(o.game);
  if (state.mpWait === o.game) {
    body.innerHTML = `<p class="mp-wait"><span class="spinner"></span>${esc(t('mp_searching'))}</p>
      <button class="btn ghost" data-mp-cancel>${esc(t('cancel'))}</button>`;
    return;
  }
  const friends = [...state.following].slice(0, 12);
  body.innerHTML = `<button class="btn primary" data-mp-queue="${o.game}">🎲 ${esc(t('mp_random'))}</button>
    <p class="muted tiny">${esc(t('mp_or_invite'))}</p>
    <form class="mp-invite-form" data-game="${o.game}"><input name="who" maxlength="20" placeholder="${esc(t('mp_name_ph'))}" autocomplete="off"><button class="btn ghost" type="submit">${esc(t('mp_invite_btn'))}</button></form>
    ${friends.length ? `<div class="mp-friends">${friends.map((n) => `<button data-mp-invite="${o.game}" data-name="${esc(n)}">${avatarHtml(n)}<span>${esc(n)}</span></button>`).join('')}</div>` : ''}`;
}

function mpInvite(game, name) {
  state.socket.emit('mp:invite', { game, name }, (r) => {
    if (r?.ok) {
      closeSheets();
      toast(t('mp_invite_sent', { name }));
    } else toast(t(`mp_err_${r?.error}`) || t('err_net'));
  });
}

$('#mp-games').onclick = (e) => {
  const c = e.target.closest('[data-mp-game]');
  if (c) openMpSheet({ game: c.dataset.mpGame });
};

$('#sheet-mp').addEventListener('click', (e) => {
  const q = e.target.closest('[data-mp-queue]');
  const inv = e.target.closest('[data-mp-invite]');
  if (e.target.closest('[data-mp-cancel]')) {
    state.socket.emit('mp:cancel');
    state.mpWait = null;
    renderMpSheet();
  }
  if (inv) mpInvite(inv.dataset.mpInvite, inv.dataset.name);
  if (q)
    state.socket.emit('mp:queue', { game: q.dataset.mpQueue }, (r) => {
      if (r?.waiting) {
        state.mpWait = q.dataset.mpQueue;
        renderMpSheet();
      } else if (r?.error) toast(t(`mp_err_${r.error}`) || t('err_net'));
    });
});

$('#sheet-mp').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.closest('.mp-invite-form');
  const name = f?.who.value.trim();
  if (name) mpInvite(f.dataset.game, name);
});

function onMpInvited(inv) {
  const box = $('#mp-invite');
  box.innerHTML = `${avatarHtml(inv.from)}<div><b>${esc(t('mp_invited', { name: inv.from }))}</b><small>${esc(mpName(inv.game))}</small></div>
    <button class="btn ghost sm" data-mp-answer="0">${esc(t('mp_no'))}</button><button class="btn primary sm" data-mp-answer="1">${esc(t('mp_yes'))}</button>`;
  box.dataset.id = inv.id;
  box.classList.remove('hidden');
  clearTimeout(state.mpInviteTimer);
  state.mpInviteTimer = setTimeout(() => box.classList.add('hidden'), 30000);
}

$('#mp-invite').onclick = (e) => {
  const b = e.target.closest('[data-mp-answer]');
  if (!b) return;
  const box = $('#mp-invite');
  box.classList.add('hidden');
  state.socket.emit('mp:answer', { id: box.dataset.id, accept: b.dataset.mpAnswer === '1' }, (r) => {
    if (r?.error) toast(t(r.error === 'busy' ? 'mp_err_busy' : 'mp_err_gone'));
  });
};

function onMpState(m) {
  const first = !state.mp || state.mp.id !== m.id;
  state.mp = m;
  state.mpWait = null;
  if (first) {
    closeSheets();
    $('#mp-view').classList.remove('hidden');
    if (!history.state?.mp) history.pushState({ mp: m.id }, '');
  }
  state.mpDeadline = Date.now() + (m.left || 0);
  renderMp();
}

function renderMp() {
  const m = state.mp;
  if (!m) return;
  const me = m.you;
  const other = m.players[1 - me];
  const s = m.state;
  const marks = m.game === 'xox' ? ['❌', '⭕'] : m.game === 'c4' ? ['🔴', '🟡'] : ['', ''];
  $('#mp-head').textContent = mpName(m.game);
  $('#mp-players').innerHTML = [me, 1 - me]
    .map((i) => {
      const active = !m.over && m.game !== 'rps' && m.turn === i;
      const score = m.game === 'rps' ? `<i>${s.score[i]}</i>` : `<i>${marks[i]}</i>`;
      return `<div class="mp-p ${active ? 'active' : ''}">${avatarHtml(m.players[i])}<b>${esc(i === me ? t('mp_you') : m.players[i])}</b>${score}</div>`;
    })
    .join('<span class="mp-vs">VS</span>');

  // Durum satiri
  let status = '';
  if (m.over) status = m.over.winner === null ? t('mp_draw') : m.over.winner === me ? t('mp_won') : t('mp_lost');
  else if (m.game === 'rps') status = s.picks[me] ? t('mp_wait_pick', { name: other }) : t('mp_pick', { n: s.round });
  else status = m.turn === me ? t('mp_your_turn') : t('mp_their_turn', { name: other });
  $('#mp-status').innerHTML = `${esc(status)}${m.over ? '' : ` <span class="mp-timer" id="mp-timer"></span>`}`;
  $('#mp-status').className = `mp-status ${m.over ? (m.over.winner === me ? 'won' : m.over.winner === null ? '' : 'lost') : ''}`;

  // Tahta
  const board = $('#mp-board');
  board.className = `mp-board ${m.game}`;
  if (m.game === 'xox') {
    board.innerHTML = s.board
      .map((c, i) => `<button data-cell="${i}" class="${s.line?.includes(i) ? 'win' : ''}" ${c !== null || m.over || m.turn !== me ? 'disabled' : ''}>${c === null ? '' : marks[c]}</button>`)
      .join('');
  } else if (m.game === 'c4') {
    board.innerHTML = s.board
      .map((c, i) => `<button data-col="${i % 7}" class="${c === null ? '' : `p${c}`} ${s.line?.includes(i) ? 'win' : ''} ${s.lastCell === i ? 'last' : ''}" ${m.over || m.turn !== me ? 'disabled' : ''}></button>`)
      .join('');
  } else {
    const last = s.last
      ? `<div class="rps-last"><span>${MP_ICONS[s.last.picks[me]]}</span><small>${esc(s.last.winner === null ? t('mp_round_draw') : s.last.winner === me ? t('mp_round_won') : t('mp_round_lost'))}</small><span>${MP_ICONS[s.last.picks[1 - me]]}</span></div>`
      : '';
    board.innerHTML = `${last}<div class="rps-picks">${['r', 'p', 's']
      .map((p) => `<button data-pick="${p}" class="${s.picks[me] === p ? 'chosen' : ''}" ${s.picks[me] || m.over ? 'disabled' : ''}>${MP_ICONS[p]}</button>`)
      .join('')}</div>${s.picks[1 - me] === '?' && !m.over ? `<p class="muted tiny">${esc(t('mp_they_picked', { name: other }))}</p>` : ''}`;
  }

  // Bitis
  const end = $('#mp-end');
  end.classList.toggle('hidden', !m.over);
  if (m.over) {
    const xp = m.over.winner === null ? 5 : m.over.winner === me ? 20 : 0;
    const left = m.over.reason === 'left' || m.oppLeft;
    const why = [m.over.reason === 'timeout' ? t('mp_timeout') : '', left ? t('mp_opp_left') : ''].filter(Boolean).join(' ');
    end.innerHTML = `${why ? `<p class="muted tiny">${esc(why)}</p>` : ''}${xp ? `<p class="mp-xp">+${xp} XP</p>` : ''}
      <button class="btn primary" data-mp-again ${left ? 'disabled' : ''}>${esc(t('mp_again'))}</button>
      <button class="btn ghost" data-action="mp-quit">${esc(t('mp_exit'))}</button>`;
  }
}

// Sira suresi geri sayimi
setInterval(() => {
  const el = $('#mp-timer');
  if (!el || !state.mp || state.mp.over) return;
  const sec = Math.max(0, Math.ceil((state.mpDeadline - Date.now()) / 1000));
  el.textContent = `⏱ ${sec}`;
  el.classList.toggle('low', sec <= 5);
}, 250);

$('#mp-board').onclick = (e) => {
  const b = e.target.closest('button:not([disabled])');
  if (!b || !state.mp) return;
  if (b.dataset.cell) state.socket.emit('mp:move', { move: Number(b.dataset.cell) });
  if (b.dataset.col) state.socket.emit('mp:move', { move: Number(b.dataset.col) });
  if (b.dataset.pick) state.socket.emit('mp:move', { move: b.dataset.pick });
};

$('#mp-end').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mp-again]');
  if (!b) return;
  state.socket.emit('mp:again');
  b.disabled = true;
  b.textContent = t('mp_again_wait');
});

async function quitMp(fromHistory) {
  if (!state.mp) return;
  if (!state.mp.over && !(await confirmBox(t('mp_quit_q'), t('mp_exit')))) {
    if (fromHistory) history.pushState({ mp: state.mp.id }, '');
    return;
  }
  state.socket.emit('mp:leave');
  state.mp = null;
  maybeInterstitial();
  $('#mp-view').classList.add('hidden');
  if (!fromHistory && history.state?.mp) history.back();
}

window.addEventListener('popstate', () => {
  if (state.mp && !$('#mp-view').classList.contains('hidden')) quitMp(true);
});

function mpSocket(socket) {
  socket.on('mp:state', onMpState);
  socket.on('mp:invited', onMpInvited);
  socket.on('mp:declined', ({ name }) => toast(t('mp_declined', { name })));
  socket.on('mp:again', ({ name }) => toast(t('mp_again_asked', { name })));
  socket.on('mp:left', () => {
    if (state.mp?.over) {
      state.mp.oppLeft = true;
      renderMp();
    }
  });
}

// ---------- Reklamlar (yalniz Android uygulamasinda) ----------
// Odullu reklam izleyen jeton kazanir; tam ekran reklam yalniz oyun bitince ve en fazla 3 dakikada bir cikar.

const adsApp = () => typeof window.LafelloApp?.showRewarded === 'function';
state.adsLeft = 0;
state.lastInterstitial = Date.now();

async function refreshAds() {
  const b = $('#ad-btn');
  b.classList.toggle('hidden', !adsApp());
  if (!adsApp()) return;
  try {
    const r = await api('/api/ads');
    state.adsLeft = r.left;
    b.disabled = r.left <= 0;
    b.textContent = r.left > 0 ? t('ad_watch', { n: r.reward, left: r.left }) : t('ad_done');
  } catch {}
}

// Uygulama reklam sonucunu window.lafelloAd ile bildirir: 'reward', 'closed', 'failed'.
function showAd(kind) {
  return new Promise((resolve) => {
    let rewarded = false;
    window.lafelloAd = (ev) => {
      if (ev === 'reward') rewarded = true;
      if (ev === 'closed' || ev === 'failed') resolve(ev === 'failed' ? 'failed' : rewarded ? 'reward' : 'closed');
    };
    try {
      if (kind === 'rewarded') window.LafelloApp.showRewarded();
      else window.LafelloApp.showInterstitial();
    } catch {
      resolve('failed');
    }
  });
}

async function watchRewardedAd() {
  const b = $('#ad-btn');
  b.disabled = true;
  try {
    const { ticket } = await api('/api/ads/start', {});
    const result = await showAd('rewarded');
    if (result === 'reward') {
      const r = await api('/api/ads/claim', { ticket });
      state.user = r.user;
      renderWallet();
      toast(t('ad_ok', { n: r.reward }));
    } else if (result === 'failed') toast(t('ad_none'));
  } catch {
    toast(t('ad_none'));
  }
  refreshAds();
}

function maybeInterstitial() {
  if (!adsApp() || Date.now() - state.lastInterstitial < 3 * 60 * 1000) return;
  state.lastInterstitial = Date.now();
  showAd('interstitial');
}

// ---------- Telefon bildirimleri ----------

document.addEventListener('visibilitychange', () => state.socket?.emit('presence', { away: document.hidden }));

// Android uygulamasinda bildirimler uygulamanin kendisinden (Firebase) gelir; sitede tarayicidan.
const androidApp = () => window.LafelloApp;
const webPushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushSupported = () => !!androidApp() || webPushOk();

async function pushSubscription() {
  if (!webPushOk()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function urlKey(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// Uygulamadan bildirim izni ve cihaz anahtari ister. Cevap window.lafelloPush ile gelir.
function androidToken(ask) {
  return new Promise((resolve) => {
    window.lafelloPush = (token) => resolve(token || '');
    try {
      androidApp().requestPush(!!ask);
    } catch {
      resolve('');
    }
    setTimeout(() => resolve(''), 60000);
  });
}

// Izin ister, cihazi bu hesaba abone eder. quiet: izin zaten verildiyse sessizce yeniler.
async function enablePush(quiet) {
  if (!pushSupported()) {
    if (!quiet) toast(t('push_unsupported'));
    return false;
  }
  if (quiet && store.get('sahne_push_off')) return false;
  try {
    if (androidApp()) {
      const token = await androidToken(!quiet);
      if (!token) {
        if (!quiet) toast(t('push_denied'));
        return false;
      }
      await api('/api/push/fcm', { token, lang: state.lang });
      state.fcmToken = token;
    } else {
      if (quiet && Notification.permission !== 'granted') return false;
      if ((await Notification.requestPermission()) !== 'granted') {
        if (!quiet) toast(t('push_denied'));
        return false;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { key } = await api('/api/push/key');
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(key) });
      }
      await api('/api/push/subscribe', { sub: sub.toJSON(), lang: state.lang });
    }
    store.del('sahne_push_off');
    state.pushOn = true;
    renderPushBtn();
    if (!quiet) toast(t('push_ok'));
    return true;
  } catch {
    if (!quiet) toast(t('err_net'));
    return false;
  }
}

// byUser: kullanici kendisi kapattiysa bir sonraki acilista sessizce yeniden acilmaz.
async function disablePush(byUser) {
  try {
    if (state.fcmToken) {
      await api('/api/push/fcm/remove', { token: state.fcmToken }).catch(() => {});
      state.fcmToken = null;
    }
    const sub = await pushSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {}
  if (byUser) store.set('sahne_push_off', '1');
  state.pushOn = false;
  renderPushBtn();
}

function renderPushBtn() {
  const b = $('#push-btn');
  b.classList.toggle('hidden', !pushSupported());
  b.textContent = state.pushOn ? t('push_active') : t('push_enable');
}

// Bildirimden gelen adres: ?room=ID ya da ?dm=isim
function openFromUrl(url) {
  const p = new URL(url, location.href).searchParams;
  if (p.get('room')) joinRoom(p.get('room'));
  else if (p.get('dm')) openThread(p.get('dm'));
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.open && state.user) openFromUrl(e.data.open);
  });
}

// ---------- Baslangic ----------

// Telefona yuklenebilmesi icin hizmet calisani.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

(async function boot() {
  applyLang();
  try {
    state.config = await api('/api/config');
  } catch {
    $('#auth-error').textContent = t('err_net');
  }
  applyLang();
  setupGoogle();
  if (state.token) {
    try {
      const { user } = await api('/api/me');
      return enterApp(user);
    } catch {
      store.del('sahne_token');
      state.token = null;
    }
  }
  enterGuest();
  // Bildirimden gelen adresle misafir acilirsa once giris istenir.
  if (location.search) openLogin(true);
})();
