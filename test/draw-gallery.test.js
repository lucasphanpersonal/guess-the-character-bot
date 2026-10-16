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

  'a fill is kept as a fill, where it fell among the strokes'() {
    const out = gallery.simplifyStrokes([stroke(line(200)), { id: 'f', kind: 'fill', color: '#ffd60a', size: 0, points: [[0.5, 0.5]] }, stroke(line(200))]);
    assert.deepEqual(out[1], { kind: 'fill', color: '#ffd60a', size: 0, points: [[0.5, 0.5]] });
    assert.equal(out[0].kind, undefined, 'a line is still a line');
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

  'one vote each for the best drawing, changeable, never your own'() {
    const g = draw.createDrawGame({ order: ['p1', 'p2', 'p3'], rounds: 1 });
    for (const [drawer, name] of [['p1', 'Pikachu'], ['p2', 'Mario'], ['p3', 'Zelda']]) {
      g.drawerIndex = g.order.indexOf(drawer);
      draw.offerChoices(g, [head(name)], T0);
      draw.choose(g, drawer, 0, T0);
      draw.endTurn(g, T0 + 1000, 'time');
    }
    assert.equal(draw.vote(g, 'p2', 0).ok, false, 'not before the game ends');
    g.phase = 'over';
    assert.equal(draw.vote(g, 'p1', 0).ok, false, 'never your own');
    assert.equal(draw.vote(g, 'p2', 0).mine, 0);
    assert.equal(draw.vote(g, 'p3', 0).mine, 0);
    assert.deepEqual(draw.votesOf(g), [2, 0, 0]);
    assert.equal(draw.vote(g, 'p3', 1).mine, 1, 'changed');
    assert.deepEqual(draw.votesOf(g), [1, 1, 0], 'one vote each');
    assert.equal(draw.vote(g, 'p3', 1).mine, null, 'the same again takes it back');
    assert.deepEqual(draw.overFor(g, names).votes, [1, 0, 0], 'the end screen carries the tally');
    assert.equal(draw.overFor(g, names).gallery[0].drawerId, 'p1', 'and whose each drawing is');
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
    assert.equal(by['So Close'].name, 'Sam');
    assert.equal(by['Abstract Artist'], undefined, 'earned, but Kira already has two');
    assert.equal(got.length, 5);
    assert.equal(got.filter((a) => a.playerId === 'p3').length, 2, 'two per player at most');
  },

  'six accolades at most, best first'() {
    // Seven earned, by seven different players, so only the cap of six can cut one.
    const drawings = [
      kept({ drawerId: 'p1', guessed: [{ playerId: 'p2', ms: 1000 }, { playerId: 'p3', ms: 5000 }] }), // Most Recognisable, Speed Demon
      kept({ drawerId: 'p4', reactions: 5, reactors: 2, guessed: [{ playerId: 'p3', ms: 30_000 }, { playerId: 'p5', ms: 78_000 }] }), // Mind Reader p3, Crowd Pleaser, Clutch p5
      kept({ drawerId: 'p7', strokes: [stroke(line(3)), stroke(line(3)), stroke(line(3))] }), // Abstract Artist
    ];
    const got = gallery.accolades(drawings, new Map([['p6', 4]]), nameOf); // So Close
    assert.deepEqual(got.map((a) => a.title), ['Most Recognisable', 'Speed Demon', 'Mind Reader', 'Crowd Pleaser', 'Clutch', 'So Close'],
      'six, in order of preference: the seventh (Abstract Artist) is the one cut');
  },

  'Crowd Pleaser is the room reacting, not one player'() {
    const g = draw.createDrawGame({ order: ['p1', 'p2', 'p3'] });
    draw.offerChoices(g, [head('Pikachu')], T0);
    draw.choose(g, 'p1', 0, T0);
    g.strokes.push(stroke(line(10)));
    for (let i = 0; i < 3; i++) draw.noteReaction(g, 'p2');
    draw.noteReaction(g, 'p3');
    draw.endTurn(g, T0 + 80_000, 'time');
    assert.deepEqual([g.drawings[0].reactions, g.drawings[0].reactors], [4, 2], 'kept with the drawing');
    const pleased = gallery.accolades(g.drawings, new Map(), nameOf).find((a) => a.title === 'Crowd Pleaser');
    assert.equal(pleased.name, 'Alex');
    assert.equal(pleased.detail, '4 reactions to Pikachu');
    const oneFan = [kept({ reactions: 9, reactors: 1, guessed: [{ playerId: 'p2', ms: 9000 }] })];
    assert.ok(!gallery.accolades(oneFan, new Map(), nameOf).some((a) => a.title === 'Crowd Pleaser'), 'nine from one player is not a crowd');
  },

  'Clean Sweep is every drawing of theirs, got by everyone'() {
    const all = (drawerId) => kept({ drawerId, guessers: 1, guessed: [{ playerId: 'p9', ms: 50_000 }] });
    const swept = gallery.accolades([all('p2'), all('p2'), kept({ drawerId: 'p1' })], new Map(), nameOf);
    assert.equal(swept.find((a) => a.title === 'Clean Sweep')?.detail, 'Everyone got all 2 of theirs');
    const once = gallery.accolades([all('p2')], new Map(), nameOf);
    assert.ok(!once.some((a) => a.title === 'Clean Sweep'), 'one drawing is not a sweep');
    const missedOne = gallery.accolades([all('p2'), kept({ drawerId: 'p2', guessers: 2, guessed: [{ playerId: 'p1', ms: 9000 }] })], new Map(), nameOf);
    assert.ok(!missedOne.some((a) => a.title === 'Clean Sweep'), 'one of the room missing one is not a sweep');
  },

  'Minimalist, Labour of Love and Rainbow say what the drawing was'() {
    // Guessed by players who draw nothing here, so no drawer's two-accolade cap is spent on guessing.
    const few = kept({ drawerId: 'p2', character: { name: 'Luigi' }, guessers: 2, guessed: [{ playerId: 'p4', ms: 40_000 }], strokes: [stroke(line(5)), stroke(line(5))] });
    const lots = kept({ drawerId: 'p3', character: { name: 'Bowser' }, guessers: 2, guessed: [{ playerId: 'p5', ms: 60_000 }], strokes: Array.from({ length: 30 }, () => stroke(line(4))) });
    const palette = ['#e21b3c', '#1368ce', '#26890c', '#ffa602', '#c13ac1', '#ffffff'];
    const bright = kept({ drawerId: 'p1', character: { name: 'Peach' }, strokes: palette.map((color) => ({ ...stroke(line(4)), color })) });
    const by = Object.fromEntries(gallery.accolades([few, lots, bright], new Map(), nameOf).map((a) => [a.title, a]));
    assert.equal(by['Minimalist']?.detail, 'Luigi in 2 strokes');
    assert.equal(by['Labour of Love']?.detail, '30 strokes on Bowser');
    assert.equal(by['Rainbow']?.detail, '5 colours in Peach', 'white is the paper, not a colour');
    // None of them when it is not so: nobody got the sparse one; the busy one was missed; four colours.
    const notSo = [
      kept({ drawerId: 'p2', guessers: 2, strokes: [stroke(line(5))] }),
      kept({ drawerId: 'p3', strokes: Array.from({ length: 30 }, () => stroke(line(4))) }),
      kept({ drawerId: 'p1', strokes: palette.slice(0, 4).map((color) => ({ ...stroke(line(4)), color })) }),
    ];
    const titles = gallery.accolades(notSo, new Map(), nameOf).map((a) => a.title);
    for (const t of ['Minimalist', 'Labour of Love', 'Rainbow']) assert.ok(!titles.includes(t), `no ${t}`);
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
