// Socket.io wiring for Guess the Character on the web: rooms, setup/confirm/reroll, the grace
// countdown, the turn loop, and -- in host-picks mode -- the view of the host who picked and sits
// out. Shared by both ways of playing; what differs between them is a VARIANT:
//
//   variant.kind           which rooms are theirs ('party' phones, 'desk' computers)
//   variant.graceSeconds   the countdown before play (phones: time to raise them to foreheads)
//   variant.playerView     what one player sees during play -- the one thing that MUST differ:
//                          a phone shows its wearer their own character, a computer never may
//   variant.attachHandlers the events only that way of playing has (a tilt; a typed guess)
//   variant.deferTimeout   "not yet" for a turn whose clock ran out mid-something (a ruling)
//   variant.onTurnEnded    drop state taken for one turn, with the turn
//
// Each variant gets its own socket.io namespace, so the two protocols never see each other's
// sockets even though their rooms share one registry.
//
// Thin on purpose: it translates socket events into calls on the room registry (../rooms.js) and
// the setup service (./service.js, over ../content.js), then broadcasts state. No game
// rules and no DB access live here -- rooms.js and gameSetup.js hold those and are unit-tested
// without a network. Seats are keyed by a persistent client playerId (handshake auth), never by
// socket id, so a reconnecting phone reclaims its seat and its in-progress setup view.

const loop = require('./turnLoop');

function namesOf(room) {
  const names = {};
  // Departed first, so a live seat always wins -- someone who left and came back is current.
  for (const [id, nickname] of room.departedNames ?? []) names[id] = nickname;
  for (const [id, seat] of room.players) names[id] = seat.nickname;
  return names;
}

function attachSockets(nsp, { registry, setup, variant }) {
  const turnEnded = (room) => variant.onTurnEnded?.(room);
  const broadcastRoom = (room) => {
    if (room) nsp.to(room.code).emit('room:state', room.publicState());
  };

  /**
   * Every socket currently in a room.
   *
   * fetchSockets() is the documented way to do this and is async because it is built to ask
   * OTHER nodes. There are none: rooms live in a Map in this process, so a second node could
   * never see them anyway. Paying an await for that made every fan-out async, which let one
   * turn's per-player emits interleave with the next one's, and made six callers async for a
   * promise that always resolved against local state.
   */
  const socketsIn = (room) => {
    const ids = nsp.adapter.rooms.get(room.code) ?? [];
    const found = [];
    for (const id of ids) {
      const s = nsp.sockets.get(id);
      if (s) found.push(s);
    }
    return found;
  };

  // --- the host who sits out (host-picks mode) --------------------------------------------
  //
  // A host who picked everyone's character is in the room but not in the turn order, and every
  // per-player emit in this file skips people who aren't in the turn order -- so without this
  // they would stare at a frozen screen for the whole game. host:state is their view instead.
  //
  // It carries EVERY character in play. So it goes to the host's own sockets and nobody else's,
  // and only while the host genuinely is sitting out: a host who is dealt in (every normal game,
  // or a player who inherited the crown after the picker left) is a player and gets a player's
  // view like everyone else.
  const hostSitsOut = (room) => !!room?.game && !room.game.turnOrder.includes(room.hostPlayerId);
  const hostViewOf = (room) => {
    const names = namesOf(room);
    if (room.status === 'setup' || room.status === 'ready') return setup.hostView(room.game, names);
    if (room.status === 'countdown') {
      return { phase: 'countdown', seconds: Math.max(0, Math.round(((room.countdownEndsAt ?? Date.now()) - Date.now()) / 1000)) };
    }
    if (room.status === 'playing') return loop.buildHostGameView(room.game, names);
    return null; // finished: the host gets game:over with the room, like anyone else
  };
  const emitHost = (room, onlyTo = null) => {
    if (!hostSitsOut(room)) return;
    const view = hostViewOf(room);
    if (!view) return;
    for (const s of onlyTo ? [onlyTo] : socketsIn(room)) {
      if (s.data.playerId === room.hostPlayerId) s.emit('host:state', view);
    }
  };

  // Send every connected player in the room their OWN setup view (never their own character).
  // Per-socket rather than a room broadcast, because each player must see a different payload.
  // The sitting-out host is told too: whatever changed a player's setup changed theirs.
  const emitSetup = (room) => {
    if (!room?.game) return;
    const names = namesOf(room);
    for (const s of socketsIn(room)) {
      const pid = s.data.playerId;
      if (room.game.confirmState[pid]) s.emit('setup:state', setup.view(room.game, pid, names));
    }
    emitHost(room);
  };

  // "hostPicked" tells the over screen that "same settings" means picking again: re-dealing the
  // same hand-picked characters to people who have just seen them all would be no game.
  const overView = (room, names) => ({ ...loop.resultView(room.game, names), hostPicked: !!room.lastSetup?.hostPicks });

  // A player leaving (or dropping) mid-setup would invalidate a deal whose turn order is fixed,
  // so setup reverts to the lobby and the host re-deals. Only for explicit leaves; a mere
  // disconnect keeps the seat.
  const abortSetupToLobby = (room, reason) => {
    if (room && (room.status === 'setup' || room.status === 'ready' || room.status === 'countdown')) {
      turnEnded(room);
      if (room.countdownTimer) {
        clearTimeout(room.countdownTimer);
        room.countdownTimer = null;
      }
      room.status = 'lobby';
      room.game = null;
      nsp.to(room.code).emit('setup:aborted', { reason });
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
      if (variant.deferTimeout?.(room)) return; // the variant ends this turn itself
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
  // One owner for dropping a pause, because it is the one piece of turn state that can outlive
  // the turn it was taken for. A pause belongs to ONE player's ONE turn: anything that arms a
  // fresh deadline has to drop it, or the guard below later "resumes" a turn that already moved
  // on and rewrites the current player's deadline with the previous player's leftover time.
  const clearPause = (room) => {
    if (room?.pauseGuard) { clearTimeout(room.pauseGuard); room.pauseGuard = null; }
    if (room?.game) { room.game.pausedForDisconnect = false; room.game.pausedRemaining = null; }
  };
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
    const remaining = game.pausedRemaining ?? game.turnSeconds * 1000;
    clearPause(room);
    scheduleTurn(room, remaining);
    broadcastRoom(room);
    emitGame(room);
  };

  const emitGame = (room) => {
    if (!room?.game) return;
    const names = namesOf(room);
    const now = Date.now();
    for (const s of socketsIn(room)) {
      if (room.game.turnOrder.includes(s.data.playerId)) {
        s.emit('game:state', variant.playerView(room, s.data.playerId, names, now));
      }
    }
    emitHost(room);
  };

  // Central handling after any turn action: announce a reveal, then either end the game or
  // arm the next turn and push fresh per-player state.
  function handleTurnResult(room, result, reveal) {
    const names = namesOf(room);
    if (reveal) nsp.to(room.code).emit('game:reveal', { ...reveal, name: names[reveal.playerId] ?? 'Player' });
    if (result.timedOut) nsp.to(room.code).emit('game:timeout', { name: names[result.finishingId] ?? 'Player' });

    // Whatever the variant took for the turn that just ended goes with it -- unless the turn did
    // not end (no nextPlayerId: somebody else left), in which case it is still that turn.
    if (result.gameOver || result.nextPlayerId) turnEnded(room);

    if (result.gameOver) {
      clearTurnTimer(room);
      clearPause(room);
      room.game.turnEndsAt = null;
      room.status = 'finished';
      nsp.to(room.code).emit('game:over', overView(room, names));
      broadcastRoom(room);
      return;
    }

    // No nextPlayerId means the turn did NOT move: somebody who wasn't the guesser left or was
    // removed (turnLoop.forfeit returns early in that case). The clock belongs to a turn still
    // in progress, so leave it -- and any pause on it -- alone. Re-arming here handed the
    // current player a fresh full turn every time another player walked out, and restarted the
    // clock of a player who was paused mid-drop.
    if (!result.nextPlayerId) return emitGame(room);

    clearPause(room); // the pause belonged to the turn that just ended, not to this one
    scheduleTurn(room);
    // The player we advanced TO may themselves be offline -- the same rule the disconnect
    // handler applies, arriving by a different route. pauseTurn broadcasts for us.
    if (!registry.isConnected(room.code, room.game.currentPlayerId)) pauseTurn(room);
    else emitGame(room);
  }

  // Grace period: after everyone locks in, a synchronized countdown -- on phones, so players can
  // raise them to their foreheads before their character appears, the moment that format is built
  // around. The variant sets it (../party reads WEB_GRACE_SECONDS); 0 skips straight to play,
  // which is what computers do and what the tests use.
  const GRACE_SECONDS = variant.graceSeconds;

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
    // To the players only. The countdown is for raising a phone to a forehead, and a host who is
    // sitting out has no forehead in this game: game:countdown would drop their phone into the
    // forehead overlay, with nothing ever coming to replace it.
    for (const s of socketsIn(room)) {
      if (room.game.turnOrder.includes(s.data.playerId)) s.emit('game:countdown', { seconds: GRACE_SECONDS });
    }
    emitHost(room);
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
      if (room.kind !== variant.kind) continue; // another game's rooms, on another namespace
      if (room.status === 'countdown' && room.countdownEndsAt && room.countdownEndsAt <= now) {
        beginGame(room);
      } else if (
        room.status === 'playing' && room.game && !room.game.pausedForDisconnect &&
        room.game.turnEndsAt && room.game.turnEndsAt <= now && !variant.deferTimeout?.(room)
      ) {
        const r = loop.timeout(room.game, room.game.currentPlayerId);
        if (r.ok) handleTurnResult(room, r, null);
      }
    }
  }, WATCHDOG_MS);
  watchdog.unref?.();

  // Nothing here is authenticated -- anyone with the link can open a socket -- so the two
  // unauthenticated actions that cost something are bounded per connection. Room codes are only
  // 32^4, which is guessable by machine but not by a person, so the join limit is what keeps a
  // stranger from walking into a game rather than the code length.
  const MAX_ROOMS_PER_SOCKET = 5;
  const MAX_FAILED_JOINS = 20;

  nsp.on('connection', (socket) => {
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
      socket.data.created = (socket.data.created || 0) + 1;
      if (socket.data.created > MAX_ROOMS_PER_SOCKET) {
        return ack?.({ ok: false, error: 'Too many rooms from this device. Reload the page.' });
      }
      const res = registry.createRoom({ hostPlayerId: playerId, nickname, kind: variant.kind });
      if (!res.ok) return ack?.({ ok: false, error: res.error });
      socket.data.code = res.room.code;
      socket.join(res.room.code);
      registry.attachConnection(res.room.code, playerId, socket.id);
      ack?.({ ok: true, state: res.room.publicState() });
      broadcastRoom(res.room);
    });

    socket.on('room:join', ({ code, nickname } = {}, ack) => {
      if ((socket.data.failedJoins || 0) >= MAX_FAILED_JOINS) {
        return ack?.({ ok: false, error: 'Too many failed attempts. Reload the page.' });
      }
      const res = registry.joinRoom(code, { playerId, nickname, kind: variant.kind });
      if (!res.ok) {
        socket.data.failedJoins = (socket.data.failedJoins || 0) + 1;
        return ack?.({ ok: false, error: res.error });
      }
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
      const dealtIn = !!g?.turnOrder.includes(playerId);
      if (g && !dealtIn && ['setup', 'ready', 'countdown', 'playing'].includes(res.room.status)) {
        // In the room but not in the game: only the host sitting out can be here (nobody new can
        // join mid-game), and emitHost sends nothing to anyone else. Checked BEFORE the
        // countdown branch below, which would otherwise hand them a player's forehead countdown.
        emitHost(res.room, socket);
      } else if ((res.room.status === 'setup' || res.room.status === 'ready') && g?.confirmState[playerId]) {
        socket.emit('setup:state', setup.view(g, playerId, namesOf(res.room)));
      } else if (res.room.status === 'countdown') {
        const remaining = Math.max(0, Math.round(((res.room.countdownEndsAt ?? Date.now()) - Date.now()) / 1000));
        socket.emit('game:countdown', { seconds: remaining });
      } else if (res.room.status === 'playing' && g?.turnOrder.includes(playerId)) {
        socket.emit('game:state', variant.playerView(res.room, playerId, namesOf(res.room), Date.now()));
      } else if (res.room.status === 'finished' && g) {
        socket.emit('game:over', overView(res.room, namesOf(res.room)));
      }
    });

    // Host asks for the pool/difficulty choices to render the config screen.
    socket.on('setup:options', (_p, ack) => ack?.(setup.options()));

    // Host-only curation for the config screen's "pick a category" path. Scoped to this room:
    // it never writes to the web's playable selection, which every other room deals from too.
    socket.on('setup:categoryLists', (payload = {}, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (r.hostPlayerId !== playerId) return ack?.({ ok: false, error: 'Only the host can curate lists.' });
      if (!payload.category) return ack?.({ ok: false, error: 'No category given.' });
      return ack?.({ ok: true, lists: setup.listsInCategory(payload.category, r) });
    });

    socket.on('setup:toggleList', (payload = {}, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (r.hostPlayerId !== playerId) return ack?.({ ok: false, error: 'Only the host can curate lists.' });
      if (!payload.listId) return ack?.({ ok: false, error: 'No list given.' });
      return ack?.(setup.toggleList(payload.listId, r));
    });

    // Host deals characters and moves the room into the confirm phase.
    socket.on('setup:start', (config = {}, ack) => {
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
      emitSetup(r);
    });

    socket.on('setup:reroll', (_p, ack) => {
      const r = room();
      if (!r?.game) return ack?.({ ok: false, error: 'No game to set up.' });
      const res = setup.reroll(r.game, playerId);
      ack?.(res);
      if (res.ok) emitSetup(r); // fan out: everyone else's reference view changed too
    });

    // The host calling off a deal. Until now the confirm/reroll phase had no exit at all: a bad
    // spread, or someone needing a minute, left the room stuck there until a player quit the
    // room outright and aborted it as a side effect. This is the same abort, asked for on
    // purpose. Everyone keeps their seat -- only the deal is thrown away.
    socket.on('setup:cancel', (_p, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (r.hostPlayerId !== playerId) return ack?.({ ok: false, error: 'Only the host can cancel.' });
      if (!['setup', 'ready', 'countdown'].includes(r.status)) {
        return ack?.({ ok: false, error: 'Nothing to cancel.' });
      }
      abortSetupToLobby(r, 'the host cancelled it');
      ack?.({ ok: true });
      broadcastRoom(r);
    });

    socket.on('setup:undo', (_p, ack) => {
      const r = room();
      if (!r?.game) return ack?.({ ok: false, error: 'No game to set up.' });
      const res = setup.undo(r.game, playerId);
      ack?.(res);
      if (res.ok) emitSetup(r); // everyone else's reference card changed back too
    });

    socket.on('setup:confirm', (_p, ack) => {
      const r = room();
      if (!r?.game) return ack?.({ ok: false, error: 'No game to set up.' });
      const res = setup.confirm(r.game, playerId);
      ack?.(res);
      if (res.ok && res.allReady) startPlaying(r); // everyone in -> the turn loop begins
      else emitSetup(r);
    });

    // --- playing-phase actions (current player only; the loop enforces it) ----------------
    //
    // `r.game` existing is NOT the same as a game being underway: setup.start builds the Game
    // during the confirm/reroll phase, and its currentTurnIndex is already 0, so whoever sits
    // first in the turn order is `currentPlayerId` before a single turn has begun. Without a
    // status check a stray game:gotit in that window was accepted and finished that player with
    // ZERO turns -- which is exactly what a phone tilting during the reroll stage produced.
    const playing = (r) => r && r.status === 'playing' && r.game;

    // A tab that was hidden has been counting the turn down on throttled timers, so it comes
    // back with a clock that has drifted and nothing to correct it until the turn changes.
    // Answering on the way back costs one message and beats pushing to everyone on a schedule.
    socket.on('game:resync', (_p, ack) => {
      const r = room();
      if (!playing(r) || !r.game.turnOrder.includes(playerId)) return ack?.({ ok: false });
      socket.emit('game:state', variant.playerView(r, playerId, namesOf(r), Date.now()));
      ack?.({ ok: true });
    });

    socket.on('game:pass', (_p, ack) => {
      const r = room();
      if (!playing(r)) return ack?.({ ok: false, error: 'No game running.' });
      const res = loop.pass(r.game, playerId);
      ack?.(res);
      if (res.ok) handleTurnResult(r, res, null);
    });

    socket.on('game:giveup', (_p, ack) => {
      const r = room();
      if (!playing(r)) return ack?.({ ok: false, error: 'No game running.' });
      const res = loop.giveUp(r.game, playerId);
      ack?.(res);
      if (res.ok) handleTurnResult(r, res, res.reveal);
    });

    // Host resets a finished game back to the lobby so the room can play again.
    socket.on('game:again', (_p, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (r.hostPlayerId !== playerId) return ack?.({ ok: false, error: 'Only the host can restart.' });
      turnEnded(r);
      clearTurnTimer(r);
      clearCountdown(r);
      r.game = null;
      r.status = 'lobby';
      ack?.({ ok: true });
      broadcastRoom(r);
    });

    // Rematch: re-deal with the same pool/difficulty and the same roster, straight back into the
    // confirm phase, without the host reconfiguring.
    socket.on('game:rematch', (_p, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (r.hostPlayerId !== playerId) return ack?.({ ok: false, error: 'Only the host can rematch.' });
      if (r.status !== 'finished') return ack?.({ ok: false, error: 'No finished game to rematch.' });
      // The picks are not kept (see setup.start), so "same settings" has nothing to deal. The
      // client routes the host to the picker instead; this is the answer for anything that asks.
      if (r.lastSetup?.hostPicks) {
        return ack?.({ ok: false, error: 'That game was hand-picked. Use Change settings to pick characters again.' });
      }
      if (r.players.size < 2) {
        return ack?.({
          ok: false,
          error:
            "Someone left, so there aren't enough players for a rematch. " +
            'Get another person to join with the room code, then try again.',
        });
      }
      turnEnded(r);
      clearTurnTimer(r);
      clearCountdown(r);
      const res = setup.start(r, r.lastSetup || {});
      if (!res.ok) return ack?.({ ok: false, error: res.error });
      r.status = 'setup';
      ack?.({ ok: true, label: res.label });
      broadcastRoom(r);
      emitSetup(r);
    });

    socket.on('setup:unlock', (_p, ack) => {
      const r = room();
      if (!r?.game) return ack?.({ ok: false, error: 'No game to set up.' });
      const res = setup.unlock(r.game, playerId);
      ack?.(res);
      emitSetup(r);
    });

    // Removing a player, host only.
    //
    // This exists because readiness became mandatory. Every player must confirm before the game
    // can begin, and confirming now requires a working motion sensor -- so one person on a
    // laptop, or one who tapped "Don't Allow", could hold a room of eight hostage forever. The
    // host could cancel the deal, but re-dealing walked straight back into the same wall, and
    // nothing except that player voluntarily leaving could break it. A gate with no override is
    // a deadlock with extra steps.
    socket.on('room:kick', ({ playerId: targetId } = {}, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (r.hostPlayerId !== playerId) return ack?.({ ok: false, error: 'Only the host can remove someone.' });
      if (!targetId || targetId === playerId) return ack?.({ ok: false, error: 'You cannot remove yourself.' });
      if (!r.players.has(targetId)) return ack?.({ ok: false, error: 'They are not in this room.' });
      const name = r.players.get(targetId).nickname || 'A player';

      // Mid-game removal is a forfeit, exactly as if they had left: their character is revealed
      // and the rotation moves on. Reusing the leave path rather than inventing a second one.
      if (r.status === 'playing' && r.game?.isActive(targetId)) {
        const res = loop.forfeit(r.game, targetId);
        if (res.ok) handleTurnResult(r, res, res.reveal);
      }
      abortSetupToLobby(r, `${name} was removed`);
      const { room: after } = registry.leaveRoom(r.code, targetId);

      // Tell their own sockets before they stop hearing about the room, or they sit on a screen
      // that has quietly stopped being real.
      const sockets = socketsIn(r);
      for (const s of sockets) {
        if (s.data.playerId === targetId) {
          s.emit('room:kicked', { reason: 'The host removed you from the room.' });
          s.leave(r.code);
          s.data.code = null;
        }
      }
      ack?.({ ok: true });
      broadcastRoom(after);
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

    // The events only this way of playing has. Handed what they need to act like the handlers
    // above: the room, whether it is really playing, and the one path that resolves a turn.
    variant.attachHandlers?.(socket, { playerId, room, playing, handleTurnResult, emitGame, namesOf });

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
