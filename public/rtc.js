// Tarayicilar arasi goruntu/ses baglantilari.
// Yayinci (publisher) her izleyiciye ayri bir baglanti acar; "tag" ayni kisiden gelen farkli akislari ayirir
// (main: kendi yayini, pk: rakip yayinci, voice: sesli oda koltugu).
window.createRtc = function createRtc(socket, { getStream, onTrack, onClose, iceServers }) {
  // Sunucudan gelen aktarma (TURN) bilgisi varsa onu, yoksa yalniz STUN kullanilir.
  const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  const config = () => ({ iceServers: (iceServers && iceServers()) || DEFAULT_ICE });
  const outgoing = new Map();
  const incoming = new Map();
  const key = (id, tag) => `${id}|${tag}`;

  function addIce(pc, candidate) {
    if (pc.remoteDescription) return pc.addIceCandidate(candidate).catch(() => {});
    (pc._queue ||= []).push(candidate);
  }
  function flushIce(pc) {
    for (const c of pc._queue || []) pc.addIceCandidate(c).catch(() => {});
    pc._queue = [];
  }
  function send(to, tag, dir, data) {
    socket.emit('signal', { to, tag, dir, data });
  }

  socket.on('stream:request', async ({ from, tag }) => {
    const stream = getStream(tag);
    if (!stream) return;
    closeOut(from, tag);
    const pc = new RTCPeerConnection(config());
    outgoing.set(key(from, tag), pc);
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.onicecandidate = (e) => e.candidate && send(from, tag, 'sub', { ice: e.candidate });
    await pc.setLocalDescription(await pc.createOffer());
    send(from, tag, 'sub', { sdp: pc.localDescription });
  });

  socket.on('signal', async ({ from, tag, dir, data }) => {
    if (dir === 'sub') {
      if (data.sdp) {
        closeIn(from, tag);
        const pc = new RTCPeerConnection(config());
        incoming.set(key(from, tag), pc);
        pc.ontrack = (e) => onTrack(from, tag, e.streams[0]);
        pc.onicecandidate = (e) => e.candidate && send(from, tag, 'pub', { ice: e.candidate });
        await pc.setRemoteDescription(data.sdp);
        flushIce(pc);
        await pc.setLocalDescription(await pc.createAnswer());
        send(from, tag, 'pub', { sdp: pc.localDescription });
      } else if (data.ice) {
        const pc = incoming.get(key(from, tag));
        if (pc) addIce(pc, data.ice);
      }
    } else {
      const pc = outgoing.get(key(from, tag));
      if (!pc) return;
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        flushIce(pc);
      } else if (data.ice) addIce(pc, data.ice);
    }
  });

  socket.on('peer:left', ({ socketId, tag }) => {
    for (const map of [outgoing, incoming]) {
      for (const k of [...map.keys()]) {
        const [id, t] = k.split('|');
        if (id === socketId && (!tag || tag === t)) {
          map.get(k).close();
          map.delete(k);
          if (map === incoming) onClose(id, t);
        }
      }
    }
  });

  function closeOut(id, tag) {
    outgoing.get(key(id, tag))?.close();
    outgoing.delete(key(id, tag));
  }
  function closeIn(id, tag) {
    incoming.get(key(id, tag))?.close();
    incoming.delete(key(id, tag));
  }

  return {
    request(target, tag) {
      if (target && target !== socket.id) socket.emit('stream:request', { target, tag });
    },
    closeIn(id, tag) {
      closeIn(id, tag);
      onClose(id, tag);
    },
    // Belirli bir etiketteki tum giden baglantilari kapatir (ornegin koltuktan kalkinca).
    closeOutTag(tag) {
      for (const k of [...outgoing.keys()]) if (k.endsWith(`|${tag}`)) { outgoing.get(k).close(); outgoing.delete(k); }
    },
    closeInTag(tag) {
      for (const k of [...incoming.keys()]) if (k.endsWith(`|${tag}`)) { const [id] = k.split('|'); closeIn(id, tag); onClose(id, tag); }
    },
    closeAll() {
      for (const pc of [...outgoing.values(), ...incoming.values()]) pc.close();
      outgoing.clear();
      incoming.clear();
    },
  };
};
