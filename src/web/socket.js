// Socket.io wiring for the web frontend (stages 1-2: rooms + setup/confirm/reroll).
//
// Thin on purpose: it translates socket events into calls on the room registry (rooms.js) and
// the setup service (built in server.js from the shared core), then broadcasts state. No game
// rules and no DB access live here -- rooms.js and gameSetup.js hold those and are unit-tested
// without a network. Seats are keyed by a persistent client playerId (handshake auth), never by
// socket id, so a reconnecting phone reclaims its seat and its in-progress setup view.

const loop = require('./turnLoop');

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

  // --- the playing phase (stage 3) --------------------------------------------------------
  const clearTurnTimer = (room) => {
    if (room?.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
  };

  // A server-authoritative turn clock. The deadline lives on the server (game.turnEndsAt) and
  // the per-player view carries seconds-remaining, so clients count down locally without
  // trusting cross-device wall clocks. When it fires the turn simply passes -- nobody is removed.
  const scheduleTurn = (room) => {
    clearTurnTimer(room);
    const game = room.game;
    game.turnEndsAt = Date.now() + game.turnSeconds * 1000;
    room.turnTimer = setTimeout(() => {
      const r = loop.timeout(game, game.currentPlayerId);
      if (r.ok) handleTurnResult(room, r, null);
    }, game.turnSeconds * 1000);
    room.turnTimer.unref?.();
  };

  const emitGame = async (room) => {
    if (!room?.game) return;
    const names = namesOf(room);
    const now = Date.now();
    const sockets = await io.in(room.code).fetchSockets();
    for (const s of sockets) {
      if (room.game.turnOrder.includes(s.data.playerId)) {
        s.emit('game:state', loop.buildGameView(room.game, s.data.playerId, names, now));
      }
    }
  };

  // Central handling after any turn action: announce a reveal, then either end the game or
  // arm the next turn and push fresh per-player state.
  function handleTurnResult(room, result, reveal) {
    const names = namesOf(room);
    clearTurnTimer(room);
    if (reveal) io.to(room.code).emit('game:reveal', { ...reveal, name: names[reveal.playerId] ?? 'Player' });
    if (result.timedOut) io.to(room.code).emit('game:timeout', { name: names[result.finishingId] ?? 'Player' });
    if (result.gameOver) {
      room.game.turnEndsAt = null;
      room.status = 'finished';
      io.to(room.code).emit('game:over', loop.resultView(room.game, names));
      broadcastRoom(room);
    } else {
      scheduleTurn(room);
      emitGame(room);
    }
  }

  const startPlaying = (room) => {
    room.status = 'playing';
    loop.startTurn(room.game); // first player's turn 1
    scheduleTurn(room);
    broadcastRoom(room);
    emitGame(room);
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
      // Rejoining mid-flow: hand this socket the view for wherever the room is, so a reconnect
      // resumes exactly where it left off rather than dropping to the lobby roster.
      const g = res.room.game;
      if ((res.room.status === 'setup' || res.room.status === 'ready') && g?.confirmState[playerId]) {
        socket.emit('setup:state', setup.view(g, playerId, namesOf(res.room)));
      } else if (res.room.status === 'playing' && g?.turnOrder.includes(playerId)) {
        socket.emit('game:state', loop.buildGameView(g, playerId, namesOf(res.room), Date.now()));
      } else if (res.room.status === 'finished' && g) {
        socket.emit('game:over', loop.resultView(g, namesOf(res.room)));
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
      ack?.(res);
      if (res.ok && res.allReady) startPlaying(r); // everyone in -> the turn loop begins
      else await emitSetup(r);
    });

    // --- playing-phase actions (current player only; the loop enforces it) ----------------
    socket.on('game:gotit', (_p, ack) => {
      const r = room();
      if (!r?.game) return ack?.({ ok: false, error: 'No game running.' });
      const res = loop.gotIt(r.game, playerId);
      ack?.(res);
      if (res.ok) handleTurnResult(r, res, res.reveal);
    });

    socket.on('game:pass', (_p, ack) => {
      const r = room();
      if (!r?.game) return ack?.({ ok: false, error: 'No game running.' });
      const res = loop.pass(r.game, playerId);
      ack?.(res);
      if (res.ok) handleTurnResult(r, res, null);
    });

    socket.on('game:giveup', (_p, ack) => {
      const r = room();
      if (!r?.game) return ack?.({ ok: false, error: 'No game running.' });
      const res = loop.giveUp(r.game, playerId);
      ack?.(res);
      if (res.ok) handleTurnResult(r, res, res.reveal);
    });

    // Host resets a finished game back to the lobby so the room can play again.
    socket.on('game:again', (_p, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (r.hostPlayerId !== playerId) return ack?.({ ok: false, error: 'Only the host can restart.' });
      clearTurnTimer(r);
      r.game = null;
      r.status = 'lobby';
      ack?.({ ok: true });
      broadcastRoom(r);
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
      // Leaving mid-game is a forfeit: reveal their character and, if it was their turn, advance.
      if (before?.status === 'playing' && before.game?.isActive(playerId)) {
        const res = loop.forfeit(before.game, playerId);
        if (res.ok) handleTurnResult(before, res, res.reveal);
      }
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
