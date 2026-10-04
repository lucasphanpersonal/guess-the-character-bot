// Applies the image trust rule (src/compendium/characterImages.js) to a database that was seeded
// before it existed, so nobody has to re-import 43,000 characters to stop seeing Kiefer
// Sutherland captioned as a cartoon character.
//
// Clearing image_url only -- the character stays, and a later seed run will not put the
// image back, because the seeder now applies the same rule.
//
//   node scripts/clean-character-images.js [--dry-run]
//
// Every list in the database, shared or private: the rule is about the medium, not about who
// plays the list.

const db = require('../src/compendium/db');
const { imageIsTrustworthy } = require('../src/compendium/characterImages');
const { scriptArgs } = require('./lib/compendiumArgs');

function main() {
  const dryRun = scriptArgs().includes('--dry-run');

  const rows = db
    .prepare(
      `SELECT ch.id, ch.name, ch.image_url, l.category
         FROM characters ch
         JOIN character_lists l ON l.id = ch.list_id
        WHERE ch.image_url IS NOT NULL`
    )
    .all();

  const doomed = rows.filter((r) => !imageIsTrustworthy(r.category, r.image_url));
  const byCategory = {};
  for (const r of doomed) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;

  console.log(`${rows.length} characters have an image; ${doomed.length} of them can't be trusted.`);
  for (const [category, n] of Object.entries(byCategory)) console.log(`  ${category}: ${n}`);
  for (const r of doomed.slice(0, 5)) {
    console.log(`  e.g. ${r.name} -> ${decodeURIComponent(r.image_url.split('/').pop())}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing was changed.');
    return;
  }

  const clear = db.prepare('UPDATE characters SET image_url = NULL WHERE id = ?');
  const clearAll = db.transaction((list) => {
    for (const r of list) clear.run(r.id);
  });
  clearAll(doomed);
  console.log(`\nCleared ${doomed.length} image(s).`);
}

if (require.main === module) main();
