// Unit tests for the web turn loop (src/web/turnLoop.js). Uses the real core Game via
// gameSetup; no socket.io, no network. Verifies the ported engine.js rules: rotation, scoring
// by turns taken, pass vs give-up, resolve-once, out-of-contention, and the button logic.

const { assert } = require('./harness');
const { createSetup } = require('../src/web/gameSetup');
const loop = require('../src/web/turnLoop');

const row = (id, name) => ({ id, name, list_id: null, image_url: null });

function game(order, chars) {
  const g = createSetup({
    order,
    guildId: 'web',
    listIds: [1],
    difficulty: 'normal',
    characters: chars,
    turnSeconds: 60,
  });
  loop.startTurn(g); // first player's turn 1 begins
  return g;
}
const names = { p1: 'Alex', p2: 'Sam', p3: 'Kira' };

function startTurnTicksTheCounter() {
  const g = game(['p1', 'p2'], [row(1, 'A'), row(2, 'B')]);
  assert.equal(g.turnsFor('p1'), 1);
  assert.equal(g.currentPlayerId, 'p1');
}

function passHandsOffWithoutScoring() {
  const g = game(['p1', 'p2'], [row(1, 'A'), row(2, 'B')]);
  const r = loop.pass(g, 'p1');
  assert.equal(r.ok, true);
  assert.equal(r.nextPlayerId, 'p2');
  assert.equal(g.turnsFor('p2'), 1);
  assert.equal(g.finishedBy.has('p1'), false);
}

function gotItRecordsRevealsAndAdvances() {
  const g = game(['p1', 'p2'], [row(1, 'A'), row(2, 'B')]);
  const r = loop.gotIt(g, 'p1');
  assert.equal(r.ok, true);
  assert.equal(g.finishedBy.get('p1'), 1);
  assert.equal(r.reveal.character.name, 'A');
  assert.equal(r.reveal.turns, 1);
  assert.equal(r.nextPlayerId, 'p2');
}

function onlyTheCurrentPlayerCanAct() {
  const g = game(['p1', 'p2'], [row(1, 'A'), row(2, 'B')]);
  assert.equal(loop.gotIt(g, 'p2').ok, false);
  assert.equal(loop.pass(g, 'p2').ok, false);
}

function aTurnResolvesExactlyOnce() {
  const g = game(['p1', 'p2', 'p3'], [row(1, 'A'), row(2, 'B'), row(3, 'C')]);
  const first = loop.gotIt(g, 'p1');
  assert.equal(first.ok, true);
  // A racing second press on the same (already advanced) turn is refused, not re-run.
  const second = loop.gotIt(g, 'p1');
  assert.equal(second.ok, false);
  // p2 got exactly one turn, not skipped.
  assert.equal(g.currentPlayerId, 'p2');
  assert.equal(g.turnsFor('p2'), 1);
}

function fewestTurnsWins() {
  const g = game(['p1', 'p2'], [row(1, 'A'), row(2, 'B')]);
  loop.pass(g, 'p1'); // p1 turn1 -> p2
  loop.pass(g, 'p2'); // p2 turn1 -> p1 turn2
  loop.gotIt(g, 'p1'); // p1 finishes on 2 -> p2 turn2
  loop.pass(g, 'p2'); // p2 turn2 -> (alone) p2 turn3
  const last = loop.gotIt(g, 'p2'); // p2 finishes on 3
  assert.equal(last.gameOver, true);
  const result = loop.resultView(g, names);
  assert.equal(result.winners.length, 1);
  assert.equal(result.winners[0].name, 'Alex');
  assert.equal(result.bestTurnCount, 2);
}

// The socket layer arms the clock by setting turnEndsAt; these set it directly and pass `now`,
// so the time left at each finish is stated rather than whatever the machine happened to take.
const T = 1_000_000;
function finishWith(g, playerId, secondsLeft) {
  g.turnEndsAt = T + secondsLeft * 1000;
  return loop.gotIt(g, playerId, T);
}

function equalTurnsAndTimeTie() {
  const g = game(['p1', 'p2'], [row(1, 'A'), row(2, 'B')]);
  finishWith(g, 'p1', 30); // p1 finishes on turn 1 -> p2 gets turn 1
  finishWith(g, 'p2', 30); // p2 finishes on turn 1 too, to the second
  const result = loop.resultView(g, names);
  assert.equal(result.winners.length, 2);
  assert.equal(result.wonOnTime, false);
}

function onEqualTurnsMoreTimeLeftWins() {
  const g = game(['p1', 'p2'], [row(1, 'A'), row(2, 'B')]);
  const first = finishWith(g, 'p1', 10);
  assert.equal(first.reveal.secondsLeft, 10, 'the reveal carries the time to beat');
  finishWith(g, 'p2', 50);
  const result = loop.resultView(g, names);
  assert.deepEqual(result.winners.map((w) => [w.name, w.secondsLeft]), [['Sam', 50]]);
  assert.equal(result.wonOnTime, true);
  assert.deepEqual(result.standings.map((s) => [s.name, s.place, s.secondsLeft]), [['Sam', 1, 50], ['Alex', 2, 10]]);
}

// While the current player's clock is paused (they dropped), time left is the frozen remainder.
function aPausedClockCountsItsFrozenRemainder() {
  const g = game(['p1', 'p2'], [row(1, 'A'), row(2, 'B')]);
  g.pausedForDisconnect = true;
  g.pausedRemaining = 22_000;
  g.turnEndsAt = null;
  loop.gotIt(g, 'p1', T);
  assert.equal(g.secondsLeftBy.get('p1'), 22);
}

function lastPlayerGetsGiveUpNotPass() {
  const g = game(['p1', 'p2'], [row(1, 'A'), row(2, 'B')]);
  loop.gotIt(g, 'p1'); // p1 done, p2 alone (turn2)
  const b = loop.buttonsFor(g);
  assert.equal(b.gotIt, true);
  assert.equal(b.pass, false); // nobody to pass to
  assert.equal(b.giveUp, true);
}

function giveUpEndsTheGameForTheLastPlayer() {
  const g = game(['p1', 'p2'], [row(1, 'A'), row(2, 'B')]);
  loop.gotIt(g, 'p1');
  const r = loop.giveUp(g, 'p2');
  assert.equal(r.ok, true);
  assert.equal(r.gameOver, true);
  assert.equal(r.reveal.kind, 'gaveup');
  assert.equal(r.reveal.character.name, 'B');
}

function outOfContentionOffersGiveUpAlongsidePass() {
  const g = game(['p1', 'p2', 'p3'], [row(1, 'A'), row(2, 'B'), row(3, 'C')]);
  // Everyone passes their turn 1, then p3 gets it on turn 1 -> best = 1. Rotation returns to
  // p1, now on turn 2, who therefore can no longer match 1.
  loop.pass(g, 'p1');
  loop.pass(g, 'p2');
  loop.gotIt(g, 'p3'); // best = 1; next is p1 on turn 2
  assert.equal(g.currentPlayerId, 'p1');
  assert.equal(g.isOutOfContention('p1'), true); // earliest finish 2 > best 1
  const b = loop.buttonsFor(g);
  assert.equal(b.pass, true); // p2 still active to pass to
  assert.equal(b.giveUp, true); // out of contention
}

function theGuesserNeverSeesTheirOwnCharacterButOthersDo() {
  const g = game(['p1', 'p2'], [row(1, 'A'), row(2, 'B')]);
  const mine = loop.buildGameView(g, 'p1', names); // p1 is current
  assert.equal(mine.isMyTurn, true);
  assert.equal(mine.wearing, null); // guesser is shown no character
  assert.ok(mine.buttons);
  const theirs = loop.buildGameView(g, 'p2', names); // p2 watches
  assert.equal(theirs.isMyTurn, false);
  assert.equal(theirs.wearing.name, 'A'); // sees the guesser's character to verify
}

module.exports = {
  'startTurn ticks the counter': startTurnTicksTheCounter,
  'pass hands off without scoring': passHandsOffWithoutScoring,
  'got it records, reveals, and advances': gotItRecordsRevealsAndAdvances,
  'only the current player can act': onlyTheCurrentPlayerCanAct,
  'a turn resolves exactly once': aTurnResolvesExactlyOnce,
  'fewest turns wins': fewestTurnsWins,
  'equal turns and equal time tie': equalTurnsAndTimeTie,
  'on equal turns, more time left wins': onEqualTurnsMoreTimeLeftWins,
  'a paused clock counts its frozen remainder': aPausedClockCountsItsFrozenRemainder,
  'the last player gets give up, not pass': lastPlayerGetsGiveUpNotPass,
  'give up ends the game for the last player': giveUpEndsTheGameForTheLastPlayer,
  'out of contention offers give up alongside pass': outOfContentionOffersGiveUpAlongsidePass,
  "the guesser never sees their own character but others do": theGuesserNeverSeesTheirOwnCharacterButOthersDo,
};
