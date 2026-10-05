// What a computer shows during play: the board.
//
// Everybody's character on the table, except your own. That is the whole difference from the
// phones (../party/view.js), whose forehead view carries the viewer's own character on purpose --
// a computer has no forehead, so here that would simply show you your answer. The rule this file
// exists to keep: NOTHING in a player's view names their own character while they are still
// guessing -- not the board, not a ruling, not a log line. test/desk.test.js checks the whole
// payload, not just the obvious field.

const { publicCharacter } = require('../publicCharacter');
const loop = require('../guess/turnLoop');
const guessing = require('./guessing');
const { notesOf } = require('./notes');

// How many of the current player's guesses to show: enough to see what has been tried, few
// enough to read at a glance.
const LOG_SHOWN = 8;

function buildBoardView(game, viewerId, names, now = Date.now()) {
  const nameOf = (id) => names[id] ?? 'Player';
  const currentId = game.currentPlayerId;
  const isMyTurn = viewerId === currentId && game.isActive(viewerId) && !game.finished;
  // Your own card turns over once you can no longer be playing for it.
  const ownRevealed = game.finished || game.finishedBy.has(viewerId) || game.surrendered.has(viewerId);
  const standings = loop.standingsView(game, names);
  const statusOf = new Map(standings.map((s) => [s.playerId, s]));

  const board = game.turnOrder.map((id) => ({
    playerId: id,
    name: nameOf(id),
    isMe: id === viewerId,
    status: statusOf.get(id)?.status ?? 'waiting',
    turns: statusOf.get(id)?.turns ?? 0,
    character: id === viewerId && !ownRevealed ? null : publicCharacter(game.headByPlayer[id]),
    // Everyone's notes, to everyone -- ./notes.js refuses any that would name a character its
    // reader is still guessing.
    notes: notesOf(game, id),
  }));

  const ruling = guessing.pendingRuling(game);
  let rulingView = null;
  if (ruling && !game.finished) {
    rulingView =
      ruling.playerId === viewerId
        ? // The guesser sees only that it is waiting -- their own text, and NOTHING about the answer.
          { id: ruling.id, waiting: true, text: ruling.text }
        : {
            id: ruling.id,
            waiting: false,
            by: nameOf(ruling.playerId),
            text: ruling.text,
            // What the guess is being held up against, so a ruler does not have to look it up.
            answer: publicCharacter(game.headByPlayer[ruling.playerId]),
            // A player who is not in the game cannot rule (guessing.rule refuses them).
            canRule: game.turnOrder.includes(viewerId),
          };
  }

  return {
    phase: game.finished ? 'over' : 'playing',
    paused: !!game.pausedForDisconnect,
    current: {
      playerId: currentId,
      name: nameOf(currentId),
      turnNumber: game.turnsFor(currentId),
      outOfContention: game.isOutOfContention(currentId),
    },
    isMyTurn,
    // No "got it" button on a computer: a typed guess is the only way to claim one.
    buttons: isMyTurn ? { ...loop.buttonsFor(game), gotIt: false } : null,
    outOfContentionNote: isMyTurn && game.isOutOfContention(viewerId) ? loop.OUT_OF_CONTENTION_NOTE : null,
    turnRemaining: loop.turnRemainingOf(game, now),
    turnSeconds: game.turnSeconds,
    board,
    // The current player's recent guesses, newest first: what they have already tried. Their
    // own words only -- a log line never carries the answer.
    guesses: guessing
      .guessLog(game)
      .filter((g) => g.playerId === currentId)
      .slice(-LOG_SHOWN)
      .reverse()
      .map((g) => ({ text: g.text, verdict: g.verdict, ruledBy: g.ruledBy ? nameOf(g.ruledBy) : null, lapsed: !!g.lapsed })),
    ruling: rulingView,
    standings,
    me: {
      finished: game.finishedBy.has(viewerId),
      turns: game.finishedBy.get(viewerId) ?? null,
      character: ownRevealed ? publicCharacter(game.headByPlayer[viewerId]) : null,
    },
  };
}

module.exports = { buildBoardView };
