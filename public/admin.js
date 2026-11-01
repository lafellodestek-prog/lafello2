// Lafello yonetim paneli: genel durum, canli yayinlar, sikayetler, kapatilan hesaplar.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const st = {
  token: sessionStorage.getItem('sahne_admin'),
  tab: 'rooms',
  reports: 'open',
  data: null,
  timer: null,
  setupMode: false,
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('tr-TR');
const REASONS = {
  'Nudity or sexual content': 'Çıplaklık ya da cinsel içerik',
  'Violence or dangerous acts': 'Şiddet ya da tehlikeli davranış',
  'Streamer under 18': '18 yaş altı yayıncı',
  'Hate speech or harassment': 'Nefret söylemi ya da taciz',
  'Scam or spam': 'Dolandırıcılık ya da spam',
};

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} sn önce`;
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return new Date(ts).toLocaleDateString('tr-TR');
}
function duration(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  return m < 60 ? `${m} dk` : `${Math.floor(m / 60)} sa ${m % 60} dk`;
}

let toastTimer;
function toast(msg) {
  $('#toast').textContent = msg;
  $('#toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 3000);
}

function confirmBox(text, yes) {
  return new Promise((resolve) => {
    $('#confirm-text').textContent = text;
    $('#confirm-yes').textContent = yes;
    $('#backdrop').classList.remove('hidden');
    $('#sheet-confirm').classList.remove('hidden');
    const done = (v) => {
      $('#backdrop').classList.add('hidden');
      $('#sheet-confirm').classList.add('hidden');
      resolve(v);
    };
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = $('#backdrop').onclick = () => done(false);
  });
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(st.token ? { Authorization: `Bearer ${st.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && st.token) {
    signOut();
    throw new Error('auth');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'net'), { code: data.error || 'net' });
  return data;
}

// ---------- Giris ----------

async function showLogin() {
  $('#a-main').classList.add('hidden');
  $('#a-login').classList.remove('hidden');
  const { setup, local } = await api('/api/admin/status');
  st.setupMode = !setup;
  $('#a-pass2').classList.toggle('hidden', setup);
  $('#a-pass2').required = !setup;
  $('#a-pass').autocomplete = setup ? 'current-password' : 'new-password';
  $('#a-login-btn').textContent = setup ? 'Giriş yap' : 'Şifreyi belirle';
  $('#a-login-btn').disabled = !setup && !local;
  $('#a-login-hint').textContent = setup
    ? ''
    : local
      ? 'İlk giriş: kendine en az 8 karakterli bir yönetici şifresi belirle.'
      : 'Panel henüz kurulmadı. İlk şifreyi uygulamanın çalıştığı bilgisayardan belirlemelisin.';
}

$('#a-login-form').onsubmit = async (e) => {
  e.preventDefault();
  const pass = $('#a-pass').value;
  $('#a-login-error').textContent = '';
  if (st.setupMode && pass !== $('#a-pass2').value) return ($('#a-login-error').textContent = 'İki şifre aynı değil.');
  try {
    const { token } = await api(st.setupMode ? '/api/admin/setup' : '/api/admin/login', { pass });
    st.token = token;
    sessionStorage.setItem('sahne_admin', token);
    $('#a-pass').value = $('#a-pass2').value = '';
    start();
  } catch (err) {
    $('#a-login-error').textContent =
      { login: 'Şifre yanlış.', wait: 'Çok fazla hatalı deneme. 10 dakika sonra tekrar dene.', short: 'Şifre en az 8 karakter olmalı.', local: 'İlk şifre yalnız bu bilgisayardan belirlenebilir.' }[err.code] ||
      'Bağlantı kurulamadı.';
  }
};

function signOut() {
  clearInterval(st.timer);
  st.token = null;
  sessionStorage.removeItem('sahne_admin');
  showLogin();
}

$('#a-logout').onclick = async () => {
  await api('/api/admin/logout', {}).catch(() => {});
  signOut();
};

// ---------- Panel ----------

async function refresh() {
  try {
    st.data = await api(`/api/admin/overview?reports=${st.reports}`);
  } catch {
    return;
  }
  render();
  if (st.tab === 'demo') loadDemo();
  if (st.tab === 'users' && document.activeElement !== $('#u-search') && $('#sheet-coins').classList.contains('hidden')) loadUsers();
  $('#a-updated').textContent = `Güncellendi ${new Date().toLocaleTimeString('tr-TR')}`;
}

function start() {
  $('#a-login').classList.add('hidden');
  $('#a-main').classList.remove('hidden');
  refresh();
  clearInterval(st.timer);
  st.timer = setInterval(refresh, 5000);
}

function render() {
  const { stats: s, rooms, reports, banned } = st.data;
  const card = (label, value, sub = '', cls = '') => `<div class="stat ${cls}"><small>${label}</small><b>${value}</b><span>${sub}</span></div>`;
  $('#a-stats').innerHTML = [
    card('Canlı yayın', fmt(s.liveRooms), `${fmt(s.viewers)} izleyici`),
    card('Çevrim içi', fmt(s.online), 'şu an bağlı kişi'),
    card('Kullanıcı', fmt(s.users), `bugün +${fmt(s.usersToday)}`),
    card('Satılan jeton', fmt(s.coinsSold), `bugün ${fmt(s.coinsSoldToday)}`),
    card('Hediye (jeton)', fmt(s.giftCoins), `bugün ${fmt(s.giftCoinsToday)} · ${fmt(s.giftsToday)} adet`),
    card('Bekleyen şikayet', fmt(s.openReports), `${fmt(s.banned)} hesap kapalı`, s.openReports ? 'warn' : ''),
  ].join('');

  $('#c-rooms').textContent = rooms.length || '';
  $('#c-users').textContent = s.users || '';
  $('#c-demo').textContent = s.demoUsers || '';
  $('#push-count').textContent = fmt(s.pushUsers || 0);
  $('#c-reports').textContent = s.openReports || '';
  $('#c-banned').textContent = banned.length || '';

  $('#tab-rooms').innerHTML = rooms.length
    ? rooms
        .map(
          (r) => `<div class="a-item">
        <div class="info">
          <b>${r.inPk ? '<span class="chip pk">PK</span>' : ''}<span class="chip">${{ voice: 'Sesli oda', chat: 'Sohbet odası' }[r.type] || 'Görüntülü'}</span>${esc(r.title)}</b>
          <small>${esc(r.hostName)} · ${fmt(r.viewers)} izleyici · ${duration(r.startedAt)} · ${fmt(r.giftCoins)} jeton hediye</small>
        </div>
        <div class="actions">
          <button class="btn ghost" data-close="${r.id}" data-title="${esc(r.title)}">Yayını kapat</button>
          <button class="btn danger" data-ban="${r.hostId}" data-name="${esc(r.hostName)}">Hesabı kapat</button>
        </div>
      </div>`,
        )
        .join('')
    : '<p class="a-empty">Şu an açık yayın yok.</p>';

  $('#a-reports').innerHTML = reports.length
    ? reports
        .map(
          (r) => `<div class="a-item">
        <div class="info">
          <b>${esc(r.targetName)} ${r.targetReports > 1 ? `<span class="chip red">${r.targetReports} şikayet</span>` : ''}${r.targetBanned ? '<span class="chip">kapalı</span>' : ''}</b>
          <small>${esc(REASONS[r.reason] || r.reason)} · şikayet eden: ${esc(r.fromName)} · ${ago(r.at)}</small>
        </div>
        ${
          r.status === 'open'
            ? `<div class="actions">
          <button class="btn ghost" data-resolve="${r.id}">Sorun yok</button>
          ${r.targetBanned ? '' : `<button class="btn danger" data-ban="${r.targetId}" data-name="${esc(r.targetName)}">Hesabı kapat</button>`}
        </div>`
            : ''
        }
      </div>`,
        )
        .join('')
    : `<p class="a-empty">${st.reports === 'open' ? 'Bekleyen şikayet yok.' : 'Henüz çözülen şikayet yok.'}</p>`;

  $('#tab-banned').innerHTML = banned.length
    ? banned
        .map(
          (u) => `<div class="a-item"><div class="info"><b>${esc(u.name)}</b></div>
        <div class="actions"><button class="btn ghost" data-unban="${u.id}" data-name="${esc(u.name)}">Hesabı aç</button></div></div>`,
        )
        .join('')
    : '<p class="a-empty">Kapatılan hesap yok.</p>';
}

$('#a-tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  st.tab = b.dataset.tab;
  $$('#a-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  for (const t of ['rooms', 'users', 'reports', 'banned', 'demo', 'push']) $(`#tab-${t}`).classList.toggle('hidden', t !== st.tab);
  if (st.tab === 'users') loadUsers();
  if (st.tab === 'demo') loadDemo();
};

// ---------- Bildirim gonder ----------

$('#push-form').onsubmit = async (e) => {
  e.preventDefault();
  const title = $('#push-title').value.trim();
  const body = $('#push-body').value.trim();
  if (!title || !body) return;
  if (!(await confirmBox(`"${title}" bildirimi bildirim alan herkese gönderilsin mi?`, 'Gönder'))) return;
  try {
    const { sent } = await api('/api/admin/push', { title, body });
    toast(`Bildirim ${fmt(sent)} cihaza gönderildi.`);
    $('#push-form').reset();
  } catch (err) {
    toast(err.message === 'wait' ? 'Az önce gönderdin, 30 saniye bekle.' : 'Gönderilemedi, tekrar dene.');
  }
};

// ---------- Deneme hesaplari ----------

async function loadDemo() {
  let users, chat;
  try {
    ({ users, chat } = await api('/api/admin/demo'));
  } catch {
    return;
  }
  st.demoChat = chat;
  $('#demo-chat-state').textContent = chat ? 'açık' : 'kapalı';
  $('#demo-chat-state').classList.toggle('green', chat);
  $('#demo-chat-btn').textContent = chat ? 'Kapat' : 'Aç';
  $('#demo-clear').classList.toggle('hidden', !users.length);
  $('#demo-list').innerHTML = users.length
    ? users
        .map(
          (u) => `<div class="a-item">
        <div class="info">
          <b>${esc(u.name)}${u.online ? '<span class="online-dot" title="Şu an bağlı"></span>' : ''} ${u.banned ? '<span class="chip red">kapalı</span>' : ''}</b>
          <div class="u-nums"><span>Şifre <b class="demo-pass">${esc(u.pass)}</b></span><span>🪙 <b>${fmt(u.coins)}</b></span></div>
        </div>
        <div class="actions">
          <button class="btn ghost" data-copy="${esc(u.name)}" data-pass="${esc(u.pass)}">Kopyala</button>
          <button class="btn ghost" data-demo-del="${u.id}" data-name="${esc(u.name)}">Sil</button>
        </div>
      </div>`,
        )
        .join('')
    : '<p class="a-empty">Henüz deneme hesabı yok. Yukarıdan açabilirsin.</p>';
}

$('#demo-chat-btn').onclick = async () => {
  try {
    const { on } = await api('/api/admin/demo/chat', { on: !st.demoChat });
    toast(on ? 'Demo sohbet açıldı.' : 'Demo sohbet kapatıldı.');
  } catch {
    toast('Olmadı, tekrar dene.');
  }
  loadDemo();
};

$('#demo-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const { created } = await api('/api/admin/demo', { count: parseInt($('#demo-count').value, 10), coins: parseInt($('#demo-coins').value, 10) });
    toast(`${created.length} deneme hesabı açıldı.`);
    loadDemo();
  } catch {
    toast('Hesap sayısı 1-20, jeton 0-100.000 arası olmalı.');
  }
};

$('#demo-list').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const text = `Kullanıcı adı: ${copy.dataset.copy}\nŞifre: ${copy.dataset.pass}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Giriş bilgisi kopyalandı.');
    } catch {
      toast(text.replace('\n', ' · '));
    }
    return;
  }
  const del = e.target.closest('[data-demo-del]');
  if (!del) return;
  if (!(await confirmBox(`${del.dataset.name} silinsin mi? Mesajları da silinir.`, 'Sil'))) return;
  await api(`/api/admin/demo/${del.dataset.demoDel}/delete`, {}).catch(() => toast('Silinemedi.'));
  loadDemo();
});

$('#demo-clear').onclick = async () => {
  if (!(await confirmBox('Tüm deneme hesapları silinsin mi? Açık yayınları kapanır, mesajları silinir.', 'Hepsini sil'))) return;
  const { deleted } = await api('/api/admin/demo/delete-all', {});
  toast(`${deleted} deneme hesabı silindi.`);
  loadDemo();
};

// ---------- Kullanicilar ----------

st.userQuery = '';
st.userPage = 0;

async function loadUsers() {
  try {
    st.users = await api(`/api/admin/users?q=${encodeURIComponent(st.userQuery)}&page=${st.userPage}`);
  } catch {
    return;
  }
  renderUsers();
}

function renderUsers() {
  const { users, total, page, pages } = st.users;
  $('#u-summary').textContent = st.userQuery ? `"${st.userQuery}" için ${fmt(total)} hesap bulundu.` : `Toplam ${fmt(total)} hesap.`;
  $('#u-list').innerHTML = users.length
    ? users
        .map(
          (u) => `<div class="a-item">
        <div class="info">
          <b>${esc(u.name)}${u.online ? '<span class="online-dot" title="Şu an bağlı"></span>' : ''} ${u.banned ? '<span class="chip red">kapalı</span>' : ''}${u.reports ? `<span class="chip">${u.reports} şikayet</span>` : ''}${u.demo ? '<span class="chip">deneme</span>' : ''}</b>
          <div class="u-nums">
            <span>Katıldı <b>${new Date(u.createdAt).toLocaleDateString('tr-TR')}</b></span>
            <span>🪙 <b>${fmt(u.coins)}</b></span>
            <span>💎 <b>${fmt(u.diamonds)}</b></span>
            <span>Satın aldı <b>${fmt(u.bought)}</b></span>
            <span>Hediye gönderdi <b>${fmt(u.spent)}</b></span>
            <span>Hediye aldı <b>${fmt(u.received)}</b></span>
          </div>
        </div>
        <div class="actions">
          <button class="btn ghost" data-coins="${u.id}" data-name="${esc(u.name)}">Jeton</button>
          ${u.banned
            ? `<button class="btn ghost" data-unban="${u.id}" data-name="${esc(u.name)}">Hesabı aç</button>`
            : `<button class="btn danger" data-ban="${u.id}" data-name="${esc(u.name)}">Hesabı kapat</button>`}
        </div>
      </div>`,
        )
        .join('')
    : '<p class="a-empty">Hesap bulunamadı.</p>';
  $('#u-pager').innerHTML =
    pages > 1
      ? `<button class="btn ghost" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>Önceki</button><span>${page + 1} / ${pages}</span><button class="btn ghost" data-page="${page + 1}" ${page + 1 >= pages ? 'disabled' : ''}>Sonraki</button>`
      : '';
}

let searchTimer;
$('#u-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    st.userQuery = $('#u-search').value.trim();
    st.userPage = 0;
    loadUsers();
  }, 300);
});

$('#u-pager').onclick = (e) => {
  const b = e.target.closest('[data-page]');
  if (!b || b.disabled) return;
  st.userPage = Number(b.dataset.page);
  loadUsers();
};

function coinBox(name) {
  return new Promise((resolve) => {
    $('#coins-title').textContent = `${name}: jeton ekle ya da düş`;
    $('#coins-amount').value = '';
    $('#backdrop').classList.remove('hidden');
    $('#sheet-coins').classList.remove('hidden');
    $('#coins-amount').focus();
    const done = (v) => {
      $('#backdrop').classList.add('hidden');
      $('#sheet-coins').classList.add('hidden');
      resolve(v);
    };
    $('#coins-yes').onclick = () => done(parseInt($('#coins-amount').value, 10));
    $('#coins-no').onclick = $('#backdrop').onclick = () => done(null);
  });
}

$('#u-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-coins]');
  if (!b) return;
  const amount = await coinBox(b.dataset.name);
  if (!amount) return;
  try {
    const { user } = await api(`/api/admin/users/${b.dataset.coins}/coins`, { amount });
    toast(`${user.name}: yeni bakiye ${fmt(user.coins)} jeton.`);
    loadUsers();
  } catch {
    toast('Jeton güncellenemedi.');
  }
});

$('.a-filter').onclick = (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  st.reports = b.dataset.filter;
  $$('.a-filter button').forEach((x) => x.classList.toggle('active', x === b));
  refresh();
};

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-close],[data-ban],[data-unban],[data-resolve]');
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.close) {
      if (!(await confirmBox(`"${d.title}" yayını kapatılsın mı? Yayıncı ve izleyiciler "kurallara aykırı" uyarısı görecek.`, 'Yayını kapat'))) return;
      await api(`/api/admin/rooms/${d.close}/close`, {});
      toast('Yayın kapatıldı.');
    } else if (d.ban) {
      if (!(await confirmBox(`${d.name} hesabı kapatılsın mı? Açık yayını biter ve bir daha giriş yapamaz.`, 'Hesabı kapat'))) return;
      await api(`/api/admin/users/${d.ban}/ban`, { banned: true });
      toast(`${d.name} hesabı kapatıldı.`);
    } else if (d.unban) {
      if (!(await confirmBox(`${d.name} hesabı yeniden açılsın mı?`, 'Hesabı aç'))) return;
      await api(`/api/admin/users/${d.unban}/ban`, { banned: false });
      toast(`${d.name} hesabı açıldı.`);
    } else if (d.resolve) {
      await api('/api/admin/reports/resolve', { ids: [Number(d.resolve)] });
      toast('Şikayet çözüldü olarak işaretlendi.');
    }
  } catch {
    toast('İşlem yapılamadı.');
  }
  refresh();
});

if (st.token) start();
else showLogin();
