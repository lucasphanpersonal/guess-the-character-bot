// Socket.io wiring for Draw the Character (namespace /draw).
//
// Translates events into calls on the rules (./game.js) and broadcasts per-player views; owns the
// clock. Rooms come from the shared registry (kind 'draw'), and getting into one -- identifying,
// creating, joining, and the limits on strangers -- is ../roomAccess.js, as for every web game.
//
// Time: ONE timer per room, always aimed at the next thing due (the end of choosing, a hint, the
// end of the drawing, the end of the reveal), and a watchdog that re-checks against the wall
// clock, because a laptop that sleeps fires its timers late. tick() is safe to call at any time:
// it does whatever is due and nothing else.
//
// Strokes: the drawer sends them in pieces as they draw; the server checks every number, keeps
// the turn's strokes (so a reconnecting browser can redraw the picture) and passes each piece on.

const access = require('../roomAccess');
const draw = require('./game');
const web = require('../content');
const { poolIndex } = require('../../compendium/answers');
const { perSocket, SLOW_DOWN } = require('../rateLimit');

// What a player can repeat inside a room, at well above a person's pace: dealing (which reads the
// pool) and guessing/chatting (which every screen in the room receives).
const dealBudget = perSocket({ max: 10, windowMs: 5000 });
const sayBudget = perSocket({ max: 8, windowMs: 4000 });
const Game = require('../../core/game/Game');

const ROUNDS = [1, 2, 3, 4, 5];
const DRAW_SECONDS = [60, 80, 100, 120];
// The palette and brush sizes. Anything else is refused rather than drawn: a stroke is relayed to
// every screen in the room, so it must be only what the client could make. Declared once, here,
// and sent to the client in room state -- the client used to keep its own copy, so adding a colour
// meant two edits, and missing one drew swatches the server silently dropped.
// Named, because a swatch is the one control where colour IS the content -- the names are what a
// screen reader, or anyone who can't tell two of them apart, has to go on. Two skin tones and the
// browns are there because characters are mostly people.
// Chosen by measured distance (CIE76 ΔE between swatches), not by eye: Navy used to sit 24 from
// Black and read as black on the canvas; it is 54 now, with Blue brightened to keep the two apart.
// Orange was really amber, 28 from Yellow; it is a true orange now, clear of Red, Yellow and Tan.
const PALETTE = [
  ['#1b1033', 'Black'], ['#9a9a9a', 'Grey'], ['#e21b3c', 'Red'], ['#ff6d00', 'Orange'], ['#ffd60a', 'Yellow'],
  ['#8fd14f', 'Lime'], ['#26890c', 'Green'], ['#12a4a0', 'Teal'], ['#7fd6ff', 'Sky blue'], ['#1f8bff', 'Blue'],
  ['#233fb5', 'Navy'], ['#c13ac1', 'Purple'], ['#ff7eb6', 'Pink'], ['#f8c9a0', 'Peach'], ['#c68642', 'Tan'],
  ['#8b4513', 'Brown'], ['#ffffff', 'Eraser'],
];
const COLOURS = new Set(PALETTE.map(([c]) => c));
const SIZE_LIST = [3, 8, 18, 36];
const SIZES = new Set(SIZE_LIST);
// What a Draw client is told about its room: the shared room state, plus the tools on offer.
const stateOf = (room) => ({ ...room.publicState(), palette: PALETTE, sizes: SIZE_LIST });
const MAX_POINTS_PER_TURN = 30000; // generous for a sketch, bounded for a stranger
const MAX_POINTS_PER_PIECE = 400;

const namesOf = (room) => {
  const names = {};
  for (const [id, nickname] of room.departedNames ?? []) names[id] = nickname;
  for (const [id, seat] of room.players) names[id] = seat.nickname;
  return names;
};

// The DB row a deal returns, in the shape every game passes around (name, imageUrl, source, id),
// plus its origin in parts for the turn's clue (./game.js clueFor).
const headOf = (row) => ({ ...Game.head({ guildId: web.WEB_SCOPE }, row), origin: web.content.originOf(row) });

function cleanPoints(points) {
  if (!Array.isArray(points)) return null;
  const out = [];
  for (const p of points.slice(0, MAX_POINTS_PER_PIECE)) {
    if (!Array.isArray(p)) return null;
    const [x, y] = p.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    // Three decimals is a pixel on any canvas a person will use, and a third of the bytes.
    out.push([Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
  }
  return out;
}

function attachDrawSockets(nsp, { registry }) {
  const broadcastRoom = (room) => room && nsp.to(room.code).emit('room:state', stateOf(room));

  const socketsIn = (room) => {
    const ids = nsp.adapter.rooms.get(room.code) ?? [];
    return [...ids].map((id) => nsp.sockets.get(id)).filter(Boolean);
  };

  // Every player gets their OWN view: the answer, the drawer's choices and insiders' lines differ
  // per person, so this is never a room broadcast. Not to anyone gone: a leaver's or removed
  // player's socket is still in the room when their departure is broadcast, and a view arriving
  // after they reached the start screen would put them straight back into the game.
  const emitViews = (room) => {
    const g = room.game;
    if (!g) return;
    const names = namesOf(room);
    const now = Date.now();
    for (const s of socketsIn(room)) {
      const id = s.data.playerId;
      if (g.order.includes(id) && !g.gone.has(id)) s.emit('draw:state', draw.viewFor(g, id, names, now));
    }
  };

  // The next characters for the current drawer. Prefer ones with a picture -- the drawer needs
  // something to draw from -- and never one already drawn this game.
  function dealChoices(room, now) {
    const g = room.game;
    const s = room.drawSettings;
    const rows = web.content.randomCharacters(s.listIds, draw.CHOICES, g.used, s.difficulty, { preferImages: true });
    if (!rows.length) return false;
    draw.offerChoices(g, rows.map(headOf), now);
    nsp.to(room.code).emit('draw:canvas', { strokes: [] });
    return true;
  }

  function finish(room) {
    clearTimer(room);
    room.status = 'finished';
    room.game.phase = 'over';
    nsp.to(room.code).emit('draw:over', draw.overFor(room.game, namesOf(room)));
    broadcastRoom(room);
  }

  const clearTimer = (room) => {
    if (room?.drawTimer) {
      clearTimeout(room.drawTimer);
      room.drawTimer = null;
    }
  };

  // Aim the room's one timer at whatever is due next.
  function schedule(room) {
    clearTimer(room);
    const g = room.game;
    if (!g || room.status !== 'playing') return;
    const now = Date.now();
    const due = [g.deadline, ...(g.phase === 'drawing' ? draw.hintTimes(g).filter((t) => t > now) : [])].filter(Boolean);
    if (!due.length) return;
    room.drawTimer = setTimeout(() => tick(room), Math.max(0, Math.min(...due) - now) + 20);
    room.drawTimer.unref?.();
  }

  // Do whatever is due. Safe to call at any moment; calls itself again through schedule().
  function tick(room) {
    const g = room.game;
    if (!g || room.status !== 'playing') return;
    const now = Date.now();
    let changed = false;

    if (g.phase === 'drawing') {
      if (draw.revealDueHints(g, now)) changed = true;
      if (g.deadline <= now) {
        draw.endTurn(g, now, 'time');
        changed = true;
      }
    }
    if (g.phase === 'reveal' && g.deadline <= now) {
      if (draw.advance(g).over) return finish(room);
      if (!dealChoices(room, now)) return finish(room); // the pool ran dry
      changed = true;
    }
    if (changed) emitViews(room);
    schedule(room);
  }

  const watchdog = setInterval(() => {
    for (const room of registry.allRooms()) if (room.kind === 'draw' && room.status === 'playing') tick(room);
  }, 2000);
  watchdog.unref?.();

  function start(room, config) {
    const { listIds, label } = web.resolvePool({ poolType: config.poolType, category: config.category, categories: config.categories, excluded: room.excludedListIds });
    if (!listIds.length) return { ok: false, error: 'That selection has no playable lists.' };
    const rounds = ROUNDS.includes(Number(config.rounds)) ? Number(config.rounds) : 3;
    const drawSeconds = DRAW_SECONDS.includes(Number(config.drawSeconds)) ? Number(config.drawSeconds) : 80;
    const difficulty = config.difficulty || web.DEFAULT_DIFFICULTY;
    room.drawSettings = { listIds, label, difficulty, rounds, drawSeconds, poolType: config.poolType, category: config.category, categories: config.categories };
    // A character's show, indexed by word the first time one of its characters is drawn: a guess of
    // one word counts only when nobody else in that show shares it (see game.js).
    const casts = new Map();
    const castOf = (c) => {
      if (c?.listId == null) return [];
      if (!casts.has(c.listId)) casts.set(c.listId, poolIndex(web.content.castOf([c.listId])));
      return casts.get(c.listId);
    };
    // One category in the whole pool, however the host got there (picked it, Surprise Me, or lists
    // that happen to share one): the kind of work is no hint, so it shows from the start.
    const categoryKnown = web.content.categoryCount(listIds) === 1;
    room.game = draw.createDrawGame({ order: [...room.order], rounds, drawSeconds, castOf, categoryKnown });
    if (!dealChoices(room, Date.now())) {
      room.game = null;
      return { ok: false, error: `${label} has no characters at this difficulty.` };
    }
    room.status = 'playing';
    broadcastRoom(room);
    emitViews(room);
    schedule(room);
    return { ok: true, label };
  }

  // Someone leaves for good: off the board for turns, kept for the scores.
  function departGame(room, playerId) {
    const g = room?.game;
    if (!g || room.status !== 'playing') return;
    const res = draw.removePlayer(g, playerId, Date.now());
    if (!res.ok) return;
    emitViews(room);
    schedule(room);
  }

  // Below two players there is no game to keep going. Called once the one who went has left the
  // socket room, so the results reach only those still in it.
  function finishIfTooFew(room) {
    const g = room?.game;
    if (g && room.status === 'playing' && g.order.filter((id) => !g.gone.has(id)).length < 2) finish(room);
  }

  nsp.on('connection', (socket) => {
    const playerId = access.identify(socket);
    if (!playerId) return;
    const room = () => registry.getRoom(socket.data.code);
    const isHost = () => room()?.hostPlayerId === playerId;

    socket.on('room:create', ({ nickname } = {}, ack) => {
      const res = access.createRoom(socket, registry, 'draw', nickname);
      if (!res.ok) return ack?.(res);
      ack?.({ ok: true, state: stateOf(res.room) });
      broadcastRoom(res.room);
    });

    socket.on('room:join', ({ code, nickname } = {}, ack) => {
      const res = access.joinRoom(socket, registry, 'draw', code, nickname);
      if (!res.ok) return ack?.(res);
      ack?.({ ok: true, state: stateOf(res.room), reconnected: res.reconnected });
      broadcastRoom(res.room);
      // Rejoining mid-game: the view, and the picture so far.
      const g = res.room.game;
      if (g && res.room.status === 'playing' && g.order.includes(playerId)) {
        socket.emit('draw:canvas', { strokes: g.phase === 'drawing' ? g.strokes : [] });
        socket.emit('draw:state', draw.viewFor(g, playerId, namesOf(res.room), Date.now()));
      } else if (g && res.room.status === 'finished') {
        socket.emit('draw:over', draw.overFor(g, namesOf(res.room)));
      }
    });

    socket.on('draw:options', (_p, ack) => ack?.(web.poolOptions()));

    // The pool picker's curation, the same events and rules as Guess the Character's: scoped to
    // this room, never written to the web's selection, host only.
    const curate = (fn) => (payload = {}, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (!isHost()) return ack?.({ ok: false, error: 'Only the host can curate lists.' });
      return ack?.(fn(payload, r));
    };
    socket.on('setup:categoryLists', curate((p, r) => (p.category ? { ok: true, lists: web.listsInCategory(p.category, r) } : { ok: false, error: 'No category given.' })));
    socket.on('setup:toggleList', curate((p, r) => web.toggleList(p.listId, r)));
    socket.on('setup:setLists', curate((p, r) => web.setListsPlaying(p.listIds, !!p.playing, r)));

    socket.on('draw:start', (config = {}, ack) => {
      if (!dealBudget(socket)) return ack?.(SLOW_DOWN);
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (!isHost()) return ack?.({ ok: false, error: 'Only the host can start.' });
      if (r.status === 'playing') return ack?.({ ok: false, error: 'Already playing.' });
      if (r.players.size < 2) return ack?.({ ok: false, error: 'Need at least 2 players.' });
      ack?.(start(r, config));
    });

    // Same settings, same roster, straight back in.
    socket.on('draw:rematch', (_p, ack) => {
      if (!dealBudget(socket)) return ack?.(SLOW_DOWN);
      const r = room();
      if (!r || !isHost()) return ack?.({ ok: false, error: 'Only the host can rematch.' });
      if (r.status !== 'finished') return ack?.({ ok: false, error: 'No finished game to rematch.' });
      if (r.players.size < 2) return ack?.({ ok: false, error: 'Need at least 2 players for a rematch.' });
      ack?.(start(r, r.drawSettings ?? {}));
    });

    socket.on('draw:again', (_p, ack) => {
      const r = room();
      if (!r || !isHost()) return ack?.({ ok: false, error: 'Only the host can do that.' });
      clearTimer(r);
      r.game = null;
      r.status = 'lobby';
      ack?.({ ok: true });
      broadcastRoom(r);
    });

    const playing = (r) => r && r.status === 'playing' && r.game;

    socket.on('draw:choose', ({ index, alsoAccept, shownAs } = {}, ack) => {
      const r = room();
      if (!playing(r)) return ack?.({ ok: false, error: 'No game running.' });
      const res = draw.choose(r.game, playerId, index, Date.now(), alsoAccept, shownAs);
      ack?.(res);
      if (res.ok) {
        emitViews(r);
        schedule(r);
      }
    });

    // Three new characters to choose from. Pictures preferred, as for the first three.
    socket.on('draw:reroll', (_p, ack) => {
      if (!dealBudget(socket)) return ack?.(SLOW_DOWN);
      const r = room();
      if (!playing(r)) return ack?.({ ok: false, error: 'No game running.' });
      const g = r.game;
      const s = r.drawSettings;
      // Checked before dealing too, so a stranger's spam cannot make the server shuffle the pool.
      if (g.phase !== 'choosing' || draw.drawerOf(g) !== playerId) return ack?.({ ok: false, error: "It's not your turn to choose." });
      const rows = web.content.randomCharacters(s.listIds, draw.CHOICES, draw.rerollExclusions(g), s.difficulty, { preferImages: true });
      const res = draw.rerollChoices(g, playerId, rows.map(headOf), Date.now());
      ack?.(res);
      if (res.ok) {
        emitViews(r);
        schedule(r);
      }
    });

    socket.on('draw:say', ({ text } = {}, ack) => {
      if (!sayBudget(socket)) return ack?.(SLOW_DOWN);
      const r = room();
      if (!playing(r)) return ack?.({ ok: false, error: 'No game running.' });
      const res = draw.say(r.game, playerId, text, Date.now());
      ack?.(res.ok ? { ok: true, verdict: res.verdict, points: res.points } : res);
      if (!res.ok) return;
      // A close guess goes out too: viewFor shows it to those who know (the drawer above all) and
      // to nobody still guessing, for whom "Sasuek" would be a hint.
      if (res.verdict === 'correct') {
        // The playerId lets the guesser's own page tell this apart from someone else getting it.
        nsp.to(r.code).emit('draw:correct', { playerId, name: namesOf(r)[playerId] ?? 'Player', points: res.points });
        if (res.allDone) draw.endTurn(r.game, Date.now(), res.doneReason);
        emitViews(r);
        return schedule(r);
      }
      emitViews(r);
    });

    // A stuck guesser gives up on this drawing: shown the answer, out of the guessing, and -- if
    // that leaves nobody still guessing -- the turn ends now rather than at the clock.
    socket.on('draw:giveup', (_p, ack) => {
      if (!sayBudget(socket)) return ack?.(SLOW_DOWN);
      const r = room();
      if (!playing(r)) return ack?.({ ok: false, error: 'No game running.' });
      const res = draw.giveUp(r.game, playerId);
      ack?.(res.ok ? { ok: true } : res);
      if (!res.ok) return undefined;
      nsp.to(r.code).emit('draw:gaveup', { playerId, name: namesOf(r)[playerId] ?? 'Player' });
      if (res.allDone) draw.endTurn(r.game, Date.now(), res.doneReason);
      emitViews(r);
      return schedule(r);
    });

    // --- the picture ------------------------------------------------------------------------
    const drawerHere = (r) => playing(r) && r.game.phase === 'drawing' && draw.drawerOf(r.game) === playerId;

    socket.on('draw:stroke', (piece = {}) => {
      const r = room();
      if (!drawerHere(r)) return;
      const g = r.game;
      const points = cleanPoints(piece.points);
      const id = String(piece.id ?? '').slice(0, 24);
      if (!points || !points.length || !id) return;
      if (g.strokes.reduce((n, s) => n + s.points.length, 0) + points.length > MAX_POINTS_PER_TURN) return;
      let stroke = g.strokes.find((s) => s.id === id);
      if (!stroke) {
        const colour = String(piece.color ?? '').toLowerCase();
        const size = Number(piece.size);
        if (!COLOURS.has(colour) || !SIZES.has(size)) return;
        stroke = { id, color: colour, size, points: [] };
        g.strokes.push(stroke);
      }
      stroke.points.push(...points);
      socket.to(r.code).emit('draw:stroke', { id, color: stroke.color, size: stroke.size, points });
    });

    socket.on('draw:undo', () => {
      const r = room();
      if (!drawerHere(r)) return;
      r.game.strokes.pop();
      nsp.to(r.code).emit('draw:canvas', { strokes: r.game.strokes });
    });

    socket.on('draw:clear', () => {
      const r = room();
      if (!drawerHere(r)) return;
      r.game.strokes = [];
      nsp.to(r.code).emit('draw:canvas', { strokes: [] });
    });

    // A tab that was hidden asks for the picture and the clock on its way back.
    socket.on('draw:resync', (_p, ack) => {
      const r = room();
      if (!playing(r) || !r.game.order.includes(playerId)) return ack?.({ ok: false });
      socket.emit('draw:canvas', { strokes: r.game.phase === 'drawing' ? r.game.strokes : [] });
      socket.emit('draw:state', draw.viewFor(r.game, playerId, namesOf(r), Date.now()));
      ack?.({ ok: true });
    });

    socket.on('room:leave', (_p, ack) => {
      const code = socket.data.code;
      if (!code) return ack?.({ ok: true });
      const before = registry.getRoom(code);
      departGame(before, playerId);
      const { room: after } = registry.leaveRoom(code, playerId);
      socket.leave(code);
      socket.data.code = null;
      ack?.({ ok: true });
      broadcastRoom(after);
      finishIfTooFew(after);
    });

    // Removing a player, host only -- as in the guessing games. Without it, someone who walks away
    // from the computer keeps their seat for the whole game: every turn of theirs runs its full
    // clock with nobody drawing, and the room can only wait. Mid-game it is the same as leaving
    // (departGame: their score stays, and if the turn was theirs it ends).
    socket.on('room:kick', ({ playerId: targetId } = {}, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (!isHost()) return ack?.({ ok: false, error: 'Only the host can remove someone.' });
      if (!targetId || targetId === playerId) return ack?.({ ok: false, error: 'You cannot remove yourself.' });
      if (!r.players.has(targetId)) return ack?.({ ok: false, error: 'They are not in this room.' });

      departGame(r, targetId);
      const { room: after } = registry.leaveRoom(r.code, targetId);
      // Tell their own sockets before they stop hearing about the room, or they sit on a screen
      // that has quietly stopped being real.
      for (const s of socketsIn(r)) {
        if (s.data.playerId !== targetId) continue;
        s.emit('room:kicked', { reason: 'The host removed you from the room.' });
        s.leave(r.code);
        s.data.code = null;
      }
      ack?.({ ok: true });
      broadcastRoom(after);
      finishIfTooFew(after);
    });

    socket.on('disconnect', () => {
      const code = socket.data.code;
      if (!code) return;
      // A dropped connection keeps the seat, and the turn goes on: a drawer who reloads comes back
      // to their picture, and one who never returns simply runs out of time.
      const { room: r, nowOffline } = registry.detachConnection(code, playerId, socket.id);
      if (nowOffline) broadcastRoom(r);
    });
  });
}

module.exports = { attachDrawSockets, PALETTE, COLOURS, SIZES };
