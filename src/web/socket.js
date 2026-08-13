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
    if (room && (room.status === 'setup' || room.status === 'ready' || room.status === 'countdown')) {
      if (room.countdownTimer) {
        clearTimeout(room.countdownTimer);
        room.countdownTimer = null;
      }
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
  const scheduleTurn = (room, ms) => {
    clearTurnTimer(room);
    const game = room.game;
    const duration = ms ?? game.turnSeconds * 1000;
    game.turnEndsAt = Date.now() + duration;
    room.turnTimer = setTimeout(() => {
      const r = loop.timeout(game, game.currentPlayerId);
      if (r.ok) handleTurnResult(room, r, null);
    }, duration);
    room.turnTimer.unref?.();
  };

  // A dropped Wi-Fi shouldn't cost the current player their turn, so when THEY go offline the
  // turn clock pauses and resumes when they come back. Bounded, so a player who never returns
  // doesn't freeze the game: after PAUSE_MAX_MS the clock resumes on its own and will, on
  // timeout, simply pass the turn (nobody is ever removed).
  const PAUSE_MAX_MS = 30000;
  const pauseTurn = (room) => {
    const game = room?.game;
    if (!game || game.finished || game.pausedForDisconnect) return;
    clearTurnTimer(room);
    game.pausedRemaining = Math.max(0, (game.turnEndsAt ?? Date.now()) - Date.now());
    game.turnEndsAt = null;
    game.pausedForDisconnect = true;
    room.pauseGuard = setTimeout(() => resumeTurn(room), PAUSE_MAX_MS);
    room.pauseGuard.unref?.();
    broadcastRoom(room);
    emitGame(room);
  };
  const resumeTurn = (room) => {
    const game = room?.game;
    if (!game || game.finished || !game.pausedForDisconnect) return;
    if (room.pauseGuard) { clearTimeout(room.pauseGuard); room.pauseGuard = null; }
    game.pausedForDisconnect = false;
    const remaining = game.pausedRemaining ?? game.turnSeconds * 1000;
    game.pausedRemaining = null;
    scheduleTurn(room, remaining);
    broadcastRoom(room);
    emitGame(room);
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

  // Grace period: after everyone locks in, a synchronized countdown so players can raise their
  // phones to their foreheads before their character appears -- the moment the whole format is
  // built around. Configurable (WEB_GRACE_SECONDS); 0 skips straight to play (used by tests).
  const GRACE_SECONDS = Number(process.env.WEB_GRACE_SECONDS ?? 5);

  const beginGame = (room) => {
    room.countdownTimer = null;
    room.status = 'playing';
    loop.startTurn(room.game); // first player's turn 1
    scheduleTurn(room);
    broadcastRoom(room);
    emitGame(room);
  };

  const startPlaying = (room) => {
    if (GRACE_SECONDS <= 0) return beginGame(room);
    room.status = 'countdown';
    room.countdownEndsAt = Date.now() + GRACE_SECONDS * 1000;
    broadcastRoom(room);
    io.to(room.code).emit('game:countdown', { seconds: GRACE_SECONDS });
    room.countdownTimer = setTimeout(() => beginGame(room), GRACE_SECONDS * 1000);
  };

  const clearCountdown = (room) => {
    if (room?.countdownTimer) {
      clearTimeout(room.countdownTimer);
      room.countdownTimer = null;
    }
  };

  // Wall-clock backstop (mirrors the Discord bot's timerWatchdog): the setTimeouts above are the
  // primary path, but if the process is suspended (a laptop sleeping) they fire late. This
  // re-checks every deadline against the real clock so a turn that expired while asleep ends on
  // wake instead of hanging. It never double-fires: the resolve-once guard in the turn loop and
  // the countdown clearing its own timer make a redundant pass a no-op.
  const WATCHDOG_MS = 3000;
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const room of registry.allRooms()) {
      if (room.status === 'countdown' && room.countdownEndsAt && room.countdownEndsAt <= now) {
        beginGame(room);
      } else if (
        room.status === 'playing' && room.game && !room.game.pausedForDisconnect &&
        room.game.turnEndsAt && room.game.turnEndsAt <= now
      ) {
        const r = loop.timeout(room.game, room.game.currentPlayerId);
        if (r.ok) handleTurnResult(room, r, null);
      }
    }
  }, WATCHDOG_MS);
  watchdog.unref?.();

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
      registry.attachConnection(res.room.code, playerId, socket.id);
      ack?.({ ok: true, state: res.room.publicState() });
      broadcastRoom(res.room);
    });

    socket.on('room:join', async ({ code, nickname } = {}, ack) => {
      const res = registry.joinRoom(code, { playerId, nickname });
      if (!res.ok) return ack?.({ ok: false, error: res.error });
      socket.data.code = res.room.code;
      socket.join(res.room.code);
      registry.attachConnection(res.room.code, playerId, socket.id);
      ack?.({ ok: true, state: res.room.publicState(), reconnected: res.reconnected });
      broadcastRoom(res.room);
      // If the current player was paused because they'd dropped, their return resumes the clock.
      if (res.room.status === 'playing' && res.room.game?.currentPlayerId === playerId) {
        resumeTurn(res.room);
      }
      // Rejoining mid-flow: hand this socket the view for wherever the room is, so a reconnect
      // resumes exactly where it left off rather than dropping to the lobby roster.
      const g = res.room.game;
      if ((res.room.status === 'setup' || res.room.status === 'ready') && g?.confirmState[playerId]) {
        socket.emit('setup:state', setup.view(g, playerId, namesOf(res.room)));
      } else if (res.room.status === 'countdown') {
        const remaining = Math.max(0, Math.round(((res.room.countdownEndsAt ?? Date.now()) - Date.now()) / 1000));
        socket.emit('game:countdown', { seconds: remaining });
      } else if (res.room.status === 'playing' && g?.turnOrder.includes(playerId)) {
        socket.emit('game:state', loop.buildGameView(g, playerId, namesOf(res.room), Date.now()));
      } else if (res.room.status === 'finished' && g) {
        socket.emit('game:over', loop.resultView(g, namesOf(res.room)));
      }
    });

    // Host asks for the pool/difficulty choices to render the config screen.
    socket.on('setup:options', (_p, ack) => ack?.(setup.options()));

    // Host-only curation for the config screen's "pick a category" path: toggles the SAME shared
    // pool /list toggle would on Discord, so it isn't scoped to this room and outlives it.
    socket.on('setup:categoryLists', (payload = {}, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (r.hostPlayerId !== playerId) return ack?.({ ok: false, error: 'Only the host can curate lists.' });
      if (!payload.category) return ack?.({ ok: false, error: 'No category given.' });
      return ack?.({ ok: true, lists: setup.listsInCategory(payload.category) });
    });

    socket.on('setup:toggleList', (payload = {}, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (r.hostPlayerId !== playerId) return ack?.({ ok: false, error: 'Only the host can curate lists.' });
      if (!payload.listId) return ack?.({ ok: false, error: 'No list given.' });
      return ack?.(setup.toggleList(payload.listId));
    });

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
      clearCountdown(r);
      r.game = null;
      r.status = 'lobby';
      ack?.({ ok: true });
      broadcastRoom(r);
    });

    // Rematch: re-deal with the same pool/difficulty and the same roster, straight back into the
    // confirm phase, without the host reconfiguring.
    socket.on('game:rematch', async (_p, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (r.hostPlayerId !== playerId) return ack?.({ ok: false, error: 'Only the host can rematch.' });
      if (r.status !== 'finished') return ack?.({ ok: false, error: 'No finished game to rematch.' });
      if (r.players.size < 2) return ack?.({ ok: false, error: 'Need at least 2 players.' });
      clearTurnTimer(r);
      clearCountdown(r);
      const res = setup.start(r, r.lastSetup || {});
      if (!res.ok) return ack?.({ ok: false, error: res.error });
      r.status = 'setup';
      ack?.({ ok: true, label: res.label });
      broadcastRoom(r);
      await emitSetup(r);
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
      // A dropped connection keeps the seat (reconnect-friendly); only an explicit leave gives it
      // up. `nowOffline` is false if another socket (another tab, or a reconnect that already
      // landed) still holds the seat, so we don't flip a still-present player to offline.
      const { room: r, nowOffline } = registry.detachConnection(code, playerId, socket.id);
      if (!nowOffline) return;
      broadcastRoom(r);
      // If the player who just went offline is the one whose turn it is, pause their clock so a
      // Wi-Fi blip doesn't burn their turn.
      if (r?.status === 'playing' && r.game?.currentPlayerId === playerId && r.game.isActive(playerId)) {
        pauseTurn(r);
      }
    });
  });
}

module.exports = { attachSockets };
