// server.js — Dövüş Arenası: oda, lobi ve girdi aktarımı
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const CHARACTERS = ['flame', 'ice'];
const ACTIONS = ['left', 'right', 'jump', 'crouch', 'punch', 'kick', 'block'];
const SLOTS = ['P1', 'P2'];

// code -> { hostId, started, players: { P1: {id, character, ready}|null, P2: ... } }
const rooms = new Map();

function genCode() {
  let code;
  do {
    code = 'ROOM-' + Math.floor(1000 + Math.random() * 9000);
  } while (rooms.has(code));
  return code;
}

function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

function publicState(room) {
  const out = {};
  for (const s of SLOTS) {
    const p = room.players[s];
    out[s] = p
      ? { connected: true, character: p.character, ready: p.ready }
      : { connected: false, character: null, ready: false };
  }
  return out;
}

function emitState(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit('lobby:state', publicState(room));
}

function resetToLobby(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.started = false;
  for (const s of SLOTS) if (room.players[s]) room.players[s].ready = false;
  io.to(code).emit('lobby:reset');
  emitState(code);
}

io.on('connection', (socket) => {
  // ---------- HOST (akıllı tahta) ----------
  socket.on('host:create', () => {
    // Eski odası varsa kapat
    if (socket.data.code && rooms.has(socket.data.code)) {
      io.to(socket.data.code).emit('room:closed');
      rooms.delete(socket.data.code);
    }
    const code = genCode();
    rooms.set(code, {
      hostId: socket.id,
      started: false,
      players: { P1: null, P2: null },
    });
    socket.data = { role: 'host', code };
    socket.join(code);

    // Telefonların erişebilmesi için localhost yerine LAN IP kullan
    const hostHeader = socket.handshake.headers.host || `localhost:${PORT}`;
    const [hostname, port] = hostHeader.split(':');
    const finalHost =
      hostname === 'localhost' || hostname === '127.0.0.1'
        ? `${lanIP()}:${port || PORT}`
        : hostHeader;
    const proto = socket.handshake.headers['x-forwarded-proto'] || 'http';
    const url = `${proto}://${finalHost}/controller.html?room=${code}`;

    socket.emit('host:created', { code, url });
    emitState(code);
  });

  socket.on('host:reset', () => {
    if (socket.data.role === 'host') resetToLobby(socket.data.code);
  });

  // ---------- CONTROLLER (telefon) ----------
  socket.on('controller:join', ({ code } = {}) => {
    code = String(code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit('join:error', 'Oda bulunamadı. QR kodu tekrar tara.');
    if (room.started) return socket.emit('join:error', 'Oyun zaten başladı.');

    const slot = SLOTS.find((s) => !room.players[s]);
    if (!slot) return socket.emit('join:error', 'Oda dolu (2/2).');

    room.players[slot] = { id: socket.id, character: null, ready: false };
    socket.data = { role: 'controller', code, slot };
    socket.join(code);
    socket.emit('controller:joined', { slot, code });
    emitState(code);
  });

  socket.on('player:select', ({ character } = {}) => {
    const { role, code, slot } = socket.data;
    if (role !== 'controller' || !CHARACTERS.includes(character)) return;
    const room = rooms.get(code);
    if (!room || room.started) return;
    room.players[slot].character = character;
    room.players[slot].ready = false;
    emitState(code);
  });

  socket.on('player:ready', () => {
    const { role, code, slot } = socket.data;
    if (role !== 'controller') return;
    const room = rooms.get(code);
    if (!room || room.started) return;
    const me = room.players[slot];
    if (!me || !me.character) return;
    me.ready = true;
    emitState(code);

    const { P1, P2 } = room.players;
    if (P1 && P2 && P1.ready && P2.ready) {
      room.started = true;
      io.to(code).emit('game:start', {
        players: {
          P1: { character: P1.character },
          P2: { character: P2.character },
        },
      });
    }
  });

  socket.on('player:input', ({ action, pressed } = {}) => {
    const { role, code, slot } = socket.data;
    if (role !== 'controller' || !ACTIONS.includes(action)) return;
    const room = rooms.get(code);
    if (!room || !room.started) return;
    io.to(room.hostId).emit('input', { slot, action, pressed: !!pressed });
  });

  // ---------- Bağlantı kopması ----------
  socket.on('disconnect', () => {
    const { role, code, slot } = socket.data || {};
    const room = rooms.get(code);
    if (!room) return;

    if (role === 'host') {
      io.to(code).emit('room:closed');
      rooms.delete(code);
    } else if (role === 'controller') {
      room.players[slot] = null;
      if (room.started) resetToLobby(code); // oyun ortasında kopan olursa lobiye dön
      else emitState(code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Sunucu hazır:`);
  console.log(`  Tahta  : http://localhost:${PORT}`);
  console.log(`  Ağ IP  : http://${lanIP()}:${PORT}`);
});
