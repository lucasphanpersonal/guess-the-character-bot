// Seeds the shared "League of Legends" character list from
// data/seed/league-of-legends.json (all current champions, fetched once from Riot's public
// Data Dragon API -- names and splash-art URLs only, no lore/descriptions). Safe to re-run
// -- it skips characters that are already in the list.
//
// Usage: node scripts/seed-league-of-legends.js [listName]

const fs = require('fs');
const path = require('path');
const { scriptArgs } = require('./lib/compendiumArgs');
const { createList, getListByName, addCharacter, setCharacterImage, getCharacters } = require('../src/compendium/characterLists');

const SPLASH_BASE = 'https://ddragon.leagueoflegends.com/cdn/img/champion/splash';
const imageUrlFor = (id) => `${SPLASH_BASE}/${id}_0.jpg`;

function main() {
  const [listName = 'League of Legends'] = scriptArgs();

  const { champions } = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'league-of-legends.json'), 'utf8')
  );

  let list = getListByName(null, listName);
  if (!list) {
    const id = createList(null, listName, 'seed-script', 'Video Games');
    list = { id };
    console.log(`Created shared list "${listName}".`);
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
