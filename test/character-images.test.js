// The image trust rule: which sources can be believed to depict the character.

const { assert } = require('./harness');
const { imageIsTrustworthy, isFandomImage, isGameWikiImage } = require('../src/compendium/characterImages');

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

  // Fandom clears the same bar as AniList, and for the same reason: a character's page on
  // their own show's wiki carries an image filed against that character, not "an image
  // associated with this item". Without this, every backfilled cartoon and game image would
  // be thrown away by the very rule that was supposed to let them in.
  'Fandom art is trusted for drawn media, where Commons never can be'() {
    const FANDOM = 'https://static.wikia.nocookie.net/ducktales/images/2/2b/Scrooge_McDuck.png/revision/latest';
    assert.equal(imageIsTrustworthy('Cartoon', FANDOM), true);
    assert.equal(imageIsTrustworthy('Video Games', FANDOM), true);
    assert.equal(imageIsTrustworthy('Television Shows', FANDOM), true);
    assert.equal(isFandomImage(FANDOM), true);
    assert.equal(isFandomImage('https://youngjustice.fandom.com/wiki/Superman'), true);
    assert.equal(isFandomImage(COMMONS('Kiefer%20Sutherland.jpg')), false);
  },

  // The domain check has to be anchored, or anyone can dress a URL up as Fandom.
  'a lookalike domain is not Fandom'() {
    assert.equal(isFandomImage('https://notfandom.com.evil.example/x.png'), false);
    assert.equal(isFandomImage('https://example.com/fandom.com/x.png'), false);
    assert.equal(imageIsTrustworthy('Cartoon', 'https://example.com/fandom.com/x.png'), false);
  },

  // wiki.gg hosts the same shape of source as Fandom -- a per-franchise wiki whose character
  // page carries that character's image -- and is where several game wikis now live.
  'wiki.gg clears the same bar as Fandom'() {
    const GG = 'https://slaythespire.wiki.gg/images/9/9a/Ironclad.png';
    assert.equal(isGameWikiImage(GG), true);
    assert.equal(imageIsTrustworthy('Video Games', GG), true, 'drawn media still accepts a franchise wiki');
    assert.equal(imageIsTrustworthy('Cartoon', GG), true);
  },

  'a lookalike domain is not wiki.gg'() {
    assert.equal(isGameWikiImage('https://notwiki.gg.evil.example/x.png'), false);
    assert.equal(isGameWikiImage('https://example.com/wiki.gg/x.png'), false);
    assert.equal(imageIsTrustworthy('Video Games', 'https://example.com/wiki.gg/x.png'), false);
  },

  // The clean-up applied the rule to every list, and the rule did not know official art: the
  // Pokémon list lost 1,047 of its 1,212 pictures. Every roster seed stores one of these.
  'a game\'s own official art is trusted for drawn media'() {
    for (const url of [
      'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Locke_0.jpg',
      'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/pudge.png',
      'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/25.png',
      'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/inferno_card.png',
    ]) assert.equal(imageIsTrustworthy('Video Games', url), true, url);
  },

  'official art is matched by its exact source, not its host'() {
    // Anything else on the same CDN, and the same paths on a lookalike, are not the game's art.
    assert.equal(imageIsTrustworthy('Video Games', 'https://raw.githubusercontent.com/someone/memes/master/pikachu.png'), false);
    assert.equal(imageIsTrustworthy('Video Games', 'https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/avatars/x.jpg'), false);
    assert.equal(imageIsTrustworthy('Video Games', 'https://ddragon.leagueoflegends.com.evil.example/cdn/img/champion/splash/x.jpg'), false);
    assert.equal(imageIsTrustworthy('Video Games', 'http://ddragon.leagueoflegends.com/cdn/img/champion/splash/x.jpg'), false, 'https only');
  },

  // A title card or a logo spells out the name the player must not know.
  'title cards and logos are junk, however the file spells them'() {
    const { looksLikeJunk } = require('../src/compendium/characterImages');
    for (const file of ['Titlecard_S7E6_marcelinethevampirequeen.png', 'Johnny_Test_titlecard.jpg', 'Title_card_Steven.png', 'P5S_EMMA_Logo.png']) {
      assert.equal(looksLikeJunk(`https://static.wikia.nocookie.net/x/images/a/ab/${file}/revision/latest`), true, file);
    }
    assert.equal(looksLikeJunk('https://static.wikia.nocookie.net/dragonage/images/4/41/Krem.png'), false, 'a character is not junk');
  },

  'a missing image is never trustworthy'() {
    assert.equal(imageIsTrustworthy('Anime', null), false);
    assert.equal(imageIsTrustworthy('Anime', ''), false);
  },
};
