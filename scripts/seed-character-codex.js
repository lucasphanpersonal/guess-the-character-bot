// Seeds character lists from the Character Codex dataset
// (data/seed/character-codex.json -- 15,939 characters, fetched once from
// https://huggingface.co/datasets/NousResearch/CharacterCodex via its datasets-server rows
// API). Two layers of lists, and a character can belong to both:
//
//   1. One list per media_type category ("Anime", "Video Games", ...) -- unchanged from the
//      original import.
//   2. One list per recognizable franchise (media_source), e.g. "Naruto", "Pokémon",
//      "Disney" -- built by merging near-duplicate media_source strings (version/edition
//      fragments like "Pokémon Red/Blue" + "Pokémon Sun/Moon", and "X (Publisher)" tags like
//      "Aladdin (Disney)"), then dropping merge roots that turned out to be generic English
//      words/phrases rather than real titles (see EXCLUDE_FRANCHISE_ROOTS below), and
//      requiring at least FRANCHISE_MIN_CHARACTERS to bother breaking a franchise out on its
//      own. This layer is purely additive -- it never removes a character from its category
//      list, so e.g. Pikachu ends up in "Anime", "Video Games", AND "Pokémon".
//
// Safe to re-run -- skips characters already present in a given target list.
//
// Usage: node scripts/seed-character-codex.js <guildId>

const fs = require('fs');
const path = require('path');
const { createList, getListByName, addCharacter, getCharacters } = require('../src/db/characterLists');

const FRANCHISE_MIN_CHARACTERS = 3;

// Merge roots that are common English words, pronouns, or descriptive tags rather than
// actual titles -- automatically merging under these produced clearly wrong groupings
// (e.g. "Ghost in the Shell", "Ghost Whisperer", and "Ghost of Tsushima" all starting with
// "Ghost", or the literal tag "TV Series"). Found by manually reviewing every merge
// candidate this heuristic produced against the real dataset before shipping it.
const EXCLUDE_FRANCHISE_ROOTS = new Set([
  '24', '300', 'Air', 'Amy', 'Angel', 'Arthur', 'Avatar', 'Board Game', 'Board Game Adaptation',
  'Bridge', 'Broken', 'Casino', 'Chicago', 'Christine', 'Comic Strip', 'Confessions', 'Covert',
  'Crash', 'Days', 'Empire', 'Epic', 'film', 'Film', 'Forever', 'Fury', 'Golf',
  'Graphic Novel adaptation', 'Graphic Novel Adaptation', 'Graphic Novel Series', 'Gravity',
  'Hearts', 'Heat', 'Heroes', 'Her', 'High Adventure', 'Historical Composer',
  'Historical Explorer', 'Historical Figure', 'Historical Poet', 'History', 'Honey',
  'Imperial', 'in parody context', 'Jungle', 'Language', 'Legend', 'Legion', 'Major', 'Me',
  'Miracle', 'Monster', 'Moon', 'Movie', 'Music Industry', 'Nadia', 'Open', 'Orange', 'Power',
  'Ra', 'Ray', 'Real Life', 'Remember', 'Rent', 'Salt', 'Sanctuary', 'Shape Up', 'Smile',
  'Soulless', 'Spy', 'Stage Adaptation', 'Steampunk Adaptation', 'Stitches', 'The Red',
  'The West', 'Tikal', 'Traditional Home', 'TV Series', 'UK', 'Unbroken', 'Up',
  'US Patent No. 1,773,980', 'Various Fairy Tales', 'Various Philosophical Works',
  'Video Game', 'Video Game Series', 'Voice Acting', 'War', 'We', 'Wild', 'with mods',
  'Wonder', 'World War II',
]);
const YEAR_LIKE_ROOT = /^\d{4}\b/;

// Same disambiguation used for the per-category import: if two characters share a name
// within one target list, the second becomes "Name (media_source)"; if that still collides
// (rare), it's skipped with a note rather than silently lost.
function dedupeNamesWithinGroup(rows) {
  const seen = new Set();
  const result = [];
  let collisionsSkipped = 0;
  for (const row of rows) {
    let name = row.character_name;
    if (seen.has(name.toLowerCase())) name = `${row.character_name} (${row.media_source})`;
    if (seen.has(name.toLowerCase())) {
      collisionsSkipped++;
      continue;
    }
    seen.add(name.toLowerCase());
    result.push({ name });
  }
  return { result, collisionsSkipped };
}

function importIntoList(guildId, listName, category, characters) {
  let list = getListByName(guildId, listName);
  let created = false;
  if (!list) {
    const id = createList(guildId, listName, 'seed-script', category);
    list = { id };
    created = true;
  }
  const existingNames = new Set(getCharacters(list.id).map((c) => c.name.toLowerCase()));
  let added = 0;
  let skipped = 0;
  for (const { name } of characters) {
    if (existingNames.has(name.toLowerCase())) {
      skipped++;
      continue;
    }
    try {
      addCharacter(list.id, name, 'seed-script');
      added++;
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') skipped++;
      else throw err;
    }
  }
  return { created, added, skipped };
}

function groupByMediaType(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.media_type)) groups.set(row.media_type, []);
    groups.get(row.media_type).push(row);
  }
  return groups;
}

// Union-find over distinct media_source strings: merges "X (Publisher)" -> Publisher, and
// word-boundary prefix chains among non-parenthetical sources (so "Digimon Adventure 02"
// collapses all the way to "Digimon", not just to "Digimon Adventure"). The two signals are
// kept deliberately separate -- letting a parenthetical tag ALSO participate in prefix
// matching is what caused bare "Aladdin" (a non-Disney folklore entry) to get swept into the
// "Disney" bucket alongside "Aladdin (Disney)" during testing.
function buildFranchiseRoots(rows) {
  const sourceSet = new Set(rows.map((r) => r.media_source));
  const sources = [...sourceSet];
  const parent = new Map(sources.map((s) => [s, s]));
  const ensure = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const find = (x) => {
    ensure(x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    ensure(a);
    ensure(b);
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra.length < rb.length || (ra.length === rb.length && ra < rb)) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  const PAREN_RE = /^(.+) \(([^)]+)\)$/;
  const parenSources = sources.filter((s) => PAREN_RE.test(s));
  const plainSources = sources.filter((s) => !PAREN_RE.test(s));

  for (const s of parenSources) {
    const m = s.match(PAREN_RE);
    union(s, m[2]);
  }
  for (const s of plainSources) {
    for (const candidate of plainSources) {
      if (candidate === s || candidate.length >= s.length) continue;
      if (s.startsWith(candidate) && ' :-'.includes(s[candidate.length])) union(s, candidate);
    }
  }

  const sourceToRoot = new Map();
  for (const s of sources) {
    const root = find(s);
    sourceToRoot.set(s, EXCLUDE_FRANCHISE_ROOTS.has(root) || YEAR_LIKE_ROOT.test(root) ? null : root);
  }
  return sourceToRoot;
}

function mostCommonMediaType(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.media_type, (counts.get(r.media_type) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function main() {
  const guildId = process.argv[2];
  if (!guildId) {
    console.error('Usage: node scripts/seed-character-codex.js <guildId>');
    console.error(
      "Find your server's ID: enable Developer Mode (User Settings > Advanced Settings > Developer Mode), " +
        'then right-click the server icon > Copy Server ID.'
    );
    process.exit(1);
  }

  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'character-codex.json'), 'utf8'));

  console.log('--- Category lists ---');
  const byMediaType = groupByMediaType(rows);
  let categoryAdded = 0;
  let categorySkipped = 0;
  for (const [category, groupRows] of [...byMediaType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { result: characters, collisionsSkipped } = dedupeNamesWithinGroup(groupRows);
    const { created, added, skipped } = importIntoList(guildId, category, category, characters);
    if (created) console.log(`Created list "${category}".`);
    console.log(`  ${category}: added ${added}, skipped ${skipped} already present.${collisionsSkipped ? ` (${collisionsSkipped} collisions skipped)` : ''}`);
    categoryAdded += added;
    categorySkipped += skipped;
  }

  console.log('\n--- Franchise lists (additive) ---');
  const sourceToRoot = buildFranchiseRoots(rows);
  const rowsByFranchise = new Map();
  for (const row of rows) {
    const franchise = sourceToRoot.get(row.media_source);
    if (!franchise) continue;
    if (!rowsByFranchise.has(franchise)) rowsByFranchise.set(franchise, []);
    rowsByFranchise.get(franchise).push(row);
  }

  let franchiseCount = 0;
  let franchiseAdded = 0;
  let franchiseSkipped = 0;
  for (const [franchise, franchiseRows] of [...rowsByFranchise.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (franchiseRows.length < FRANCHISE_MIN_CHARACTERS) continue;
    const { result: characters, collisionsSkipped } = dedupeNamesWithinGroup(franchiseRows);
    if (characters.length < FRANCHISE_MIN_CHARACTERS) continue;

    const category = mostCommonMediaType(franchiseRows);
    const { created, added, skipped } = importIntoList(guildId, franchise, category, characters);
    if (created) console.log(`Created franchise list "${franchise}" (category: ${category}).`);
    console.log(`  ${franchise}: added ${added}, skipped ${skipped} already present.${collisionsSkipped ? ` (${collisionsSkipped} collisions skipped)` : ''}`);
    franchiseCount++;
    franchiseAdded += added;
    franchiseSkipped += skipped;
  }

  console.log(
    `\nDone. Categories: added ${categoryAdded}, skipped ${categorySkipped}. ` +
      `Franchises: ${franchiseCount} lists, added ${franchiseAdded}, skipped ${franchiseSkipped}.`
  );
}

main();
