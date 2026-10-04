// The compendium's lists and characters: every content read and write goes through here.
//
// SCOPES. Anything that plays -- a Discord server (its guild id), the web app ('web') -- is a
// scope, and a scope sees two kinds of list:
//
//   - the SHARED compendium (owner_scope NULL), visible to every scope: every seeded list, and
//     every list made with /list create -- a list typed out by hand is wanted everywhere;
//   - its OWN private lists (owner_scope = the scope), invisible elsewhere. Nothing makes these
//     today except the migration, for a second Discord server's lists (see db.js); the slot is
//     kept so a scope CAN hold something no one else sees.
//
// Each scope also has its own playable selection (list_selection), which is what `enabled`
// means on any row returned here: 1 if THAT scope has the list switched on. The same list can be
// on for one Discord server, off for another and on for the web, which is the whole reason the
// selection stopped being a column on the list.
//
// A null scope means "the compendium itself": it sees only shared lists and has no selection.
// That is what the content scripts (seeding, image fills) work against.

const db = require('./db');
const { foldDiacritics, normalizeLoose } = require('./text');

// The web app's scope, resolved once, here: the web server plays as it, and /list create in
// Discord switches a new list on for it too -- two processes that must agree on the name.
// WEB_SCOPE overrides it (the socket check gives itself a throwaway one).
const WEB_SCOPE = process.env.WEB_SCOPE || 'web';

// SQL fragments, each binding the scope ONCE with a positional `?`. Every query below that uses
// them passes the scope in the order the fragments appear in its text -- SELECT list first.
const VISIBLE = '(cl.owner_scope IS NULL OR cl.owner_scope = ?)';
const ENABLED = 'EXISTS (SELECT 1 FROM list_selection s WHERE s.scope = ? AND s.list_id = cl.id)';

/** Lists visible to `scope`, each with `enabled` for that scope. `tail` continues the WHERE. */
function scopedLists(scope, tail = '', ...params) {
  return db
    .prepare(`SELECT cl.*, ${ENABLED} AS enabled FROM character_lists cl WHERE ${VISIBLE} ${tail}`)
    .all(scope, scope, ...params);
}

/** Whether a list row may be used by `scope` -- for ids that came from a client. */
function isVisibleTo(list, scope) {
  return !!list && (list.owner_scope == null || list.owner_scope === scope);
}

// `scope` null makes a SHARED list -- what the seed scripts and /list create do. A scope makes a
// list private to it. Lists arrive switched off because the seed scripts create them in the
// thousands. A list somebody types out by hand is the opposite case -- that is a deliberate
// choice, so it is playable straight away: `enabled` switches it on for its owning scope, and
// `enabledFor` for any others (/list create names the server it was typed in, and the web).
function createList(scope, name, createdBy, category = null, { enabled = false, enabledFor = [] } = {}) {
  const id = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO character_lists (owner_scope, name, created_by, created_at, category) VALUES (?, ?, ?, ?, ?)'
      )
      .run(scope ?? null, name, createdBy, Date.now(), category);
    const on = [...(enabled && scope != null ? [scope] : []), ...enabledFor];
    for (const s of new Set(on)) setListsEnabled(s, [info.lastInsertRowid], true);
    return info.lastInsertRowid;
  })();
  return id;
}

// COLLATE NOCASE only folds ASCII case, not diacritics, and most people typing a list name
// won't bother with accents -- so "Pokemon" needs to resolve to "Pokémon" too.
const normalizeForMatch = foldDiacritics;

// A scope's own list wins over a shared one of the same name: a server that made its own
// "Pokemon" means that one when it types the name.
function getListByName(scope, name) {
  const exact = scopedLists(scope, 'AND cl.name = ? COLLATE NOCASE ORDER BY cl.owner_scope IS NULL', name)[0];
  if (exact) return exact;

  // Fallback: diacritic-insensitive match (e.g. "Pokemon" should find "Pokémon").
  const target = normalizeForMatch(name);
  const matches = listLists(scope).filter((l) => normalizeForMatch(l.name) === target);
  return matches.find((l) => l.owner_scope != null) || matches[0] || null;
}

function listLists(scope) {
  return scopedLists(scope, 'ORDER BY cl.name COLLATE NOCASE');
}

function setListCategory(listId, category) {
  return db.prepare('UPDATE character_lists SET category = ? WHERE id = ?').run(category, listId).changes > 0;
}

function addCharacter(listId, name, addedBy, imageUrl = null) {
  const info = db
    .prepare('INSERT INTO characters (list_id, name, added_by, created_at, image_url) VALUES (?, ?, ?, ?, ?)')
    .run(listId, name, addedBy, Date.now(), imageUrl);
  return info.lastInsertRowid;
}

function setCharacterFame(listId, name, fame) {
  return (
    db
      .prepare('UPDATE characters SET fame = ? WHERE list_id = ? AND name = ? COLLATE NOCASE')
      .run(fame, listId, name).changes > 0
  );
}

function setCharacterImage(listId, name, imageUrl) {
  const info = db
    .prepare('UPDATE characters SET image_url = ? WHERE list_id = ? AND name = ? COLLATE NOCASE')
    .run(imageUrl, listId, name);
  return info.changes > 0;
}

function removeCharacter(listId, name) {
  const info = db
    .prepare('DELETE FROM characters WHERE list_id = ? AND name = ? COLLATE NOCASE')
    .run(listId, name);
  return info.changes > 0;
}

/**
 * One list's characters, best-known first, for browsing.
 *
 * Paginated because a single list can run to 1,212 rows (Pokemon) and a phone on a tunnel should
 * not receive them in one response. Ordered by fame DESC with unranked last -- the same ordering
 * difficulty cuts along, so what a browser sees at the top is what the game actually deals first.
 */
function getCharactersRanked(listId, limit = 60, offset = 0) {
  return db
    .prepare(
      `SELECT id, name, image_url, fame
         FROM characters
        WHERE list_id = ?
        ORDER BY fame IS NULL, fame DESC, name COLLATE NOCASE
        LIMIT ? OFFSET ?`
    )
    .all(listId, limit, offset);
}

function countCharacters(listId) {
  return db.prepare('SELECT COUNT(*) AS n FROM characters WHERE list_id = ?').get(listId)?.n ?? 0;
}

function getCharacters(listId) {
  return db
    .prepare('SELECT * FROM characters WHERE list_id = ? ORDER BY name COLLATE NOCASE')
    .all(listId);
}

// "Naruto (Manga)", or just "Anime" when the list is its own category.
function formatListLabel(list) {
  if (!list.category || list.category === list.name) return list.name;
  return `${list.name} (${list.category})`;
}

/**
 * Which work a character comes from, for display alongside their name.
 *
 * A name on its own is ambiguous often enough to matter: the seed data has three different
 * Dittos (Pokémon, Ben 10, a Marvel character), an "Ed" in both Ed Edd n Eddy and Cowboy
 * Bebop, and a "Jack" in Samurai Jack, Lost and Titanic. A player answering questions about
 * a name they half-recognise needs to know which one they were handed.
 *
 * The same character usually sits in several lists at once -- a show and the film spun off
 * from it, or Pikachu in both "Pokémon" and an anime title -- so this picks the most useful
 * one.
 * A franchise list (name differs from its category) beats a bare category list, and among
 * franchise lists the *biggest* wins.
 *
 * Biggest, not smallest, and that was a real bug rather than a preference. Spin-offs and
 * tie-in films have far smaller casts than the show they came from, so ranking by smallest
 * confidently answered "Squidward Tentacles, from The Patrick Star Show" and "Blossom, from
 * The Powerpuff Girls Movie" -- technically true, useless as a hint, and wrong about where
 * people know the character from. The flagship show has the fullest cast, so its list is
 * the biggest, and it is also the one worth naming.
 *
 * Lists named after the character are skipped rather than shown, since "SpongeBob
 * SquarePants, from SpongeBob SquarePants" tells nobody anything -- a title character falls
 * back to the next-best list ("Television Shows"). Returns null only when that leaves
 * nothing, e.g. a one-off list somebody typed by hand for a single character.
 */
function getCharacterSource(scope, characterName, drawnListId = null) {
  const rows = db
    .prepare(
      `SELECT cl.id, cl.name, cl.category, COUNT(c2.id) AS size
         FROM characters ch
         JOIN character_lists cl ON cl.id = ch.list_id
         JOIN characters c2 ON c2.list_id = cl.id
        WHERE ${VISIBLE} AND ch.name = ? COLLATE NOCASE
        GROUP BY cl.id
        ORDER BY size DESC`
    )
    .all(scope, characterName);
  // normalizeForMatch folds case as well as diacritics, so this needs no extra lowercasing.
  const sameName = (a, b) => normalizeForMatch(a) === normalizeForMatch(b);
  const candidates = rows.filter((row) => !sameName(row.name, characterName));
  if (!candidates.length) return null;

  // A list is a specific work unless it is just its own category ("Anime", "Video Games").
  // A null category counts as a work rather than as generic: an uncategorised list is still
  // named after something, so "Pokémon" beats falling through to a bare category name.
  const isWork = (row) => !row.category || row.category !== row.name;

  // The list the character was actually dealt from settles it outright, when it names a
  // work. Two unrelated characters can share a name -- there is a Ditto in Pokémon and a
  // different Ditto in Ben 10 -- and no amount of ranking over the name alone can tell them
  // apart. Which list it came from can.
  const drawn = drawnListId != null && candidates.find((row) => row.id === drawnListId);
  const best = (drawn && isWork(drawn) && drawn) || candidates.find(isWork) || candidates[0];
  return isWork(best) && best.category ? `${best.name} (${best.category})` : best.name;
}

// How many lists a selection can name individually before it is summarised instead.
const LABEL_LIST_LIMIT = 3;

/**
 * Human-readable label for a whole lobby selection, e.g. "Naruto (Manga) + Scrubs (TV Shows)".
 *
 * A selection can cover a whole category -- `/lobby create category:Video Games` pools 127
 * lists, and rolling "Anime" pools 443 -- and naming each one would produce a label
 * thousands of characters long, well past what Discord will render in an embed. Past a
 * handful, the shared category is the honest summary; a mixed selection just gets counted.
 */
function getListLabelForIds(listIds) {
  const lists = getListsByIds(listIds, null);
  if (lists.length <= LABEL_LIST_LIMIT) return lists.map(formatListLabel).join(' + ');

  const categories = new Set(lists.map((l) => l.category || 'Uncategorized'));
  const suffix = `${lists.length} lists`;
  return categories.size === 1 ? `${[...categories][0]} (${suffix})` : suffix;
}

// Returned in the same order as `listIds` so display labels match the order the host typed
// them, rather than whatever order SQLite happens to return rows in.
//
// NOT filtered by visibility: the ids usually come from a game already in progress, and a list
// that vanished from a game's own record would be worse than a stale label. Where an id came from
// a client, check it with isVisibleTo. `enabled` is relative to `scope`, as everywhere here; a
// null scope (labels, which never read it) reports every list as off.
function getListsByIds(listIds, scope) {
  if (!listIds.length) return [];
  const placeholders = listIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT cl.*, ${ENABLED} AS enabled FROM character_lists cl WHERE cl.id IN (${placeholders})`)
    .all(scope ?? null, ...listIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return listIds.map((id) => byId.get(id)).filter(Boolean);
}

function getCharactersForLists(listIds) {
  if (!listIds.length) return [];
  const placeholders = listIds.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM characters WHERE list_id IN (${placeholders}) ORDER BY name COLLATE NOCASE`)
    .all(...listIds);
}

// ---------------------------------------------------------------------------
// Difficulty: how deep into a cast a random draw is allowed to go
// ---------------------------------------------------------------------------
//
// Curating lists cannot fix being dealt somebody obscure, because the obscurity is INSIDE
// the list. Attack on Titan is on everybody's shortlist and its cast still runs from Eren
// (36,038 favourites) down to bit parts with three. So difficulty cuts each cast by fame
// instead of cutting the list.
//
// The cut is per list, deliberately. Fame comes from two incomparable scales (AniList
// favourites in the thousands, Wikipedia sitelinks in the tens), so a pool-wide threshold
// would quietly delete every Wikidata-sourced character. "The top quarter of each cast" is
// scale-free, and it is also the more useful rule: it keeps the leads of every show rather
// than every character of the most-documented shows.

const DIFFICULTIES = {
  easy: { label: 'Easy', keep: 0.25, blurb: 'best-known quarter of each cast' },
  normal: { label: 'Normal', keep: 0.6, blurb: 'skips the deepest cuts' },
  everything: { label: 'Everything', keep: 1, blurb: 'every character, however obscure' },
};
const DEFAULT_DIFFICULTY = 'normal';

const difficultyOf = (difficulty) => DIFFICULTIES[difficulty] ?? DIFFICULTIES[DEFAULT_DIFFICULTY];

/**
 * Keeps the best-known share of each list's cast.
 *
 * A list with no fame data at all passes through untouched -- an unranked list is unranked,
 * not unpopular, and silently reducing it to one arbitrary character would be worse than
 * doing nothing. Within a partially ranked list, unranked characters sort last.
 */
function applyDifficulty(characters, difficulty) {
  const { keep } = difficultyOf(difficulty);
  if (keep >= 1) return characters;

  const byList = new Map();
  for (const c of characters) {
    if (!byList.has(c.list_id)) byList.set(c.list_id, []);
    byList.get(c.list_id).push(c);
  }

  const kept = [];
  for (const cast of byList.values()) {
    if (!cast.some((c) => c.fame != null)) {
      kept.push(...cast);
      continue;
    }
    const ranked = [...cast].sort((a, b) => (b.fame ?? -1) - (a.fame ?? -1));
    // At least one, so a two-character list never becomes undrawable.
    kept.push(...ranked.slice(0, Math.max(1, Math.ceil(ranked.length * keep))));
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Learning from rerolls
// ---------------------------------------------------------------------------

// How many DIFFERENT people have to reject a character before the bot stops dealing it.
// Three is a consensus rather than one person's blind spot, and it is reversible: the row
// is per (character, user), so clearing the table restores everything.
const REROLL_DEMOTE_THRESHOLD = 3;

function recordReroll(characterId, userId) {
  if (!characterId) return 0;
  db.prepare(
    'INSERT OR IGNORE INTO character_rerolls (character_id, user_id, created_at) VALUES (?, ?, ?)'
  ).run(characterId, userId, Date.now());
  return countRerollers(characterId);
}

function countRerollers(characterId) {
  return (
    db
      .prepare('SELECT COUNT(DISTINCT user_id) AS n FROM character_rerolls WHERE character_id = ?')
      .get(characterId)?.n ?? 0
  );
}

// The characters this server has collectively given up on, within the given lists.
function demotedCharacterIds(listIds) {
  if (!listIds.length) return new Set();
  const placeholders = listIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT r.character_id AS id
         FROM character_rerolls r
         JOIN characters c ON c.id = r.character_id
        WHERE c.list_id IN (${placeholders})
        GROUP BY r.character_id
       HAVING COUNT(DISTINCT r.user_id) >= ?`
    )
    .all(...listIds, REROLL_DEMOTE_THRESHOLD);
  return new Set(rows.map((r) => r.id));
}

// The pool a random deal actually draws from: the enabled lists' characters, minus the
// deepest cuts for this difficulty, minus what the server has rerolled into the ground.
function drawablePool(listIds, difficulty) {
  const demoted = demotedCharacterIds(listIds);
  return dedupeByName(
    applyDifficulty(getCharactersForLists(listIds), difficulty).filter((c) => !demoted.has(c.id))
  );
}

// Merging multiple lists can surface the same character under two different list_ids (e.g. two
// lists both containing "Mario") -- dedupe by name, keeping the first occurrence, so the same
// character can never end up assigned to both players.
//
// Keyed with normalizeLoose, which is the same test the judge uses to decide whether a guess
// matches a name. That is exactly the right bar: if "Spider-Man" and "Spiderman" are one answer
// to the judge, dealing both of them puts two players in a room wearing what is, as far as the
// game is concerned, the same character -- and whichever of them is guessed, one of the two is
// wrong for reasons nobody can see. A plain lowercase key let every such pair through.
function dedupeByName(characters) {
  const seen = new Set();
  const deduped = [];
  for (const c of characters) {
    const key = normalizeLoose(c.name);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return deduped;
}

// Filter for "not already in play", keyed exactly like dedupeByName above. The pool can only
// hold one spelling of a character, but the names being excluded need not come from the pool:
// a hand-picked or typed-in "Spiderman" is in play while the pool's copy is "Spider-Man". A
// lowercase key let that through, so a random fill or a reroll could put the same character on
// two heads -- which is the dedupe bug all over again, arriving by a different door.
function notExcluded(excludeNames) {
  const excluded = new Set([...excludeNames].map(normalizeLoose));
  return (c) => !excluded.has(normalizeLoose(c.name));
}

// Counts what would actually be dealt, not what the lists hold -- the lobby board uses this
// and a number that ignored difficulty would misrepresent the game about to be played.
function countDistinctCharacters(listIds, difficulty = 'everything') {
  return drawablePool(listIds, difficulty).length;
}

// Up to `count` distinct characters drawn from the merged, de-duplicated pool. Returns
// fewer than requested only when the pool itself is too small.
//
// `preferImages` (used by the web app, where the reveal is a full-screen picture) restricts the
// draw to characters that have artwork -- but only when there are enough of them to fill the
// request, so a small or image-poor pool still deals rather than failing.
function getRandomCharacters(listIds, count, excludeNames = [], difficulty = DEFAULT_DIFFICULTY, { preferImages = false } = {}) {
  let pool = drawablePool(listIds, difficulty).filter(notExcluded(excludeNames));
  if (preferImages) {
    const withImage = pool.filter((c) => c.image_url);
    if (withImage.length >= count) pool = withImage;
  }
  // Partial Fisher-Yates: only shuffle as far as we need to.
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

function getRandomPair(listIds, difficulty = DEFAULT_DIFFICULTY) {
  return getRandomCharacters(listIds, 2, [], difficulty);
}

function searchListNames(scope, query, limit = 25) {
  const direct = db
    .prepare(`SELECT cl.name FROM character_lists cl WHERE ${VISIBLE} AND cl.name LIKE ? ORDER BY cl.name COLLATE NOCASE LIMIT ?`)
    .all(scope, `%${query}%`, limit)
    .map((r) => r.name);
  if (direct.length >= limit || !query) return direct;

  // Fallback: diacritic-insensitive substring match (e.g. "Pokemon" should surface
  // "Pokémon" as a suggestion), merged in after the direct matches, capped at limit.
  const target = normalizeForMatch(query);
  const seen = new Set(direct.map((n) => n.toLowerCase()));
  const extra = listLists(scope)
    .map((l) => l.name)
    .filter((name) => !seen.has(name.toLowerCase()) && normalizeForMatch(name).includes(target));
  return [...direct, ...extra].slice(0, limit);
}

// `category = ?` with the 'Uncategorized' pseudo-category meaning NULL, plus its parameters.
const categoryClause = (category) =>
  category === 'Uncategorized' ? ['cl.category IS NULL', []] : ['cl.category = ?', [category]];

function listCategoriesWithCounts(scope) {
  return db
    .prepare(
      `SELECT COALESCE(cl.category, 'Uncategorized') as category, COUNT(*) as count
       FROM character_lists cl WHERE ${VISIBLE} GROUP BY cl.category ORDER BY cl.category COLLATE NOCASE`
    )
    .all(scope);
}

function listNamesInCategory(scope, category) {
  const [where, params] = categoryClause(category);
  return scopedLists(scope, `AND ${where} ORDER BY cl.name COLLATE NOCASE`, ...params).map((r) => r.name);
}

function getListsByCategory(scope, category) {
  const [where, params] = categoryClause(category);
  return scopedLists(scope, `AND ${where}`, ...params);
}

// ---------------------------------------------------------------------------
// A scope's playable selection (`enabled`), curated from /list select
// ---------------------------------------------------------------------------
//
// Only pooled draws consult this. Naming a list outright -- `/lobby create list:Naruto` --
// deliberately bypasses it: the point of the selection is to keep obscure lists out of a
// random deal, not to make them unreachable when somebody asks for one by name.

function getEnabledListsByCategory(scope, category) {
  const [where, params] = categoryClause(category);
  return scopedLists(scope, `AND ${ENABLED} AND ${where}`, scope, ...params);
}

function getEnabledLists(scope) {
  return scopedLists(scope, `AND ${ENABLED} ORDER BY cl.name COLLATE NOCASE`, scope);
}

// Every category with how much of it is switched on -- drives the /list select landing page
// and the "nothing is enabled yet" errors, which need to name what IS available.
function listCategoriesWithEnabledCounts(scope) {
  return db
    .prepare(
      `SELECT COALESCE(cl.category, 'Uncategorized') as category,
              COUNT(*) as count,
              SUM(${ENABLED}) as enabled
       FROM character_lists cl WHERE ${VISIBLE} GROUP BY cl.category ORDER BY cl.category COLLATE NOCASE`
    )
    .all(scope, scope)
    .map((row) => ({ ...row, enabled: row.enabled ?? 0 }));
}

// Ordered most-recognisable-first so the lists worth switching on land on page 1. Lists
// with no fame score (hand-made ones, and anything the backfill couldn't match) sort last
// rather than being treated as unpopular.
function listsForFilter(scope, category) {
  const [where, params] = categoryClause(category);
  return db
    .prepare(
      `SELECT cl.*, ${ENABLED} AS enabled, COUNT(c.id) AS character_count
         FROM character_lists cl
         LEFT JOIN characters c ON c.list_id = cl.id
        WHERE ${VISIBLE} AND ${where}
        GROUP BY cl.id
        ORDER BY cl.popularity IS NULL, cl.popularity DESC, cl.name COLLATE NOCASE`
    )
    .all(scope, scope, ...params);
}

/**
 * Makes the `n` best-known lists in a category the WHOLE selection for that category --
 * anything below the line is switched off. With no category, every category is re-cut to
 * its own top `n`.
 *
 * Exact rather than additive, because "top 50" plainly means "the top 50 is what we play
 * with". The additive version could only ever grow a selection, so asking a category that
 * already had 150 on for its top 50 silently did nothing while reporting success -- the
 * worst possible outcome, since there was no way to tell it hadn't worked.
 *
 * Hand-picked extras do get dropped. `/list toggle` puts one back in three keystrokes,
 * which is a smaller cost than a command that lies about what it did.
 */
function setTopN(scope, category, n) {
  const categories =
    category != null ? [category] : listCategoriesWithEnabledCounts(scope).map((c) => c.category);

  let enabled = 0;
  let disabled = 0;
  for (const cat of categories) {
    const ranked = listsForFilter(scope, cat);
    const keep = ranked.slice(0, n);
    const drop = ranked.slice(n);
    enabled += setListsEnabled(scope, keep.filter((l) => l.enabled !== 1).map((l) => l.id), true);
    disabled += setListsEnabled(scope, drop.filter((l) => l.enabled === 1).map((l) => l.id), false);
  }
  return { enabled, disabled };
}

// A selection belongs to a scope, so there is no such thing as switching a list on "globally" --
// the null scope (the compendium itself) has none, and asking it for one is a bug in the caller.
function requireScope(scope) {
  if (scope == null) throw new Error('A playable selection belongs to a scope; none was given.');
}

// Returns how many lists actually changed state. Only lists the scope can see can be switched
// on: the ids may have come from a client, and a selection row for an invisible list would be a
// way to deal another server's private list.
function setListsEnabled(scope, listIds, enabled) {
  requireScope(scope);
  if (!listIds.length) return 0;
  const placeholders = listIds.map(() => '?').join(',');
  if (enabled) {
    return db
      .prepare(
        `INSERT OR IGNORE INTO list_selection (scope, list_id)
         SELECT ?, cl.id FROM character_lists cl WHERE cl.id IN (${placeholders}) AND ${VISIBLE}`
      )
      .run(scope, ...listIds, scope).changes;
  }
  return db
    .prepare(`DELETE FROM list_selection WHERE scope = ? AND list_id IN (${placeholders})`)
    .run(scope, ...listIds).changes;
}

// Clears the whole selection. The only way back to a known state: enableTopN only ever
// adds, so re-cutting a server that has drifted means starting from nothing.
function disableAllLists(scope) {
  requireScope(scope);
  return db.prepare('DELETE FROM list_selection WHERE scope = ?').run(scope).changes;
}

// Flips one list and reports the state it landed on, so the caller can say what happened
// without a second read.
function toggleListEnabled(scope, listId) {
  requireScope(scope);
  const on = !!db.prepare('SELECT 1 FROM list_selection WHERE scope = ? AND list_id = ?').get(scope, listId);
  setListsEnabled(scope, [listId], !on);
  return !!db.prepare('SELECT 1 FROM list_selection WHERE scope = ? AND list_id = ?').get(scope, listId);
}

// Popularity is a property of the list, not of who plays it: these touch every list the scope
// can see, and the content scripts pass null to work on the shared compendium.
function clearPopularity(scope) {
  return db.prepare(`UPDATE character_lists AS cl SET popularity = NULL WHERE ${VISIBLE}`).run(scope).changes;
}

function setPopularityByName(scope, name, popularity) {
  return (
    db
      .prepare(`UPDATE character_lists AS cl SET popularity = ? WHERE ${VISIBLE} AND cl.name = ? COLLATE NOCASE`)
      .run(popularity, scope, name).changes > 0
  );
}

// Picks one random category (uniformly among distinct categories, not weighted by list
// count) for "category roulette". Only categories with something enabled can be rolled --
// otherwise roulette lands on an empty pool and the lobby dies at Start.
function getRandomCategory(scope) {
  const categories = listCategoriesWithEnabledCounts(scope)
    .filter((c) => c.enabled > 0)
    .map((c) => c.category);
  if (!categories.length) return null;
  return categories[Math.floor(Math.random() * categories.length)];
}

function getRandomCharacterExcluding(listIds, excludeNames, difficulty = DEFAULT_DIFFICULTY, { preferImages = false } = {}) {
  let candidates = drawablePool(listIds, difficulty).filter(notExcluded(excludeNames));
  if (preferImages) {
    const withImage = candidates.filter((c) => c.image_url);
    if (withImage.length) candidates = withImage; // a reroll only needs one, so any is enough
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function getCharacterByNameInLists(listIds, name) {
  return dedupeByName(getCharactersForLists(listIds)).find((c) => c.name.toLowerCase() === name.toLowerCase()) || null;
}

// A hand-picked name that isn't in any list -- an inside joke, a person not in the database,
// a typo the host meant literally. Shaped like a real character row so it flows through
// Game.head() unchanged, just with nothing to look an image or source up by: no id (so a
// reroll away from it records against nothing), no list_id (so there's no list to offer
// dropping), no image_url (so it reveals as text, same as any character with no artwork).
function freeformCharacter(name) {
  return { name, image_url: null, id: null, list_id: null };
}

// ---------------------------------------------------------------------------
// Looking a character up across everything a scope can see, for /character and the host's picker
// ---------------------------------------------------------------------------
//
// Deliberately NOT scoped to a lobby's lists, unlike the two functions below it: this is
// "show me that character", not "pick one for this game", and refusing to find somebody
// because the current lobby happens to be drawing from Anime would be a strange answer.
//
// The same name genuinely belongs to several characters -- there is a Ditto in Pokemon and
// another in Ben 10 -- so results are NOT deduplicated by name the way the lobby search is.
// The autocomplete label carries the list, and the value carries the row id, so picking a
// suggestion resolves to exactly one character rather than to whichever shared the name.
function searchCharactersInScope(scope, query, limit = 25) {
  return db
    .prepare(
      `SELECT ch.id, ch.name, ch.image_url, ch.fame, cl.name AS listName, cl.category, ${ENABLED} AS enabled
         FROM characters ch
         JOIN character_lists cl ON cl.id = ch.list_id
        WHERE ${VISIBLE} AND ch.name LIKE ? ESCAPE '\\'
        ORDER BY
          -- Ranked by WORD start, not string start. Ranking on string prefix alone answers
          -- "Zoro" with Zorome and Zoroark while burying Roronoa Zoro, and "Einstein" with
          -- Einstein Nina while burying Albert Einstein -- because the name people search by
          -- is often not the first word. Matching either end of a word puts all of those in
          -- the same tier, and fame then decides between them.
          CASE
            WHEN ch.name = ? COLLATE NOCASE THEN 0
            WHEN ch.name LIKE ? ESCAPE '\\' THEN 1
            WHEN ch.name LIKE ? ESCAPE '\\' THEN 1
            ELSE 2
          END,
          ch.fame IS NULL, ch.fame DESC,
          ch.name COLLATE NOCASE
        LIMIT ?`
    )
    .all(
      scope,
      scope,
      `%${escapeLike(query)}%`,
      query,
      `${escapeLike(query)}%`,
      `% ${escapeLike(query)}%`,
      limit
    );
}

// Scoped on purpose: the id comes back from an autocomplete value or a web request, which is
// client-supplied and so cannot be trusted to be one this scope can see.
function getCharacterById(scope, id) {
  return (
    db
      .prepare(
        `SELECT ch.id, ch.name, ch.image_url, ch.fame, ch.list_id,
                cl.name AS listName, cl.category, ${ENABLED} AS enabled
           FROM characters ch
           JOIN character_lists cl ON cl.id = ch.list_id
          WHERE ${VISIBLE} AND ch.id = ?`
      )
      .get(scope, scope, id) ?? null
  );
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

function searchCharactersInLists(listIds, query, limit = 25) {
  return dedupeByName(getCharactersForLists(listIds))
    .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, limit)
    .map((c) => c.name);
}

module.exports = {
  createList,
  setListCategory,
  getListByName,
  listLists,
  addCharacter,
  setCharacterImage,
  removeCharacter,
  getCharacters,
  getCharactersRanked,
  countCharacters,
  getCharactersForLists,
  getListsByIds,
  formatListLabel,
  getListLabelForIds,
  getCharacterSource,
  countDistinctCharacters,
  getRandomPair,
  getRandomCharacters,
  getRandomCharacterExcluding,
  DIFFICULTIES,
  DEFAULT_DIFFICULTY,
  difficultyOf,
  applyDifficulty,
  drawablePool,
  recordReroll,
  countRerollers,
  demotedCharacterIds,
  setCharacterFame,
  REROLL_DEMOTE_THRESHOLD,
  searchListNames,
  isVisibleTo,
  WEB_SCOPE,
  listCategoriesWithCounts,
  listNamesInCategory,
  getListsByCategory,
  getEnabledListsByCategory,
  getEnabledLists,
  listCategoriesWithEnabledCounts,
  listsForFilter,
  setListsEnabled,
  setTopN,
  toggleListEnabled,
  disableAllLists,
  setPopularityByName,
  clearPopularity,
  getRandomCategory,
  getCharacterByNameInLists,
  freeformCharacter,
  searchCharactersInLists,
  searchCharactersInScope,
  getCharacterById,
};
