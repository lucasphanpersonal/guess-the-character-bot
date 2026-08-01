// Seeds a "Pokemon" character list for a guild from data/seed/pokemon-species.json
// (the National Pokedex species list, fetched once from PokeAPI). Safe to re-run --
// it skips characters that are already in the list.
//
// Usage: node scripts/seed-pokemon-list.js <guildId> [listName]

const fs = require('fs');
const path = require('path');
const { createList, getListByName, addCharacter, setCharacterImage, getCharacters } = require('../src/db/characterLists');

const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork';
const imageUrlFor = (id) => `${SPRITE_BASE}/${id}.png`;

// PokeAPI slugs that don't title-case cleanly (punctuation, gender symbols, kept hyphens).
const EXCEPTIONS = {
  'mr-mime': 'Mr. Mime',
  'mr-rime': 'Mr. Rime',
  'mime-jr': 'Mime Jr.',
  'ho-oh': 'Ho-Oh',
  'porygon-z': 'Porygon-Z',
  'nidoran-f': 'Nidoran♀',
  'nidoran-m': 'Nidoran♂',
  farfetchd: "Farfetch'd",
  sirfetchd: "Sirfetch'd",
  'type-null': 'Type: Null',
  'jangmo-o': 'Jangmo-o',
  'hakamo-o': 'Hakamo-o',
  'kommo-o': 'Kommo-o',
  flabebe: 'Flabébé',
  'wo-chien': 'Wo-Chien',
  'chien-pao': 'Chien-Pao',
  'ting-lu': 'Ting-Lu',
  'chi-yu': 'Chi-Yu',
};

function formatName(slug) {
  if (EXCEPTIONS[slug]) return EXCEPTIONS[slug];
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function main() {
  const guildId = process.argv[2];
  const listName = process.argv[3] || 'Pokemon';
  if (!guildId) {
    console.error('Usage: node scripts/seed-pokemon-list.js <guildId> [listName]');
    console.error(
      "Find your server's ID: enable Developer Mode (User Settings > Advanced Settings > Developer Mode), " +
        'then right-click the server icon > Copy Server ID.'
    );
    process.exit(1);
  }

  const species = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'pokemon-species.json'), 'utf8'));

  let list = getListByName(guildId, listName);
  if (!list) {
    const id = createList(guildId, listName, 'seed-script');
    list = { id };
    console.log(`Created list "${listName}" for guild ${guildId}.`);
  } else {
    console.log(`Found existing list "${listName}" (id ${list.id}) -- adding/updating characters.`);
  }

  const existingByName = new Map(getCharacters(list.id).map((c) => [c.name.toLowerCase(), c]));
  let added = 0;
  let imagesBackfilled = 0;
  let skipped = 0;
  for (const { id, slug } of species) {
    const name = formatName(slug);
    const imageUrl = imageUrlFor(id);
    const existingChar = existingByName.get(name.toLowerCase());
    if (existingChar) {
      if (!existingChar.image_url) {
        setCharacterImage(list.id, name, imageUrl);
        imagesBackfilled++;
      }
      skipped++;
      continue;
    }
    try {
      addCharacter(list.id, name, 'seed-script', imageUrl);
      added++;
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        skipped++;
      } else {
        throw err;
      }
    }
  }

  console.log(
    `Done. Added ${added}, skipped ${skipped} already present (${imagesBackfilled} backfilled with an image). ` +
      `"${listName}" now has ${getCharacters(list.id).length} characters.`
  );
}

main();
