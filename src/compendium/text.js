// Shared text normalization. Both list-name lookup and in-game guess matching need to treat
// accented and unaccented spellings as equivalent, since people rarely type accents --
// "Pokemon" should find "Pokémon", and guessing "Flabebe" should match "Flabébé".

const COMBINING_DIACRITICS_RE = /[̀-ͯ]/g;

// "Pokémon" -> "pokemon". NFD splits "é" into "e" + a combining accent, which we then drop,
// so the base letter survives. Case is folded too. Punctuation/spacing is preserved.
function foldDiacritics(str) {
  return str.normalize('NFD').replace(COMBINING_DIACRITICS_RE, '').toLowerCase();
}

// Stricter form used for comparing guesses to character names: folds diacritics, then drops
// everything that isn't a letter or digit, so "Kai'Sa" / "kaisa" / "Kai Sa" all collapse to
// "kaisa". Folding MUST happen first -- stripping non-alphanumerics from raw "Flabébé" would
// delete the accented letters entirely ("flabb") instead of reducing them to "flabebe".
function normalizeLoose(str) {
  return foldDiacritics(str).replace(/[^a-z0-9]/g, '');
}

module.exports = { foldDiacritics, normalizeLoose };
