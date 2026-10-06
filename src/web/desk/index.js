// Desk: Guess the Character on computers.
//
// Same game as the phones -- ../guess deals it, checks it and runs its turns -- played the other
// way round: every screen shows everybody's character except its owner's (./view.js), questions
// are asked out loud or over a call, and the guesser TYPES their answer (./guessing.js). Typed
// guesses are judged by the compendium's checker; a close one goes to the other players.
//
// Served at /desk/ with its own socket.io namespace (/desk), mounted by ../server.js. Rooms come
// from the same registry as the phones', marked kind 'desk', so a phone can never be dealt into a
// game its client cannot draw.

const path = require('path');
const { attachSockets } = require('../guess/socket');
const { setup } = require('../guess/service');
const loop = require('../guess/turnLoop');
const { content } = require('../content');
const guessing = require('./guessing');
const { buildBoardView } = require('./view');
const notes = require('./notes');
const { poolIndex } = require('../../compendium/answers');
const { perSocket, SLOW_DOWN } = require('../rateLimit');

// Typed guesses: a fast typist manages one a second or so.
const guessBudget = perSocket({ max: 8, windowMs: 4000 });

// How long the others get to rule on a close guess before it lapses as a miss. Long enough to
// read a name and tap; short enough that a table that has wandered off cannot hold a turn.
const RULING_MS = Number(process.env.WEB_DESK_RULING_MS || 20000);

// What a guess of one word must be told apart from: the guesser's own show, indexed by word once
// per show per game. "Fred" names the one Fred in his show, though somewhere among 25,000
// characters there is always another -- judged against the whole pool, a first name was "close"
// more often than not. A character with no list behind it (a name the host typed) has no show,
// so it is told apart from the whole pool instead.
function othersFor(game, character) {
  game.deskCasts ??= new Map();
  const key = character?.listId ?? 'pool';
  if (!game.deskCasts.has(key)) {
    const names = character?.listId != null ? content.poolNames([character.listId]) : content.poolNames(game.lobby.listIds ?? []);
    game.deskCasts.set(key, poolIndex(names));
  }
  return game.deskCasts.get(key);
}

function clearRulingTimer(room) {
  if (room?.rulingTimer) {
    clearTimeout(room.rulingTimer);
    room.rulingTimer = null;
  }
}

const variant = {
  kind: 'desk',
  // No countdown: there is no phone to raise. Play starts the moment everyone is in.
  graceSeconds: 0,
  playerView: (room, viewerId, names, now) => buildBoardView(room.game, viewerId, names, now),

  // A turn whose clock runs out while the others are ruling waits for the ruling: the guess was
  // made in time, and it would be a strange rule that let a slow tap cost somebody their answer.
  // RULING_MS bounds the wait.
  deferTimeout: (room) => !!guessing.pendingRuling(room.game),

  onTurnEnded(room) {
    clearRulingTimer(room);
    if (room?.game) guessing.endTurnState(room.game);
  },

  attachHandlers(socket, { playerId, room, playing, handleTurnResult, emitGame, namesOf }) {
    // After a miss or a rejected ruling: if the clock ran out while that was being decided, the
    // turn ends now, as the timeout it was always going to be.
    const settleAfterMiss = (r) => {
      const g = r.game;
      if (!g.pausedForDisconnect && g.turnEndsAt && g.turnEndsAt <= Date.now()) {
        const res = loop.timeout(g, g.currentPlayerId);
        if (res.ok) return handleTurnResult(r, res, null);
      }
      emitGame(r);
    };

    // To everyone in the room, for the feed: who guessed what, and how it went. Never the answer
    // -- the guesser is in this room too.
    const announce = (r, text, verdict, extra = {}) =>
      socket.nsp.to(r.code).emit('desk:guess', { name: namesOf(r)[playerId] ?? 'Player', text, verdict, ...extra });

    socket.on('game:guess', (payload = {}, ack) => {
      if (!guessBudget(socket)) return ack?.(SLOW_DOWN);
      const r = room();
      if (!playing(r)) return ack?.({ ok: false, error: 'No game running.' });
      const res = guessing.submitGuess(r.game, playerId, payload.text, { others: othersFor(r.game, r.game.headByPlayer[playerId]) });
      if (!res.ok) return ack?.(res);
      ack?.({ ok: true, verdict: res.verdict });
      const text = String(payload.text).trim().slice(0, guessing.GUESS_MAX);
      announce(r, text, res.verdict);
      if (res.verdict === 'correct') return handleTurnResult(r, res, res.reveal);
      if (res.verdict === 'close') {
        clearRulingTimer(r);
        const id = res.rulingId;
        r.rulingTimer = setTimeout(() => {
          r.rulingTimer = null;
          if (r.status !== 'playing' || !guessing.lapse(r.game, id).ok) return;
          socket.nsp.to(r.code).emit('desk:ruled', { accepted: false, lapsed: true });
          settleAfterMiss(r);
        }, RULING_MS);
        r.rulingTimer.unref?.();
        return emitGame(r);
      }
      return emitGame(r); // a miss: the log changed, the turn goes on
    });

    // A player's notes, sent as they type (the client waits for a pause). Stored on the game, so
    // a rematch starts clean, and broadcast as they are -- only what ./notes.js lets through.
    socket.on('desk:notes', (payload = {}, ack) => {
      const r = room();
      if (!playing(r)) return ack?.({ ok: false, error: 'Notes are for during a game.' });
      if (String(payload.text ?? '') === notes.notesOf(r.game, playerId)) return ack?.({ ok: true });
      const res = notes.setNotes(r.game, playerId, payload.text);
      ack?.(res);
      if (res.ok) socket.nsp.to(r.code).emit('desk:notes', { playerId, text: res.text });
    });

    socket.on('game:rule', (payload = {}, ack) => {
      const r = room();
      if (!playing(r)) return ack?.({ ok: false, error: 'No game running.' });
      const res = guessing.rule(r.game, playerId, Number(payload.id), !!payload.accept);
      if (!res.ok) return ack?.(res);
      clearRulingTimer(r);
      ack?.({ ok: true, accepted: res.accepted });
      socket.nsp.to(r.code).emit('desk:ruled', { accepted: res.accepted, by: namesOf(r)[playerId] ?? 'Player' });
      if (res.accepted) return handleTurnResult(r, res, res.reveal);
      return settleAfterMiss(r);
    });
  },
};

module.exports = {
  // The client, served by ../server.js at /desk/.
  publicDir: path.join(__dirname, 'public'),
  attach: (io, { registry }) => attachSockets(io.of('/desk'), { registry, setup, variant }),
};
