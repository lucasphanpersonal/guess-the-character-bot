// Seeds one shared list from a roster file in data/seed/ (scripts/fetch-hero-rosters.js writes
// them): { list, category, characters: [{ name, image }] }. Safe to re-run -- characters already
// in the list are skipped, and only a missing picture is filled in.
//
//   node scripts/seed-roster.js data/seed/dota-2.json
//   node scripts/seed-roster.js data/seed/deadlock.json
//
// The list is shared (every scope can see it) and, like every new list, switched on nowhere:
// each scope's selection is its own (select-lists.js for the web, /list toggle on Discord).

const fs = require('fs');
const path = require('path');
const { createList, getListByName, addCharacter, setCharacterImage, getCharacters } = require('../src/compendium/characterLists');

function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/seed-roster.js data/seed/<game>.json');
  const { list: listName, category, characters } = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!listName || !Array.isArray(characters)) throw new Error(`${file} is not a roster file`);

  let list = getListByName(null, listName);
  if (!list) {
    list = { id: createList(null, listName, 'seed-script', category ?? 'Video Games') };
    console.log(`Created shared list "${listName}".`);
  } else {
    console.log(`Found existing list "${listName}" (id ${list.id}) -- adding missing characters.`);
  }

  const existing = new Map(getCharacters(list.id).map((c) => [c.name.toLowerCase(), c]));
  let added = 0;
  let pictured = 0;
  let skipped = 0;
  for (const { name, image } of characters) {
    const already = existing.get(name.toLowerCase());
    if (already) {
      if (!already.image_url && image) {
        setCharacterImage(list.id, name, image);
        pictured++;
      }
      skipped++;
      continue;
    }
    addCharacter(list.id, name, 'seed-script', image ?? null);
    added++;
  }
  console.log(`${listName}: ${added} added, ${skipped} already there${pictured ? ` (${pictured} given a picture)` : ''}.`);
}

main();
