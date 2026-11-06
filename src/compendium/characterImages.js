// Whether an image can be trusted to actually depict the character.
//
// Wikidata's image property is not "a picture of this character" -- it is "an image
// associated with this item", which for a fictional character routinely resolves to the
// actor who played them, a cosplayer at a convention, a wax figure, or a period book
// illustration. Real examples from the seed data:
//
//   Jack Bauer      -> Kiefer Sutherland at 24 Redemption premiere
//   Kim Bauer       -> Elisha Cuthbert in 2009
//   Cruella de Vil  -> a Flickr convention photo
//   Santa Claus     -> an 1837 painting by Robert Walter Weir
//   Captain Nemo    -> an 1870 Neuville & Riou engraving
//
// The rule is about SOURCE and MEDIUM, not about guessing which files are bad. Commons is
// trusted for real people only: for a fictional character it is the wrong question asked of
// the wrong source, so its images are dropped outright -- no heuristics, no false positives.
// Live action can still carry an actor's photo, from TMDB (the actor credited in that very
// role) or the show's own wiki; for animation and games no photograph can be right at all.
//
// AniList art is always kept: it is drawn from the work itself, per character.
//
// A missing image costs almost nothing (the DM reads fine without one) while a wrong image
// is actively harmful here -- whoever is answering questions builds their whole mental
// picture of the character from it.

// Categories whose characters cannot be photographed, only drawn or rendered.
const DRAWN_MEDIA = new Set(['Cartoon', 'Video Games']);

const isAniListImage = (url) => /(^|\.)anilist\.co\//.test(url) || url.includes('anilistcdn');

// Fandom is the same KIND of source as AniList, which is why it clears the same bar: a
// character's page on their own show's wiki carries an image filed against that character --
// a still or official art for animation, the actor in costume for live action. Either way it
// is the canonical look.
//
// That is the thing Commons could never promise. Commons answers "an image associated with
// this item", which is how Woody became a photograph of a theme-park mascot; a franchise wiki
// answers "a picture of this character", which is the question actually being asked.
const isFandomImage = (url) => /(^|\.)(fandom\.com|wikia\.nocookie\.net|wikia\.com)\//.test(url);

// wiki.gg is the same thing under a different landlord: a per-franchise MediaWiki where a
// character page's image is filed against that character. Many game wikis have migrated there
// from Fandom (Slay the Spire among them, and its wiki.gg copy is the one that covers the
// sequel), so excluding it would reject the better source for exactly the category -- Video
// Games -- with the worst artwork coverage. The reasoning is the source's SHAPE, not its brand.
const isGameWikiImage = (url) => /(^|\.)wiki\.gg\//.test(url);

// A game's own art, from where the game itself publishes it: Riot's Data Dragon, Valve's CDN
// for Dota 2, PokeAPI's copy of the official Pokémon artwork, Deadlock's extracted hero assets.
// Each is the character as the game draws them -- the one thing Commons never promised -- and
// each is what a roster seed (seed-roster.js, seed-league-of-legends.js, seed-pokemon-list.js)
// stores. Not trusting them is how the Pokémon list lost 1,047 of its 1,212 pictures: the
// clean-up applied this rule to every list and threw official artwork out as untrusted.
// Exact hosts and paths, never a whole CDN: the reason is the source, so the match is the source.
const OFFICIAL_ART = [
  /^https:\/\/ddragon\.leagueoflegends\.com\/cdn\/img\/champion\//,
  /^https:\/\/cdn\.cloudflare\.steamstatic\.com\/apps\/dota2\/images\/dota_react\/heroes\//,
  /^https:\/\/raw\.githubusercontent\.com\/PokeAPI\/sprites\/master\/sprites\/pokemon\/other\/official-artwork\//,
  /^https:\/\/assets-bucket\.deadlock-api\.com\/assets-api-res\/images\/heroes\//,
];
const isOfficialGameArt = (url) => OFFICIAL_ART.some((re) => re.test(url));

/**
 * Lead images that are about the SHOW rather than the character -- worse than nothing, since
 * a title card names the show to someone whose whole job is to not know it.
 *
 * Measured over the first 760 cartoon matches, this is a 3-in-760 problem: a logo, a title
 * card and a group shot. Tempting to fix it structurally instead, by refusing any page whose
 * title is the show's own name -- but 8 of the 10 characters named after their series got the
 * RIGHT image that way (BoJack Horseman, Chowder, Kim Possible), so that rule would have
 * thrown away four good images for every bad one it caught. The narrow filter wins.
 *
 * Matched against the filename with separators normalised: "Steven_Universe_logo.png" has no
 * word boundary before "logo", so \blogo\b silently misses the exact case that motivated it.
 */
// Shared by every importer of wiki art: scripts/fetch-fandom-images.js and the Persona roster
// (scripts/fetch-hero-rosters.js), whose EMMA arrived as a logo spelling out "EMMA".
const JUNK_IMAGE = /(\blogo\b|\bwordmark\b|favicon|wiki background|placeholder|\bno image\b|noimage|question mark|default avatar|title ?card|group shot|groupshot|cast photo|characters slide|\bposter\b)/i;

const looksLikeJunk = (url) => JUNK_IMAGE.test(decodeURIComponent(url).replace(/[-_]+/g, ' '));

// Wikimedia Commons, the one source the rule cannot believe for a fictional character.
const isCommonsImage = (url) => /^https?:\/\/(upload|commons)\.wikimedia\.org\//.test(url);

// The one category where a photograph from Commons is simply right: it is the person.
const REAL_PEOPLE = 'Real People';

function imageIsTrustworthy(category, imageUrl) {
  if (!imageUrl) return false;
  if (isAniListImage(imageUrl) || isFandomImage(imageUrl) || isGameWikiImage(imageUrl) || isOfficialGameArt(imageUrl)) return true;
  // Commons is refused for EVERY fictional character, not just the drawn categories. The
  // category turned out not to say the medium: animated films and series are filed under
  // Movies and Television Shows (Aladdin, Big Hero 6, Cars, Avatar, Batman: The Brave and the
  // Bold), and that is how 543 Commons files reached fictional characters, about 200 of them
  // plainly cosplay, expo or wax-museum shots by filename alone. Even the live-action ones were
  // mostly the actor at a premiere years later ("Elisha Cuthbert in 2009"); TMDB and the show's
  // own wiki answer the actual question instead.
  if (isCommonsImage(imageUrl)) return category === REAL_PEOPLE;
  return !DRAWN_MEDIA.has(category);
}

// Convenience for the seed path: the image to store, or null to store none.
const trustworthyImageOrNull = (category, imageUrl) =>
  imageIsTrustworthy(category, imageUrl) ? imageUrl : null;

module.exports = {
  imageIsTrustworthy,
  trustworthyImageOrNull,
  isAniListImage,
  isFandomImage,
  isGameWikiImage,
  isOfficialGameArt,
  isCommonsImage,
  looksLikeJunk,
  DRAWN_MEDIA,
};
