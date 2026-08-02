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
// The rule is about MEDIUM, not about guessing which files are bad. For live action a
// photograph of the actor genuinely is the character's canonical look, so it stays. For
// animation and games no photograph can be right, so Commons images are dropped there
// outright -- no heuristics, no false positives.
//
// AniList art is always kept: it is drawn from the work itself, per character.
//
// A missing image costs almost nothing (the DM reads fine without one) while a wrong image
// is actively harmful here -- whoever is answering questions builds their whole mental
// picture of the character from it.

// Categories whose characters cannot be photographed, only drawn or rendered.
const DRAWN_MEDIA = new Set(['Cartoon', 'Video Games']);

const isAniListImage = (url) => /(^|\.)anilist\.co\//.test(url) || url.includes('anilistcdn');

function imageIsTrustworthy(category, imageUrl) {
  if (!imageUrl) return false;
  if (isAniListImage(imageUrl)) return true;
  return !DRAWN_MEDIA.has(category);
}

// Convenience for the seed path: the image to store, or null to store none.
const trustworthyImageOrNull = (category, imageUrl) =>
  imageIsTrustworthy(category, imageUrl) ? imageUrl : null;

module.exports = { imageIsTrustworthy, trustworthyImageOrNull, isAniListImage, DRAWN_MEDIA };
