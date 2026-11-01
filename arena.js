// Iki kisilik canli oyunlar: XOX, Dort Bagla, Tas-Kagit-Makas.
// Rastgele rakip bulma ya da davetle eslesme; hamleler sunucuda dogrulanir. Kazanan XP alir.

const GAMES = {
  xox: { turnMs: 30000 },
  c4: { turnMs: 30000 },
  rps: { turnMs: 20000 },
};
const WIN_XP = 20;
const DRAW_XP = 5;
const INVITE_MS = 30000;

const XOX_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const C4_W = 7;
const C4_H = 6;

let ctx = null;
const queues = new Map(); // oyun -> bekleyen socketId
const matches = new Map(); // maçId -> mac
const invites = new Map(); // davetId -> davet
let nextId = 1;

export function attachArena(c) {
  ctx = c;
}

const sock = (sid) => ctx.io.sockets.sockets.get(sid);
const userOf = (sid) => sock(sid)?.data.user;

// ---------- Oyun kurallari ----------

function newState(game) {
  if (game === 'xox') return { board: Array(9).fill(null) };
  if (game === 'c4') return { board: Array(C4_W * C4_H).fill(null) };
  return { round: 1, score: [0, 0], picks: [null, null], last: null };
}

function xoxResult(b) {
  for (const l of XOX_LINES) if (b[l[0]] !== null && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) return { winner: b[l[0]], line: l };
  return b.every((c) => c !== null) ? { winner: null, line: null } : null;
}

function c4Result(b) {
  const at = (x, y) => (x >= 0 && x < C4_W && y >= 0 && y < C4_H ? b[y * C4_W + x] : null);
  for (let y = 0; y < C4_H; y++)
    for (let x = 0; x < C4_W; x++) {
      const p = at(x, y);
      if (p === null) continue;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const line = [0, 1, 2, 3].map((k) => [x + dx * k, y + dy * k]);
        if (line.every(([lx, ly]) => at(lx, ly) === p)) return { winner: p, line: line.map(([lx, ly]) => ly * C4_W + lx) };
      }
    }
  return b.every((c) => c !== null) ? { winner: null, line: null } : null;
}

const RPS_BEATS = { r: 's', p: 'r', s: 'p' };

// Hamleyi uygular; gecersizse false doner.
function applyMove(m, who, move) {
  const s = m.state;
  if (m.game === 'rps') {
    if (!['r', 'p', 's'].includes(move) || s.picks[who]) return false;
    s.picks[who] = move;
    if (s.picks[0] && s.picks[1]) {
      const [a, b] = s.picks;
      const roundWinner = a === b ? null : RPS_BEATS[a] === b ? 0 : 1;
      if (roundWinner !== null) s.score[roundWinner]++;
      s.last = { picks: [a, b], winner: roundWinner };
      s.picks = [null, null];
      s.round++;
      // Iki tur alan maci kazanir (3 tur uzerinden); beraberliklerle 7 turu gecerse sonuca gore biter.
      if (s.score[0] === 2 || s.score[1] === 2) return finish(m, s.score[0] === 2 ? 0 : 1), true;
      if (s.round > 7) return finish(m, s.score[0] === s.score[1] ? null : s.score[0] > s.score[1] ? 0 : 1), true;
    }
    return true;
  }
  if (m.turn !== who) return false;
  const b = s.board;
  let cell = -1;
  if (m.game === 'xox') {
    if (!Number.isInteger(move) || move < 0 || move > 8 || b[move] !== null) return false;
    cell = move;
  } else {
    if (!Number.isInteger(move) || move < 0 || move >= C4_W) return false;
    for (let y = C4_H - 1; y >= 0; y--) if (b[y * C4_W + move] === null) {
      cell = y * C4_W + move;
      break;
    }
    if (cell < 0) return false;
  }
  b[cell] = who;
  s.lastCell = cell;
  const r = m.game === 'xox' ? xoxResult(b) : c4Result(b);
  if (r) {
    s.line = r.line;
    finish(m, r.winner);
  } else m.turn = 1 - who;
  return true;
}

// ---------- Mac yonetimi ----------

function publicState(m, forIdx) {
  const s = { ...m.state };
  // Tas-kagit-makas: rakibin secimi tur bitene kadar gizli kalir.
  if (m.game === 'rps') s.picks = s.picks.map((p, i) => (i === forIdx ? p : p ? '?' : null));
  return {
    id: m.id,
    game: m.game,
    you: forIdx,
    players: m.players.map((p) => p.name),
    turn: m.turn,
    state: s,
    left: m.endsAt ? Math.max(0, m.endsAt - Date.now()) : 0,
    over: m.over,
  };
}

function emitState(m) {
  m.players.forEach((p, i) => sock(p.sid)?.emit('mp:state', publicState(m, i)));
}

function armTimer(m) {
  clearTimeout(m.timer);
  if (m.over) return;
  const ms = GAMES[m.game].turnMs;
  m.endsAt = Date.now() + ms;
  m.timer = setTimeout(() => {
    if (m.over) return;
    // Sure doldu: siradaki oyuncu kaybeder. TKM'de secim yapmayan kaybeder; ikisi de yapmadiysa berabere.
    if (m.game === 'rps') {
      const [a, b] = m.state.picks;
      finish(m, !a && !b ? null : a ? 0 : 1, 'timeout');
    } else finish(m, 1 - m.turn, 'timeout');
  }, ms);
}

function finish(m, winner, reason = 'end') {
  if (m.over) return;
  clearTimeout(m.timer);
  m.over = { winner, reason };
  m.endsAt = 0;
  for (const [i, p] of m.players.entries()) {
    const xp = winner === null ? DRAW_XP : winner === i ? WIN_XP : 0;
    if (xp) {
      const user = ctx.db.addXp(p.userId, xp);
      if (user) ctx.pushWallet(user);
    }
  }
  emitState(m);
  // Bitmis mac bir sure "tekrar oyna" icin tutulur.
  setTimeout(() => matches.get(m.id) === m && matches.delete(m.id), 5 * 60 * 1000);
}

function startMatch(game, a, b) {
  const players = [a, b].map((sid) => ({ sid, userId: userOf(sid).id, name: userOf(sid).name, again: false }));
  const m = { id: String(nextId++), game, players, turn: 0, state: newState(game), over: null, timer: null, endsAt: 0 };
  matches.set(m.id, m);
  for (const p of players) {
    const s = sock(p.sid);
    if (s) s.data.matchId = m.id;
  }
  armTimer(m);
  emitState(m);
  return m;
}

function leaveQueues(sid) {
  for (const [g, w] of queues) if (w === sid) queues.delete(g);
}

function forfeit(sid) {
  const m = matches.get(sock(sid)?.data.matchId || '');
  if (!m) return;
  const i = m.players.findIndex((p) => p.sid === sid);
  if (i < 0) return;
  if (!m.over) finish(m, 1 - i, 'left');
  else matches.delete(m.id);
  m.players.forEach((p) => p.sid !== sid && sock(p.sid)?.emit('mp:left'));
}

// ---------- Baglanti olaylari ----------

export function arenaSocket(socket) {
  const me = socket.data.user;
  const ack = (fn) => (typeof fn === 'function' ? fn : () => {});
  const busy = () => {
    const m = matches.get(socket.data.matchId || '');
    return m && !m.over;
  };

  socket.on('mp:queue', ({ game } = {}, cb) => {
    cb = ack(cb);
    if (!GAMES[game]) return cb({ error: 'game' });
    if (busy()) return cb({ error: 'busy' });
    forfeit(socket.id);
    leaveQueues(socket.id);
    const waiting = queues.get(game);
    if (waiting && sock(waiting) && userOf(waiting).id !== me.id && !ctx.db.isBlocked(me.id, userOf(waiting).id)) {
      queues.delete(game);
      startMatch(game, waiting, socket.id);
      return cb({ ok: true });
    }
    queues.set(game, socket.id);
    cb({ waiting: true });
  });

  socket.on('mp:cancel', () => leaveQueues(socket.id));

  socket.on('mp:invite', ({ game, name } = {}, cb) => {
    cb = ack(cb);
    if (!GAMES[game]) return cb({ error: 'game' });
    const target = ctx.db.dmTarget(String(name || ''));
    if (!target || target.id === me.id) return cb({ error: 'nouser' });
    if (ctx.db.isBlocked(me.id, target.id)) return cb({ error: 'blocked' });
    const sids = [...(ctx.userSockets.get(target.id) || [])];
    if (!sids.length) return cb({ error: 'offline' });
    const id = String(nextId++);
    invites.set(id, { id, game, from: socket.id, toId: target.id, at: Date.now() });
    setTimeout(() => invites.delete(id), INVITE_MS);
    for (const sid of sids) ctx.io.to(sid).emit('mp:invited', { id, game, from: me.name });
    cb({ ok: true });
  });

  socket.on('mp:answer', ({ id, accept } = {}, cb) => {
    cb = ack(cb);
    const inv = invites.get(String(id));
    invites.delete(String(id));
    if (!inv || inv.toId !== me.id || !sock(inv.from)) return cb({ error: 'gone' });
    if (!accept) {
      sock(inv.from).emit('mp:declined', { name: me.name });
      return cb({ ok: true });
    }
    const inviterMatch = matches.get(sock(inv.from).data.matchId || '');
    if (busy() || (inviterMatch && !inviterMatch.over)) return cb({ error: 'busy' });
    leaveQueues(socket.id);
    leaveQueues(inv.from);
    startMatch(inv.game, inv.from, socket.id);
    cb({ ok: true });
  });

  socket.on('mp:move', ({ move } = {}) => {
    const m = matches.get(socket.data.matchId || '');
    if (!m || m.over) return;
    const i = m.players.findIndex((p) => p.sid === socket.id);
    if (i < 0 || !applyMove(m, i, move)) return;
    if (!m.over) armTimer(m);
    emitState(m);
  });

  // Iki oyuncu da isterse ayni rakiple yeni mac; ilk hamle sirasi degisir.
  socket.on('mp:again', () => {
    const m = matches.get(socket.data.matchId || '');
    if (!m || !m.over) return;
    const i = m.players.findIndex((p) => p.sid === socket.id);
    if (i < 0) return;
    m.players[i].again = true;
    const other = m.players[1 - i];
    if (!sock(other.sid)) return socket.emit('mp:left');
    if (other.again) {
      matches.delete(m.id);
      startMatch(m.game, m.players[1].sid, m.players[0].sid);
    } else sock(other.sid).emit('mp:again', { name: me.name });
  });

  socket.on('mp:leave', () => {
    leaveQueues(socket.id);
    forfeit(socket.id);
    socket.data.matchId = null;
  });
}

export function arenaDisconnect(socket) {
  leaveQueues(socket.id);
  forfeit(socket.id);
}
