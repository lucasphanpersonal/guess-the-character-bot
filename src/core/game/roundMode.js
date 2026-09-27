// The seam that lets the game support more than one "shape" of round without rewriting the
// turn loop -- see docs/mobile-app-plan.md#leaving-room-for-a-simultaneous-mode.
//
// `Game` (Game.js) stays a plain record of who has which character, who has finished, and in
// what order. What VARIES between game modes is only two things:
//   1. who is allowed to act right now, and
//   2. what "advance" means when someone acts.
//
// Those two are what the Discord bot bakes directly into engine.js ("only currentPlayerId may
// act", "a turn is both the unit of pacing and the unit of score"). Pulling them behind this
// interface means a second mode (e.g. a simultaneous free-for-all where everyone guesses at
// once and placement is the order people self-declare) is an additive implementation, not a
// rewrite of the loop.
//
// Only TurnRotationMode ships today. It is deliberately thin: it delegates every state question
// to the pure methods already on Game, and owns no Discord or transport concerns, so it is
// equally usable by the Discord engine and the web server.

/**
 * @typedef {Object} RoundMode
 * @property {(playerId: string) => boolean} canAct  May this player resolve/pass their turn now?
 * @property {(playerId: string) => void}    onCorrect  Record a completion and advance.
 * @property {(playerId: string) => void}    onPass     Hand the turn on (never a surrender).
 * @property {() => boolean}                  isOver     Is the game finished?
 */

/**
 * Today's rules: strict rotation, one active player at a time, scored by turns taken.
 *
 * This mirrors what engine.js does, expressed against Game's pure helpers. It intentionally
 * does NOT send messages, touch timers, or know about a client -- a caller (Discord engine or
 * web server) drives I/O around it. That separation is the whole point of the seam.
 */
class TurnRotationMode {
  /** @param {import('./Game')} game */
  constructor(game) {
    this.game = game;
  }

  canAct(playerId) {
    return playerId === this.game.currentPlayerId && this.game.isActive(playerId);
  }

  /**
   * The player got their character on the turn currently in hand. Records it and moves the
   * pointer to the next still-guessing player (or leaves it, signalling game over).
   * Returns whether the game is now over, so the caller can branch on it.
   */
  onCorrect(playerId, msLeft = null) {
    this.game.recordFinish(playerId, msLeft);
    return this.#advance();
  }

  /** Hand the turn on without recording anything. Returns whether the game is now over. */
  onPass() {
    return this.#advance();
  }

  isOver() {
    return this.game.nextActiveIndex() === null;
  }

  #advance() {
    const next = this.game.nextActiveIndex();
    if (next === null) return true; // nobody left guessing -> over
    this.game.currentTurnIndex = next;
    return false;
  }
}

module.exports = { TurnRotationMode };
