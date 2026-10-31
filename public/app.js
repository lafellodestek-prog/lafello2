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
function avatar(el, name) {
  el.textContent = String(name || '?').charAt(0).toUpperCase();
  el.style.background = `linear-gradient(135deg, hsl(${hue(name)} 80% 60%), hsl(${(hue(name) + 50) % 360} 80% 45%))`;
}
function avatarHtml(name, cls = 'avatar') {
  const h = hue(name);
  return `<span class="${cls}" style="background:linear-gradient(135deg,hsl(${h} 80% 60%),hsl(${(h + 50) % 360} 80% 45%))">${esc(String(name).charAt(0).toUpperCase())}</span>`;
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
    state.token = token;
    store.set('sahne_token', token);
    enterApp(user);
  } catch (err) {
    $('#auth-error').textContent = t(`err_${err.code}`);
  }
};

async function logout() {
  await api('/api/logout', {}).catch(() => {});
  await leaveRoom(true);
  state.socket?.disconnect();
  state.socket = null;
  state.token = null;
  state.user = null;
  store.del('sahne_token');
  closeSheets();
  show('auth');
}

// ---------- Ana sayfa ----------

function enterApp(user) {
  state.user = user;
  renderWallet();
  connectSocket();
  show('home');
}

function renderWallet() {
  const u = state.user;
  if (!u || !state.config) return;
  $('#home-coins').textContent = fmt(u.coins);
  $('#gift-coins').textContent = fmt(u.coins);
  $('#wallet-coins').textContent = fmt(u.coins);
  $('#wallet-diamonds').textContent = fmt(u.diamonds);
  $('#wallet-name').textContent = u.name;
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
  const list = state.rooms.filter((r) =>
    state.tab === 'all' ? true : state.tab === 'pk' ? r.inPk : r.type === state.tab,
  );
  $('#room-empty').classList.toggle('hidden', list.length > 0);
  $('#room-grid').innerHTML = list
    .map((r) => {
      const h = hue(r.hostName);
      const meta = r.type === 'voice' ? t('speakers', { n: r.speakers }) : r.type === 'chat' ? t('members', { n: r.count + 1 }) : t('viewers', { n: r.count });
      return `<button class="card" data-room="${r.id}" style="--h:${h}">
        <div class="card-art">${r.type === 'voice' ? '🎙️' : r.type === 'chat' ? '💬' : avatarHtml(r.hostName, 'card-avatar')}</div>
        <div class="badges"><span class="badge live">● LIVE</span>${r.inPk ? '<span class="badge pk">PK</span>' : ''}${r.type === 'voice' ? `<span class="badge">${esc(t('tab_voice'))}</span>` : r.type === 'chat' ? `<span class="badge">${esc(t('tab_chat'))}</span>` : ''}</div>
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
  const c = e.target.closest('[data-room]');
  if (c) joinRoom(c.dataset.room);
};

// ---------- Baglanti ----------

function connectSocket() {
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;

  state.rtc = createRtc(socket, {
    getStream: (tag) => (tag === 'voice' ? state.micStream : state.isHost ? state.localStream : null),
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
    state.user = user;
    renderWallet();
  });
  socket.on('chat', addChat);
  socket.on('dm', onDm);
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
    $('#auth-error').textContent = t('err_banned');
  });
  socket.on('account:deleted', async () => {
    await logout();
    $('#auth-error').textContent = t('err_deleted');
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
  btns.push(`<button class="round gift" data-action="gifts" title="${t('gifts')}">🎁</button>`);
  $('#room-actions').innerHTML = btns.join('');
}

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
  else el.innerHTML = `${m.host ? `<span class="tag">${esc(t('host'))}</span>` : ''}<b data-name="${esc(m.name)}">${esc(m.name)}</b> ${esc(m.text)}`;
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
  $('#user-av').innerHTML = avatarHtml(name, 'avatar big-av');
  $('#user-name').textContent = name;
  const btns = [];
  btns.push(`<button class="btn primary" data-user-act="dm">${esc(t('dm_send'))}</button>`);
  if (state.isHost && state.room) btns.push(`<button class="btn ghost" data-user-act="kick">${esc(t('kick'))}</button>`);
  $('#user-actions').innerHTML = btns.join('');
  $('#user-actions').dataset.name = name;
  openSheet('user');
}

$('#user-actions').onclick = async (e) => {
  const act = e.target.closest('[data-user-act]')?.dataset.userAct;
  const { name } = $('#user-actions').dataset;
  if (act === 'dm') openThread(name);
  if (act === 'kick') {
    closeSheets();
    if ((await confirmBox(t('kick_q', { name }), state.lang === 'tr' ? 'Çıkar' : 'Remove'))) state.socket.emit('room:kick', { name });
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
    case 'lang':
      state.lang = state.lang === 'tr' ? 'en' : 'tr';
      store.set('sahne_lang', state.lang);
      applyLang();
      break;
    case 'wallet':
      renderWallet();
      openSheet('wallet');
      break;
    case 'golive':
      openSheet('golive');
      break;
    case 'inbox':
      openInbox();
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
  if (state.token) {
    try {
      const { user } = await api('/api/me');
      return enterApp(user);
    } catch {
      store.del('sahne_token');
      state.token = null;
    }
  }
  show('auth');
})();
