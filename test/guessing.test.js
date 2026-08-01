const { assert } = require('./harness');
const Game = require('../src/game/Game');
const { foldDiacritics, normalizeLoose } = require('../src/util/text');

function gameWithCharacter(name) {
  return new Game({
    lobby: { players: ['a', 'b'] },
    characters: [{ name }, { name: 'Zzzzzzzzzz' }],
    turnSeconds: 90,
  });
}
const accepts = (target, guess) => gameWithCharacter(target).checkGuess('a', guess);

module.exports = {
  'foldDiacritics reduces accents to base letters'() {
    assert.equal(foldDiacritics('Pokémon'), 'pokemon');
    assert.equal(foldDiacritics('Flabébé'), 'flabebe');
    assert.equal(foldDiacritics('Alexander Dubček'), 'alexander dubcek');
  },

  'normalizeLoose folds accents BEFORE stripping punctuation'() {
    // The ordering matters: stripping first would delete "é" outright, turning "Flabébé"
    // into "flabb" and breaking the match. This is a regression guard.
    assert.equal(normalizeLoose('Flabébé'), 'flabebe');
    assert.equal(normalizeLoose("Kai'Sa"), 'kaisa');
    assert.equal(normalizeLoose('Nidoran♀'), 'nidoran');
  },

  'exact and case-insensitive guesses match'() {
    assert.ok(accepts('Charizard', 'Charizard'));
    assert.ok(accepts('Charizard', 'charizard'));
  },

  'typos are tolerated proportionally to name length'() {
    assert.ok(accepts('Charizard', 'Charazrd'), '2 edits on a 9-char name');
    assert.ok(!accepts('Ash', 'Ish'), 'no tolerance on very short names');
  },

  'unrelated guesses are rejected'() {
    assert.ok(!accepts('Charizard', 'Blastoise'));
    assert.ok(!accepts('Pikachu', ''));
  },

  'accented names accept unaccented guesses'() {
    assert.ok(accepts('Flabébé', 'Flabebe'));
    assert.ok(accepts('Renée', 'Renee'));
    assert.ok(accepts('Beyoncé', 'Beyonce'));
    assert.ok(accepts('Antoni Gaudí', 'Gaudi'));
  },

  'a single well-known word matches a multi-word name'() {
    assert.ok(accepts('Shikamaru Nara', 'Shikamaru'));
    assert.ok(accepts('Shikamaru Nara', 'Nara'));
    assert.ok(accepts('The Amazing Spider-Man', 'Spider-Man'));
  },

  'bare stopwords do not trivially win'() {
    assert.ok(!accepts('The Amazing Spider-Man', 'The'));
    assert.ok(!accepts('The Amazing Spider-Man', 'of'));
  },
};
