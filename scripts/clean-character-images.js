// Applies the image trust rule (src/compendium/characterImages.js) to a database that was seeded
// before it existed, so nobody has to re-import 43,000 characters to stop seeing Kiefer
// Sutherland captioned as a cartoon character.
//
// Clearing image_url only -- the character stays, and a later seed run will not put the
// image back, because the seeder now applies the same rule. Afterwards, `npm run fetch:fandom`
// and `npm run fetch:tmdb` refill what they can, since both only touch characters with no image.
//
// Only Commons files are ever cleared. Images set by hand (the retired bot's /list image) from any other host
// (a game's press kit, a publisher's site) are left alone: the rule cannot vouch for them, but a
// person chose them on purpose. A hand-set COMMONS file on a fictional character is cleared like
// any other -- nothing records who set an image, so it cannot be told apart.
//
// Every cleared row is written to data/image-clean-<timestamp>.json BEFORE anything changes,
// because nothing else can bring these URLs back: the seeders now refuse them too. --undo puts
// back every row in a log whose image is still empty (one refilled since keeps its new art).
//
//   node scripts/clean-character-images.js [--dry-run]
//   node scripts/clean-character-images.js --undo=data/image-clean-<timestamp>.json
//
// Every list in the database, shared or private: the rule is about the medium, not about who
// plays the list.

const fs = require('fs');
const path = require('path');
const db = require('../src/compendium/db');
const { writeFileAtomic } = require('./lib/writeAtomic');
const { imageIsTrustworthy, isCommonsImage } = require('../src/compendium/characterImages');
const { scriptArgs } = require('./lib/compendiumArgs');

function undo(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const restore = db.prepare('UPDATE characters SET image_url = ? WHERE id = ? AND image_url IS NULL');
  let restored = 0;
  db.transaction(() => {
    for (const r of rows) restored += restore.run(r.image_url, r.id).changes;
  })();
  console.log(`Restored ${restored} of ${rows.length} image(s) from ${file}.`);
}

function main() {
  const args = scriptArgs();
  const undoFile = args.find((a) => a.startsWith('--undo='))?.slice('--undo='.length);
  if (undoFile) return undo(undoFile);
  const dryRun = args.includes('--dry-run');

  const rows = db
    .prepare(
      `SELECT ch.id, ch.name, ch.image_url, l.category, l.name AS list
         FROM characters ch
         JOIN character_lists l ON l.id = ch.list_id
        WHERE ch.image_url IS NOT NULL`
    )
    .all();

  const doomed = rows.filter((r) => isCommonsImage(r.image_url) && !imageIsTrustworthy(r.category, r.image_url));
  const byCategory = {};
  for (const r of doomed) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;

  console.log(`${rows.length} characters have an image; ${doomed.length} of them can't be trusted.`);
  for (const [category, n] of Object.entries(byCategory)) console.log(`  ${category}: ${n}`);
  // Per list too, so a list of REAL people filed outside "Real People" (whose photos are right)
  // shows up here before its photographs are cleared.
  const byList = {};
  for (const r of doomed) byList[`${r.category} / ${r.list}`] = (byList[`${r.category} / ${r.list}`] ?? 0) + 1;
  console.log('  by list:');
  for (const [list, n] of Object.entries(byList).sort((a, b) => b[1] - a[1])) console.log(`    ${n}  ${list}`);
  for (const r of doomed.slice(0, 5)) {
    console.log(`  e.g. ${r.name} -> ${decodeURIComponent(r.image_url.split('/').pop())}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing was changed.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = path.join(__dirname, '..', 'data', `image-clean-${stamp}.json`);
  const undoRows = doomed.map(({ id, name, category, list, image_url }) => ({ id, name, category, list, image_url }));
  writeFileAtomic(log, `${JSON.stringify(undoRows, null, 1)}\n`);
  console.log(`\nUndo log: ${log}`);

  const clear = db.prepare('UPDATE characters SET image_url = NULL WHERE id = ?');
  const clearAll = db.transaction((list) => {
    for (const r of list) clear.run(r.id);
  });
  clearAll(doomed);
  console.log(`\nCleared ${doomed.length} image(s).`);
}

if (require.main === module) main();
