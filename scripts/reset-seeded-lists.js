// Removes every list this repo's seed scripts created in the shared compendium, so the character
// bank can be rebuilt from a chosen set of sources.
//
// WHY THIS EXISTS
// The Character Codex was the original bulk source and turned out to be a poor fit: it
// carries categories nobody would play with (Blogs, Magazines, Scientific Papers, Research
// Journals, Biographies), files authors as characters (Eiichiro Oda under One Piece), and
// duplicates the same character under several spellings ("Luffy", "Luffy D. Monkey",
// "Monkey D. Luffy"). Dropping it is the fix, but it cannot be done surgically: character
// rows do not record which script inserted them, and seed-wikidata deliberately merges into
// any list whose name already matches, so hundreds of lists hold rows from two sources.
//
// So the honest way to drop one source is to clear everything the seeders own and re-run
// the ones being kept. Lists created by a person -- anything whose created_by is not
// 'seed-script' -- are left completely alone, and so is every scope's private list.
//
// Deleting a list cascades to its characters and to every scope's selection of it
// (src/compendium/schema.sql, ON DELETE CASCADE) -- so this also empties those lists out of every selection.
//
// Usage:
//   node scripts/reset-seeded-lists.js            # dry run, shows what would go
//   node scripts/reset-seeded-lists.js --yes      # actually delete

const db = require('../src/compendium/db');
const { scriptArgs } = require('./lib/compendiumArgs');

const SEED_AUTHOR = 'seed-script';

function summarise() {
  const lists = db
    .prepare(
      `SELECT cl.id, cl.name, cl.category, cl.created_by, COUNT(ch.id) AS characters
         FROM character_lists cl
         LEFT JOIN characters ch ON ch.list_id = cl.id
        WHERE cl.owner_scope IS NULL
        GROUP BY cl.id`
    )
    .all();

  const seeded = lists.filter((l) => l.created_by === SEED_AUTHOR);
  const kept = lists.filter((l) => l.created_by !== SEED_AUTHOR);

  // Characters a person added to a seeded list would be lost with it, so they are counted
  // out loud rather than discovered afterwards.
  const handAdded = db
    .prepare(
      `SELECT COUNT(*) AS n FROM characters ch
         JOIN character_lists cl ON cl.id = ch.list_id
        WHERE cl.owner_scope IS NULL AND cl.created_by = ? AND ch.added_by <> ?`
    )
    .get(SEED_AUTHOR, SEED_AUTHOR).n;

  return { lists, seeded, kept, handAdded };
}

function main() {
  const confirmed = scriptArgs().includes('--yes');

  const { seeded, kept, handAdded } = summarise();
  const characters = seeded.reduce((sum, l) => sum + l.characters, 0);

  const byCategory = new Map();
  for (const l of seeded) {
    const key = l.category || 'Uncategorized';
    byCategory.set(key, (byCategory.get(key) || 0) + 1);
  }

  console.log('Shared compendium');
  console.log(`  seed-created lists to remove: ${seeded.length} (${characters} character rows)`);
  for (const [category, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(n).padStart(5)}  ${category}`);
  }
  console.log(`  human-created lists kept:     ${kept.length}`);
  if (handAdded) {
    console.log(`  !! ${handAdded} character(s) added by hand to seeded lists WOULD BE LOST`);
  }

  if (!confirmed) {
    console.log('\nDry run -- nothing deleted. Re-run with --yes to proceed.');
    return;
  }

  const remove = db.prepare('DELETE FROM character_lists WHERE id = ?');
  const run = db.transaction(() => {
    for (const l of seeded) remove.run(l.id);
  });
  run();

  const remaining = db.prepare('SELECT COUNT(*) AS n FROM character_lists WHERE owner_scope IS NULL').get().n;
  console.log(`\nDeleted ${seeded.length} list(s). ${remaining} shared list(s) remain.`);
}

module.exports = { summarise, SEED_AUTHOR };

if (require.main === module) main();
