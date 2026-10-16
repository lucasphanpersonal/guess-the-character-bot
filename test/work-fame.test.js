// The pure parts of scripts/fetch-work-fame.js (the rest is network, and runs by hand): which
// twelve months it measures, and what counts as a Wikipedia when picking a franchise's work.

const { assert } = require('./harness');
const { lastYear, wikipedias, FITS } = require('../scripts/fetch-work-fame');

module.exports = {
  'the year measured is the twelve whole months before this one'() {
    assert.deepEqual(lastYear(new Date('2026-10-16T12:00:00Z')), ['2025100100', '2026093000']);
    assert.deepEqual(lastYear(new Date('2026-01-05T00:00:00Z')), ['2025010100', '2025123100'], 'across a new year');
    assert.deepEqual(lastYear(new Date('2024-03-10T00:00:00Z')), ['2023030100', '2024022900'], 'a leap February ends on the 29th');
  },

  'only Wikipedias count, not Commons, Wikiquote or Wikidata'() {
    const entity = { sitelinks: { enwiki: {}, frwiki: {}, be_x_oldwiki: {}, commonswiki: {}, enwikiquote: {}, wikidatawiki: {}, specieswiki: {} } };
    assert.equal(wikipedias(entity), 3);
    assert.equal(wikipedias({}), 0);
  },

  'a search result must be the kind of work the category holds'() {
    assert.ok(FITS['Television Shows'].test('American television drama series'));
    assert.ok(FITS.Movies.test('2005 animated film directed by Eric Darnell'));
    assert.ok(FITS['Video Games'].test('2011 video game'));
    assert.ok(!FITS.Movies.test('island country in the Indian Ocean'), 'Madagascar the country is not Madagascar the film');
    assert.ok(!FITS['Television Shows'].test('2009 film by James Cameron'));
  },
};
