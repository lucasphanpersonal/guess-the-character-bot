// The turn loop, for Guess the Character on the web -- phones and computers alike.
//
// The RULES are not here: they are src/core/game/turnRules.js, the one copy the Discord bot runs
// too. This file is the web's side of them: its clock (a server-side deadline, frozen while the
// current player is disconnected), and what every web view shares -- standings, the clock, the
// buttons, the results. Pure, no socket.io, unit-tested on its own; the socket layer drives it.
//
// It has no opinion on what a PLAYER sees: that differs completely between the two ways of
// playing (phones show each wearer their own character; computers show everyone's but your own),
// so each brings its own view -- ../party/view.js and ../desk/view.js.
//
// The web ends a turn and moves on in one step (turnRules.resolveTurn, then advance): it has
// nothing to show in between, unlike the bot.

const { publicCharacter } = require('../publicCharacter');
const rules = require('../../core/game/turnRules');

/** Begin a turn for the current player: their turn counter ticks up. */
const startTurn = (game) => rules.beginTurn(game);

// How long the current turn's clock still has to run, in ms, or null with no clock. While
// paused (the current player dropped) that is the frozen remainder, not a deadline in the past.
// One owner for "time left": the clock players see and the tiebreak are both read from here.
function msLeftOf(game, now) {
  if (game.pausedForDisconnect) return game.pausedRemaining ?? 0;
  return game.turnEndsAt ? Math.max(0, game.turnEndsAt - now) : null;
}

// A resolved turn, followed straight through: who it was, and where the game goes next.
const moveOn = (game, resolved) => ({ finishingId: resolved.finishingId, ...rules.advance(game) });

/** Current player declares they got their character. Records it, reveals it, advances. */
function gotIt(game, playerId, now = Date.now()) {
  const turns = game.turnsFor(playerId);
  const r = rules.claimCorrect(game, playerId, msLeftOf(game, now));
  if (!r.ok) return r;
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
    ...moveOn(game, r),
  };
}

/** Hand the turn on. Never removes anyone. Only offered while others are still guessing. */
function pass(game, playerId) {
  const r = rules.pass(game, playerId);
  return r.ok ? { ok: true, ...moveOn(game, r) } : r;
}

/** Bow out: reveal what they were wearing and drop from the rotation. */
function giveUp(game, playerId) {
  const r = rules.giveUp(game, playerId);
  if (!r.ok) return r;
  const reveal = { playerId, turns: null, character: publicCharacter(game.headByPlayer[playerId]), kind: 'gaveup' };
  return { ok: true, reveal, ...moveOn(game, r) };
}

/**
 * A player leaves the game entirely (an explicit exit, not a dropped connection). Recorded as
 * a surrender and their character revealed. If it was their turn the rotation advances; if not,
 * nothing needs advancing -- and no nextPlayerId says so to the caller.
 */
function forfeit(game, playerId) {
  const r = rules.forfeit(game, playerId);
  if (!r.ok) return r;
  const reveal = { playerId, turns: null, character: publicCharacter(game.headByPlayer[playerId]), kind: 'left' };
  if (!r.resolved) return { ok: true, reveal, gameOver: false };
  return { ok: true, reveal, ...moveOn(game, { finishingId: playerId }) };
}

/** The turn clock ran out: pass, if it's still that player's turn. Never removes anyone. */
function timeout(game, playerId) {
  const r = rules.timeout(game, playerId);
  return r.ok ? { ok: true, timedOut: true, ...moveOn(game, r) } : r;
}

// Which buttons the current player gets -- the core's rule, in the web's shape. "Got it" is
// always offered on a phone; the computers turn it off for typing (../desk/view.js).
function buttonsFor(game) {
  const c = rules.guesserControls(game);
  return { gotIt: true, pass: c.pass, giveUp: c.giveUp };
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
