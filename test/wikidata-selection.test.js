// Covers the trimming rules in scripts/seed-wikidata-characters.js.
//
// Wikidata hands over whole casts including production bookkeeping, so the interesting
// cases are the two failure modes that ruin a game: importing entries nobody could guess
// ("Incidental 29"), and -- the subtler one -- trimming so hard that a show whose cast has
// no individual Wikipedia articles loses its main characters entirely.

const { assert } = require('./harness');
const { selectForShow, dedupeByName, isGuessable } = require('../scripts/seed-wikidata-characters');

const character = (name, sitelinks = 0, image = null) => ({ name, sitelinks, image, qid: `Q${name.length}` });

module.exports = {
  'production bookkeeping and descriptions are not guessable'() {
    assert.equal(isGuessable('Incidental 29'), false, 'incidental');
    assert.equal(isGuessable('"A" incidentals'), false, 'incidentals suffix');
    assert.equal(isGuessable('Squid guard 1'), false, 'trailing index');
    assert.equal(isGuessable("Squidward's teenage cousin"), false, 'possessive description');
    assert.equal(isGuessable('Patchy’s mom'), false, 'curly apostrophe');
    assert.equal(isGuessable("Old Man Jenkins' grandson"), false, 'possessive without trailing s');
    assert.equal(isGuessable('moon jellyfish'), false, 'common noun');
    assert.equal(isGuessable('list of The Powerpuff Girls characters'), false, 'list item');
    assert.equal(isGuessable('X'), false, 'single letter');
  },

  'real characters survive the filter'() {
    for (const name of [
      'SpongeBob SquarePants',
      'Mr. Krabs',
      'Ed',
      'Plank',
      'Sideshow Bob',
      "Theodore \"T-Bag\" Bagwell",
      'Apu Nahasapeemapetilon',
      'Ben 10,000',
      // A possessive *name*, not a description -- the capital letter is the difference.
      "Santa's Little Helper",
    ]) {
      assert.equal(isGuessable(name), true, name);
    }
  },

  'a show is capped at its best-known characters'() {
    const cast = [
      character('Nobody', 0),
      character('SpongeBob SquarePants', 40),
      character('Squidward Tentacles', 20),
      character('Incidental 29', 0),
    ];
    const picked = selectForShow(cast, 2).map((c) => c.name);
    assert.deepEqual(picked, ['SpongeBob SquarePants', 'Squidward Tentacles'], 'top 2 by sitelinks');
  },

  // The regression that motivated a per-show cap instead of a global fame threshold: every
  // Ed Edd n Eddy character has zero sitelinks, so any "must have a Wikipedia article" rule
  // deletes the entire cast of a show people definitely want to play.
  'a cast with no Wikipedia articles at all is still imported'() {
    const cast = ['Ed', 'Edd', 'Eddy', 'Rolf', 'Plank', 'Nazz'].map((n) => character(n, 0));
    const picked = selectForShow(cast, 30);
    assert.equal(picked.length, 6, 'whole cast kept');
  },

  // Shows whose characters all sit at zero sitelinks would otherwise import a different
  // arbitrary subset every run, so the cut has to be deterministic.
  'the cut is stable when everything ties on fame'() {
    const cast = ['Rolf', 'Ed', 'Nazz', 'Plank'].map((n) => character(n, 0));
    const first = selectForShow(cast, 2).map((c) => c.name);
    const second = selectForShow([...cast].reverse(), 2).map((c) => c.name);
    assert.deepEqual(first, second, 'same picks regardless of input order');
    assert.deepEqual(first, ['Ed', 'Nazz'], 'alphabetical tiebreak');
  },

  'duplicate names within one show are dropped rather than mangled'() {
    const picked = dedupeByName([character('Ditto', 5), character('ditto', 1), character('Ben', 2)]);
    assert.deepEqual(picked.map((c) => c.name), ['Ditto', 'Ben'], 'case-insensitive dedupe');
  },
};
