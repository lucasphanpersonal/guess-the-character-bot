// Seeds one list per show/film from data/seed/wikidata-characters.json (built by
// scripts/fetch-wikidata-characters.js), filling the Western-screen-media gap the Character
// Codex leaves: Samurai Jack, The Powerpuff Girls, Ed Edd n Eddy, Ben 10, Regular Show and
// several hundred more that the codex has fewer than three characters for -- and therefore
// never turns into a playable list at all.
//
// Like the codex importer this is additive and idempotent: it creates a franchise list per
// show, skips characters already present, and never overwrites an existing image.
//
// HOW DEEP EACH SHOW GOES
// Wikidata records main casts and walk-ons alike, so SpongeBob arrives with 152 entries
// ending in "Incidental 29" and "Great Great Great Grandpa Krabs". Those make miserable
// game material -- nobody can guess them, and in audience-vote mode they crowd out the
// characters people actually want.
//
// The obvious trim is a global fame threshold ("must have at least one Wikipedia article"),
// and it is wrong. Ed Edd n Eddy has *thirteen* characters and not one of them has an
// article of their own -- the whole cast lives on a shared "list of characters" page -- so a
// global cutoff deletes Ed, Edd, Eddy, Rolf, Plank and Nazz while keeping dozens of minor
// SpongeBob relatives. Fame is only comparable within a show, not across them.
//
// So the cut is per show: sort by sitelink count and keep the top PER_SHOW_LIMIT. SpongeBob
// loses its long tail, Ed Edd n Eddy keeps its entire cast, and no show can flood the pool.
//
// Usage:
//   node scripts/seed-wikidata-characters.js <guildId>
//   node scripts/seed-wikidata-characters.js <guildId> --per-show 50
//   node scripts/seed-wikidata-characters.js <guildId> --group kids-tv
//   node scripts/seed-wikidata-characters.js <guildId> --dry-run

const fs = require('fs');
const path = require('path');
const {
  createList,
  setListCategory,
  getListByName,
  addCharacter,
  getCharacters,
  setCharacterImage,
} = require('../src/db/characterLists');

const DATA_PATH = path.join(__dirname, '..', 'data', 'seed', 'wikidata-characters.json');

// How many characters a single show may contribute, best-known first.
const PER_SHOW_LIMIT = 30;
// Same threshold the codex importer uses -- below three characters a list is not worth
// existing, since a lobby drawing from it has almost nothing to choose between.
const MIN_CHARACTERS = 3;

/**
 * Names that are labels for a character rather than a name anyone could guess.
 *
 * Wikidata is a database first and a character list second, so it carries production
 * bookkeeping ("Incidental 29", "Squid guard 1") and relationship descriptions
 * ("Squidward's teenage cousin", "Old Man Jenkins' grandson") as first-class items. Both
 * are unguessable by construction: the first has no on-screen identity and the second
 * *is* its own clue.
 */
const UNGUESSABLE = [
  /^incidental\b/i,
  /\bincidentals?$/i,
  // "Squid guard 1", "Fish #3" -- a trailing index is production shorthand, not a name.
  /[ #]\d+$/,
  // Possessive *descriptions* -- "Sandy's cousin", "Old Man Jenkins' grandson" -- which are
  // their own answer and so unguessable. The lowercase letter is what separates them from
  // possessive *names* like "Santa's Little Helper", which are real characters and stay.
  /['’]s?\s+[a-z]/,
  // Wikidata list/category items that slipped through the type filter.
  /^(?:list|lists|category|index) of\b/i,
  // Unnamed placeholders.
  /\b(?:unnamed|unidentified|generic|background character)\b/i,
];

// A name that is mostly lowercase is a common noun Wikidata happened to type as a
// character ("moon jellyfish", "chum"), not a character anyone would name.
function looksLikeCommonNoun(name) {
  return /^[a-z]/.test(name);
}

function isGuessable(name) {
  if (name.length < 2 || name.length > 60) return false;
  if (looksLikeCommonNoun(name)) return false;
  return !UNGUESSABLE.some((re) => re.test(name));
}

/**
 * Picks which characters from one show to import.
 *
 * Sorted by sitelinks so the cut keeps the recognisable end, with the name as a stable
 * tiebreak -- otherwise shows whose characters all sit at zero sitelinks (the common case
 * for cartoons) would import a different arbitrary subset on every run.
 */
function selectForShow(characters, perShow) {
  return characters
    .filter((c) => isGuessable(c.name))
    .sort((a, b) => b.sitelinks - a.sitelinks || a.name.localeCompare(b.name))
    .slice(0, perShow);
}

// Two characters in one show can share a display name once the Wikipedia-title pass has
// stripped disambiguators (Ed Edd n Eddy's "Ed" and Ben 10's "Ditto" are distinct items
// that can collide with an existing row). Within a list the name is the identity, so a
// collision is dropped rather than mangled into something unguessable.
function dedupeByName(selected) {
  const seen = new Set();
  const out = [];
  for (const character of selected) {
    const key = character.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(character);
  }
  return out;
}

function importShow(guildId, listName, category, characters, { dryRun }) {
  if (dryRun) {
    const list = getListByName(guildId, listName);
    const existing = list ? new Set(getCharacters(list.id).map((c) => c.name.toLowerCase())) : new Set();
    const added = characters.filter((c) => !existing.has(c.name.toLowerCase())).length;
    return { created: !list, added, skipped: characters.length - added, images: 0 };
  }

  let list = getListByName(guildId, listName);
  let created = false;
  if (!list) {
    list = { id: createList(guildId, listName, 'seed-script', category) };
    created = true;
  } else if (list.category !== category && list.created_by === 'seed-script') {
    // An earlier run of this script derived the category from the source group rather than
    // from the work itself, which filed every Cartoon Network Studios series as a film.
    // Only rows this script created are corrected -- a category somebody set by hand is
    // theirs, not ours to overwrite.
    setListCategory(list.id, category);
  }

  const existing = new Map(getCharacters(list.id).map((c) => [c.name.toLowerCase(), c]));
  let added = 0;
  let skipped = 0;
  let images = 0;
  for (const character of characters) {
    const current = existing.get(character.name.toLowerCase());
    if (current) {
      // Never overwrite artwork somebody set by hand; only fill a gap.
      if (!current.image_url && character.image) {
        setCharacterImage(list.id, character.name, character.image);
        images++;
      }
      skipped++;
      continue;
    }
    try {
      addCharacter(list.id, character.name, 'seed-script', character.image || null);
      added++;
      if (character.image) images++;
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') skipped++;
      else throw err;
    }
  }
  return { created, added, skipped, images };
}

function parseArgs(argv) {
  const opts = { guildId: null, perShow: PER_SHOW_LIMIT, groups: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--per-show') opts.perShow = Number(argv[++i]);
    else if (arg === '--group') opts.groups.push(argv[++i]);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown flag ${arg}`);
    else if (!opts.guildId) opts.guildId = arg;
  }
  if (!Number.isInteger(opts.perShow) || opts.perShow < 1) {
    throw new Error('--per-show needs a positive integer');
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.guildId) {
    console.error(
      'Usage: node scripts/seed-wikidata-characters.js <guildId> [--per-show N] [--group KEY] [--dry-run]'
    );
    console.error(
      "Find your server's ID: enable Developer Mode (User Settings > Advanced Settings > Developer Mode), " +
        'then right-click the server icon > Copy Server ID.'
    );
    process.exit(1);
  }
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`Missing ${path.relative(process.cwd(), DATA_PATH)}.`);
    console.error('Build it first with: npm run fetch:wikidata');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const shows = Object.values(data.series)
    .filter((s) => !opts.groups.length || opts.groups.includes(s.group))
    .sort((a, b) => a.label.localeCompare(b.label));

  if (!shows.length) {
    console.error(`No shows matched. Groups present: ${[...new Set(Object.values(data.series).map((s) => s.group))].join(', ')}`);
    process.exit(1);
  }

  let listsCreated = 0;
  let totalAdded = 0;
  let totalSkipped = 0;
  let totalImages = 0;
  let tooSmall = 0;

  for (const show of shows) {
    const selected = dedupeByName(selectForShow(show.characters, opts.perShow));
    if (selected.length < MIN_CHARACTERS) {
      tooSmall++;
      continue;
    }

    const { created, added, skipped, images } = importShow(
      opts.guildId,
      show.label,
      show.category,
      selected,
      opts
    );
    if (created) listsCreated++;
    if (added || images) {
      console.log(
        `  ${show.label}: added ${added}, skipped ${skipped} already present` +
          `${images ? `, ${images} image(s)` : ''}${show.characters.length > selected.length ? ` [${show.characters.length - selected.length} trimmed]` : ''}`
      );
    }
    totalAdded += added;
    totalSkipped += skipped;
    totalImages += images;
  }

  console.log(
    `\n${opts.dryRun ? '[dry run] ' : ''}Done. ${listsCreated} list(s) created from ${shows.length - tooSmall} show(s) ` +
      `(${tooSmall} skipped for having fewer than ${MIN_CHARACTERS} guessable characters). ` +
      `Added ${totalAdded}, skipped ${totalSkipped} already present, ${totalImages} image(s) attached.`
  );
  if (opts.dryRun) console.log('--dry-run: no database writes.');
}

module.exports = { selectForShow, dedupeByName, isGuessable, PER_SHOW_LIMIT, MIN_CHARACTERS };

if (require.main === module) main();
