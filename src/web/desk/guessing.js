// Typed guesses and the other players' rulings -- how a turn is answered on a computer.
//
// Pure, like ../guess/turnLoop.js: no socket.io, no DB, unit-tested on its own. The socket layer
// (./index.js) drives it and emits.
//
// On phones the room rules on a spoken guess by watching the wearer's phone; on Discord, other
// players press a button. On a computer the guesser TYPES, and the compendium's checker
// (src/compendium/answers.js) decides what it can:
//
//   correct  -> the turn ends as "got it", exactly as a tilt up would
//   wrong    -> nothing happens but a line in the log: a miss costs nothing and the turn goes on,
//               as on Discord (no limit -- chosen, not overlooked)
//   close    -> the OTHER players rule: a typo, a stripped title, a shared surname is a person's
//               call. The first ruling settles it.
//
// A ruling belongs to one turn of one player. It is dropped when that turn ends however it ends
// (endTurnState, called by the socket layer for every turn end), and checked against the turn it
// was made in, so a late tap can never resolve somebody else's turn.

const { judgeGuess } = require('../../compendium/answers');
const loop = require('../guess/turnLoop');

const GUESS_MAX = 80;
const LOG_MAX = 200;

// Per-game desk state, kept on the core Game beside everything else about this game.
const stateOf = (game) => (game.desk ??= { log: [], ruling: null, seq: 0 });
const turnOf = (game) => `${game.currentPlayerId}:${game.turnsFor(game.currentPlayerId)}`;

function remember(game, entry) {
  const st = stateOf(game);
  st.log.push(entry);
  if (st.log.length > LOG_MAX) st.log.splice(0, st.log.length - LOG_MAX);
}

/**
 * The current player types a guess.
 *
 * @param {object} opts
 * @param {string[]} opts.others  the pool's character names, so "Sasuke" can count for Sasuke
 *   Uchiha when nobody else in the pool is called Sasuke (see judgeGuess's singleWords)
 * @returns {{ok: false, error: string} | {ok: true, verdict: 'correct'|'close'|'wrong', ...}}
 *   a correct guess carries everything loop.gotIt returns (reveal, next player, game over)
 */
function submitGuess(game, playerId, text, { others = [], now = Date.now() } = {}) {
  if (!game || game.finished) return { ok: false, error: 'The game is over.' };
  if (playerId !== game.currentPlayerId) return { ok: false, error: "It's not your turn." };
  const st = stateOf(game);
  if (st.ruling) return { ok: false, error: 'The others are still ruling on your last guess.' };
  const guess = String(text ?? '').trim().slice(0, GUESS_MAX);
  if (!guess) return { ok: false, error: 'Type a name first.' };

  const { verdict } = judgeGuess(guess, game.headByPlayer[playerId].name, { others, singleWords: true });
  const turn = turnOf(game);
  if (verdict === 'correct') {
    const res = loop.gotIt(game, playerId, now);
    if (res.ok) remember(game, { playerId, text: guess, verdict: 'correct', turn });
    return { ...res, verdict };
  }
  if (verdict === 'close') {
    st.ruling = { id: ++st.seq, playerId, text: guess, turn, at: now };
    return { ok: true, verdict, rulingId: st.ruling.id };
  }
  remember(game, { playerId, text: guess, verdict: 'wrong', turn });
  return { ok: true, verdict };
}

/**
 * Another player rules on a close guess.
 *
 * @param {boolean} accept  true: it was right, the turn ends as "got it"; false: a miss
 * @returns {{ok: false, error: string} | {ok: true, accepted: boolean, ...}} an accepted ruling
 *   carries everything loop.gotIt returns
 */
function rule(game, judgeId, rulingId, accept, now = Date.now()) {
  if (!game || game.finished) return { ok: false, error: 'The game is over.' };
  const st = stateOf(game);
  const r = st.ruling;
  if (!r || r.id !== rulingId || r.turn !== turnOf(game)) return { ok: false, error: 'That guess has already been ruled on.' };
  if (judgeId === r.playerId) return { ok: false, error: "You can't rule on your own guess." };
  // In the game, not merely in the room: the person ruling has to have been looking at the board.
  if (!game.turnOrder.includes(judgeId)) return { ok: false, error: 'Only players in this game can rule.' };

  st.ruling = null;
  if (accept) {
    const res = loop.gotIt(game, r.playerId, now);
    if (res.ok) remember(game, { playerId: r.playerId, text: r.text, verdict: 'correct', ruledBy: judgeId, turn: r.turn });
    return { ...res, accepted: true };
  }
  remember(game, { playerId: r.playerId, text: r.text, verdict: 'wrong', ruledBy: judgeId, turn: r.turn });
  return { ok: true, accepted: false };
}

/**
 * Nobody ruled in time. A ruling cannot hold a turn forever -- everyone else may have walked off
 * -- so it lapses as a miss, the outcome that costs nothing.
 */
function lapse(game, rulingId) {
  const st = stateOf(game);
  const r = st.ruling;
  if (!r || r.id !== rulingId) return { ok: false, stale: true };
  st.ruling = null;
  remember(game, { playerId: r.playerId, text: r.text, verdict: 'wrong', lapsed: true, turn: r.turn });
  return { ok: true };
}

/** Whatever was taken for the turn that just ended goes with it. */
function endTurnState(game) {
  if (game?.desk) game.desk.ruling = null;
}

const pendingRuling = (game) => game?.desk?.ruling ?? null;
const guessLog = (game) => game?.desk?.log ?? [];

module.exports = { submitGuess, rule, lapse, endTurnState, pendingRuling, guessLog, GUESS_MAX };
