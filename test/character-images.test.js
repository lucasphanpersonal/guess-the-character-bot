// The image trust rule: which sources can be believed to depict the character.

const { assert } = require('./harness');
const { imageIsTrustworthy } = require('../src/util/characterImages');

const ANILIST = 'https://s4.anilist.co/file/anilistcdn/character/large/b1-ChxaldmieFlQ.png';
const COMMONS = (file) => `https://upload.wikimedia.org/wikipedia/commons/a/ab/${file}`;

module.exports = {
  'AniList art is trusted everywhere -- it is drawn from the work itself'() {
    for (const category of ['Anime', 'Manga', 'Cartoon', 'Video Games', 'Movies']) {
      assert.equal(imageIsTrustworthy(category, ANILIST), true, category);
    }
  },

  // A photograph can't depict a drawing, so no Commons file survives in these categories --
  // this is the rule that removes the cosplay shots and theme-park mascots.
  'Commons images are dropped for animation and games'() {
    assert.equal(imageIsTrustworthy('Cartoon', COMMONS('Cruella%20(11926613414).jpg')), false);
    assert.equal(imageIsTrustworthy('Video Games', COMMONS('Ema%20Skye%20cosplay.jpg')), false);
    assert.equal(imageIsTrustworthy('Cartoon', COMMONS('Woody%20at%20Toy%20Story%20Land.jpg')), false);
  },

  // For live action the actor's photo genuinely is the character's canonical look, so the
  // rule deliberately stops here rather than trying to guess which files are bad.
  'Commons images are kept for live-action media'() {
    assert.equal(imageIsTrustworthy('Television Shows', COMMONS('Kiefer%20Sutherland.jpg')), true);
    assert.equal(imageIsTrustworthy('Movies', COMMONS('Some%20Actor%202009.jpg')), true);
  },

  'a missing image is never trustworthy'() {
    assert.equal(imageIsTrustworthy('Anime', null), false);
    assert.equal(imageIsTrustworthy('Anime', ''), false);
  },
};
