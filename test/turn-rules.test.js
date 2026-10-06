// The turn rules both frontends run (src/core/game/turnRules.js), on a bare core Game.
//
// The two frontends' own suites (game-flow, multiplayer, web-turnloop, desk) play these rules
// through their I/O; this pins the rules themselves, and the two-step end of a turn that lets the
// bot act between resolving a turn and moving on.

const { assert } = require('./harness');
const Game = require('../src/core/game/Game');
const rules = require('../src/core/game/turnRules');

function game(players = ['a', 'b', 'c']) {
  const g = new Game({
    lobby: { guildId: null, players },
    characters: players.map((id) => ({ name: `Char ${id}`, id: null })),
    turnSeconds: 60,
  });
  rules.beginTurn(g);
  return g;
}

module.exports = {
  'the first turn is counted when it begins'() {
    const g = game();
    assert.equal(g.currentPlayerId, 'a');
    assert.equal(g.turnsFor('a'), 1);
  },

  'a turn resolves once: a second resolution of the same turn is refused'() {
    const g = game();
    assert.deepEqual(rules.resolveTurn(g, { correct: true, msLeft: 20500 }), { ok: true, finishingId: 'a' });
    assert.deepEqual(rules.resolveTurn(g, { correct: true }), { ok: false, duplicate: true });
    assert.equal(g.finishedBy.get('a'), 1);
    assert.equal(g.secondsLeftBy.get('a'), 21, 'the tiebreak is the clock the frontend passed in');
  },

  'resolving does not move on; advance does, and counts the next turn'() {
    const g = game();
    rules.resolveTurn(g);
    assert.equal(g.currentPlayerId, 'a', 'between the two steps it is still the turn that ended');
    assert.deepEqual(rules.advance(g), { gameOver: false, nextPlayerId: 'b' });
    assert.equal(g.turnsFor('b'), 1);
  },

  'the rotation skips anyone done, and loops back to a lone survivor'() {
    const g = game();
    rules.claimCorrect(g, 'a');
    rules.advance(g); // b
    rules.giveUp(g, 'b');
    assert.deepEqual(rules.advance(g), { gameOver: false, nextPlayerId: 'c' });
    rules.pass(g, 'c');
    assert.deepEqual(rules.advance(g), { gameOver: false, nextPlayerId: 'c' }, 'nobody else is left, so c again');
    assert.equal(g.turnsFor('c'), 2);
  },

  'the game is over when nobody is left guessing'() {
    const g = game(['a', 'b']);
    rules.claimCorrect(g, 'a');
    rules.advance(g);
    rules.claimCorrect(g, 'b');
    assert.deepEqual(rules.advance(g), { gameOver: true });
    assert.equal(g.finished, true);
  },

  'only the current player may claim, pass or give up'() {
    const g = game();
    for (const act of [rules.claimCorrect, rules.pass, rules.giveUp]) {
      assert.deepEqual(act(g, 'b'), { ok: false, error: "It's not your turn." });
    }
    assert.equal(g.surrendered.size, 0);
  },

  'giving up twice is refused, so a double press cannot reveal twice'() {
    const g = game();
    assert.equal(rules.giveUp(g, 'a').ok, true);
    assert.equal(rules.giveUp(g, 'a').ok, false);
  },

  'leaving off-turn takes the player out without touching the turn in hand'() {
    const g = game();
    assert.deepEqual(rules.forfeit(g, 'c'), { ok: true, resolved: false });
    assert.ok(g.surrendered.has('c'));
    assert.equal(g.currentPlayerId, 'a');
    assert.deepEqual(rules.forfeit(g, 'a'), { ok: true, resolved: true }, 'on their own turn, the turn ends');
    assert.deepEqual(rules.forfeit(g, 'a'), { ok: false, stale: true }, 'and only once');
  },

  'a clock running out passes the turn, if it is still that player\'s'() {
    const g = game();
    assert.deepEqual(rules.timeout(g, 'b'), { ok: false, stale: true });
    assert.equal(rules.timeout(g, 'a').ok, true);
    assert.equal(rules.timeout(g, 'a').ok, false, 'a late second timer finds it resolved');
  },

  'which controls the guesser gets'() {
    const g = game(['a', 'b']);
    assert.deepEqual(rules.guesserControls(g), { pass: true, giveUp: false, alone: false, outOfContention: false });
    rules.pass(g, 'a');
    rules.advance(g); // b, turn 1
    rules.claimCorrect(g, 'b'); // b done on turn 1
    rules.advance(g); // a, turn 2: can no longer tie
    assert.deepEqual(rules.guesserControls(g), { pass: false, giveUp: true, alone: true, outOfContention: false }, 'the last one: give up only');
    const three = game();
    rules.claimCorrect(three, 'a');
    rules.advance(three); // b, turn 1 -- can still tie a
    assert.equal(rules.guesserControls(three).outOfContention, false);
    rules.pass(three, 'b');
    rules.advance(three); // c
    rules.pass(three, 'c');
    rules.advance(three); // b, turn 2 -- can't tie a's 1 now
    assert.deepEqual(rules.guesserControls(three), { pass: true, giveUp: true, alone: false, outOfContention: true });
  },
};
