// Gives difficulty something to work with on lists that arrived without fame scores.
//
//   node scripts/backfill-fame-from-order.js --dry-run
//   node scripts/backfill-fame-from-order.js
//
// `applyDifficulty` cuts each cast by fame, and deliberately passes a list through UNTOUCHED
// when it has no fame data at all ("unranked is not the same as unpopular"). That is the right
// rule, but it left 200 enabled lists -- 4,274 characters, Pokemon and most of Video Games among
// them -- dealt in full at every difficulty. Easy was not easy for any of them.
//
// The fix does not invent popularity. Every bulk seeder INSERTS IN RANKED ORDER already: AniList
// by favourites, Wikidata by sitelink count, PokeAPI by Pokedex number. That ordering survives in
// the row ids, it just was never written down as a score. Measured across 188 lists that DO have
// fame, insertion order agrees with fame rank at a mean Spearman correlation of 0.92-1.00, with
// 180 of them near-perfect -- so reading rank back out of the row order is recovering a signal
// that is already there, not guessing.
//
// Only rows added by `seed-script` are touched. Characters added by hand through Discord have no
// meaningful insertion order, and this script's own sibling (seed-wiki-characters.js) inserts
// alphabetically, which would produce a confidently wrong ranking. Both are skipped, and a list
// is only backfilled when EVERY row in it qualifies.

const db = require('../src/core/db/connection');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const SEEDER = 'seed-script';

function main() {
  // Lists with no fame at all, where every row came from a ranked-order seeder.
  const lists = db
    .prepare(
      `SELECT cl.id, cl.name, cl.category, cl.enabled, COUNT(c.id) AS n
         FROM character_lists cl
         JOIN characters c ON c.list_id = cl.id
        GROUP BY cl.id
       HAVING COUNT(c.fame) = 0
          AND COUNT(*) = SUM(CASE WHEN c.added_by = ? THEN 1 ELSE 0 END)
        ORDER BY cl.enabled DESC, n DESC`
    )
    .all(SEEDER);

  const skipped = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT cl.id FROM character_lists cl JOIN characters c ON c.list_id = cl.id
          GROUP BY cl.id
         HAVING COUNT(c.fame) = 0 AND COUNT(*) <> SUM(CASE WHEN c.added_by = ? THEN 1 ELSE 0 END))`
    )
    .get(SEEDER).n;

  console.log(`${lists.length} fameless list(s) eligible; ${skipped} skipped (hand-added or alphabetically seeded)\n`);

  // Descending so the first-inserted character scores highest. The absolute numbers are
  // meaningless across lists -- applyDifficulty only ever compares within one cast -- so a plain
  // ordinal is the honest representation.
  const rowsOf = db.prepare('SELECT id FROM characters WHERE list_id = ? ORDER BY id');
  const setFame = db.prepare('UPDATE characters SET fame = ? WHERE id = ?');
  const apply = db.transaction((list) => {
    const rows = rowsOf.all(list.id);
    rows.forEach((r, i) => setFame.run(rows.length - i, r.id));
    return rows.length;
  });

  let lists_ = 0;
  let chars = 0;
  for (const list of lists) {
    lists_++;
    chars += list.n;
    if (verbose || list.n > 100) console.log(`  ${list.enabled ? '*' : ' '} ${list.name} (${list.category}) — ${list.n}`);
    if (!dryRun) apply(list);
  }

  console.log('\n--- summary ---');
  console.log(`  lists ${dryRun ? 'that would be' : ''} ranked: ${lists_}`);
  console.log(`  characters:               ${chars}`);
  console.log(`  skipped lists:            ${skipped}  (untouched on purpose)`);
  if (dryRun) console.log('  written:                  0  (dry run)');
  console.log('\n  ( * = in the playable selection )');
}

main();
