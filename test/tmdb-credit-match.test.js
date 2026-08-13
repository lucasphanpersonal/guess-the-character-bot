// Name matching for the TMDB artwork backfill (scripts/fetch-tmdb-images.js).
//
// This is the part worth testing: a false positive here silently stores the WRONG actor's face
// against a character, and nothing downstream would catch it -- the image just quietly misleads
// whoever is answering questions about them.

const { assert } = require('./harness');
const { creditMatches } = require('../scripts/fetch-tmdb-images');

function exactNamesMatch() {
  assert.equal(creditMatches('Jack Bauer', 'Jack Bauer'), true);
  assert.equal(creditMatches('walter white', 'Walter White'), true);
}

function tmdbRoleDecorationIsIgnored() {
  // TMDB spells roles freely; the parenthetical is stripped by norm().
  assert.equal(creditMatches('Hershel Greene', 'Hershel Greene (archive footage)'), true);
  assert.equal(creditMatches('Gregory House', 'Dr. Gregory House'), true);
}

function aFullNameMatchesItsBilling() {
  assert.equal(creditMatches('Han Solo', 'Han Solo'), true);
  // Our name is the shorter side, appearing as whole words in a longer billing.
  assert.equal(creditMatches('Sarah Connor', 'Sarah Connor / Narrator'), true);
}

function differentPeopleDoNotMatch() {
  assert.equal(creditMatches('Jack Bauer', 'Kim Bauer'), false);
  assert.equal(creditMatches('Walter White', 'Skyler White'), false);
  assert.equal(creditMatches('Michael Scott', 'Michael Scarn'), false);
}

function shortNamesRequireAnExactMatch() {
  // The dangerous class: a 2-3 letter name is a substring of half the cast list. Containment is
  // refused below 4 characters, so these must be exact or nothing.
  assert.equal(creditMatches('Ed', 'Edward Scissorhands'), false);
  assert.equal(creditMatches('Ron', 'Rondo Hatton'), false);
  assert.equal(creditMatches('Ed', 'Ed'), true, 'an exact short name still matches');
}

function containmentRespectsWordBoundaries() {
  // "rose" must not match "roseanne" -- substring containment alone would have allowed it.
  assert.equal(creditMatches('Rose', 'Roseanne Conner'), false);
  assert.equal(creditMatches('Rose', 'Rose Tyler'), true);
}

function emptyOrMissingNamesNeverMatch() {
  assert.equal(creditMatches('', 'Jack Bauer'), false);
  assert.equal(creditMatches('Jack Bauer', ''), false);
  assert.equal(creditMatches('Jack Bauer', null), false);
}

module.exports = {
  'exact names match': exactNamesMatch,
  'TMDB role decoration is ignored': tmdbRoleDecorationIsIgnored,
  'a full name matches its billing': aFullNameMatchesItsBilling,
  'different people do not match': differentPeopleDoNotMatch,
  'short names require an exact match': shortNamesRequireAnExactMatch,
  'containment respects word boundaries': containmentRespectsWordBoundaries,
  'empty or missing names never match': emptyOrMissingNamesNeverMatch,
};
