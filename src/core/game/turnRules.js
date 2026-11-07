// The turn rules of Guess the Character -- one copy, for every frontend.
//
// Pure: no sockets, no timers, no clock of its own. The web (src/web/guess/turnLoop.js, for the
// phones and the computers alike) drives these over a core Game and wraps them in its own I/O.
// One copy for both ways of playing is what keeps them from disagreeing about one rule.
//
// THE RULES. Strict rotation, one player at a time. Getting your character ends YOUR involvement,
// not the game; the score is turns taken (Game.standings). Pass hands the turn on and never removes
// anyone. Give up and leaving are the only ways out without finishing, and both are deliberate.
// Going quiet is never terminal: a turn that runs out just passes.
//
// ENDING A TURN is two steps, because the frontends need to act in between:
//
//   resolveTurn  the resolve-once lock, and the outcome recorded. Synchronous, so it is a lock:
//                judging is open to everyone who isn't guessing, so simultaneous presses are
//                routine, and each extra resolution used to advance the rotation again -- skipping
//                the next player and charging them a turn they never got. Keyed by turn rather
//                than a busy flag: exact, cannot get stuck if something throws, and the next turn
//                still resolves normally.
//   advance      the pointer to the next player still guessing, and their turn counted -- or the
//                game over when nobody is left.
//
// The web runs the two back to back. The bot freezes the outgoing turn's board and announces a
// finish between them, so those still describe the turn that just ended.
//
// The clock is the frontend's: a resolution takes `msLeft` from whatever clock that frontend runs
// (the tiebreak -- see Game.recordFinish).
//
// This is also the seam a different shape of round (everyone guessing at once) would replace:
// who may act and what "advance" means are decided here and nowhere else.
//
// DESERTED. Going quiet is never terminal for a PLAYER -- but a whole table going quiet used to
// be endless: every turn timed out, passed, and armed the next, forever (the bot posting a board
// a minute to an empty channel; a web room ticking on after everyone had gone). So timeouts in a
// row are counted, anything anyone does resets the count, and two full laps of them -- every
// player still guessing, twice over, with nobody touching anything -- is `deserted`. One lap
// would end a game because two people stepped out for a drink. What a frontend does about it is
// its own: the bot ends the game as /lobby end does, keeping finished results; the web pauses it,
// so anyone coming back can carry on.

const turnKey = (game) => `${game.currentPlayerId}:${game.turnsFor(game.currentPlayerId)}`;

/** Somebody did something -- a guess, a ruling, a pass -- so the table is not deserted. */
function noteActivity(game) {
  if (game) game.idleTimeouts = 0;
}

/** Two full laps of turns timed out with nobody acting. See DESERTED above. */
function deserted(game) {
  return !!game && !game.finished && (game.idleTimeouts ?? 0) >= 2 * Math.max(1, game.activePlayers.length);
}

/** Begin the current player's turn: their count -- the score -- ticks up. */
function beginTurn(game) {
  game.turnsTaken.set(game.currentPlayerId, game.turnsFor(game.currentPlayerId) + 1);
  return game.currentPlayerId;
}

/**
 * End the turn in hand, once. Records a finish when `correct`.
 *
 * @returns {{ok: true, finishingId: string} | {ok: false, duplicate: true}}
 */
function resolveTurn(game, { correct = false, msLeft = null, idle = false } = {}) {
  const key = turnKey(game);
  if (game.resolvedTurns.has(key)) return { ok: false, duplicate: true };
  game.resolvedTurns.add(key);
  // A timeout is the one resolution nobody chose; every other one is somebody at the table.
  game.idleTimeouts = idle ? (game.idleTimeouts ?? 0) + 1 : 0;
  const finishingId = game.currentPlayerId;
  if (correct) game.recordFinish(finishingId, msLeft);
  return { ok: true, finishingId };
}

/**
 * Move on from a resolved turn: to the next player still guessing, whose turn begins now -- or,
 * with nobody left, to the end (game.finished).
 *
 * @returns {{gameOver: true} | {gameOver: false, nextPlayerId: string}}
 */
function advance(game) {
  const next = game.nextActiveIndex();
  if (next === null) {
    game.finished = true;
    return { gameOver: true };
  }
  game.currentTurnIndex = next;
  beginTurn(game);
  return { gameOver: false, nextPlayerId: game.currentPlayerId };
}

const over = (game) => !game || game.finished;
// A second press on a turn already resolved: refused, and marked, since a frontend may want to
// treat a double tap as the harmless thing it is.
const DUPLICATE = { ok: false, duplicate: true, error: 'That turn was already resolved.' };

/** The current player got their character. */
function claimCorrect(game, playerId, msLeft = null) {
  if (over(game)) return { ok: false, error: 'The game is over.' };
  if (playerId !== game.currentPlayerId) return { ok: false, error: "It's not your turn." };
  const r = resolveTurn(game, { correct: true, msLeft });
  return r.ok ? r : DUPLICATE;
}

/** Hand the turn on. Never removes anyone. */
function pass(game, playerId) {
  if (over(game)) return { ok: false, error: 'The game is over.' };
  if (playerId !== game.currentPlayerId) return { ok: false, error: "It's not your turn." };
  const r = resolveTurn(game);
  return r.ok ? r : DUPLICATE;
}

/** The current player bows out: off the rotation, recorded as given up, and the turn ends. */
function giveUp(game, playerId) {
  if (over(game)) return { ok: false, error: 'The game is over.' };
  if (playerId !== game.currentPlayerId) return { ok: false, error: "It's not your turn." };
  // Checked and marked before anything else, so a second press racing the first finds them
  // already out rather than surrendering twice.
  if (!game.isActive(playerId)) return { ok: false, error: "You're already out of this game." };
  game.surrendered.add(playerId);
  const r = resolveTurn(game);
  return r.ok ? r : DUPLICATE;
}

/**
 * A player leaves the game for good, on their turn or not -- an explicit exit, never a dropped
 * connection. Recorded as given up. Only when it was their turn is there a turn to end (`resolved`);
 * otherwise the current player is active by definition, so nothing needs advancing.
 *
 * @returns {{ok: false, stale: true} | {ok: true, resolved: boolean}}
 */
function forfeit(game, playerId) {
  if (over(game) || !game.turnOrder.includes(playerId) || !game.isActive(playerId)) return { ok: false, stale: true };
  game.surrendered.add(playerId);
  noteActivity(game); // somebody chose something, on their turn or not
  if (playerId !== game.currentPlayerId) return { ok: true, resolved: false };
  return { ok: true, resolved: resolveTurn(game).ok };
}

/** The clock ran out on `playerId`'s turn: it passes, if it is still theirs. Never removes anyone. */
function timeout(game, playerId) {
  if (over(game) || game.currentPlayerId !== playerId) return { ok: false, stale: true };
  const r = resolveTurn(game, { idle: true });
  return r.ok ? r : { ok: false, stale: true };
}

/**
 * Which of the guesser's own controls apply right now:
 *   still in contention, others guessing  -> Pass
 *   out of contention, others guessing    -> Pass and Give up
 *   the last one guessing                 -> Give up (nobody to pass to)
 */
function guesserControls(game) {
  const alone = game.activePlayers.filter((id) => id !== game.currentPlayerId).length === 0;
  return {
    pass: !alone,
    giveUp: alone || game.isOutOfContention(game.currentPlayerId),
    alone,
    outOfContention: !alone && game.isOutOfContention(game.currentPlayerId),
  };
}

module.exports = { beginTurn, resolveTurn, advance, claimCorrect, pass, giveUp, forfeit, timeout, guesserControls, noteActivity, deserted };
