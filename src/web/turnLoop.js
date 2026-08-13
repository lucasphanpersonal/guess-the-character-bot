// Stage 3: the turn loop, for the web frontend.
//
// Ports the RULES of src/discord/game/engine.js -- rotation, scoring by turns taken, pass vs
// give-up, the resolve-a-turn-exactly-once guard, out-of-contention -- with the Discord I/O
// removed. All the state already lives on the core Game (turnsTaken, finishedBy, surrendered,
// nextActiveIndex, standings, isOutOfContention), so this file is a thin, pure orchestration
// over it: no socket.io, no DB, unit-tested on its own. The socket layer drives it and emits.
//
// Pre-gesture display model (this stage): the current player looks at their screen to TAP, so
// their screen shows action buttons, not their character; everyone else's screen shows the
// guesser's character so the room can verify a "got it". Stage 4 inverts this into true
// forehead mode (your phone shows YOUR character for the room; a tilt resolves the turn).

const { publicCharacter } = require('./gameSetup');

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

// Records the outcome and advances the rotation, or ends the game when nobody is left guessing.
function endTurn(game, { correct }) {
  const key = turnKey(game);
  if (game.resolvedTurns.has(key)) return { duplicate: true };
  game.resolvedTurns.add(key);

  const finishingId = game.currentPlayerId;
  if (correct) game.finishedBy.set(finishingId, game.turnsFor(finishingId));

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
function gotIt(game, playerId) {
  if (notPlaying(game)) return { ok: false, error: 'The game is over.' };
  if (playerId !== game.currentPlayerId) return { ok: false, error: "It's not your turn." };
  const turns = game.turnsFor(playerId);
  const r = endTurn(game, { correct: true });
  if (r.duplicate) return { ok: false, error: 'That turn was already resolved.' };
  return {
    ok: true,
    reveal: { playerId, turns, character: publicCharacter(game.headByPlayer[playerId]), kind: 'got' },
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
    return { playerId: id, name: nameOf(id), status, turns: game.finishedBy.get(id) ?? game.turnsFor(id) };
  });
}

/**
 * Per-player view of a running (or finished) game. The current player, on their own turn, is
 * NOT shown their character; everyone else sees the guesser's character to verify a "got it".
 */
function buildGameView(game, viewerId, names, now = Date.now()) {
  const currentId = game.currentPlayerId;
  const isMyTurn = viewerId === currentId && game.isActive(viewerId) && !game.finished;
  const turnRemaining =
    game.turnEndsAt && !game.finished ? Math.max(0, Math.round((game.turnEndsAt - now) / 1000)) : null;

  return {
    phase: game.finished ? 'over' : 'playing',
    current: {
      playerId: currentId,
      name: names[currentId] ?? 'Player',
      turnNumber: game.turnsFor(currentId),
      outOfContention: game.isOutOfContention(currentId),
    },
    isMyTurn,
    buttons: isMyTurn ? buttonsFor(game) : null,
    // The viewer's OWN character. In forehead mode every phone shows its wearer's character for
    // the room to see -- the wearer holds it to their head and doesn't look, exactly as the
    // physical game trusts. Sent to everyone; only forehead mode renders it. The tap fallback
    // (no motion sensor) ignores it for the current player and shows action buttons instead, so
    // a guesser who must look at their screen to tap never sees their own answer.
    myCharacter: game.isActive(viewerId) && !game.finished ? publicCharacter(game.headByPlayer[viewerId]) : null,
    // The guesser's character, shown to everyone but the guesser (used by the tap fallback).
    wearing: !isMyTurn && game.isActive(currentId) && !game.finished ? publicCharacter(game.headByPlayer[currentId]) : null,
    outOfContentionNote:
      isMyTurn && game.isOutOfContention(viewerId)
        ? "You can't win it now — but getting yours still sets where you place."
        : null,
    turnRemaining,
    turnSeconds: game.turnSeconds,
    standings: standingsView(game, names),
    me: {
      finished: game.finishedBy.has(viewerId),
      turns: game.finishedBy.get(viewerId) ?? null,
      // Once you've got it, you've earned the reveal of what you were wearing.
      character: game.finishedBy.has(viewerId) ? publicCharacter(game.headByPlayer[viewerId]) : null,
    },
  };
}

// Final standings for the over screen (reuses Game.standings, which is the DB shape too).
function resultView(game, names) {
  const standings = game.standings();
  const winners = standings.filter((s) => s.outcome === 'won');
  return {
    winners: winners.map((s) => ({ playerId: s.playerId, name: names[s.playerId] ?? 'Player', turns: s.turnsTaken })),
    standings: standings.map((s) => ({
      playerId: s.playerId,
      name: names[s.playerId] ?? 'Player',
      outcome: s.outcome,
      turns: s.turnsTaken,
    })),
    bestTurnCount: game.bestTurnCount,
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
  buildGameView,
  standingsView,
  resultView,
};
