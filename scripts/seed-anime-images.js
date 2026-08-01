// Backfills character artwork into the Character Codex's anime/manga lists from
// data/seed/anilist-character-images.json (official art from AniList, fetched once by
// scripts/fetch-anilist-images.js). The codex dataset ships no images at all, so these
// characters otherwise reveal as plain text.
//
// Purely additive and safe to re-run: it only writes where image_url is currently NULL, never
// overwrites art that's already there, and adds no characters. Rows the fetch pass couldn't
// confidently identify simply stay NULL and keep rendering as text.
//
// Target lists are the "Anime" and "Manga" category lists plus every franchise list whose
// category is Anime or Manga -- the same set fetch-anilist-images.js gathered art for.
//
// Usage: node scripts/seed-anime-images.js <guildId> [--dry-run]

const fs = require('fs');
const path = require('path');
const { getListsByCategory, getCharacters, setCharacterImage } = require('../src/db/characterLists');
const {
  FRANCHISE_MIN_CHARACTERS,
  dedupeNamesWithinGroup,
  groupByMediaType,
  buildFranchiseRoots,
  mostCommonMediaType,
} = require('./seed-character-codex');

const CODEX_PATH = path.join(__dirname, '..', 'data', 'seed', 'character-codex.json');
const CACHE_PATH = path.join(__dirname, '..', 'data', 'seed', 'anilist-character-images.json');
const ANIME_MANGA = ['Anime', 'Manga'];

const rowKey = (row) => `${row.character_name}||${row.media_source}`;

// A stored character name isn't always the raw character_name -- seed-character-codex.js
// appends "(media_source)" when two characters would collide inside one list. Re-running that
// same disambiguation is the only reliable way to get from a name in the DB back to the codex
// row it came from, and therefore to the right image. Returns listName -> (storedName -> row).
function buildListIndex(rows) {
  const index = new Map();
  const record = (listName, characters) => {
    const byName = new Map();
    for (const { name, row } of characters) byName.set(name.toLowerCase(), row);
    index.set(listName.toLowerCase(), byName);
  };

  for (const [mediaType, groupRows] of groupByMediaType(rows)) {
    if (!ANIME_MANGA.includes(mediaType)) continue;
    record(mediaType, dedupeNamesWithinGroup(groupRows).result);
  }

  const sourceToRoot = buildFranchiseRoots(rows);
  const rowsByFranchise = new Map();
  for (const row of rows) {
    const franchise = sourceToRoot.get(row.media_source);
    if (!franchise) continue;
    if (!rowsByFranchise.has(franchise)) rowsByFranchise.set(franchise, []);
    rowsByFranchise.get(franchise).push(row);
  }
  for (const [franchise, franchiseRows] of rowsByFranchise) {
    if (franchiseRows.length < FRANCHISE_MIN_CHARACTERS) continue;
    const { result } = dedupeNamesWithinGroup(franchiseRows);
    if (result.length < FRANCHISE_MIN_CHARACTERS) continue;
    if (!ANIME_MANGA.includes(mostCommonMediaType(franchiseRows))) continue;
    record(franchise, result);
  }

  return index;
}

function main() {
  const args = process.argv.slice(2);
  const guildId = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!guildId) {
    console.error('Usage: node scripts/seed-anime-images.js <guildId> [--dry-run]');
    console.error(
      "Find your server's ID: enable Developer Mode (User Settings > Advanced Settings > Developer Mode), " +
        'then right-click the server icon > Copy Server ID.'
    );
    process.exit(1);
  }
  if (!fs.existsSync(CACHE_PATH)) {
    console.error(`Missing ${path.relative(process.cwd(), CACHE_PATH)}.`);
    console.error('Run `node scripts/fetch-anilist-images.js` first to build it from AniList.');
    process.exit(1);
  }

  const rows = JSON.parse(fs.readFileSync(CODEX_PATH, 'utf8'));
  const { characters: images } = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const listIndex = buildListIndex(rows);

  const targetLists = ANIME_MANGA.flatMap((category) => getListsByCategory(guildId, category));
  if (!targetLists.length) {
    console.error(`Guild ${guildId} has no Anime/Manga lists. Run \`npm run seed:codex -- ${guildId}\` first.`);
    process.exit(1);
  }
  console.log(
    `${Object.keys(images).length} images in the cache; ` +
      `${targetLists.length} Anime/Manga lists in guild ${guildId}.${dryRun ? ' (dry run -- no writes)' : ''}`
  );

  let filled = 0;
  let alreadyHadImage = 0;
  let noImageAvailable = 0;
  let notFromCodex = 0;
  const listsTouched = [];

  for (const list of targetLists.sort((a, b) => a.name.localeCompare(b.name))) {
    const byStoredName = listIndex.get(list.name.toLowerCase());
    let filledHere = 0;
    for (const character of getCharacters(list.id)) {
      if (character.image_url) {
        alreadyHadImage++;
        continue;
      }
      // Characters added by hand, or belonging to a list the codex no longer produces, have no
      // codex row to cross-check against -- leave them alone rather than name-matching blind.
      const row = byStoredName && byStoredName.get(character.name.toLowerCase());
      if (!row) {
        notFromCodex++;
        continue;
      }
      const match = images[rowKey(row)];
      if (!match) {
        noImageAvailable++;
        continue;
      }
      if (!dryRun) setCharacterImage(list.id, character.name, match.image);
      filled++;
      filledHere++;
    }
    if (filledHere) {
      listsTouched.push(list.name);
      console.log(`  ${list.name}: ${dryRun ? 'would fill' : 'filled'} ${filledHere}`);
    }
  }

  console.log(`\n${dryRun ? 'Would fill' : 'Filled'} ${filled} image(s) across ${listsTouched.length} list(s).`);
  console.log(
    `Left as-is: ${alreadyHadImage} already had art, ${noImageAvailable} had no confident AniList match, ` +
      `${notFromCodex} not from the codex import.`
  );
}

main();
