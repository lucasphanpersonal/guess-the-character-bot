// Whether a typed guess names a character: 'correct', 'close', or 'wrong'.
//
// The games on a computer cannot lean on the table the way the Discord bot and the phones do --
// there, a person rules on what was said out loud. Here somebody TYPES "sasuke" for "Sasuke
// Uchiha", "tails" for `Miles "Tails" Prower`, "uzumaki naruto" for "Naruto Uzumaki", and a
// checker has to agree with what a person would have said. Comparing whole names would refuse
// all three; accepting any word of the name would be worse -- "America" is a word of "Captain
// America", "Wales" of "Catherine, Princess of Wales", and "Uzumaki" of half the Naruto cast.
//
// So there are three verdicts, not two. CORRECT is reserved for forms a person would accept
// without a second thought. CLOSE is "a person should look at this" -- a game shows it as a hint,
// or hands it to the other players to rule on -- and it is where everything uncertain goes,
// because a wrong "correct" ends somebody's turn, or the round, for no reason they can see.
//
// Everything is compared through normalizeLoose (./text.js), the same key the pool dedupes by:
// case, accents, spaces and punctuation never decide anything, so "Spiderman", "spider-man" and
// "Spider Man" are one answer here exactly as they are one character there.

const { foldDiacritics, normalizeLoose } = require('./text');

// A leading word that is a TITLE, not a name. Stripped, what remains is only CLOSE: plenty of
// titles are part of the name itself (Captain America, Mr. Mime, Mr. Freeze, Doctor Who), and
// nothing about the words says which kind of name this is.
const TITLES = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'doctor', 'prof', 'professor', 'sir', 'dame', 'lord', 'lady',
  'king', 'queen', 'prince', 'princess', 'emperor', 'empress', 'captain', 'capt', 'general',
  'admiral', 'commander', 'colonel', 'major', 'lieutenant', 'sergeant', 'officer', 'agent',
  'detective', 'inspector', 'chief', 'principal', 'coach', 'judge', 'father', 'mother', 'brother',
  'sister', 'uncle', 'aunt', 'auntie', 'grandpa', 'grandma', 'saint', 'st', 'count', 'countess',
  'duke', 'duchess', 'baron', 'baroness', 'master', 'grand', 'moff', 'darth',
]);

// Words that never stand for a character on their own.
const FILLER = new Set(['the', 'of', 'a', 'an', 'and', 'de', 'del', 'da', 'di', 'du', 'la', 'le', 'van', 'von', 'der', 'no', 'jr', 'sr']);
const ROMAN = /^(i{1,3}|iv|v|vi{0,3}|ix|x)$/;

// A token as it is compared: folded and stripped like normalizeLoose, one word at a time.
const key = (word) => normalizeLoose(word);

// Words of a display name, splitting on whitespace only: "Jean-Pierre" and "Spider-Man" are one
// word each, and normalizeLoose folds the hyphen away inside it.
function wordsOf(text) {
  return foldDiacritics(String(text)).split(/\s+/).map(key).filter(Boolean);
}

/** A word that can stand for a whole character: long enough, and not a title or filler. */
function isNameWord(k) {
  return k.length >= 3 && !TITLES.has(k) && !FILLER.has(k) && !ROMAN.test(k) && !/^\d+$/.test(k);
}

/**
 * Every form of a name a guess may take, sorted by how sure a match is.
 *
 *   exact   -- any of these is CORRECT
 *   loose   -- CLOSE: a person should look (a title stripped off)
 *   words   -- single words that may stand for the whole name, IF no other character in the
 *              pool shares them (judgeGuess checks that; this cannot see the pool)
 */
function answerForms(name) {
  const exact = new Set();
  const loose = new Set();
  const add = (set, text) => {
    const k = key(text);
    if (k) set.add(k);
  };
  const raw = String(name).trim();
  add(exact, raw);

  // "Zabimaru (Female)", "Joe Jackson (talent manager)": a trailing qualifier, preceded by a
  // space. Not "f(x)", whose brackets are the name.
  const unqualified = raw.replace(/\s+\([^)]*\)\s*$/, '').trim();
  add(exact, unqualified);

  // "The Major", "The Joker": the article is optional either way round.
  const noArticle = unqualified.replace(/^the\s+/i, '');
  add(exact, noArticle);

  // `Miles "Tails" Prower`: the nickname alone, and the name without it.
  let plain = noArticle;
  const quoted = noArticle.match(/"([^"]+)"/);
  if (quoted) {
    add(exact, quoted[1]);
    plain = noArticle.replace(/"[^"]*"/, ' ').replace(/\s+/g, ' ').trim();
    add(exact, plain);
  }

  // "Catherine, Princess of Wales", "Morton Koopa, Jr.": the part before the comma is the name;
  // what follows describes it, and no single word of it may stand in. A comma followed by a space:
  // "Ben 10,000" is a number, not "Ben 10" described.
  const comma = plain.indexOf(', ');
  const core = comma > 0 ? plain.slice(0, comma).trim() : plain;
  add(exact, core);

  const words = core.split(/\s+/).filter(Boolean);
  // Leading titles, stripped -- all of them, for "Grand Moff Tarkin": "Princess Leia" -> "Leia",
  // but also "Captain America" -> "America", which is why it is only close. So are the single
  // words of what remains ("Sparrow" for "Captain Jack Sparrow"): near enough for a person to
  // look, never enough to decide on their own.
  let start = 0;
  while (start < words.length - 1 && TITLES.has(key(words[start]))) start++;
  const titled = start > 0;
  if (titled) {
    const rest = words.slice(start);
    add(loose, rest.join(' '));
    if (rest.length > 1) for (const w of rest) if (isNameWord(key(w))) add(loose, w);
  }

  // Single words that may stand for the whole name: "Sasuke" for "Sasuke Uchiha", "Luffy" for
  // "Monkey D. Luffy". Only in a name of two or three words with no title in front -- a long name
  // is a full formal name whose parts mean little alone, and a titled one is the case above.
  // Nor in "X no Y" / "X of Y": "Sendou no Sobo" is Sendou's GRANDMOTHER, and "Sendou" names
  // somebody else.
  const possessive = words.slice(1, -1).some((w) => key(w) === 'no' || key(w) === 'of');
  const single = [];
  if (comma < 0 && !titled && !possessive && words.length >= 2 && words.length <= 3) {
    for (const w of words) {
      const k = key(w);
      if (isNameWord(k) && !single.includes(k)) single.push(k);
    }
  }
  for (const k of exact) loose.delete(k);
  return { exact: [...exact], loose: [...loose], words: single };
}

// Optimal string alignment distance: insertions, deletions, substitutions, and swapping two
// neighbours -- the typo people actually make ("Sasuek").
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3; // all the caller ever needs to know
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// How many typos a form of this length forgives. None below four letters: one edit turns "Ed"
// into "Al", and short names are exactly where two characters sit one letter apart.
const typoBudget = (k) => (k.length >= 8 ? 2 : k.length >= 4 ? 1 : 0);

/**
 * @param {string} guess    what was typed
 * @param {string} name     the character's name
 * @param {object} [opts]
 * @param {boolean} [opts.singleWords]  let one word of the name count as the whole of it
 *   ("Sasuke" for Sasuke Uchiha). A game opts in, because it depends on who is typing: a player
 *   naming the character they are wearing types a name, while players guessing at a DRAWING type
 *   whatever they see, and "Combat" for "Combat Carl" or "Wild" for "Wild Horn" would hand them
 *   the round. Off, such a word is close.
 * @param {string[]} [opts.others]  other characters' names in the same pool. Even with
 *   singleWords on, a word only counts when none of these shares it -- "Sasuke" names Sasuke
 *   Uchiha in a pool with no other Sasuke, "Uzumaki" names nobody. Without them, no single word
 *   is ever correct.
 * @returns {{ verdict: 'correct'|'close'|'wrong', as: string|null }}  `as` is the form matched.
 */
function judgeGuess(guess, name, { others = [], singleWords = false } = {}) {
  // The article is optional on the guess's side too: "the joker" names "Joker".
  const g = key(String(guess).trim().replace(/^the\s+/i, '')) || key(guess);
  if (!g) return { verdict: 'wrong', as: null };
  const forms = answerForms(name);

  if (forms.exact.includes(g) || forms.exact.includes(key(guess))) return { verdict: 'correct', as: g };

  // The words in any order: "Uzumaki Naruto", "Jean-Pierre Polnareff". Same words, same count.
  const guessWords = wordsOf(String(guess).replace(/^the\s+/i, ''));
  const nameWords = wordsOf(String(name).replace(/\s+\([^)]*\)\s*$/, '').replace(/^the\s+/i, ''));
  const sameBag = (a, b) => a.length === b.length && a.length > 1 && [...a].sort().join(' ') === [...b].sort().join(' ');
  if (sameBag(guessWords, nameWords)) return { verdict: 'correct', as: g };

  // One word of the name, standing for all of it -- only when nobody else in the pool has it.
  if (forms.words.includes(g)) {
    const own = key(name);
    const shared = others.some((other) => key(other) !== own && wordsOf(other).includes(g));
    if (singleWords && !shared && others.length) return { verdict: 'correct', as: g };
    return { verdict: 'close', as: g };
  }

  if (forms.loose.includes(g)) return { verdict: 'close', as: g };

  // Typos, against everything that would have counted.
  for (const f of [...forms.exact, ...forms.loose, ...forms.words]) {
    if (editDistance(g, f) <= typoBudget(f)) return { verdict: 'close', as: f };
  }

  // The right name with something extra: "Monkey D Luffy" for "Luffy", "Captain Rex Clone" ...
  // Every word of a correct form is in the guess, and the guess says more.
  if (guessWords.length > 1) {
    for (const f of forms.exact) {
      if (f.length >= 3 && guessWords.includes(f)) return { verdict: 'close', as: f };
    }
    if (nameWords.length > 1 && nameWords.every((w) => guessWords.includes(w))) return { verdict: 'close', as: key(name) };
  }

  return { verdict: 'wrong', as: null };
}

/**
 * The keys under which two names are ONE character, as far as a guess can tell.
 *
 * The pool must not deal two players what the checker would accept as the same answer --
 * otherwise one of them is marked wrong for a guess that was right, for reasons nobody can see.
 * That is CLAUDE.md's "dedupe with the same key the judge compares with", and the judge here
 * accepts more than one spelling: every exact form, and the words in any order. So two names are
 * one character when they share ANY of these keys -- "Noelle Silva" and "Silva Noelle" (the same
 * person listed twice), `Miles "Tails" Prower` and "Tails", "Zabimaru (Male)" and "Zabimaru
 * (Female)". It also folds a few genuinely different people who share a name ("Vanilla Ice" and
 * JoJo's "Ice Vanilla"): the checker cannot tell those apart either, so neither can a table.
 *
 * Single words are deliberately NOT keys -- whether "Sasuke" names someone depends on the pool.
 */
function identityKeys(name) {
  const bare = String(name).replace(/"[^"]*"/g, ' ').replace(/\s+\([^)]*\)\s*$/, '').replace(/^\s*the\s+/i, '');
  const bag = wordsOf(bare).sort().join(' ');
  return [...new Set([...answerForms(name).exact, ...(bag ? [bag] : [])])];
}

/**
 * `text` -- a work's title, say -- with every word that names this character blanked to
 * underscores, punctuation kept: "Super Mario Bros." for Mario reads "Super _____ Bros.", and
 * "The Simpsons" for Homer Simpson "The ________". A hint that spells the answer is not a hint.
 *
 * A word goes if it IS a word of the name (bar filler: "the", "of" stay), or if it CONTAINS a
 * name-sized word of it -- the plural, the possessive, "Spider-Man:" with its colon. Compared
 * through the same key as everything else here, so case and accents decide nothing.
 */
function maskNameWords(text, name) {
  const named = wordsOf(name).filter((k) => !FILLER.has(k));
  const long = named.filter(isNameWord);
  return String(text)
    .split(/(\s+)/)
    .map((token) => {
      const k = key(foldDiacritics(token));
      if (!k || !(named.includes(k) || long.some((w) => k.includes(w)))) return token;
      return token.replace(/[\p{L}\p{N}]/gu, '_');
    })
    .join('');
}

module.exports = { judgeGuess, answerForms, identityKeys, editDistance, wordsOf, maskNameWords };
