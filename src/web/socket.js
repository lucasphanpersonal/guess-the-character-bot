// Socket.io wiring for the web frontend (stage 1: rooms + membership).
//
// Thin on purpose: it translates socket events into RoomRegistry calls (src/web/rooms.js) and
// broadcasts the resulting room state. All the actual rules live in rooms.js, which has no
// socket.io dependency and is unit-tested on its own. Keeping the transport this thin is what
// lets the room model be tested without a network, the same way the Discord engine's rules are
// tested without Discord.
//
// Identity: each browser generates a persistent playerId (stored locally) and sends it in the
// socket handshake auth. Seats are keyed by that id, never by socket.id -- so a phone that
// drops Wi-Fi and reconnects (socket.io does this automatically) re-emits room:join and
// reclaims its exact seat. See docs/mobile-app-plan.md#reconnection-...

function attachSockets(io, registry) {
  const broadcast = (room) => {
    if (room) io.to(room.code).emit('room:state', room.publicState());
  };

  io.on('connection', (socket) => {
    const playerId = socket.handshake.auth?.playerId;
    if (!playerId) {
      socket.emit('room:error', { error: 'Missing player id.' });
      socket.disconnect(true);
      return;
    }
    // What this socket is currently in, so disconnect/leave know where to act.
    socket.data.playerId = playerId;
    socket.data.code = null;

    socket.on('room:create', ({ nickname } = {}, ack) => {
      const res = registry.createRoom({ hostPlayerId: playerId, nickname });
      if (!res.ok) return ack?.({ ok: false, error: res.error });
      socket.data.code = res.room.code;
      socket.join(res.room.code);
      ack?.({ ok: true, state: res.room.publicState() });
      broadcast(res.room);
    });

    socket.on('room:join', ({ code, nickname } = {}, ack) => {
      const res = registry.joinRoom(code, { playerId, nickname });
      if (!res.ok) return ack?.({ ok: false, error: res.error });
      socket.data.code = res.room.code;
      socket.join(res.room.code);
      ack?.({ ok: true, state: res.room.publicState(), reconnected: res.reconnected });
      broadcast(res.room);
    });

    socket.on('room:leave', (_payload, ack) => {
      const code = socket.data.code;
      if (!code) return ack?.({ ok: true });
      const { room } = registry.leaveRoom(code, playerId);
      socket.leave(code);
      socket.data.code = null;
      ack?.({ ok: true });
      broadcast(room); // no-op if the room was deleted (room === null)
    });

    socket.on('disconnect', () => {
      const code = socket.data.code;
      if (!code) return;
      // A dropped connection keeps the seat (reconnect-friendly) -- only an explicit leave
      // gives it up. Mark it disconnected so the roster shows who's currently offline.
      const room = registry.setConnected(code, playerId, false);
      broadcast(room);
    });
  });
}

module.exports = { attachSockets };
