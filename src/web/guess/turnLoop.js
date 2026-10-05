// The turn loop, for Guess the Character on the web -- phones and computers alike.
//
// Ports the RULES of src/discord/game/engine.js -- rotation, scoring by turns taken, pass vs
// give-up, the resolve-a-turn-exactly-once guard, out-of-contention -- with the Discord I/O
// removed. All the state already lives on the core Game (turnsTaken, finishedBy, surrendered,
// nextActiveIndex, standings, isOutOfContention), so this file is a thin, pure orchestration
// over it: no socket.io, no DB, unit-tested on its own. The socket layer drives it and emits.
//
// It has no opinion on what a PLAYER sees: that differs completely between the two ways of
// playing (phones show each wearer their own character; computers show everyone's but your own),
// so each brings its own view -- ../party/view.js and ../desk/view.js. What every view shares --
// standings, the clock, the buttons, the results -- is here.

const { publicCharacter } = require('../publicCharacter');

/** Begin a turn for the current player: their turn counter ticks up. */
function startTurn(game) {
  game.turnsTaken.set(game.currentPlayerId, game.turnsFor(game.currentPlayerId) + 1);
  return game.currentPlayerId;
}

// The resolve-once key: "<player>:<their turn number>". Checked and written before anything
// else so two near-simultaneous actions can't resolve the same turn twice (which would skip
// and mischarge the next player). See the long note in engine.js.
function turnKey(game) {
  return `${game.currentPlayerId}:${game.turnsFor(game.currentPlayerId)}`;
}

// How long the current turn's clock still has to run, in ms, or null with no clock. While
// paused (the current player dropped) that is the frozen remainder, not a deadline in the past.
// One owner for "time left": the clock players see and the tiebreak are both read from here.
function msLeftOf(game, now) {
  if (game.pausedForDisconnect) return game.pausedRemaining ?? 0;
  return game.turnEndsAt ? Math.max(0, game.turnEndsAt - now) : null;
}

// Records the outcome and advances the rotation, or ends the game when nobody is left guessing.
function endTurn(game, { correct, now = Date.now() }) {
  const key = turnKey(game);
  if (game.resolvedTurns.has(key)) return { duplicate: true };
  game.resolvedTurns.add(key);

  const finishingId = game.currentPlayerId;
  // Time left is the tiebreak between equal turn counts (Game.standings). Read here, before the
  // socket layer re-arms the clock for the next turn.
  if (correct) game.recordFinish(finishingId, msLeftOf(game, now));

  const next = game.nextActiveIndex();
  if (next === null) {
    game.finished = true;
    return { finishingId, gameOver: true };
  }
  game.currentTurnIndex = next;
  startTurn(game);
  return { finishingId, gameOver: false, nextPlayerId: game.currentPlayerId };
}

const notPlaying = (game) => !game || game.finished;

/** Current player declares they got their character. Records it, reveals it, advances. */
function gotIt(game, playerId, now = Date.now()) {
  if (notPlaying(game)) return { ok: false, error: 'The game is over.' };
  if (playerId !== game.currentPlayerId) return { ok: false, error: "It's not your turn." };
  const turns = game.turnsFor(playerId);
  const r = endTurn(game, { correct: true, now });
  if (r.duplicate) return { ok: false, error: 'That turn was already resolved.' };
  return {
    ok: true,
    // secondsLeft goes out with the reveal because it is, from this moment, the time to beat.
    reveal: {
      playerId,
      turns,
      secondsLeft: game.secondsLeftBy.get(playerId) ?? null,
      character: publicCharacter(game.headByPlayer[playerId]),
      kind: 'got',
    },
    ...r,
  };
}

/** Hand the turn on. Never removes anyone. Only offered while others are still guessing. */
function pass(game, playerId) {
  if (notPlaying(game)) return { ok: false, error: 'The game is over.' };
  if (playerId !== game.currentPlayerId) return { ok: false, error: "It's not your turn." };
  const r = endTurn(game, { correct: false });
  if (r.duplicate) return { ok: false, error: 'That turn was already resolved.' };
  return { ok: true, ...r };
}

/** Bow out: reveal what they were wearing and drop from the rotation. */
function giveUp(game, playerId) {
  if (notPlaying(game)) return { ok: false, error: 'The game is over.' };
  if (playerId !== game.currentPlayerId) return { ok: false, error: "It's not your turn." };
  if (!game.isActive(playerId)) return { ok: false, error: "You're already out." };
  game.surrendered.add(playerId);
  const reveal = { playerId, turns: null, character: publicCharacter(game.headByPlayer[playerId]), kind: 'gaveup' };
  const r = endTurn(game, { correct: false });
  if (r.duplicate) return { ok: false, error: 'That turn was already resolved.' };
  return { ok: true, reveal, ...r };
}

/**
 * A player leaves the game entirely (an explicit exit, not a dropped connection). Recorded as
 * a surrender and their character revealed. If it was their turn the rotation advances; if not,
 * the current player is active by definition so nothing needs advancing. Mirrors engine.submitForfeit.
 */
function forfeit(game, playerId) {
  if (notPlaying(game) || !game.isActive(playerId)) return { ok: false, stale: true };
  game.surrendered.add(playerId);
  const reveal = { playerId, turns: null, character: publicCharacter(game.headByPlayer[playerId]), kind: 'left' };
  if (playerId === game.currentPlayerId) {
    const r = endTurn(game, { correct: false });
    return { ok: true, reveal, ...r };
  }
  return { ok: true, reveal, gameOver: false };
}

/** The turn clock ran out: pass, if it's still that player's turn. Never removes anyone. */
function timeout(game, playerId) {
  if (notPlaying(game) || game.currentPlayerId !== playerId) return { ok: false, stale: true };
  const r = endTurn(game, { correct: false });
  return { ok: true, timedOut: true, ...r };
}

// Which buttons the current player gets, matching engine.js/turnBoard.js:
//   in contention, others active     -> Got it + Pass
//   out of contention, others active  -> Got it + Pass + Give up
//   last one guessing                 -> Got it + Give up (no one to pass to)
function buttonsFor(game) {
  const others = game.activePlayers.filter((id) => id !== game.currentPlayerId);
  const hasOthers = others.length > 0;
  return { gotIt: true, pass: hasOthers, giveUp: game.isOutOfContention(game.currentPlayerId) || !hasOthers };
}

function standingsView(game, names) {
  const nameOf = (id) => names[id] ?? 'Player';
  return game.turnOrder.map((id) => {
    let status;
    if (game.finishedBy.has(id)) status = 'finished';
    else if (game.surrendered.has(id)) status = 'gave_up';
    else if (id === game.currentPlayerId && !game.finished) status = 'guessing';
    else status = 'waiting';
    return {
      playerId: id,
      name: nameOf(id),
      status,
      turns: game.finishedBy.get(id) ?? game.turnsFor(id),
      // A finisher's time, visible while the game is still on: it is the target for anyone else
      // who gets theirs in as many turns.
      secondsLeft: game.secondsLeftBy.get(id) ?? null,
    };
  });
}

// Shown to the current player when they can no longer win. Both ways of playing render it: it
// was once rendered by a single code path, and deleting that path quietly stopped telling anyone.
const OUT_OF_CONTENTION_NOTE = "You can't win it now — but getting yours still sets where you place.";

// Seconds left on the current turn. When paused (the current player dropped), the clock is
// frozen at the remaining time rather than counting down against them.
function turnRemainingOf(game, now) {
  if (game.finished) return null;
  const ms = msLeftOf(game, now);
  return ms == null ? null : Math.max(0, Math.round(ms / 1000));
}

/**
 * The watching host's view of a running game, in host-picks mode: whose turn, the clock, and
 * every player's character beside their standing. Watch-only -- it carries no buttons, because
 * the host does not resolve turns; players answer with their own tilt.
 *
 * Holds EVERY character in play, so it must never reach a player. socket.js sends it to the host
 * alone, and only while they are sitting the game out.
 */
function buildHostGameView(game, names, now = Date.now()) {
  const currentId = game.currentPlayerId;
  return {
    phase: 'playing',
    paused: !!game.pausedForDisconnect,
    current: { playerId: currentId, name: names[currentId] ?? 'Player', turnNumber: game.turnsFor(currentId) },
    turnRemaining: turnRemainingOf(game, now),
    turnSeconds: game.turnSeconds,
    players: standingsView(game, names).map((s) => ({ ...s, character: publicCharacter(game.headByPlayer[s.playerId]) })),
  };
}

// Final standings for the over screen (reuses Game.standings, which is the DB shape too).
function resultView(game, names) {
  const standings = game.standings();
  const winners = standings.filter((s) => s.outcome === 'won');
  return {
    winners: winners.map((s) => ({ playerId: s.playerId, name: names[s.playerId] ?? 'Player', turns: s.turnsTaken, secondsLeft: s.secondsLeft })),
    standings: standings.map((s) => ({
      playerId: s.playerId,
      name: names[s.playerId] ?? 'Player',
      outcome: s.outcome,
      turns: s.turnsTaken,
      // From core, so the client never ranks on its own -- see Game.standings.
      place: s.place,
      secondsLeft: s.secondsLeft,
      // Safe to reveal everyone's character now the game is over.
      character: publicCharacter(game.headByPlayer[s.playerId]),
    })),
    bestTurnCount: game.bestTurnCount,
    wonOnTime: game.wonOnTime,
  };
}

module.exports = {
  startTurn,
  gotIt,
  pass,
  giveUp,
  forfeit,
  timeout,
  buttonsFor,
  buildHostGameView,
  standingsView,
  turnRemainingOf,
  resultView,
  OUT_OF_CONTENTION_NOTE,
};
