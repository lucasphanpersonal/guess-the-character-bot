// Diacritic folding and loose normalisation, used by character-list name matching.
//
// The fuzzy GUESS matching these once also covered is gone: guesses are ruled on by the
// player who can see the answer, so there is no string for the bot to match.

const { assert } = require('./harness');
const { foldDiacritics, normalizeLoose } = require('../src/core/util/text');

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
};
