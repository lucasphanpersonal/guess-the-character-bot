// Host-picks mode (src/web/gameSetup.js dealWithPicks + the host's views): the host chooses
// characters and sits the game out. Real core Game, fake content -- no DB, no sockets.
//
// The picks arrive from a client, so most of what is pinned down here is what gets REFUSED.

const { assert } = require('./harness');
const { createSetup, dealWithPicks, buildHostSetupView, applyReroll } = require('../src/web/gameSetup');
const loop = require('../src/web/turnLoop');
const { normalizeLoose } = require('../src/compendium/text');

const row = (id, name) => ({ id, name, list_id: null, image_url: null });
const LIBRARY = { 1: row(1, 'Spider-Man'), 2: row(2, 'Batman'), 3: row(3, 'Mario') };
const POOL = [row(10, 'Luigi'), row(11, 'Zelda'), row(12, 'Link'), row(13, 'Spiderman')];

// Mirrors core's getRandomCharacters closely enough for these rules: excludes by the judge's key.
function fakeContent(pool = POOL) {
  const calls = [];
  return {
    calls,
    characterById: (id) => LIBRARY[id] ?? null,
    freeform: (name) => ({ name, id: null, list_id: null, image_url: null }),
    randomCharacters: (listIds, n, excludeNames) => {
      calls.push({ n, excludeNames: [...excludeNames] });
      const excluded = new Set(excludeNames.map(normalizeLoose));
      return pool.filter((c) => !excluded.has(normalizeLoose(c.name))).slice(0, n);
    },
  };
}

const names = { a: 'Alex', b: 'Sam', c: 'Kira' };
const deal = (picks, opts = {}) =>
  dealWithPicks({ order: ['a', 'b', 'c'], picks, names, content: opts.content ?? fakeContent(opts.pool), listIds: opts.listIds ?? [1], difficulty: 'everything' });

function picksLandOnTheRightPlayersAndTheRestAreRandom() {
  const r = deal({ a: { id: 2 }, c: { name: 'Grandma Jean' } });
  assert.equal(r.ok, true);
  assert.equal(r.characters[0].name, 'Batman');
  assert.equal(r.characters[1].name, 'Luigi'); // b was left on random
  assert.equal(r.characters[2].name, 'Grandma Jean');
  assert.equal(r.characters[2].id, null, 'a typed name is freeform: no row behind it');
}

function everyoneCanBeRandom() {
  const r = deal({});
  assert.equal(r.ok, true);
  assert.equal(r.characters.length, 3);
}

// Dropping it would deal the room something other than what the host saw on their screen.
function aPickForSomeoneNotDealtInIsRefused() {
  const r = dealWithPicks({ order: ['a', 'b'], picks: { host: { id: 1 } }, names, content: fakeContent(), listIds: [1], difficulty: 'everything' });
  assert.equal(r.ok, false);
}

function anUnknownIdIsRefusedNamingThePlayer() {
  const r = deal({ b: { id: 999 } });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('Sam'), r.error);
  assert.equal(deal({ b: { id: 'nonsense' } }).ok, false);
}

// The judge's key: two spellings of one character are one character.
function theSameCharacterTwiceIsRefusedNamingBoth() {
  const r = deal({ a: { id: 1 }, b: { name: 'spiderman' } });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('Alex') && r.error.includes('Sam'), r.error);
}

// The pool here holds "Spiderman"; the host picked "Spider-Man". The fill must not hand it out.
function theRandomFillExcludesThePicks() {
  const content = fakeContent();
  const r = deal({ a: { id: 1 } }, { content });
  assert.equal(r.ok, true);
  assert.deepEqual(content.calls[0].excludeNames, ['Spider-Man']);
  assert.ok(!r.characters.slice(1).some((c) => normalizeLoose(c.name) === 'spiderman'));
}

function aBlankPickMeansRandom() {
  const r = deal({ a: { name: '   ' } });
  assert.equal(r.ok, true);
  assert.equal(r.characters[0].name, 'Luigi');
}

function aTypedNameIsTrimmedAndCapped() {
  const r = deal({ a: { name: `  ${'x'.repeat(200)}  ` } });
  assert.equal(r.characters[0].name.length, 60);
  assert.ok(!r.characters[0].name.startsWith(' '));
}

function tooFewLeftForTheRandomSeatsIsRefused() {
  const r = deal({}, { pool: [row(10, 'Luigi')] });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('3 players'), r.error);
}

// Picking for everyone never touches the pool, so an empty one is fine -- until someone is
// left on random.
function anEmptyPoolOnlyMattersForRandomSeats() {
  assert.equal(deal({ a: { id: 1 }, b: { id: 2 }, c: { id: 3 } }, { listIds: [] }).ok, true);
  assert.equal(deal({ a: { id: 1 } }, { listIds: [] }).ok, false);
}

// A reroll would undo the host's choice.
function aHostPickedGameCannotBeRerolled() {
  const g = createSetup({ order: ['a', 'b'], guildId: 'web', listIds: [1], difficulty: 'everything', characters: [row(1, 'A'), row(2, 'B')], rerollAllowed: false });
  const r = applyReroll(g, 'a', { content: fakeContent(), listIds: [1], difficulty: 'everything' });
  assert.equal(r.ok, false);
}

function theHostSetupViewShowsEveryCharacterAndWhoIsReady() {
  const g = createSetup({ order: ['a', 'b'], guildId: 'web', listIds: [1], difficulty: 'everything', characters: [row(1, 'Alpha'), row(2, 'Beta')] });
  g.confirmState.a.confirmed = true;
  const v = buildHostSetupView(g, names);
  assert.equal(v.phase, 'setup');
  assert.deepEqual(v.players.map((p) => [p.name, p.character.name, p.confirmed]), [['Alex', 'Alpha', true], ['Sam', 'Beta', false]]);
  assert.equal(v.waitingOn, 1);
  assert.equal(v.allReady, false);
}

function theHostGameViewShowsTurnClockAndEveryCharacter() {
  const g = createSetup({ order: ['a', 'b', 'c'], guildId: 'web', listIds: [1], difficulty: 'everything', characters: [row(1, 'Alpha'), row(2, 'Beta'), row(3, 'Gamma')] });
  loop.startTurn(g);
  loop.gotIt(g, 'a'); // Alex finishes; Sam is up
  g.turnEndsAt = 1_000_000 + 42_000;
  const v = loop.buildHostGameView(g, names, 1_000_000);
  assert.equal(v.phase, 'playing');
  assert.equal(v.current.name, 'Sam');
  assert.equal(v.turnRemaining, 42);
  assert.deepEqual(v.players.map((p) => [p.name, p.character.name, p.status]), [
    ['Alex', 'Alpha', 'finished'],
    ['Sam', 'Beta', 'guessing'],
    ['Kira', 'Gamma', 'waiting'],
  ]);
  assert.equal(v.buttons, undefined, 'watch-only: the host resolves nothing');
}

module.exports = {
  'picks land on the right players and the rest are random': picksLandOnTheRightPlayersAndTheRestAreRandom,
  'everyone can be random': everyoneCanBeRandom,
  'a pick for someone not dealt in is refused': aPickForSomeoneNotDealtInIsRefused,
  'an unknown id is refused, naming the player': anUnknownIdIsRefusedNamingThePlayer,
  'the same character twice is refused, naming both': theSameCharacterTwiceIsRefusedNamingBoth,
  'the random fill excludes the picks': theRandomFillExcludesThePicks,
  'a blank pick means random': aBlankPickMeansRandom,
  'a typed name is trimmed and capped': aTypedNameIsTrimmedAndCapped,
  'too few left for the random seats is refused': tooFewLeftForTheRandomSeatsIsRefused,
  'an empty pool only matters for random seats': anEmptyPoolOnlyMattersForRandomSeats,
  'a host-picked game cannot be rerolled': aHostPickedGameCannotBeRerolled,
  'the host setup view shows every character and who is ready': theHostSetupViewShowsEveryCharacterAndWhoIsReady,
  'the host game view shows turn, clock and every character': theHostGameViewShowsTurnClockAndEveryCharacter,
};
