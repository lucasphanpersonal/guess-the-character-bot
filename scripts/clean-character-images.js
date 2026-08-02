// Applies the image trust rule (src/util/characterImages.js) to a database that was seeded
// before it existed, so nobody has to re-import 43,000 characters to stop seeing Kiefer
// Sutherland captioned as a cartoon character.
//
// Clearing image_url only -- the character stays, and a later seed run will not put the
// image back, because the seeder now applies the same rule.
//
//   node scripts/clean-character-images.js <guildId> [--dry-run]

const db = require('../src/db/connection');
const { imageIsTrustworthy } = require('../src/util/characterImages');

function main() {
  const args = process.argv.slice(2);
  const guildId = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!guildId) {
    console.error('Usage: node scripts/clean-character-images.js <guildId> [--dry-run]');
    process.exit(1);
  }

  const rows = db
    .prepare(
      `SELECT ch.id, ch.name, ch.image_url, l.category
         FROM characters ch
         JOIN character_lists l ON l.id = ch.list_id
        WHERE l.guild_id = ? AND ch.image_url IS NOT NULL`
    )
    .all(guildId);

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
