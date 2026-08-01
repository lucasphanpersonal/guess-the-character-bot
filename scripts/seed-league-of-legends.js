// Seeds a "League of Legends" character list for a guild from
// data/seed/league-of-legends.json (all current champions, fetched once from Riot's public
// Data Dragon API -- names and splash-art URLs only, no lore/descriptions). Safe to re-run
// -- it skips characters that are already in the list.
//
// Usage: node scripts/seed-league-of-legends.js <guildId> [listName]

const fs = require('fs');
const path = require('path');
const { createList, getListByName, addCharacter, setCharacterImage, getCharacters } = require('../src/db/characterLists');

const SPLASH_BASE = 'https://ddragon.leagueoflegends.com/cdn/img/champion/splash';
const imageUrlFor = (id) => `${SPLASH_BASE}/${id}_0.jpg`;

function main() {
  const guildId = process.argv[2];
  const listName = process.argv[3] || 'League of Legends';
  if (!guildId) {
    console.error('Usage: node scripts/seed-league-of-legends.js <guildId> [listName]');
    console.error(
      "Find your server's ID: enable Developer Mode (User Settings > Advanced Settings > Developer Mode), " +
        'then right-click the server icon > Copy Server ID.'
    );
    process.exit(1);
  }

  const { champions } = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'league-of-legends.json'), 'utf8')
  );

  let list = getListByName(guildId, listName);
  if (!list) {
    const id = createList(guildId, listName, 'seed-script', 'Video Games');
    list = { id };
    console.log(`Created list "${listName}" for guild ${guildId}.`);
  } else {
    console.log(`Found existing list "${listName}" (id ${list.id}) -- adding/updating characters.`);
  }

  const existingByName = new Map(getCharacters(list.id).map((c) => [c.name.toLowerCase(), c]));
  let added = 0;
  let imagesBackfilled = 0;
  let skipped = 0;
  for (const { id, name } of champions) {
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
