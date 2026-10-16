// Seeds one shared list from a roster file in data/seed/ (scripts/fetch-hero-rosters.js writes
// them): { list, category, characters: [{ name, image, fame? }] }. Safe to re-run -- characters
// already in the list are skipped, and only a missing picture is filled in. `fame`, when the
// roster has one, is set every run: it is what difficulty cuts on, and the source can change.
//
//   node scripts/seed-roster.js data/seed/dota-2.json
//   node scripts/seed-roster.js data/seed/deadlock.json
//
// The list is shared (every scope can see it) and, like every new list, switched on nowhere:
// each scope's selection is its own (select-lists.js for the web, /list toggle on Discord).

const fs = require('fs');
const path = require('path');
const { createList, getListByName, addCharacter, setCharacterImage, setCharacterFame, getCharacters } = require('../src/compendium/characterLists');

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
  let famed = 0;
  for (const { name, image, fame } of characters) {
    const already = existing.get(name.toLowerCase());
    if (Number.isFinite(fame)) famed++;
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
  for (const { name, fame } of characters) if (Number.isFinite(fame)) setCharacterFame(list.id, name, fame);
  console.log(`${listName}: ${added} added, ${skipped} already there${pictured ? ` (${pictured} given a picture)` : ''}${famed ? `; fame set for ${famed}` : ''}.`);
}

main();
