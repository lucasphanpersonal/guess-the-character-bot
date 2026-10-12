// Telephone (src/web/draw/telephone.js): the chains, the clock, the replay -- on a fake clock.
//
// The leak test matters most, as in the classic game: during play nobody may be sent anything of a
// chain but the one thing they are working from.

const { assert } = require('./harness');
const tel = require('../src/web/draw/telephone');

const head = (name) => ({ id: null, name, imageUrl: null, source: null });
const names = { p1: 'Alex', p2: 'Sam', p3: 'Kira', p4: 'Jo' };
const T0 = 1_000_000;
// Distinctive starting characters, so finding one in a payload means one thing.
const STARTS = { p1: ['Pikachu', 'Bulbasaur', 'Eevee'], p2: ['Mario', 'Luigi', 'Peach'], p3: ['Zelda', 'Link', 'Ganon'], p4: ['Sonic', 'Tails', 'Knuckles'] };

function game(order = ['p1', 'p2', 'p3'], drawSeconds = 60) {
  const choices = new Map(order.map((id) => [id, STARTS[id].map(head)]));
  return tel.begin(tel.createTelephone({ order, drawSeconds, choices }), T0);
}
const stroke = (id) => ({ id, color: '#e21b3c', size: 8, points: [[0.1, 0.1], [0.5, 0.5]] });

module.exports = {
  'every chain visits every seat once, and ends on a guess'() {
    const t = game();
    assert.equal(t.steps, 3, 'three players: pick, draw, guess');
    for (const c of [0, 1, 2]) {
      const seats = [0, 1, 2].map((s) => t.order.find((id) => tel.chainIndexFor(t, id, s) === c));
      assert.equal(new Set(seats).size, 3, `chain ${c} meets three different seats`);
      assert.equal(seats[0], t.order[c], 'and starts with its owner');
    }
    assert.equal(game(['p1', 'p2', 'p3', 'p4']).steps, 3, 'four players: still ends on a guess (pick, draw, guess)');
    assert.equal(tel.stepKind(3), 'draw');
  },

  'a chain carries the pick to the drawer and the drawing to the guesser'() {
    const t = game();
    tel.submit(t, 'p1', { index: 1 }, T0); // Bulbasaur
    tel.submit(t, 'p2', { index: 0 }, T0);
    tel.submit(t, 'p3', { index: 2 }, T0);
    assert.equal(t.phase, 'draw', 'everyone picked: on to drawing at once');
    // p2 draws chain 0 (p1's): the name p1 picked.
    assert.equal(tel.viewFor(t, 'p2', names, T0).task.prompt, 'Bulbasaur');
    tel.addPiece(t, 'p2', stroke('a'));
    for (const id of ['p1', 'p2', 'p3']) tel.submit(t, id, {}, T0);
    assert.equal(t.phase, 'guess');
    // p3 guesses chain 0: p2's drawing.
    assert.equal(tel.viewFor(t, 'p3', names, T0).task.drawing.length, 1);
    tel.submit(t, 'p3', { text: 'a green frog thing' }, T0);
    tel.submit(t, 'p1', { text: '' }, T0);
    tel.submit(t, 'p2', { text: 'Ganon' }, T0);
    assert.equal(t.phase, 'replay');
    assert.deepEqual(t.chains[0].entries.map((e) => e.text ?? e.kind), ['Bulbasaur', 'draw', 'a green frog thing']);
    assert.equal(t.chains[1].entries[2].text, '(no guess)', 'a blank guess is said to be one');
  },

  'during play a player is sent their own task and nothing of any other chain'() {
    const t = game();
    tel.submit(t, 'p1', { index: 0 }, T0);
    tel.submit(t, 'p2', { index: 0 }, T0);
    tel.submit(t, 'p3', { index: 0 }, T0);
    // Drawing step: p2 holds "Pikachu"; Mario and Zelda are other chains.
    const json = JSON.stringify(tel.viewFor(t, 'p2', names, T0));
    assert.ok(json.includes('Pikachu'), 'their own prompt');
    assert.ok(!/Mario|Zelda|Luigi|Link|Bulbasaur/.test(json), json);
    // At the pick, only your own three.
    const fresh = game();
    const pick = JSON.stringify(tel.viewFor(fresh, 'p1', names, T0));
    assert.ok(pick.includes('Eevee') && !/Mario|Zelda/.test(pick));
  },

  'the clock hands in what each player had'() {
    const t = game();
    tel.submit(t, 'p1', { index: 2 }, T0);
    assert.equal(tel.timeUp(t, T0 + tel.PICK_SECONDS * 1000 - 1), false);
    assert.equal(tel.timeUp(t, T0 + tel.PICK_SECONDS * 1000), true);
    assert.equal(t.chains[1].entries[0].text, 'Mario', 'no pick: the first of their three');
    const t2 = T0 + tel.PICK_SECONDS * 1000;
    tel.addPiece(t, 'p3', stroke('x'));
    tel.addPiece(t, 'p3', stroke('y'));
    tel.undo(t, 'p3');
    tel.timeUp(t, t2 + 60_000);
    assert.equal(t.chains[tel.chainIndexFor(t, 'p3', 1)].entries[1].strokes.length, 1, 'the drawing so far, undo and all');
  },

  'someone leaving is skipped, and the chains carry on'() {
    const t = game(['p1', 'p2', 'p3', 'p4']);
    tel.removePlayer(t, 'p4', T0);
    for (const id of ['p1', 'p2', 'p3']) tel.submit(t, id, { index: 0 }, T0);
    assert.equal(t.phase, 'draw', 'the three still here were enough to move on');
    assert.equal(t.chains[3].entries[0].text, 'Sonic', "the leaver's chain still starts, with their first choice");
    for (const id of ['p1', 'p2', 'p3']) tel.submit(t, id, {}, T0);
    const skipped = t.chains.flatMap((c) => c.entries).filter((e) => e?.skipped);
    assert.equal(skipped.length, 1, "the leaver's drawing is skipped, nobody else's");
    // Down to one: straight to the replay of what there is.
    tel.removePlayer(t, 'p2', T0);
    tel.removePlayer(t, 'p3', T0);
    assert.equal(t.phase, 'replay');
  },

  'the replay shows a chain a card at a time, and only then whether it made it'() {
    const t = game();
    for (const id of ['p1', 'p2', 'p3']) tel.submit(t, id, { index: 0 }, T0);
    for (const id of ['p1', 'p2', 'p3']) tel.submit(t, id, {}, T0);
    // p3 guesses chain 0 (Pikachu) right; the rest wrong.
    tel.submit(t, 'p3', { text: 'pikachu' }, T0);
    tel.submit(t, 'p1', { text: 'a duck' }, T0);
    tel.submit(t, 'p2', { text: 'a car' }, T0);
    let v = tel.viewFor(t, 'p2', names, T0).replay;
    assert.equal(v.entries.length, 1);
    assert.equal(v.madeIt, null, 'not given away before the end of the chain');
    tel.replayNext(t);
    tel.replayNext(t);
    v = tel.viewFor(t, 'p2', names, T0).replay;
    assert.equal(v.entries.length, 3);
    assert.equal(v.madeIt, true, 'Pikachu made it through');
    tel.replayNext(t);
    assert.equal(tel.viewFor(t, 'p2', names, T0).replay.chain, 1, 'then the next chain');
    tel.replayBack(t);
    assert.equal(tel.viewFor(t, 'p2', names, T0).replay.entries.length, 3, 'and back');
    for (let i = 0; i < 20; i++) tel.replayNext(t);
    assert.equal(t.phase, 'over');
    const album = tel.viewFor(t, 'p1', names, T0).album;
    assert.deepEqual(album.map((c) => c.madeIt), [true, false, false]);
  },

  'a pause holds the clock and the hand-ins'() {
    const t = game();
    tel.pause(t, T0 + 10_000);
    assert.equal(tel.submit(t, 'p1', { index: 0 }, T0 + 20_000).ok, false, 'nothing handed in while paused');
    assert.equal(tel.timeUp(t, T0 + 90_000), false, 'and the clock does not run out');
    assert.equal(tel.viewFor(t, 'p1', names, T0 + 90_000).secondsLeft, tel.PICK_SECONDS - 10);
    tel.resume(t, T0 + 100_000);
    assert.equal(tel.viewFor(t, 'p1', names, T0 + 100_000).secondsLeft, tel.PICK_SECONDS - 10, 'picked up where it stopped');
  },
};
