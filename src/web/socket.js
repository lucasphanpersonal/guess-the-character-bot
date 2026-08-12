// Socket.io wiring for the web frontend (stages 1-2: rooms + setup/confirm/reroll).
//
// Thin on purpose: it translates socket events into calls on the room registry (rooms.js) and
// the setup service (built in server.js from the shared core), then broadcasts state. No game
// rules and no DB access live here -- rooms.js and gameSetup.js hold those and are unit-tested
// without a network. Seats are keyed by a persistent client playerId (handshake auth), never by
// socket id, so a reconnecting phone reclaims its seat and its in-progress setup view.

function namesOf(room) {
  const names = {};
  for (const [id, seat] of room.players) names[id] = seat.nickname;
  return names;
}

function attachSockets(io, { registry, setup }) {
  const broadcastRoom = (room) => {
    if (room) io.to(room.code).emit('room:state', room.publicState());
  };

  // Send every connected player in the room their OWN setup view (never their own character).
  // Per-socket rather than a room broadcast, because each player must see a different payload.
  const emitSetup = async (room) => {
    if (!room?.game) return;
    const names = namesOf(room);
    const sockets = await io.in(room.code).fetchSockets();
    for (const s of sockets) {
      const pid = s.data.playerId;
      if (room.game.confirmState[pid]) s.emit('setup:state', setup.view(room.game, pid, names));
    }
  };

  // A player leaving (or dropping) mid-setup would invalidate a deal whose turn order is fixed,
  // so setup reverts to the lobby and the host re-deals. Only for explicit leaves; a mere
  // disconnect keeps the seat.
  const abortSetupToLobby = (room, reason) => {
    if (room && (room.status === 'setup' || room.status === 'ready')) {
      room.status = 'lobby';
      room.game = null;
      io.to(room.code).emit('setup:aborted', { reason });
    }
  };

  io.on('connection', (socket) => {
    const playerId = socket.handshake.auth?.playerId;
    if (!playerId) {
      socket.emit('room:error', { error: 'Missing player id.' });
      socket.disconnect(true);
      return;
    }
    socket.data.playerId = playerId;
    socket.data.code = null;

    const room = () => registry.getRoom(socket.data.code);
    const isHost = () => room()?.hostPlayerId === playerId;

    socket.on('room:create', ({ nickname } = {}, ack) => {
      const res = registry.createRoom({ hostPlayerId: playerId, nickname });
      if (!res.ok) return ack?.({ ok: false, error: res.error });
      socket.data.code = res.room.code;
      socket.join(res.room.code);
      ack?.({ ok: true, state: res.room.publicState() });
      broadcastRoom(res.room);
    });

    socket.on('room:join', async ({ code, nickname } = {}, ack) => {
      const res = registry.joinRoom(code, { playerId, nickname });
      if (!res.ok) return ack?.({ ok: false, error: res.error });
      socket.data.code = res.room.code;
      socket.join(res.room.code);
      ack?.({ ok: true, state: res.room.publicState(), reconnected: res.reconnected });
      broadcastRoom(res.room);
      // Rejoining mid-setup: hand this socket its personal setup view so a reconnect resumes
      // exactly where it was, not just the lobby roster.
      if ((res.room.status === 'setup' || res.room.status === 'ready') && res.room.game?.confirmState[playerId]) {
        socket.emit('setup:state', setup.view(res.room.game, playerId, namesOf(res.room)));
      }
    });

    // Host asks for the pool/difficulty choices to render the config screen.
    socket.on('setup:options', (_p, ack) => ack?.(setup.options()));

    // Host deals characters and moves the room into the confirm phase.
    socket.on('setup:start', async (config = {}, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (r.hostPlayerId !== playerId) return ack?.({ ok: false, error: 'Only the host can start.' });
      if (r.status !== 'lobby') return ack?.({ ok: false, error: 'Already started.' });
      if (r.players.size < 2) return ack?.({ ok: false, error: 'Need at least 2 players.' });

      const res = setup.start(r, config);
      if (!res.ok) return ack?.({ ok: false, error: res.error });
      r.status = 'setup';
      ack?.({ ok: true, label: res.label });
      broadcastRoom(r);
      await emitSetup(r);
    });

    socket.on('setup:reroll', async (_p, ack) => {
      const r = room();
      if (!r?.game) return ack?.({ ok: false, error: 'No game to set up.' });
      const res = setup.reroll(r.game, playerId);
      ack?.(res);
      if (res.ok) await emitSetup(r); // fan out: everyone else's reference view changed too
    });

    socket.on('setup:confirm', async (_p, ack) => {
      const r = room();
      if (!r?.game) return ack?.({ ok: false, error: 'No game to set up.' });
      const res = setup.confirm(r.game, playerId);
      if (res.ok && res.allReady) r.status = 'ready';
      ack?.(res);
      await emitSetup(r);
      if (res.allReady) broadcastRoom(r); // status -> ready
    });

    socket.on('setup:unlock', async (_p, ack) => {
      const r = room();
      if (!r?.game) return ack?.({ ok: false, error: 'No game to set up.' });
      const res = setup.unlock(r.game, playerId);
      ack?.(res);
      await emitSetup(r);
    });

    socket.on('room:leave', (_payload, ack) => {
      const code = socket.data.code;
      if (!code) return ack?.({ ok: true });
      const before = registry.getRoom(code);
      abortSetupToLobby(before, 'a player left');
      const { room: after } = registry.leaveRoom(code, playerId);
      socket.leave(code);
      socket.data.code = null;
      ack?.({ ok: true });
      broadcastRoom(after);
    });

    socket.on('disconnect', () => {
      const code = socket.data.code;
      if (!code) return;
      // A dropped connection keeps the seat (reconnect-friendly); only an explicit leave gives
      // it up. Mark offline so the roster shows it.
      const r = registry.setConnected(code, playerId, false);
      broadcastRoom(r);
    });
  });
}

module.exports = { attachSockets };
