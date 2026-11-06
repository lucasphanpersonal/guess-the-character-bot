// What a phone shows during play: forehead mode.
//
// Every phone shows ITS OWN wearer's character for the room to read; the wearer holds it to their
// head and doesn't look, and a tilt resolves the turn -- exactly as the physical game trusts. That
// is why this view, and only this one, carries the viewer's own character (`myCharacter`). A
// computer has no forehead, and ../desk/view.js must never do the same.

const { publicCharacter } = require('../publicCharacter');
const loop = require('../guess/turnLoop');

/**
 * Per-player view of a running (or finished) game. The current player, on their own turn, is
 * NOT shown their character; everyone else sees the guesser's character to verify a "got it".
 */
function buildGameView(game, viewerId, names, now = Date.now()) {
  const currentId = game.currentPlayerId;
  const isMyTurn = viewerId === currentId && game.isActive(viewerId) && !game.finished;

  return {
    phase: game.finished ? 'over' : 'playing',
    // True while the current player is disconnected -- their clock is held and everyone waits.
    paused: !!game.pausedForDisconnect,
    hostPaused: !!game.hostPaused,
    current: {
      playerId: currentId,
      name: names[currentId] ?? 'Player',
      turnNumber: game.turnsFor(currentId),
      outOfContention: game.isOutOfContention(currentId),
    },
    isMyTurn,
    buttons: isMyTurn ? loop.buttonsFor(game) : null,
    // The viewer's OWN character. In forehead mode every phone shows its wearer's character for
    // the room to see -- the wearer holds it to their head and doesn't look, exactly as the
    // physical game trusts. Sent to everyone; only forehead mode renders it.
    myCharacter: game.isActive(viewerId) && !game.finished ? publicCharacter(game.headByPlayer[viewerId]) : null,
    // The guesser's character, shown to everyone but the guesser. Nothing renders this today
    // (forehead mode shows each phone its own wearer), but it stays: `wearing === null` for the
    // guesser is the assertion that pins down the one leak that would ruin the game, and
    // test/web-turnloop.test.js + the socket check both hold it to that.
    wearing: !isMyTurn && game.isActive(currentId) && !game.finished ? publicCharacter(game.headByPlayer[currentId]) : null,
    outOfContentionNote: isMyTurn && game.isOutOfContention(viewerId) ? loop.OUT_OF_CONTENTION_NOTE : null,
    turnRemaining: loop.turnRemainingOf(game, now),
    // Seconds of the turn's opening beat still to run (turnLoop.turnGraceMs): the clock waits on it.
    turnStartsIn: loop.graceRemainingOf(game, now),
    turnSeconds: game.turnSeconds,
    standings: loop.standingsView(game, names),
    me: {
      finished: game.finishedBy.has(viewerId),
      turns: game.finishedBy.get(viewerId) ?? null,
      // Once you've got it, you've earned the reveal of what you were wearing.
      character: game.finishedBy.has(viewerId) ? publicCharacter(game.headByPlayer[viewerId]) : null,
    },
  };
}

module.exports = { buildGameView };
