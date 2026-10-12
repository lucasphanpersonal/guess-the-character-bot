// Draw the Character's end screen (src/web/draw/gallery.js): the drawings kept, and the accolades.

const { assert } = require('./harness');
const draw = require('../src/web/draw/game');
const gallery = require('../src/web/draw/gallery');

const head = (name) => ({ id: null, name, imageUrl: null, source: null });
const names = { p1: 'Alex', p2: 'Sam', p3: 'Kira' };
const nameOf = (id) => names[id] ?? 'Player';
const T0 = 1_000_000;
const line = (n) => Array.from({ length: n }, (_, i) => [i / n, i / n]);
const stroke = (points) => ({ id: String(Math.random()), color: '#e21b3c', size: 8, points });

// A drawing as record() keeps it, for the accolade rules.
const kept = (over) => ({ drawerId: 'p1', character: { name: 'Pikachu' }, strokes: [], guessed: [], gaveUp: [], guessers: 2, reason: 'time', drawSeconds: 80, ...over });

module.exports = {
  'a straight line keeps its ends and drops what lies on it'() {
    const out = gallery.simplifyLine(line(500), 0.0015);
    assert.deepEqual(out, [[0, 0], [499 / 500, 499 / 500]]);
  },

  'a corner survives simplifying'() {
    const corner = [...line(50), ...Array.from({ length: 50 }, (_, i) => [1, 1 - i / 50])];
    const out = gallery.simplifyLine(corner, 0.0015);
    assert.ok(out.some(([x, y]) => x > 0.95 && y > 0.95), 'the turn is still there');
    assert.ok(out.length < 10, `and little else (${out.length} points)`);
  },

  'a huge drawing is cut to the budget, however it was drawn'() {
    // Jagged, so simplifying alone cannot get it under: every point is a corner.
    const zigzag = Array.from({ length: 4000 }, (_, i) => [i / 4000, i % 2 ? 0.9 : 0.1]);
    const out = gallery.simplifyStrokes([stroke(zigzag), stroke(zigzag)]);
    const total = out.reduce((n, s) => n + s.points.length, 0);
    assert.ok(total <= gallery.MAX_POINTS, `${total} points`);
    assert.ok(total > 0, 'but not to nothing');
  },

  'a finished drawing is kept with who got it and how fast'() {
    const g = draw.createDrawGame({ order: ['p1', 'p2', 'p3'] });
    draw.offerChoices(g, [head('Pikachu')], T0);
    draw.choose(g, 'p1', 0, T0);
    g.strokes.push(stroke(line(100)));
    draw.say(g, 'p2', 'pikachu', T0 + 4000);
    draw.say(g, 'p3', 'pikahcu', T0 + 5000); // close: two letters swapped
    draw.endTurn(g, T0 + 80_000, 'time');
    assert.equal(g.drawings.length, 1);
    const [d] = g.drawings;
    assert.equal(d.drawerId, 'p1');
    assert.equal(d.character.name, 'Pikachu');
    assert.deepEqual(d.guessed, [{ playerId: 'p2', ms: 4000 }]);
    assert.equal(d.guessers, 2);
    assert.ok(d.strokes[0].points.length < 100, 'simplified');
    assert.equal(g.closeCalls.get('p3'), 1, 'the near miss is counted');
  },

  'a turn that ends before anything is drawn keeps nothing'() {
    const g = draw.createDrawGame({ order: ['p1', 'p2'] });
    draw.offerChoices(g, [head('Pikachu')], T0);
    draw.endTurn(g, T0, 'drawer-left'); // left while choosing
    assert.equal(g.drawings.length, 0);
  },

  'the end screen gets names, every drawing and the accolades'() {
    const g = draw.createDrawGame({ order: ['p1', 'p2'], rounds: 1 });
    draw.offerChoices(g, [head('Pikachu')], T0);
    draw.choose(g, 'p1', 0, T0);
    draw.say(g, 'p2', 'pikachu', T0 + 3000);
    draw.endTurn(g, T0 + 3000, 'all');
    const over = draw.overFor(g, names);
    assert.equal(over.gallery[0].drawer, 'Alex');
    assert.deepEqual(over.gallery[0].got, [{ name: 'Sam', seconds: 3 }]);
    assert.ok(!JSON.stringify(over.gallery).includes('p2'), 'names, not ids');
    assert.deepEqual(over.accolades.map((a) => a.title), ['Most Recognisable', 'Speed Demon']);
  },

  'each accolade says something true about the game'() {
    const drawings = [
      kept({ drawerId: 'p1', character: { name: 'Pikachu' }, guessed: [{ playerId: 'p2', ms: 2000 }, { playerId: 'p3', ms: 76_000 }] }),
      kept({ drawerId: 'p2', character: { name: 'Mario' }, guessed: [{ playerId: 'p3', ms: 30_000 }] }),
      kept({ drawerId: 'p3', character: { name: 'Zelda' }, strokes: [stroke(line(3)), stroke(line(3)), stroke(line(3))] }),
    ];
    const got = gallery.accolades(drawings, new Map([['p2', 4]]), nameOf);
    const by = Object.fromEntries(got.map((a) => [a.title, a]));
    assert.equal(by['Most Recognisable'].name, 'Alex', 'everyone got his');
    assert.equal(by['Most Recognisable'].detail, 'Everyone got Pikachu');
    assert.equal(by['Speed Demon'].detail, 'Got Pikachu in 2s');
    assert.equal(by['Mind Reader'].name, 'Kira', 'two right, more than anyone');
    assert.equal(by['Clutch'].detail, 'Got Pikachu with 4s left');
    assert.equal(got.length, 4, 'four at most -- So Close and Abstract Artist were earned but cut');
    assert.equal(got.filter((a) => a.playerId === 'p3').length, 2, 'and two per player at most');
  },

  'an accolade nobody earned is not handed out'() {
    // Nobody guessed anything; one drawing was barely started.
    const drawings = [kept({ strokes: [stroke(line(2))] })];
    assert.deepEqual(gallery.accolades(drawings, new Map([['p2', 2]]), nameOf), [], 'two near misses is not So Close; one stroke is not art');
    const drawn = [kept({ strokes: [stroke(line(4)), stroke(line(4)), stroke(line(4))] })];
    assert.deepEqual(gallery.accolades(drawn, new Map(), nameOf).map((a) => a.title), ['Abstract Artist']);
  },

  'Mind Reader needs a clear winner'() {
    const drawings = [
      kept({ drawerId: 'p1', guessed: [{ playerId: 'p2', ms: 9000 }, { playerId: 'p3', ms: 9500 }] }),
      kept({ drawerId: 'p1', guessed: [{ playerId: 'p2', ms: 9000 }, { playerId: 'p3', ms: 9500 }] }),
    ];
    assert.ok(!gallery.accolades(drawings, new Map(), nameOf).some((a) => a.title === 'Mind Reader'), 'a tie names nobody');
  },
};
