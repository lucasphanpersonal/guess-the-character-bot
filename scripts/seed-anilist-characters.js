// Seeds one list per anime/manga title from data/seed/anilist-characters.json (built by
// scripts/fetch-anilist-characters.js).
//
// This replaces the Character Codex as the source for anime and manga, because for this
// genre the codex was not merely thin but wrong: One Piece arrived with fourteen entries
// containing four spellings of Luffy, three of Chopper, and the author Eiichiro Oda as if
// he were a character -- while Zoro, Nami, Sanji and Usopp were absent entirely. AniList
// gives 815 One Piece characters, correctly named, nearly all with artwork.
//
// SEASONS ARE MERGED
// AniList files every season and cour as its own title, so a straight import produces
// "Attack on Titan", "Attack on Titan Season 2", "Attack on Titan Season 3" and
// "Attack on Titan: The Final Season" as four lists with heavily overlapping casts. At
// lobby time that is four ways to pick the same show. Titles that differ only by a season
// or part marker are merged into the base title, unioning their casts.
//
// WHICH CHARACTERS
// AniList labels each cast member MAIN, SUPPORTING or BACKGROUND. MAIN and SUPPORTING are
// imported; BACKGROUND is the show's own word for walk-ons and is skipped by default,
// since a list where most entries are unguessable makes for bad games and crowds out the
// characters people actually want in audience-vote mode. Pass --include-background to take
// literally everything.
//
// Usage:
//   node scripts/seed-anilist-characters.js <guildId>
//   node scripts/seed-anilist-characters.js <guildId> --include-background
//   node scripts/seed-anilist-characters.js <guildId> --per-show 50
//   node scripts/seed-anilist-characters.js <guildId> --dry-run

const fs = require('fs');
const path = require('path');
const {
  createList,
  getListByName,
  addCharacter,
  getCharacters,
  setCharacterImage,
} = require('../src/db/characterLists');

const DATA_PATH = path.join(__dirname, '..', 'data', 'seed', 'anilist-characters.json');

const MIN_CHARACTERS = 3;

/**
 * Strips season/part/cour markers so sibling entries collapse onto one title.
 *
 * Deliberately conservative: it only removes suffixes that are unambiguously season
 * markers. A bare trailing number is left alone, because "Steins;Gate 0", "Mob Psycho 100"
 * and "Ranking of Kings" style titles would otherwise be mangled into the wrong show.
 */
const SEASON_SUFFIX = new RegExp(
  [
    '\\s*[:\\-]?\\s*(?:the\\s+)?final\\s+season.*$',
    '\\s*[:\\-]?\\s*season\\s+\\d+.*$',
    '\\s*[:\\-]?\\s*\\d+(?:st|nd|rd|th)\\s+season.*$',
    '\\s*[:\\-]?\\s*part\\s+\\d+$',
    '\\s*[:\\-]?\\s*cour\\s+\\d+$',
    '\\s+(?:II|III|IV)$',
  ].join('|'),
  'i'
);

function baseTitle(label) {
  const stripped = label.replace(SEASON_SUFFIX, '').trim();
  return stripped.length >= 2 ? stripped : label;
}

const KEEP_ROLES = new Set(['MAIN', 'SUPPORTING']);

/**
 * Groups titles onto their base name and unions the casts.
 *
 * The merged list keeps the most popular member's category and the shortest label, which is
 * the base show rather than a sequel's longer title.
 */
function mergeSeasons(series) {
  const groups = new Map();
  for (const s of series) {
    const key = baseTitle(s.label).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const merged = [];
  for (const members of groups.values()) {
    members.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    const primary = members[0];
    const characters = [];
    const seen = new Set();
    for (const member of members) {
      for (const c of member.characters) {
        const key = c.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        characters.push(c);
      }
    }
    merged.push({
      label: baseTitle(primary.label),
      category: primary.category,
      popularity: primary.popularity,
      characters,
      mergedFrom: members.length,
    });
  }
  return merged;
}

function selectCast(characters, { includeBackground, perShow }) {
  const kept = characters
    .filter((c) => includeBackground || KEEP_ROLES.has(c.role))
    .sort((a, b) => b.favourites - a.favourites || a.name.localeCompare(b.name));
  return perShow ? kept.slice(0, perShow) : kept;
}

function importTitle(guildId, title, cast, { dryRun }) {
  if (dryRun) {
    const list = getListByName(guildId, title.label);
    const existing = list ? new Set(getCharacters(list.id).map((c) => c.name.toLowerCase())) : new Set();
    return {
      created: !list,
      added: cast.filter((c) => !existing.has(c.name.toLowerCase())).length,
      skipped: 0,
      images: 0,
    };
  }

  let list = getListByName(guildId, title.label);
  let created = false;
  if (!list) {
    list = { id: createList(guildId, title.label, 'seed-script', title.category) };
    created = true;
  }

  const existing = new Map(getCharacters(list.id).map((c) => [c.name.toLowerCase(), c]));
  let added = 0;
  let skipped = 0;
  let images = 0;
  for (const character of cast) {
    const current = existing.get(character.name.toLowerCase());
    if (current) {
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
  const opts = { guildId: null, includeBackground: false, perShow: null, dryRun: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--include-background') opts.includeBackground = true;
    else if (arg === '--per-show') opts.perShow = Number(argv[++i]);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown flag ${arg}`);
    else if (!opts.guildId) opts.guildId = arg;
  }
  if (opts.perShow !== null && (!Number.isInteger(opts.perShow) || opts.perShow < 1)) {
    throw new Error('--per-show needs a positive integer');
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.guildId) {
    console.error(
      'Usage: node scripts/seed-anilist-characters.js <guildId> [--include-background] [--per-show N] [--dry-run]'
    );
    process.exit(1);
  }
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`Missing ${path.relative(process.cwd(), DATA_PATH)}. Build it with: npm run fetch:anilist-characters`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const titles = mergeSeasons(Object.values(data.series)).sort((a, b) => a.label.localeCompare(b.label));

  let created = 0;
  let totalAdded = 0;
  let totalSkipped = 0;
  let totalImages = 0;
  let tooSmall = 0;
  let mergedAway = 0;

  for (const title of titles) {
    mergedAway += title.mergedFrom - 1;
    const cast = selectCast(title.characters, opts);
    if (cast.length < MIN_CHARACTERS) {
      tooSmall++;
      continue;
    }
    const r = importTitle(opts.guildId, title, cast, opts);
    if (r.created) created++;
    if (r.added && !opts.quiet) {
      console.log(
        `  ${title.label}: added ${r.added}${r.skipped ? `, skipped ${r.skipped}` : ''}` +
          `${r.images ? `, ${r.images} image(s)` : ''}${title.mergedFrom > 1 ? ` [${title.mergedFrom} seasons merged]` : ''}`
      );
    }
    totalAdded += r.added;
    totalSkipped += r.skipped;
    totalImages += r.images;
  }

  console.log(
    `\n${opts.dryRun ? '[dry run] ' : ''}Done. ${created} list(s) created from ${titles.length - tooSmall} title(s) ` +
      `(${mergedAway} season entries merged away, ${tooSmall} too small). ` +
      `Added ${totalAdded}, skipped ${totalSkipped}, ${totalImages} image(s).`
  );
}

module.exports = { baseTitle, mergeSeasons, selectCast, KEEP_ROLES, MIN_CHARACTERS };

if (require.main === module) main();
