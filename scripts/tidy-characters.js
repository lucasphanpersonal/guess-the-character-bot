// One-off tidy of the shared compendium, from a read-through of the live library (Nov 2026).
//
//   node scripts/tidy-characters.js                                  # report only
//   node scripts/tidy-characters.js --apply                          # change, writing an undo log first
//   node scripts/tidy-characters.js --apply --images-from=<file>     # also fill images (see below)
//   node scripts/tidy-characters.js --undo=data/tidy-<timestamp>.json
//
// Four kinds of change, each written out by hand below rather than found by a pattern, because
// every pattern tried matched things it must not touch:
//
// MERGES -- one character listed twice in one list ("Rin Tohsaka" and "Tohsaka Rin"). The judge
// already treats most of these as one answer (answers.js identityKeys), so this is tidying, not a
// fairness fix -- except the pairs found by a shared picture ("Tess" and "Tess Tyler"), which the
// judge does NOT fold, so both could be dealt in one game. Lookalikes that are two people stay:
// Hanako-kun's Akane Aoi and Aoi Akane are a boy and a girl, Nidoran♀/♂ and Zabimaru's halves are
// separate entries on purpose. Folded with the AniList rename script's own merge
// (planMerges/applyMerges), so the kept row takes the other's picture, fame, rerolls and past games.
//
// PAIRS -- two characters in one entry ("Shrek and Fiona"). Nobody can be dealt two people. A
// pair whose members are each already in the list is deleted; one whose members are missing is
// SPLIT into them, so Splatoon does not lose Callie and Marie. The new rows keep the pair's fame
// (it ranked them both) and get no picture: the pair's picture shows two people. Single
// characters with "and" in the name stay -- Nunu & Willump, Mr. Game & Watch, Zak and Wheezie
// (one two-headed dragon), Henry Jekyll & Hyde.
//
// CLEARED IMAGES -- a picture that is a placeholder, not the character.
//
// --images-from -- a JSON array of { id, list_id, name, image_url } to fill where a character
// still has none, applied only while the id, list and name all still agree and the URL is https.
// The fill scripts (fetch-fandom-images.js, fetch-tmdb-images.js) write straight to whatever
// database they open; they were run on a copy, and this carries their finds over, so the live
// database changes once, under one undo log, instead of over hours.
//
// Only shared lists (owner_scope IS NULL) are touched. Anything not found is reported, never
// guessed at.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./lib/writeAtomic');
const { planMerges, applyMerges, undoMerges } = require('./rename-anilist-characters');

// [list, keep, drop]: the kept name is the one a player would type.
const MERGES = [
  ['Big Hero 6', 'GoGo Tomago', 'Go Go Tomago'],
  ['Cars', 'Strip "The King" Weathers', 'Strip Weathers'],
  ['The Fairly OddParents', 'Crimson Chin', 'The Crimson Chin'],
  ['The Powerpuff Girls', 'Rowdyruff Boys', 'The Rowdyruff Boys'],
  ['WALL-E', 'WALL-E', 'WALL·E'],
  ['Black Butler', 'Ciel Phantomhive', '"Ciel Phantomhive"'],
  ['Fate/stay night', 'Rin Tohsaka', 'Tohsaka Rin'],
  ['Fate/stay night', 'Shinji Mato', 'Shinji Matō'],
  ['Sword Art Online', 'Asuna Yuki', 'Asuna Yūki'],
  ['Touhou Project', 'Koishi Komeiji', 'Komeiji Koishi'],
  ['Batman', 'Penguin', 'The Penguin'],
  ['Sonic the Hedgehog', 'Miles "Tails" Prower', 'Tails'],
  ['BlazBlue', 'Hades: Izanami', 'Hades Izanami'],
  ['Blue Archive', 'Aikiyo Fuuka', 'Aikiyo Fuuka (New Year ver.)'],
  ['Call of Duty', 'Simon "Ghost" Riley', 'Ghost'],
  ['Call of Duty', 'John "Soap" MacTavish', 'Soap MacTavish'],
  ['DmC: Devil May Cry', 'Dante', 'Dante (DmC)'],
  // Found by a shared picture: the judge does not fold these.
  ['Camp Rock', 'Tess Tyler', 'Tess'],
  ['Lucifer', 'Lucifer Morningstar', 'Lucifer'],
  ['Q-Force', 'Louisa Desk', 'Louisa'],
  ['Trolls', 'Poppy', 'Queen Poppy'],
  ['Zootopia', "Gary De'Snake", 'Gary'],
  ['Fabula Nova Crystallis Final Fantasy', 'Oerba Dia Vanille', 'Vanille'],
  ['Mario', 'Koopa Troopa', 'Koopa'],
  ['Street Fighter', 'Luke Sullivan', 'Luke'],
  ['Five Nights at Freddy\'s', 'Vanessa', 'Vanessa A.'],
  ['Guilty Gear', 'Jack-O Valentine', "Jack-O'"],
  ['Kunio-kun', 'Marian Kelly', 'Marian'],
  ['Star Wars', 'Mother Talzin', 'Talzin'],
];

// [list, pair name, [members]]. Members already in the list are left as they are.
const PAIRS = [
  ['Pokemon', 'Xerneas and Yveltal', ['Xerneas', 'Yveltal']],
  ["A Bug's Life", 'Tuck and Roll', ['Tuck', 'Roll']],
  ['DreamWorks Dragons', 'Hiccup Horrendous Haddock III and Astrid Hofferson', ['Hiccup Horrendous Haddock III', 'Astrid Hofferson']],
  ['How to Train Your Dragon', 'Hiccup Horrendous Haddock III and Astrid Hofferson', ['Hiccup Horrendous Haddock III', 'Astrid Hofferson']],
  ['How to Train Your Dragon 2', 'Hiccup Horrendous Haddock III and Astrid Hofferson', ['Hiccup Horrendous Haddock III', 'Astrid Hofferson']],
  ['How to Train Your Dragon: The Hidden World', 'Hiccup Horrendous Haddock III and Astrid Hofferson', ['Hiccup Horrendous Haddock III', 'Astrid Hofferson']],
  ['Gotham', 'Jerome and Jeremiah Valeska', ['Jerome Valeska', 'Jeremiah Valeska']],
  ['Looney Tunes', 'Babbit and Catstello', ['Babbit', 'Catstello']],
  ['Looney Tunes', 'Rocky and Mugsy', ['Rocky', 'Mugsy']],
  ...['Scared Shrekless', 'Shrek', 'Shrek 2', 'Shrek 4-D', 'Shrek 5', 'Shrek Forever After', 'Shrek the Halls', 'Shrek the Third']
    .map((list) => [list, 'Shrek and Fiona', ['Shrek', 'Princess Fiona']]),
  ['The Lion King', 'Kamari and Azizi', ['Kamari', 'Azizi']],
  ['The Little Mermaid', 'Flotsam and Jetsam', ['Flotsam', 'Jetsam']],
  ...['Toy Story', 'Toy Story 4', 'Toy Story 5'].map((list) => [list, 'Ducky and Bunny', ['Ducky', 'Bunny']]),
  ['Lookism', 'Max and Derrick', ['Max', 'Derrick']],
  ['Tower of God', 'Tebo & Lebo', ['Tebo', 'Lebo']],
  ['Ratchet & Clank', 'Ratchet and Clank', ['Ratchet', 'Clank']],
  ['Splatoon', 'Callie and Marie', ['Callie', 'Marie']],
  ['Dragon Quest', 'Bianca, Nera, and Debora', ['Bianca', 'Nera', 'Debora']],
  ['Dragon Quest', 'Maya and Meena', ['Maya', 'Meena']],
  ['Off', 'Psalmanazar & Herodotus', ['Psalmanazar', 'Herodotus']],
  ['K-Pop Groups', 'Red Velvet - Irene & Seulgi', []], // a sub-unit; Irene and Seulgi are idols, not groups
  ['K-Pop Groups', 'Super Junior Donghae & Eunhyuk', []],
  ['Slay the Spire', 'Centurion and Mystic', ['Centurion', 'Mystic']],
  ['Slay the Spire', 'Donu and Deca', ['Donu', 'Deca']],
  ['Slay the Spire', 'Spire Shield and Spire Spear', ['Spire Shield', 'Spire Spear']],
  ['Persona', 'Angel and Julian', ['Angel', 'Julian']],
  ['Persona', 'Bunkichi and Mitsuko', ['Bunkichi', 'Mitsuko']],
  ['Persona', 'Caroline & Justine', ['Caroline', 'Justine']],
];

// [list, name]: the image is AniList's "no picture" placeholder.
const CLEAR_IMAGES = [['Dragon Age', 'Leliana']];

const ADDED_BY = 'tidy-script';

function finder(db) {
  const stmt = db.prepare(
    `SELECT c.* FROM characters c JOIN character_lists cl ON cl.id = c.list_id
      WHERE cl.owner_scope IS NULL AND cl.name = ? COLLATE NOCASE AND c.name = ?`
  );
  return (list, name) => stmt.get(list, name) ?? null;
}

/** Everything this run would change, with nothing changed yet. */
function plan(db, { images = [] } = {}) {
  const find = finder(db);
  const missing = [];

  const collisions = [];
  const mergeLists = new Map(); // dropped id -> { list, keep }, for the report
  for (const [list, keep, drop] of MERGES) {
    const kept = find(list, keep);
    const gone = find(list, drop);
    if (!kept || !gone) missing.push(`merge ${list}: ${!kept ? `"${keep}"` : ''}${!kept && !gone ? ' and ' : ''}${!gone ? `"${drop}"` : ''} not found`);
    else {
      collisions.push({ id: gone.id, keepId: kept.id, duplicate: true });
      mergeLists.set(gone.id, { list, keep });
    }
  }

  const rerolls = db.prepare('SELECT * FROM character_rerolls WHERE character_id = ?');
  const games = db.prepare('SELECT rowid AS rowid FROM game_players WHERE character_id = ?');
  const castOf = db.prepare('SELECT id, name FROM characters WHERE list_id = ? AND id != ?');
  const lower = (s) => s.toLocaleLowerCase('en');
  const pairs = [];
  for (const [list, name, members] of PAIRS) {
    const row = find(list, name);
    if (!row) {
      missing.push(`pair ${list}: "${name}" not found`);
      continue;
    }
    // A member is already in the list when a row has its exact name, or a row's name is the
    // member's first part ("Hiccup" covers "Hiccup Horrendous Haddock III"). Never the other way:
    // "Max Zhang" starting with "Max" says nothing about Lookism's Max, and taking it to would
    // drop him silently.
    const cast = castOf.all(row.list_id, row.id);
    const add = [];
    const covered = [];
    for (const m of members) {
      const hit = cast.find((c) => lower(c.name) === lower(m) || lower(m).startsWith(`${lower(c.name)} `));
      if (hit) covered.push({ member: m, by: hit.name });
      else add.push(m);
    }
    pairs.push({ row, add, covered, rerolls: rerolls.all(row.id), gameRowids: games.all(row.id).map((g) => g.rowid), list });
  }

  const cleared = [];
  for (const [list, name] of CLEAR_IMAGES) {
    const row = find(list, name);
    if (!row) missing.push(`clear image ${list}: "${name}" not found`);
    else if (row.image_url) cleared.push({ id: row.id, image_url: row.image_url });
  }

  // A find made on a copy names its row by id, list and name; it is applied only while all three
  // still agree, because ids on the copy and the live file can drift apart (a merge, a re-seed).
  const current = db.prepare('SELECT list_id, name, image_url FROM characters WHERE id = ?');
  const goneIds = new Set([...collisions.map((c) => c.id), ...pairs.map((p) => p.row.id)]);
  const filled = [];
  for (const i of images) {
    const row = current.get(i.id);
    const ok = row && row.list_id === i.list_id && row.name === i.name && row.image_url === null &&
      /^https:\/\//.test(i.image_url ?? '') && !goneIds.has(i.id);
    if (ok) filled.push({ id: i.id, list_id: i.list_id, name: i.name, image_url: i.image_url });
  }

  return { merges: planMerges(db, collisions), mergeLists, pairs, cleared, filled, missing };
}

function apply(db, p) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO characters (list_id, name, added_by, created_at, image_url, fame) VALUES (?, ?, ?, ?, NULL, ?)'
  );
  const remove = db.prepare('DELETE FROM characters WHERE id = ? AND name = ?');
  const setImage = db.prepare('UPDATE characters SET image_url = ? WHERE id = ?');
  const fillImage = db.prepare('UPDATE characters SET image_url = ? WHERE id = ? AND image_url IS NULL');
  const added = [];
  db.transaction(() => {
    applyMerges(db, p.merges);
    for (const pair of p.pairs) {
      for (const name of pair.add) {
        const r = insert.run(pair.row.list_id, name, ADDED_BY, Date.now(), pair.row.fame);
        if (r.changes) added.push(Number(r.lastInsertRowid));
      }
      remove.run(pair.row.id, pair.row.name); // rerolls cascade; game_players.character_id goes NULL
    }
    for (const c of p.cleared) setImage.run(null, c.id);
    for (const f of p.filled) fillImage.run(f.image_url, f.id);
  })();
  return added;
}

/** Puts everything back from an undo log, newest change first. */
function undo(db, log) {
  const cols = log.pairs.length ? Object.keys(log.pairs[0].row) : [];
  const insert = cols.length
    ? db.prepare(`INSERT OR IGNORE INTO characters (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    : null;
  const reroll = db.prepare('INSERT OR IGNORE INTO character_rerolls (id, character_id, user_id, created_at) VALUES (?, ?, ?, ?)');
  const game = db.prepare('UPDATE game_players SET character_id = ? WHERE rowid = ? AND character_id IS NULL');
  // By (list, name, added_by) rather than by the logged ids, which are written only after the
  // change: a crash between the two log writes leaves the rows without their ids.
  const dropAdded = db.prepare('DELETE FROM characters WHERE list_id = ? AND name = ? AND added_by = ?');
  const unfill = db.prepare('UPDATE characters SET image_url = NULL WHERE id = ? AND image_url = ?');
  const restoreImage = db.prepare('UPDATE characters SET image_url = ? WHERE id = ? AND image_url IS NULL');
  db.transaction(() => {
    for (const f of log.filled) unfill.run(f.id, f.image_url);
    for (const c of log.cleared) restoreImage.run(c.image_url, c.id);
    for (const p of log.pairs) for (const name of p.add) dropAdded.run(p.row.list_id, name, ADDED_BY);
    for (const p of log.pairs) {
      insert.run(...cols.map((c) => p.row[c]));
      for (const r of p.rerolls) reroll.run(r.id, r.character_id, r.user_id, r.created_at);
      for (const rowid of p.gameRowids) game.run(p.row.id, rowid);
    }
    undoMerges(db, log.merges);
  })();
}

function report(p) {
  for (const m of p.merges) {
    const { list, keep } = p.mergeLists.get(m.gone.id);
    console.log(`merge  ${list}: "${m.gone.name}" into "${keep}" (#${m.keepId})`);
  }
  for (const pair of p.pairs) {
    const added = pair.add.length ? `, add ${pair.add.map((n) => `"${n}"`).join(', ')}` : '';
    const covered = pair.covered.map((c) => `"${c.member}" is "${c.by}"`).join(', ');
    console.log(`pair   ${pair.list}: delete "${pair.row.name}"${added}${covered ? ` (already there: ${covered})` : ''}`);
  }
  for (const c of p.cleared) console.log(`image  clear #${c.id}`);
  for (const f of p.filled) console.log(`image  fill #${f.id} "${f.name}" ${f.image_url}`);
  console.log(`\n${p.merges.length} merge(s), ${p.pairs.length} pair(s), ${p.cleared.length} image(s) cleared, ${p.filled.length} image(s) filled.`);
  for (const m of p.missing) console.log(`NOT FOUND: ${m}`);
}

function main() {
  const db = require('../src/compendium/db');
  require('../src/core/db/connection'); // game_players, which merges and pair deletes keep pointing right
  const args = require('./lib/compendiumArgs').scriptArgs();

  const undoFile = args.find((a) => a.startsWith('--undo='))?.slice('--undo='.length);
  if (undoFile) {
    undo(db, JSON.parse(fs.readFileSync(undoFile, 'utf8')));
    console.log(`Restored from ${undoFile}.`);
    return;
  }

  const imagesFile = args.find((a) => a.startsWith('--images-from='))?.slice('--images-from='.length);
  const images = imagesFile ? JSON.parse(fs.readFileSync(imagesFile, 'utf8')) : [];
  const p = plan(db, { images });
  report(p);
  if (!args.includes('--apply')) {
    console.log('\nReport only: nothing was changed. Re-run with --apply.');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = path.join(__dirname, '..', 'data', `tidy-${stamp}.json`);
  const record = { merges: p.merges, pairs: p.pairs, cleared: p.cleared, filled: p.filled, added: [] };
  writeFileAtomic(log, `${JSON.stringify(record)}\n`); // before anything changes
  record.added = apply(db, p);
  writeFileAtomic(log, `${JSON.stringify(record)}\n`);
  console.log(`\nApplied. Undo with --undo=${path.relative(process.cwd(), log)}`);
}

if (require.main === module) main();

module.exports = { plan, apply, undo, MERGES, PAIRS, CLEAR_IMAGES };
