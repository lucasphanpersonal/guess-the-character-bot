// Renames the AniList characters already in the database to the names the importer now gives
// them (scripts/lib/anilistNames.js): "Gojou Satoru" -> "Satoru Gojo", "Spiegel Spike" -> "Spike
// Spiegel". Seeding only ever ADDS what is missing, so without this a re-seed would put
// "Satoru Gojo" next to "Gojou Satoru" rather than replace him.
//
//   node scripts/rename-anilist-characters.js                  # report only: writes the CSV
//   node scripts/rename-anilist-characters.js --apply          # rename, writing an undo log first
//   node scripts/rename-anilist-characters.js --undo=data/anilist-renames-<timestamp>.json
//
// It needs data/seed/anilist-characters.json fetched with the raw name parts (run
// `npm run fetch:anilist` once; it re-fetches any series that lacks them). A character whose
// series still lacks them is left alone and counted.
//
// FINDING THE ROW. The old importer stored the surname-first form, which the stored parts let us
// recompute exactly. A row is matched by that old name AND its AniList image URL, which is per
// character, so two different characters who happen to share an old name in different shows can
// never be confused. Where the image no longer matches (the art changed since seeding), a row
// in an Anime or Manga list is still matched by name alone -- but only when that old name means
// the same new name everywhere in the file, so the fallback cannot guess between two people.
//
// A rename that would collide with a name already in the same list (two seasons merged under two
// spellings) is skipped and reported, never forced: the list's UNIQUE(list_id, name) is what
// keeps one character from being dealt twice.

const fs = require('fs');
const path = require('path');
const { surnameFirstName, englishName, looksOrderSwapped } = require('./lib/anilistNames');
const { writeFileAtomic } = require('./lib/writeAtomic');

const SEED_PATH = path.join(__dirname, '..', 'data', 'seed', 'anilist-characters.json');
const NAME_ONLY_CATEGORIES = new Set(['Anime', 'Manga']);

/**
 * Works out every rename without touching anything.
 * Returns { renames: [{ id, listId, list, category, from, to, matchedBy }], skipped: {...} }.
 */
function planRenames(db, series) {
  const byImage = new Map(); // `${oldName}\u0000${image}` -> new name
  const byOldName = new Map(); // lowercased old name -> Set of new names
  let withoutParts = 0;

  for (const s of Object.values(series)) {
    for (const c of s.characters || []) {
      if (!c.parts) {
        withoutParts++;
        continue;
      }
      const from = surnameFirstName(c.parts);
      // The new name is worked out HERE, from the stored parts, with today's rules -- not read
      // from c.name, which the fetch computed with whatever rules it had. Reading c.name meant a
      // naming fix did nothing until the next multi-hour re-fetch, and the report silently showed
      // the old misfires after the fix had merged.
      const to = englishName(c.parts, [s.label, s.romaji]);
      // A name that stays the same is still recorded: it is what makes an old name that ONE
      // PIECE keeps and another show changes ambiguous, rather than a rename for both.
      if (!from) continue;
      if (c.image) byImage.set(`${from.toLowerCase()}\u0000${c.image}`, to);
      const key = from.toLowerCase();
      if (!byOldName.has(key)) byOldName.set(key, new Set());
      byOldName.get(key).add(to);
    }
  }

  const rows = db
    .prepare(
      `SELECT ch.id, ch.list_id AS listId, ch.name, ch.image_url, l.name AS list, l.category
         FROM characters ch JOIN character_lists l ON l.id = ch.list_id`
    )
    .all();
  const namesInList = new Map();
  for (const r of rows) {
    if (!namesInList.has(r.listId)) namesInList.set(r.listId, new Set());
    namesInList.get(r.listId).add(r.name.toLowerCase());
  }

  const renames = [];
  const skipped = { collision: [], ambiguous: 0, withoutParts };
  for (const r of rows) {
    const key = r.name.toLowerCase();
    let to = r.image_url ? byImage.get(`${key}\u0000${r.image_url}`) : undefined;
    let matchedBy = 'image';
    if (!to && NAME_ONLY_CATEGORIES.has(r.category) && byOldName.has(key)) {
      const candidates = byOldName.get(key);
      if (candidates.size === 1) {
        [to] = candidates;
        matchedBy = 'name';
      } else {
        skipped.ambiguous++;
      }
    }
    if (!to || to === r.name) continue;

    const taken = namesInList.get(r.listId);
    // A case-only change ("Ichigo kurosaki" -> "Ichigo Kurosaki") is the same row, not a collision.
    if (to.toLowerCase() !== key && taken.has(to.toLowerCase())) {
      skipped.collision.push({ list: r.list, from: r.name, to });
      continue;
    }
    taken.delete(key);
    taken.add(to.toLowerCase());
    renames.push({ id: r.id, listId: r.listId, list: r.list, category: r.category, from: r.name, to, matchedBy });
  }
  return { renames, skipped };
}

function applyRenames(db, renames) {
  const rename = db.prepare('UPDATE characters SET name = ? WHERE id = ? AND name = ?');
  let changed = 0;
  db.transaction(() => {
    for (const r of renames) changed += rename.run(r.to, r.id, r.from).changes;
  })();
  return changed;
}

/** Puts names back from an undo log, but only on rows still carrying the name this script gave. */
function undoRenames(db, renames) {
  const back = db.prepare('UPDATE characters SET name = ? WHERE id = ? AND name = ?');
  let changed = 0;
  db.transaction(() => {
    for (const r of renames) changed += back.run(r.from, r.id, r.to).changes;
  })();
  return changed;
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function main() {
  const db = require('../src/compendium/db');
  const args = require('./lib/compendiumArgs').scriptArgs();
  const dataDir = path.join(__dirname, '..', 'data');

  const undoFile = args.find((a) => a.startsWith('--undo='))?.slice('--undo='.length);
  if (undoFile) {
    const renames = JSON.parse(fs.readFileSync(undoFile, 'utf8'));
    console.log(`Restored ${undoRenames(db, renames)} of ${renames.length} name(s) from ${undoFile}.`);
    return;
  }

  const { series } = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const { renames, skipped } = planRenames(db, series);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const csvPath = path.join(dataDir, `anilist-renames-${stamp}.csv`);
  // check_order marks a rename shaped like a character whose AniList parts are swapped; read those.
  const lines = ['list,category,from,to,matched_by,check_order'];
  for (const r of [...renames].sort((a, b) => a.list.localeCompare(b.list) || a.from.localeCompare(b.from))) {
    lines.push([r.list, r.category, r.from, r.to, r.matchedBy, looksOrderSwapped(r.from) ? 'yes' : ''].map(csvCell).join(','));
  }
  writeFileAtomic(csvPath, `${lines.join('\n')}\n`);

  const byImage = renames.filter((r) => r.matchedBy === 'image').length;
  console.log(`${renames.length} rename(s): ${byImage} matched by image, ${renames.length - byImage} by name alone.`);
  console.log(`Skipped: ${skipped.collision.length} that would collide with a name already in the list, ` +
    `${skipped.ambiguous} whose old name means different characters, ` +
    `${skipped.withoutParts} character(s) in the seed file without name parts (re-run fetch:anilist).`);
  for (const r of renames.slice(0, 8)) console.log(`  e.g. ${r.from} -> ${r.to}  (${r.list})`);
  for (const c of skipped.collision.slice(0, 5)) console.log(`  collision: ${c.from} -> ${c.to}  (${c.list})`);
  console.log(`Report: ${csvPath}`);
  console.log(`${renames.filter((r) => looksOrderSwapped(r.from)).length} row(s) flagged check_order=yes: ` +
    'the old first word looks like a Japanese given name, so AniList may have the parts swapped.');
  console.log('Read it before --apply: look for English words the long-vowel rule folded by mistake ' +
    '(add them to FOLD_EXCEPTIONS in scripts/lib/anilistNames.js).');

  if (!args.includes('--apply')) {
    console.log('\nReport only: nothing was changed. Re-run with --apply to rename.');
    return;
  }
  const log = path.join(dataDir, `anilist-renames-${stamp}.json`);
  writeFileAtomic(log, `${JSON.stringify(renames.map(({ id, from, to }) => ({ id, from, to })))}\n`);
  console.log(`Undo log: ${log}`);
  console.log(`Renamed ${applyRenames(db, renames)} character(s).`);
}

module.exports = { planRenames, applyRenames, undoRenames };

if (require.main === module) main();
