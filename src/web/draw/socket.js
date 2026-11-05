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
const tel = require('./telephone');
const { freshSeating } = require('../../core/game/seating');

// What a player can repeat inside a room, at well above a person's pace: dealing (which reads the
// pool) and guessing/chatting (which every screen in the room receives).
const dealBudget = perSocket({ max: 10, windowMs: 5000 });
const sayBudget = perSocket({ max: 8, windowMs: 4000 });
// Reactions to a drawing in progress: a fixed few, so none can carry a guess (or anything else)
// to a room that is still guessing. Rate-limited apart from guesses, so tapping ★ never costs a
// guess its budget.
const REACTIONS = new Set(['star', 'wow', 'huh', 'ha']);
const reactBudget = perSocket({ max: 5, windowMs: 3000 });
// Telephone guesses are sent as they are typed (debounced on the page), so a timeout keeps them.
const typeBudget = perSocket({ max: 30, windowMs: 5000 });
const Game = require('../../core/game/Game');

const ROUNDS = [1, 2, 3, 4, 5];
const DRAW_SECONDS = [60, 80, 100, 120];
// The palette and brush sizes. Anything else is refused rather than drawn: a stroke is relayed to
// every screen in the room, so it must be only what the client could make. Declared once, here,
// and sent to the client in room state -- the client used to keep its own copy, so adding a colour
// meant two edits, and missing one drew swatches the server silently dropped.
// Named, because a swatch is the one control where colour IS the content -- the names are what a
// screen reader, or anyone who can't tell two of them apart, has to go on.
// Chosen by measured distance (CIE76 ΔE between swatches), not by eye: Navy used to sit 24 from
// Black and read as black on the canvas; it is 54 now, with Blue brightened to keep the two apart.
// Orange was really amber, 28 from Yellow; it is a true orange now, clear of Red and Yellow. Every
// pair is at least 25 apart -- except along the skin range, six steps from Fair to Deep, 16 to 22
// apart: characters are mostly people, and a range is meant to be steps. It replaced Peach, Tan and
// a saddle Brown, which sat 14 from the step beside it; the range's own browns do hair and wood.
// Fair is 22 from the Eraser, so it still shows on the white page.
const PALETTE = [
  ['#1b1033', 'Black'], ['#545454', 'Dark grey'], ['#9a9a9a', 'Grey'], ['#e21b3c', 'Red'], ['#8c1c2c', 'Maroon'],
  ['#ff6d00', 'Orange'], ['#ffd60a', 'Yellow'], ['#8fd14f', 'Lime'], ['#26890c', 'Green'], ['#7d7f1f', 'Olive'],
  ['#12a4a0', 'Teal'], ['#7fd6ff', 'Sky blue'], ['#1f8bff', 'Blue'], ['#233fb5', 'Navy'], ['#c13ac1', 'Purple'],
  ['#b9a0ff', 'Lavender'], ['#ff7eb6', 'Pink'],
  ['#fad8bd', 'Fair skin'], ['#eeb485', 'Light skin'], ['#d38e55', 'Medium skin'], ['#9c5c32', 'Tan skin'],
  ['#653a23', 'Brown skin'], ['#3a2218', 'Deep skin'],
  ['#ffffff', 'Eraser'],
];
const COLOURS = new Set(PALETTE.map(([c]) => c));
const SIZE_LIST = [3, 8, 18, 36];
const SIZES = new Set(SIZE_LIST);
// What a Draw client is told about its room: the shared room state, plus the tools on offer.
const stateOf = (room) => ({ ...room.publicState(), palette: PALETTE, sizes: SIZE_LIST });
const MAX_POINTS_PER_TURN = 30000; // generous for a sketch, bounded for a stranger
const MAX_POINTS_PER_PIECE = 400;
// Every screen floods its whole canvas for each fill on every redraw (an undo replays them all),
// so a turn's fills are bounded the way its points are.
const MAX_FILLS_PER_TURN = 60;

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

/**
 * A piece of a stroke as a client sent it, checked: a palette colour, a brush size, points on the
 * canvas -- or a fill, whole, at one point. Null when it is anything else. Both modes draw with it.
 */
function cleanPiece(piece = {}) {
  const points = cleanPoints(piece.points);
  const id = String(piece.id ?? '').slice(0, 24);
  if (!points || !points.length || !id) return null;
  const color = String(piece.color ?? '').toLowerCase();
  if (!COLOURS.has(color)) return null;
  if (piece.kind === 'fill') return points.length === 1 ? { id, kind: 'fill', color, size: 0, points } : null;
  const size = Number(piece.size);
  return SIZES.has(size) ? { id, color, size, points } : null;
}

function attachDrawSockets(nsp, { registry }) {
  // The library's names, for "a typo that is somebody's name is not a typo" (game.js judging):
  // indexed now, at start-up, rather than inside the first guess of the first game.
  web.warmKnownNames();
  const broadcastRoom = (room) => room && nsp.to(room.code).emit('room:state', stateOf(room));

  const socketsIn = (room) => {
    const ids = nsp.adapter.rooms.get(room.code) ?? [];
    return [...ids].map((id) => nsp.sockets.get(id)).filter(Boolean);
  };

  // Every player gets their OWN view: the answer, the drawer's choices and insiders' lines differ
  // per person, so this is never a room broadcast. Not to anyone gone: a leaver's or removed
  // player's socket is still in the room when their departure is broadcast, and a view arriving
  // after they reached the start screen would put them straight back into the game.
  const isTel = (room) => room?.game?.mode === 'telephone';
  const emitViews = (room) => {
    const g = room.game;
    if (!g) return;
    const names = namesOf(room);
    const now = Date.now();
    for (const s of socketsIn(room)) {
      const id = s.data.playerId;
      if (!g.order.includes(id) || g.gone.has(id)) continue;
      if (isTel(room)) s.emit('tel:state', tel.viewFor(g, id, names, now));
      else s.emit('draw:state', draw.viewFor(g, id, names, now));
    }
  };

  // After anything that may have moved a Telephone game on: everyone's view, the clock, and the
  // room's status once the album is reached (the end screen's Rematch and Change Settings).
  function afterTel(room) {
    if (room.game?.phase === 'over' && room.status === 'playing') {
      room.status = 'finished';
      broadcastRoom(room);
    }
    emitViews(room);
    schedule(room);
  }

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
    // Paused: nothing is due until Continue, which schedules afresh.
    if (!g || room.status !== 'playing') return;
    if (isTel(room)) {
      if (tel.isPaused(g) || g.deadline == null) return;
      room.drawTimer = setTimeout(() => tick(room), Math.max(0, g.deadline - Date.now()) + 20);
      room.drawTimer.unref?.();
      return;
    }
    if (draw.isPaused(g)) return;
    const now = Date.now();
    const due = [g.deadline, ...(g.phase === 'drawing' ? draw.hintTimes(g).filter((t) => t > now) : [])].filter(Boolean);
    if (!due.length) return;
    room.drawTimer = setTimeout(() => tick(room), Math.max(0, Math.min(...due) - now) + 20);
    room.drawTimer.unref?.();
  }

  // Do whatever is due. Safe to call at any moment; calls itself again through schedule().
  function tick(room) {
    const g = room.game;
    // The watchdog ticks every room; a paused one has nothing due, however late it is.
    if (!g || room.status !== 'playing') return;
    if (isTel(room)) {
      if (tel.timeUp(g, Date.now())) return afterTel(room);
      return schedule(room);
    }
    if (draw.isPaused(g)) return;
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

  // A deleted room's timer goes with it, or its rounds play on to nobody until the game runs out.
  registry.onRoomDeleted((room) => {
    if (room.kind === 'draw') clearTimer(room);
  });

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
    const mode = config.mode === 'telephone' ? 'telephone' : 'classic';
    // Classic only: Telephone's pick is a different step, and it is not drawing for a room to guess.
    const search = mode === 'classic' && !!config.search;
    room.drawSettings = { mode, listIds, label, difficulty, rounds, drawSeconds, search, poolType: config.poolType, category: config.category, categories: config.categories };
    if (mode === 'telephone') return startTelephone(room, label);
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
    // Seated afresh, unlike the last game in this room (core/game/seating.js): the host no longer
    // always draws first, nor a rematch replays the same order.
    const order = freshSeating(room.order, room.lastOrder);
    room.game = draw.createDrawGame({ order, rounds, drawSeconds, castOf, categoryKnown, allowSearch: search, knownName: web.content.knownName });
    if (!dealChoices(room, Date.now())) {
      room.game = null;
      return { ok: false, error: `${label} has no characters at this difficulty.` };
    }
    room.lastOrder = order;
    room.status = 'playing';
    broadcastRoom(room);
    emitViews(room);
    schedule(room);
    return { ok: true, label };
  }

  // Telephone: up to three starting characters for everyone, none shared, pictures preferred. A
  // small pool gives fewer each rather than none -- one each is still a game.
  function startTelephone(room, label) {
    const s = room.drawSettings;
    // Seated afresh too: the order is who passes to whom, so it decides whose chain you continue.
    const order = freshSeating(room.order, room.lastOrder);
    if (order.length < tel.MIN_PLAYERS) return { ok: false, error: `Telephone needs at least ${tel.MIN_PLAYERS} players.` };
    const rows = web.content.randomCharacters(s.listIds, order.length * tel.CHOICES, [], s.difficulty, { preferImages: true });
    const each = Math.min(tel.CHOICES, Math.floor(rows.length / order.length));
    if (each < 1) return { ok: false, error: `${label} has too few characters at this difficulty for ${order.length} players.` };
    const heads = rows.map(headOf);
    const choices = new Map(order.map((id, i) => [id, heads.slice(i * each, (i + 1) * each)]));
    room.game = tel.begin(tel.createTelephone({ order, drawSeconds: s.drawSeconds, choices, knownName: web.content.knownName }), Date.now());
    room.lastOrder = order;
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
    if (isTel(room)) {
      // Their seat is skipped from here on; with one player left, straight to the replay.
      if (tel.removePlayer(g, playerId, Date.now()).ok) afterTel(room);
      return;
    }
    const res = draw.removePlayer(g, playerId, Date.now());
    if (!res.ok) return;
    emitViews(room);
    schedule(room);
  }

  // Below two players there is no game to keep going. Called once the one who went has left the
  // socket room, so the results reach only those still in it.
  function finishIfTooFew(room) {
    const g = room?.game;
    if (isTel(room)) return; // Telephone ends itself early (telephone.js removePlayer)
    if (g && room.status === 'playing' && g.order.filter((id) => !g.gone.has(id)).length < 2) finish(room);
  }

  nsp.on('connection', (socket) => {
    const playerId = access.identify(socket);
    if (!playerId) return;
    const room = () => registry.getRoom(socket.data.code);
    const isHost = () => room()?.hostPlayerId === playerId;

    socket.on('room:create', ({ nickname, avatar } = {}, ack) => {
      const res = access.createRoom(socket, registry, 'draw', nickname, avatar);
      if (!res.ok) return ack?.(res);
      ack?.({ ok: true, state: stateOf(res.room) });
      broadcastRoom(res.room);
    });

    // The lobby's face picker (shared/avatars.js). Any time, not only in the lobby: a face is
    // decoration, and the picker is simply not shown once a game is under way.
    socket.on('room:avatar', ({ avatar } = {}, ack) => {
      const res = access.setAvatar(socket, registry, avatar);
      if (!res.ok) return ack?.(res);
      ack?.({ ok: true, avatar: res.avatar });
      broadcastRoom(res.room);
    });

    socket.on('room:join', ({ code, nickname, avatar } = {}, ack) => {
      const res = access.joinRoom(socket, registry, 'draw', code, nickname, avatar);
      if (!res.ok) return ack?.(res);
      ack?.({ ok: true, state: stateOf(res.room), reconnected: res.reconnected });
      broadcastRoom(res.room);
      // Rejoining mid-game: the view, and the picture so far.
      const g = res.room.game;
      if (isTel(res.room) && g.order.includes(playerId) && ['playing', 'finished'].includes(res.room.status)) {
        socket.emit('tel:state', tel.viewFor(g, playerId, namesOf(res.room), Date.now()));
      } else if (g && res.room.status === 'playing' && g.order.includes(playerId)) {
        socket.emit('draw:canvas', { strokes: g.phase === 'drawing' ? g.strokes : [] });
        socket.emit('draw:state', draw.viewFor(g, playerId, namesOf(res.room), Date.now()));
      } else if (g && res.room.status === 'finished') {
        socket.emit('draw:over', draw.overFor(g, namesOf(res.room)));
        // Back on the end screen: the tally, and which one is theirs.
        socket.emit('draw:votes', { counts: draw.votesOf(g), mine: g.votes?.get(playerId) ?? null });
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
    // The host's browser re-applying what they switched off last time (content.js keepListsOff).
    socket.on('setup:keepOff', curate((p, r) => web.keepListsOff(p.listIds, r)));

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

    // A classic game running. Every classic handler asks this, so none of them can act on a
    // Telephone game (whose rules are telephone.js, handled below).
    const playing = (r) => r && r.status === 'playing' && r.game && !isTel(r);

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

    // A character the drawer searched for (game.js addSearched), when the host allowed it: by id from
    // the library, looked up again here in the web's own scope -- never a client's own description of
    // one -- or a name typed in, which has no picture. Not limited to the room's pool: searching is
    // an explicit choice, as the host's picker is (/api/browse/search, which the client asks).
    socket.on('draw:search', ({ id, name } = {}, ack) => {
      if (!dealBudget(socket)) return ack?.(SLOW_DOWN);
      const r = room();
      if (!playing(r)) return ack?.({ ok: false, error: 'No game running.' });
      const g = r.game;
      // Before the lookup, so a stranger's requests cannot make the server search for them.
      if (!g.allowSearch) return ack?.({ ok: false, error: "Searching isn't on in this room." });
      if (g.phase !== 'choosing' || draw.drawerOf(g) !== playerId) return ack?.({ ok: false, error: "It's not your turn to choose." });
      let row;
      if (id != null) {
        row = Number.isInteger(Number(id)) ? web.content.characterById(Number(id)) : null;
        if (!row) return ack?.({ ok: false, error: 'No such character.' });
      } else {
        const typed = String(name ?? '').trim().slice(0, 60);
        if (!typed.replace(/[^\p{L}\p{N}]/gu, '')) return ack?.({ ok: false, error: 'Type a name first.' });
        row = web.content.freeform(typed);
      }
      const res = draw.addSearched(g, playerId, headOf(row));
      // The views first, then the answer: the client opens the dialog on the answer, from a view that
      // already holds the new choice (one socket delivers in order).
      if (res.ok) emitViews(r);
      ack?.(res);
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
        // `nth`: how many have it now, this one included -- each one's cue climbs a step, so the
        // room hears how far round it has gone. Public already: the player list tags them all.
        nsp.to(r.code).emit('draw:correct', { playerId, name: namesOf(r)[playerId] ?? 'Player', points: res.points, nth: r.game.guessed.size });
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

    // The end screen's vote for the best drawing (game.js vote). The tally goes to everyone; who
    // voted for what goes to nobody.
    socket.on('draw:vote', ({ drawing } = {}, ack) => {
      if (!sayBudget(socket)) return ack?.(SLOW_DOWN);
      const r = room();
      if (!r?.game || r.status !== 'finished' || isTel(r)) return ack?.({ ok: false, error: 'Voting opens when the game ends.' });
      const res = draw.vote(r.game, playerId, drawing);
      ack?.(res);
      if (res.ok) nsp.to(r.code).emit('draw:votes', { counts: draw.votesOf(r.game) });
    });

    // A guesser reacts to the drawing: everyone sees it float up over the picture, the drawer
    // above all -- the one player who otherwise hears nothing until someone gets it.
    socket.on('draw:react', ({ kind } = {}, ack) => {
      if (!reactBudget(socket)) return ack?.(SLOW_DOWN);
      const r = room();
      if (!playing(r) || r.game.phase !== 'drawing' || draw.isPaused(r.game)) return ack?.({ ok: false, error: 'Nothing to react to right now.' });
      if (!REACTIONS.has(kind)) return ack?.({ ok: false, error: 'Unknown reaction.' });
      const g = r.game;
      if (playerId === draw.drawerOf(g) || !g.order.includes(playerId) || g.gone.has(playerId)) {
        return ack?.({ ok: false, error: 'Only the guessers react.' });
      }
      draw.noteReaction(g, playerId); // for Crowd Pleaser at the end
      nsp.to(r.code).emit('draw:reaction', { kind });
      ack?.({ ok: true });
    });

    // --- the picture ------------------------------------------------------------------------
    const drawerHere = (r) => playing(r) && r.game.phase === 'drawing' && !draw.isPaused(r.game) && draw.drawerOf(r.game) === playerId;

    socket.on('draw:stroke', (piece = {}) => {
      const r = room();
      if (!drawerHere(r)) return;
      const g = r.game;
      const p = cleanPiece(piece);
      if (!p) return;
      const { id, points } = p;
      if (g.strokes.reduce((n, s) => n + s.points.length, 0) + points.length > MAX_POINTS_PER_TURN) return;
      // A fill: one point, one palette colour, whole in one piece -- painted where it falls in the
      // order of strokes, so undo, a reconnect and the gallery all replay it like any other.
      if (p.kind === 'fill') {
        if (g.strokes.some((s) => s.id === id)) return;
        if (g.strokes.filter((s) => s.kind === 'fill').length >= MAX_FILLS_PER_TURN) return;
        g.strokes.push(p);
        socket.to(r.code).emit('draw:stroke', p);
        return;
      }
      let stroke = g.strokes.find((s) => s.id === id);
      if (stroke?.kind === 'fill') return; // a fill is whole when it arrives
      if (!stroke) {
        // A stroke keeps the colour and size it began with.
        stroke = { id, color: p.color, size: p.size, points: [] };
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

    // --- Telephone (telephone.js) ---------------------------------------------------------
    const telephone = (r) => r && r.game && isTel(r) && ['playing', 'finished'].includes(r.status);
    const telAct = (fn) => (payload = {}, ack) => {
      const r = room();
      if (!telephone(r)) return ack?.({ ok: false, error: 'No Telephone game running.' });
      const res = fn(r, payload);
      ack?.(res);
      if (res?.ok) afterTel(r);
    };
    socket.on('tel:pick', telAct((r, { index }) => tel.submit(r.game, playerId, { index }, Date.now())));
    socket.on('tel:submit', telAct((r, { text }) => tel.submit(r.game, playerId, { text }, Date.now())));
    socket.on('tel:reroll', (payload, ack) => {
      if (!dealBudget(socket)) return ack?.(SLOW_DOWN);
      telAct((r) => {
        const s = r.drawSettings;
        const g = r.game;
        if (g.phase !== 'pick' || g.done.has(playerId)) return { ok: false, error: 'Nothing to choose right now.' };
        const rows = web.content.randomCharacters(s.listIds, tel.CHOICES, tel.offeredNames(g), s.difficulty, { preferImages: true });
        return tel.rerollChoices(g, playerId, rows.map(headOf));
      })(payload, ack);
    });
    // The drawing in progress: kept for its drawer alone (a timeout hands in what there is, and a
    // reload gets it back), never relayed -- nobody watches a Telephone drawing being made.
    socket.on('tel:stroke', (piece = {}) => {
      const r = room();
      const p = cleanPiece(piece);
      if (telephone(r) && p) tel.addPiece(r.game, playerId, p);
    });
    socket.on('tel:typing', ({ text } = {}) => {
      const r = room();
      if (typeBudget(socket) && telephone(r)) tel.typeGuess(r.game, playerId, text);
    });
    socket.on('tel:undo', () => {
      const r = room();
      if (telephone(r)) tel.undo(r.game, playerId);
    });
    socket.on('tel:clear', () => {
      const r = room();
      if (telephone(r)) tel.clearDraft(r.game, playerId);
    });
    // The replay is the host's to move on, so the room watches each chain together.
    const hostReplay = (move) => (payload, ack) => {
      if (!isHost()) return ack?.({ ok: false, error: 'The host moves the replay on.' });
      telAct((r) => move(r.game))(payload, ack);
    };
    socket.on('tel:next', hostReplay(tel.replayNext));
    socket.on('tel:back', hostReplay(tel.replayBack));
    socket.on('tel:resync', (_p, ack) => {
      const r = room();
      if (!telephone(r) || !r.game.order.includes(playerId)) return ack?.({ ok: false });
      socket.emit('tel:state', tel.viewFor(r.game, playerId, namesOf(r), Date.now()));
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

    // The host stops the clock, and starts it again (game.js pause / resume).
    socket.on('room:pause', ({ paused } = {}, ack) => {
      const r = room();
      if (!r) return ack?.({ ok: false, error: 'Not in a room.' });
      if (!isHost()) return ack?.({ ok: false, error: 'Only the host can pause.' });
      if (r.status !== 'playing' || !r.game) return ack?.({ ok: false, error: 'There is no game running to pause.' });
      const now = Date.now();
      const rules = isTel(r) ? tel : draw;
      if (paused) rules.pause(r.game, now);
      else rules.resume(r.game, now);
      ack?.({ ok: true, paused: rules.isPaused(r.game) });
      broadcastRoom(r);
      emitViews(r);
      schedule(r);
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
