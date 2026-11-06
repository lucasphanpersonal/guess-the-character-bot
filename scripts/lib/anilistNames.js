// How an AniList character's name is shown: the way English-speaking fans write it.
//
// AniList stores a name in parts (first, middle, last), given name first. The importer used to
// flip every one of them to surname first, to get "Monkey D. Luffy" and "Roronoa Zoro" -- which
// is right for ONE PIECE, whose English releases kept the Japanese order, and wrong nearly
// everywhere else. Measured on the live library: 13,313 of 20,562 AniList names had been
// flipped, giving "Gojou Satoru" and "Yeager Eren", and every Western name came out scrambled:
// "Spiegel Spike", "Forger Loid", "Lawliet L", "Wong Hau Pepelu Tivrusky IV Edward".
//
// So the default is AniList's own order, and surname-first is the exception, kept per franchise
// for the few whose English releases use it.
//
// AniList also romanizes long vowels in full (Gojou, Bakugou, Shouto, Yuuji); 2,784 names had
// one. English releases drop them, so they are folded -- but only inside a word made entirely
// of Japanese syllables, so that a Western name (Louise, Soul) can never be touched.

// Franchises whose English releases keep the Japanese order: Monkey D. Luffy, Nico Robin,
// Trafalgar Law. Matched against the series' English and romaji titles.
const SURNAME_FIRST_SERIES = [/\bone piece\b/i];

/** The old, surname-first form. Kept so a rename can find the row the old importer wrote. */
function surnameFirstName(name) {
  const last = (name.last || '').trim();
  const first = (name.first || '').trim();
  const middle = (name.middle || '').trim();
  // A mononym ("Nami", "Gaara") has no surname; reordering a one-part name is how you get a blank.
  if (!last || !first) return (name.full || first || last || '').trim();
  return [last, middle, first].filter(Boolean).join(' ');
}

function givenFirstName(name) {
  const parts = [name.first, name.middle, name.last].map((p) => (p || '').trim()).filter(Boolean);
  return parts.length ? parts.join(' ') : (name.full || '').trim();
}

// One Japanese syllable: an optional consonant (or digraph), then a vowel; or a syllabic n; or
// the first half of a doubled consonant (Hattori, Kakkoi). A word that is a run of these and
// nothing else is romaji. No l, v, q or x, and no consonant cluster or final consonant but n --
// which is what keeps Louise, Soul, Spike and Edward out.
const SYLLABLE = '(?:(?:ky|gy|sh|sy|ch|ts|ny|hy|by|py|my|ry|[kgsztdnhbpmyrwfj])?[aeiou]|n|([kgsztdhbpmrcf])(?=\\1|ch))';
const ROMAJI_WORD = new RegExp(`^(?:${SYLLABLE})+$`, 'i');

/**
 * Folds the long vowels English releases drop: Gojou -> Gojo, Shouyou -> Shoyo, Yuuji -> Yuji.
 * "ou" folds only where the u is the lengthening, not the start of the next syllable: Inoue
 * stays Inoue (see the rule below for where that line is drawn). "oo", "ii", "aa" and "ei" are left alone -- they are as often written in English
 * (Tooru, Niikura) and "oo" would turn a romaji-shaped English word like "Moon" into "Mon".
 */
// Words the syllable rule gets wrong, found by reading every word it folds in the library.
// Jounouchi is Jou-no-uchi, where the second "ou" is two syllables; Rouge and Mousse are French;
// Urouge is ONE PIECE's official spelling; Mouseman is English.
const FOLD_EXCEPTIONS = new Map([
  ['jounouchi', 'Jonouchi'],
  ['rouge', 'Rouge'],
  ['urouge', 'Urouge'],
  ['mouseman', 'Mouseman'],
  ['mousse', 'Mousse'],
]);

function foldLongVowels(word) {
  const exception = FOLD_EXCEPTIONS.get(word.toLowerCase());
  if (exception) return word[0] === word[0].toLowerCase() ? exception.toLowerCase() : exception;
  // Three letters or fewer stay as written: Kou, You and Sou are the spellings English releases
  // tend to keep, and You Watanabe is not "Yo".
  if (word.length <= 3 || !ROMAJI_WORD.test(word)) return word;
  // Not before a/e, where the u starts the next syllable: Inoue. Before i it is the lengthening
  // in the common names (Kyouichirou, Shouichi), so it folds.
  return word.replace(/ou(?![ae])/gi, (m) => m[0]).replace(/uu/gi, (m) => m[0]);
}

function foldName(text) {
  // Split on spaces and hyphens, keeping them, so "Jin-Woo" and "Kyou-chan" are folded per part.
  return text
    .split(/([\s-]+)/)
    .map((part) => (/^[\s-]*$/.test(part) ? part : foldLongVowels(part)))
    .join('');
}

const keepsSurnameFirst = (titles) =>
  titles.filter(Boolean).some((title) => SURNAME_FIRST_SERIES.some((re) => re.test(title)));

/**
 * The name to show for an AniList character.
 *
 * @param name    AniList's name object: { first, middle, last, full }
 * @param titles  The series' titles (English and romaji), to tell whether it keeps surname-first.
 */
function englishName(name, titles = []) {
  const ordered = keepsSurnameFirst(titles) ? surnameFirstName(name) : givenFirstName(name);
  return foldName(ordered).replace(/\s+/g, ' ').trim();
}

module.exports = { englishName, surnameFirstName, givenFirstName, foldLongVowels, keepsSurnameFirst, SURNAME_FIRST_SERIES };
