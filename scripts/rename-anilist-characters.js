// Renames the AniList characters already in the database to the names the importer now gives
// them (scripts/lib/anilistNames.js): "Gojou Satoru" -> "Satoru Gojo", "Spiegel Spike" -> "Spike
// Spiegel". Seeding only ever ADDS what is missing, so without this a re-seed would put
// "Satoru Gojo" next to "Gojou Satoru" rather than replace him.
//
//   node scripts/rename-anilist-characters.js                  # report only: writes the CSV
//   node scripts/rename-anilist-characters.js --apply          # rename, writing an undo log first
//   node scripts/rename-anilist-characters.js --apply --merge-duplicates   # also fold duplicate collisions (see below)
//   node scripts/rename-anilist-characters.js --undo=data/anilist-renames-<timestamp>.json
//
// It can be run again after the rules change: rows are found by every spelling a character's name
// has had (looseKey), so a pass finds what the previous pass renamed.
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
// keeps one character from being dealt twice. When the row already holding the name is the same
// character (no art, art that is no AniList character's, or art only that character uses), it is a
// duplicate, and --merge-duplicates folds the two: the kept row takes the other's picture, fame,
// rerolls and past games, and the other is deleted, all recorded in the undo log first.

const fs = require('fs');
const path = require('path');
const { surnameFirstName, givenFirstName, englishName, looksOrderSwapped, looseKey } = require('./lib/anilistNames');
const { writeFileAtomic } = require('./lib/writeAtomic');

const SEED_PATH = path.join(__dirname, '..', 'data', 'seed', 'anilist-characters.json');
const NAME_ONLY_CATEGORIES = new Set(['Anime', 'Manga']);

// Every name a row for this character can carry now: the old importer's surname-first form, the
// given-first form, and each without the middle name (AniList adds middle names after the fact:
// Kyouraku's two). Compared by looseKey, so a row an earlier pass renamed with older rules
// ("Tooru Oikawa", "Shouei Baro") is found again by the next one.
function oldForms(parts) {
  const first = (parts.first || '').trim();
  const last = (parts.last || '').trim();
  const forms = [surnameFirstName(parts), givenFirstName(parts)];
  if (first && last) forms.push(`${last} ${first}`, `${first} ${last}`);
  // AniList files middle names inside `first` and changes them (the live rows say "Kyouraku Jirou
  // Souzousa Shunsui", today's parts "Jirou Sakuranosuke Shunsui"), so the surname and the last
  // word of `first` are a form too; a row is tried by its own first and last words to match it.
  const given = first.split(/\s+/).pop();
  if (given && last && given !== first) forms.push(`${last} ${given}`, `${given} ${last}`);
  return [...new Set(forms.filter(Boolean).map(looseKey))];
}

/**
 * Works out every rename without touching anything.
 * Returns { renames: [{ id, listId, list, category, from, to, matchedBy }], skipped: {...} }.
 * skipped.collision rows carry the id of the row already holding the name (keepId), and
 * duplicate: true when that row is the same character, so mergeDuplicates may fold them.
 */
function planRenames(db, series) {
  const byImage = new Map(); // `${looseKey(old form)}\u0000${image}` -> Set of new names
  const byOldName = new Map(); // looseKey(old form) -> Set of new names
  // image -> { who: Set of AniList characters, to: Set of new names }. An image is evidence of
  // WHO a row is only when one character uses it: AniList's placeholder (default.jpg) is shared
  // by 1,813 characters, among them INUYASHIKI's Joshi and Joushi, two people whose names now
  // fold together.
  const imageUsers = new Map();
  let withoutParts = 0;

  for (const [seriesKey, s] of Object.entries(series)) {
    for (const [i, c] of (s.characters || []).entries()) {
      if (!c.parts) {
        withoutParts++;
        continue;
      }
      // The new name is worked out HERE, from the stored parts, with today's rules -- not read
      // from c.name, which the fetch computed with whatever rules it had. Reading c.name meant a
      // naming fix did nothing until the next multi-hour re-fetch, and the report silently showed
      // the old misfires after the fix had merged.
      const to = englishName(c.parts, [s.label, s.romaji]);
      if (c.image) {
        if (!imageUsers.has(c.image)) imageUsers.set(c.image, { who: new Set(), to: new Set() });
        imageUsers.get(c.image).who.add(c.id ?? `${seriesKey}:${i}`);
        imageUsers.get(c.image).to.add(to);
      }
      // A name that stays the same is still recorded: it is what makes an old name that ONE
      // PIECE keeps and another show changes ambiguous, rather than a rename for both.
      for (const key of oldForms(c.parts)) {
        const imageKey = `${key}\u0000${c.image}`;
        if (c.image && !byImage.has(imageKey)) byImage.set(imageKey, new Set());
        if (c.image) byImage.get(imageKey).add(to);
        if (!byOldName.has(key)) byOldName.set(key, new Set());
        byOldName.get(key).add(to);
      }
    }
  }

  const rows = db
    .prepare(
      `SELECT ch.id, ch.list_id AS listId, ch.name, ch.image_url, l.name AS list, l.category
         FROM characters ch JOIN character_lists l ON l.id = ch.list_id`
    )
    .all();
  const namesInList = new Map(); // listId -> Map(lowercased name -> row)
  for (const r of rows) {
    if (!namesInList.has(r.listId)) namesInList.set(r.listId, new Map());
    namesInList.get(r.listId).set(r.name.toLowerCase(), r);
  }

  const renames = [];
  const skipped = { collision: [], ambiguous: 0, withoutParts };
  for (const r of rows) {
    const words = r.name.trim().split(/\s+/);
    const shortKey = words.length > 2 ? looseKey(`${words[0]} ${words[words.length - 1]}`) : null;
    let key = looseKey(r.name);
    // Two characters on one shared image whose old names fold alike would be a guess: no match.
    const imageMatch = (k) => {
      const hit = r.image_url ? byImage.get(`${k}\u0000${r.image_url}`) : undefined;
      return hit?.size === 1 ? [...hit][0] : undefined;
    };
    let to = imageMatch(key) ?? (shortKey ? imageMatch(shortKey) : undefined);
    let matchedBy = 'image';
    if (!to && shortKey && !byOldName.has(key) && byOldName.has(shortKey)) key = shortKey;
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
    const holder = taken.get(to.toLowerCase());
    // A case-only change ("Ichigo kurosaki" -> "Ichigo Kurosaki") is the same row, not a collision.
    if (holder && holder.id !== r.id) {
      // Merged only on evidence it is the same character: no art, art that is no AniList
      // character's, or art that belongs to exactly one AniList character and that character is
      // this one. Two people whose names fold together (Yuuki and Yuki, Joushi and Joshi) must
      // never be merged, so shared art (the placeholder) is no evidence and leaves the pair alone.
      const users = holder.image_url && imageUsers.get(holder.image_url);
      const duplicate = !holder.image_url || !users || (users.who.size === 1 && users.to.has(to));
      skipped.collision.push({ id: r.id, keepId: holder.id, list: r.list, from: r.name, to, duplicate });
      continue;
    }
    taken.delete(r.name.toLowerCase());
    taken.set(to.toLowerCase(), r);
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

/**
 * Folds each duplicate collision into the row that already has the new name: the kept row takes
 * the duplicate's picture and fame where it has none, its rerolls and its place in past games,
 * and the duplicate is deleted. Returns an undo record per merge, written to the undo log FIRST.
 */
function planMerges(db, collisions) {
  // A row that is one merge's keeper and another's duplicate would take the first merge's games
  // and rerolls and then be deleted with them. Three spellings of one character; left for a person.
  const goneIds = new Set(collisions.filter((c) => c.duplicate).map((c) => c.id));
  const row = db.prepare('SELECT * FROM characters WHERE id = ?');
  const keptRerollUsers = db.prepare('SELECT user_id FROM character_rerolls WHERE character_id = ?');
  const hasGames = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'game_players'").get();
  const rerolls = db.prepare('SELECT * FROM character_rerolls WHERE character_id = ?');
  const games = hasGames ? db.prepare('SELECT rowid AS rowid FROM game_players WHERE character_id = ?') : null;
  return collisions
    .filter((c) => c.duplicate && !goneIds.has(c.keepId))
    .map((c) => {
      const gone = row.get(c.id);
      const kept = row.get(c.keepId);
      if (!gone || !kept) return null;
      return {
        gone,
        keepId: kept.id,
        filled: {
          image_url: kept.image_url == null && gone.image_url != null ? gone.image_url : undefined,
          fame: kept.fame == null && gone.fame != null ? gone.fame : undefined,
        },
        // All of the duplicate's rerolls, to put back on undo (deleting the row cascades them),
        // and the users among them that MOVE: those with no reroll on the kept row already.
        // UNIQUE(character_id, user_id) means the others stay where they are, and undo must not
        // take the kept row's own reroll away.
        rerolls: rerolls.all(gone.id),
        movedRerollUsers: (() => {
          const kept = new Set(keptRerollUsers.all(c.keepId).map((r) => r.user_id));
          return rerolls.all(gone.id).map((r) => r.user_id).filter((u) => !kept.has(u));
        })(),
        gameRowids: games ? games.all(gone.id).map((g) => g.rowid) : [],
      };
    })
    .filter(Boolean);
}

function applyMerges(db, merges) {
  const fill = (col) => db.prepare(`UPDATE characters SET ${col} = ? WHERE id = ? AND ${col} IS NULL`);
  const fillImage = fill('image_url');
  const fillFame = fill('fame');
  const moveReroll = db.prepare('INSERT OR IGNORE INTO character_rerolls (character_id, user_id, created_at) VALUES (?, ?, ?)');
  const moveGame = merges.some((m) => m.gameRowids.length)
    ? db.prepare('UPDATE game_players SET character_id = ? WHERE rowid = ?')
    : null;
  const remove = db.prepare('DELETE FROM characters WHERE id = ? AND name = ?');
  let changed = 0;
  db.transaction(() => {
    for (const m of merges) {
      if (m.filled.image_url !== undefined) fillImage.run(m.filled.image_url, m.keepId);
      if (m.filled.fame !== undefined) fillFame.run(m.filled.fame, m.keepId);
      const moving = new Set(m.movedRerollUsers);
      for (const r of m.rerolls) if (moving.has(r.user_id)) moveReroll.run(m.keepId, r.user_id, r.created_at);
      for (const rowid of m.gameRowids) moveGame.run(m.keepId, rowid);
      changed += remove.run(m.gone.id, m.gone.name).changes;
    }
  })();
  return changed;
}

/** Puts merged duplicates back exactly: the row (same id), its rerolls, its games, and the kept row's fields. */
function undoMerges(db, merges) {
  const cols = merges.length ? Object.keys(merges[0].gone) : [];
  const insert = cols.length
    ? db.prepare(`INSERT OR IGNORE INTO characters (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    : null;
  const reroll = db.prepare('INSERT OR IGNORE INTO character_rerolls (id, character_id, user_id, created_at) VALUES (?, ?, ?, ?)');
  const dropMoved = db.prepare('DELETE FROM character_rerolls WHERE character_id = ? AND user_id = ?');
  const unfill = (col) => db.prepare(`UPDATE characters SET ${col} = NULL WHERE id = ? AND ${col} = ?`);
  const unfillImage = unfill('image_url');
  const unfillFame = unfill('fame');
  const game = merges.some((m) => m.gameRowids.length) ? db.prepare('UPDATE game_players SET character_id = ? WHERE rowid = ?') : null;
  let changed = 0;
  db.transaction(() => {
    for (const m of merges) {
      changed += insert.run(...cols.map((c) => m.gone[c])).changes;
      for (const user of m.movedRerollUsers) dropMoved.run(m.keepId, user);
      for (const r of m.rerolls) reroll.run(r.id, r.character_id, r.user_id, r.created_at);
      for (const rowid of m.gameRowids) game.run(m.gone.id, rowid);
      if (m.filled.image_url !== undefined) unfillImage.run(m.keepId, m.filled.image_url);
      if (m.filled.fame !== undefined) unfillFame.run(m.keepId, m.filled.fame);
    }
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
    const log = JSON.parse(fs.readFileSync(undoFile, 'utf8'));
    // The first logs were a bare array of renames; later ones carry merges too.
    const { renames, merges = [] } = Array.isArray(log) ? { renames: log } : log;
    console.log(`Restored ${undoMerges(db, merges)} of ${merges.length} merged duplicate(s), ` +
      `then ${undoRenames(db, renames)} of ${renames.length} name(s), from ${undoFile}.`);
    return;
  }

  const { series } = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const { renames, skipped } = planRenames(db, series);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const csvPath = path.join(dataDir, `anilist-renames-${stamp}.csv`);
  // check_order marks a rename shaped like a character whose AniList parts are swapped; read those.
  const lines = ['list,category,from,to,matched_by,check_order'];
  // A collision is listed too: "duplicate" ones are merged by --merge-duplicates, "distinct" ones
  // are two characters whose names come out alike, and are left for a person.
  for (const r of [...renames].sort((a, b) => a.list.localeCompare(b.list) || a.from.localeCompare(b.from))) {
    lines.push([r.list, r.category, r.from, r.to, r.matchedBy, looksOrderSwapped(r.from) ? 'yes' : ''].map(csvCell).join(','));
  }
  for (const c of skipped.collision) {
    lines.push([c.list, '', c.from, c.to, c.duplicate ? 'duplicate' : 'distinct', ''].map(csvCell).join(','));
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

  const duplicates = skipped.collision.filter((c) => c.duplicate).length;
  console.log(`${duplicates} of the collisions are the same character twice; --merge-duplicates folds them together.`);

  const merging = args.includes('--merge-duplicates');
  // The collisions are worked out as if this run's renames happen, so merging without them
  // would act on a plan that is not what the database holds.
  if (merging && !args.includes('--apply')) {
    console.log('\n--merge-duplicates needs --apply alongside it: the collisions assume the renames.');
    return;
  }
  if (!args.includes('--apply')) {
    console.log('\nReport only: nothing was changed. Re-run with --apply to rename, and --merge-duplicates to merge.');
    return;
  }
  const doRenames = renames;
  const merges = merging ? planMerges(db, skipped.collision) : [];
  const chained = skipped.collision.filter((c) => c.duplicate).length - merges.length;
  if (merging && chained) console.log(`${chained} duplicate(s) left alone: one row would be kept by one merge and deleted by another.`);
  const log = path.join(dataDir, `anilist-renames-${stamp}.json`);
  writeFileAtomic(log, `${JSON.stringify({ renames: doRenames.map(({ id, from, to }) => ({ id, from, to })), merges })}\n`);
  console.log(`Undo log: ${log}`);
  if (doRenames.length) console.log(`Renamed ${applyRenames(db, doRenames)} character(s).`);
  if (merges.length) console.log(`Merged ${applyMerges(db, merges)} duplicate(s) into the row already carrying the name.`);
}

module.exports = { planRenames, applyRenames, undoRenames, planMerges, applyMerges, undoMerges };

if (require.main === module) main();
