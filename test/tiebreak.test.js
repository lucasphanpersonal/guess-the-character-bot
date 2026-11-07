// The tiebreak in core Game.standings, shared by both frontends: fewest turns wins, and equal
// turns go to whoever had more whole seconds left on the turn they got it.

const { assert } = require('./harness');
const Game = require('../src/core/game/Game');

function game(ids) {
  const lobby = { guildId: 'tiebreak-test', listIds: [], players: ids };
  const characters = ids.map((id, i) => ({ id: i + 1, name: `Char ${id}`, list_id: null, image_url: null }));
  return new Game({ lobby, characters, turnSeconds: 60 });
}
// Gives a player `turns` turns and records them finishing with `msLeft` on the clock.
function finish(g, id, turns, msLeft) {
  g.turnsTaken.set(id, turns);
  g.recordFinish(id, msLeft);
}
const row = (g, id) => g.standings().find((r) => r.playerId === id);

function fewerTurnsBeatsMoreTime() {
  const g = game(['a', 'b']);
  finish(g, 'a', 1, 1_000);
  finish(g, 'b', 2, 59_000);
  assert.equal(row(g, 'a').outcome, 'won');
  assert.equal(row(g, 'b').outcome, 'lost');
  assert.equal(g.wonOnTime, false, 'turns decided it, not the clock');
}

function onEqualTurnsMoreTimeWins() {
  const g = game(['a', 'b']);
  finish(g, 'a', 1, 12_000);
  finish(g, 'b', 1, 41_000);
  assert.deepEqual(g.standings().map((r) => [r.playerId, r.place, r.outcome, r.secondsLeft]), [
    ['b', 1, 'won', 41],
    ['a', 2, 'lost', 12],
  ]);
  assert.equal(g.wonOnTime, true);
}

function levelToTheSecondIsATie() {
  const g = game(['a', 'b']);
  finish(g, 'a', 1, 30_000);
  finish(g, 'b', 1, 30_000);
  assert.equal(row(g, 'a').outcome, 'won');
  assert.equal(row(g, 'b').outcome, 'won');
  assert.equal(row(g, 'a').place, 1);
  assert.equal(row(g, 'b').place, 1);
  assert.equal(g.wonOnTime, false);
}

// Whole seconds, the unit the clock shows: below that the gap is the tilt hold and the network,
// not play. 41.4s and 41.2s are both "41s left" and stay level; 41.6s rounds to 42 and wins.
function sameDisplayedSecondStaysLevel() {
  const g = game(['a', 'b']);
  finish(g, 'a', 1, 41_400);
  finish(g, 'b', 1, 41_200);
  assert.equal(row(g, 'a').outcome, 'won');
  assert.equal(row(g, 'b').outcome, 'won');

  const h = game(['a', 'b']);
  finish(h, 'a', 1, 41_600);
  finish(h, 'b', 1, 41_400);
  assert.equal(row(h, 'a').outcome, 'won');
  assert.equal(row(h, 'b').outcome, 'lost');
}

// Nothing to compare, so nobody is ahead: exactly the old behaviour.
function noClockKeepsTheTie() {
  const g = game(['a', 'b']);
  finish(g, 'a', 1, null);
  finish(g, 'b', 1, 45_000);
  assert.equal(row(g, 'a').outcome, 'won');
  assert.equal(row(g, 'b').outcome, 'won');
  assert.equal(row(g, 'a').secondsLeft, null);
}

// A finish read after the deadline (the clock's grace) is 0, never negative.
function pastTheDeadlineIsZero() {
  const g = game(['a']);
  finish(g, 'a', 1, -20_000);
  assert.equal(row(g, 'a').secondsLeft, 0);
}

// Competition ranking: level players share a place, and the next place skips past them.
function placesShareAndSkip() {
  const g = game(['a', 'b', 'c', 'd', 'e']);
  finish(g, 'a', 1, 50_000);
  finish(g, 'b', 1, 30_000);
  finish(g, 'c', 1, 30_000);
  finish(g, 'd', 2, 59_000);
  g.surrendered.add('e');
  assert.deepEqual(g.standings().map((r) => [r.playerId, r.place, r.outcome]), [
    ['a', 1, 'won'],
    ['b', 2, 'lost'],
    ['c', 2, 'lost'],
    ['d', 4, 'lost'],
    ['e', null, 'gave_up'],
  ]);
}

module.exports = {
  'fewer turns beats more time': fewerTurnsBeatsMoreTime,
  'on equal turns, more time wins': onEqualTurnsMoreTimeWins,
  'level to the second is a tie': levelToTheSecondIsATie,
  'the same displayed second stays level': sameDisplayedSecondStaysLevel,
  'no clock keeps the tie': noClockKeepsTheTie,
  'past the deadline is zero': pastTheDeadlineIsZero,
  'places share and skip': placesShareAndSkip,
};
