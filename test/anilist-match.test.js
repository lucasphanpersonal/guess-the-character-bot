// Covers the match-confidence rules in scripts/fetch-anilist-images.js. Wrong artwork is
// worse than no artwork -- it actively misleads someone trying to guess -- so the cases that
// matter most here are the ones that must NOT match.

const { assert } = require('./harness');
const {
  titleRelation,
  nameMatchTier,
  isConfidentMatch,
  isNameSubset,
  pickMatch,
  pickPartialMatch,
  searchPlan,
} = require('../scripts/fetch-anilist-images');

// Minimal stand-ins for the AniList shapes pickMatch/pickPartialMatch consume.
const character = (full, { alternative = [], native = null, media = [], favourites = 0, id = 1 } = {}) => ({
  id,
  favourites,
  name: { full, native, alternative },
  image: { large: `https://example.test/${id}.png` },
  media: { nodes: media.map((title) => ({ title: { romaji: title, english: title, native: null } })) },
});

module.exports = {
  'a sequel or arc title still counts as the same franchise'() {
    assert.equal(titleRelation('Naruto', 'Naruto'), 2, 'identical');
    assert.equal(titleRelation('Naruto', 'NARUTO: Shippuuden'), 1, 'sequel');
    assert.equal(titleRelation('Bleach', 'Bleach: Sennen Kessen-hen'), 1, 'arc');
    assert.equal(titleRelation('Pokémon Red/Blue', 'Pokemon'), 1, 'punctuation and accents ignored');
  },

  'a title that merely starts with the same word is not the same franchise'() {
    // These are the false positives plain substring matching would wave through.
    assert.equal(titleRelation('Air', 'Air Gear'), 0, 'too short to be evidence');
    assert.equal(titleRelation('One', 'One Piece'), 0);
    assert.equal(titleRelation('Naruto', 'Boruto: Naruto Next Generations'), 0, 'shared word, not a prefix');
    assert.equal(titleRelation('Attack on Titan', 'Shingeki no Kyojin'), 0, 'unrelated strings');
  },

  'name matching tiers rank full names above nicknames'() {
    const naruto = { full: 'Naruto Uzumaki', native: 'うずまきナルト', alternative: ['Fox'] };
    assert.equal(nameMatchTier('Naruto Uzumaki', naruto), 3, 'exact full name');
    assert.equal(nameMatchTier('Uzumaki Naruto', naruto), 2, 'family name first');
    assert.equal(nameMatchTier('Fox', naruto), 1, 'nickname only');
    assert.equal(nameMatchTier('Sasuke Uchiha', naruto), 0);
  },

  'romanization variants of the same name still match'() {
    assert.equal(nameMatchTier('Zero Kiryu', { full: 'Zero Kiryuu', alternative: [] }), 2);
    assert.equal(nameMatchTier('Kōji Kabuto', { full: 'Kouji Kabuto', alternative: [] }), 2);
  },

  'a second name in parentheses is treated as an alias'() {
    const lelouch = { full: 'Lelouch Lamperouge', alternative: [] };
    assert.equal(nameMatchTier('Lelouch Lamperouge (Lelouch vi Britannia)', lelouch), 3);
    assert.deepEqual(
      searchPlan({ character_name: 'Lelouch Lamperouge (Lelouch vi Britannia)' }).slice(0, 3).map((t) => t.term),
      ['Lelouch Lamperouge (Lelouch vi Britannia)', 'Lelouch Lamperouge', 'Lelouch vi Britannia']
    );
  },

  'no image without corroborating media, and no nickname match without an exact title'() {
    assert.equal(isConfidentMatch(3, 0), false, 'right name, no franchise evidence');
    assert.equal(isConfidentMatch(0, 2), false, 'right franchise, wrong name');
    assert.equal(isConfidentMatch(1, 1), false, 'nickname plus a mere sequel title is too weak');
    assert.equal(isConfidentMatch(1, 2), true, 'nickname is fine against an exact title');
    assert.equal(isConfidentMatch(3, 1), true);
  },

  'a same-named character from another franchise is rejected'() {
    const row = { character_name: 'Sakura', media_source: 'Naruto' };
    const impostor = character('Sakura', { media: ['Cardcaptor Sakura'], favourites: 9000 });
    assert.equal(pickMatch(row, [impostor]), null);

    const real = character('Sakura', { media: ['NARUTO: Shippuuden'], id: 2 });
    assert.equal(pickMatch(row, [impostor, real]).candidate.id, 2, 'picks the one from the right franchise');
  },

  'the partial-name fallback accepts a shortened name only when it is unambiguous'() {
    const row = { character_name: 'Levi Ackerman', media_source: 'Attack on Titan' };
    assert.ok(isNameSubset('Levi Ackerman', { full: 'Levi' }), 'AniList stores him as plain "Levi"');
    assert.equal(isNameSubset('Levi Ackerman', { full: 'Levi Smith' }), false, 'extra name part disqualifies');

    const levi = character('Levi', { media: ['Attack on Titan'], id: 3 });
    assert.equal(pickPartialMatch(row, [levi]).candidate.id, 3);

    // Two plausible Levis from the same franchise: unresolvable, so take neither.
    const otherLevi = character('Levi', { media: ['Attack on Titan'], id: 4, favourites: 99999 });
    assert.equal(pickPartialMatch(row, [levi, otherLevi]), null);
  },

  'the partial-name fallback still requires the franchise to line up'() {
    const row = { character_name: 'Levi Ackerman', media_source: 'Attack on Titan' };
    const wrongShow = character('Levi', { media: ['Nanatsu no Taizai'], id: 5 });
    assert.equal(pickPartialMatch(row, [wrongShow]), null);
  },

  'short single-word searches are not attempted as fallbacks'() {
    // Searching AniList for "Rin" returns a wall of unrelated characters, so the plan stops
    // at the full name rather than inviting a coin flip.
    assert.deepEqual(searchPlan({ character_name: 'Rin Ito' }).map((t) => t.mode), ['exact']);
    assert.deepEqual(searchPlan({ character_name: 'Totoro' }).map((t) => t.mode), ['exact'], 'nothing to split');
  },
};
