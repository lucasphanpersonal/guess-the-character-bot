const db = require('./connection');
const { foldDiacritics } = require('../util/text');

// Lists arrive disabled because the seed scripts create them in the thousands. A list
// somebody types out by hand is the opposite case -- that is a deliberate choice, so
// /list create passes enabled: true and it is playable straight away.
function createList(guildId, name, createdBy, category = null, { enabled = false } = {}) {
  const info = db
    .prepare(
      'INSERT INTO character_lists (guild_id, name, created_by, created_at, category, enabled) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(guildId, name, createdBy, Date.now(), category, enabled ? 1 : 0);
  return info.lastInsertRowid;
}

// COLLATE NOCASE only folds ASCII case, not diacritics, and most people typing a list name
// won't bother with accents -- so "Pokemon" needs to resolve to "Pokémon" too.
const normalizeForMatch = foldDiacritics;

function getListByName(guildId, name) {
  const exact = db
    .prepare('SELECT * FROM character_lists WHERE guild_id = ? AND name = ? COLLATE NOCASE')
    .get(guildId, name);
  if (exact) return exact;

  // Fallback: diacritic-insensitive match (e.g. "Pokemon" should find "Pokémon").
  const target = normalizeForMatch(name);
  return listLists(guildId).find((l) => normalizeForMatch(l.name) === target) || null;
}

function listLists(guildId) {
  return db
    .prepare('SELECT * FROM character_lists WHERE guild_id = ? ORDER BY name COLLATE NOCASE')
    .all(guildId);
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
function getCharacterSource(guildId, characterName, drawnListId = null) {
  const rows = db
    .prepare(
      `SELECT cl.id, cl.name, cl.category, COUNT(c2.id) AS size
         FROM characters ch
         JOIN character_lists cl ON cl.id = ch.list_id
         JOIN characters c2 ON c2.list_id = cl.id
        WHERE cl.guild_id = ? AND ch.name = ? COLLATE NOCASE
        GROUP BY cl.id
        ORDER BY size DESC`
    )
    .all(guildId, characterName);
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
  const lists = getListsByIds(listIds);
  if (lists.length <= LABEL_LIST_LIMIT) return lists.map(formatListLabel).join(' + ');

  const categories = new Set(lists.map((l) => l.category || 'Uncategorized'));
  const suffix = `${lists.length} lists`;
  return categories.size === 1 ? `${[...categories][0]} (${suffix})` : suffix;
}

// Returned in the same order as `listIds` so display labels match the order the host typed
// them, rather than whatever order SQLite happens to return rows in.
function getListsByIds(listIds) {
  if (!listIds.length) return [];
  const placeholders = listIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM character_lists WHERE id IN (${placeholders})`).all(...listIds);
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

// Merging multiple lists can surface the same character name under two different list_ids
// (e.g. two lists both containing "Mario") -- dedupe by lowercase name, keeping the first
// occurrence, so the same character can never end up assigned to both players.
function dedupeByName(characters) {
  const seen = new Set();
  const deduped = [];
  for (const c of characters) {
    const key = c.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return deduped;
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
  const excludeLower = new Set([...excludeNames].map((n) => n.toLowerCase()));
  let pool = drawablePool(listIds, difficulty).filter((c) => !excludeLower.has(c.name.toLowerCase()));
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

function searchListNames(guildId, query, limit = 25) {
  const direct = db
    .prepare('SELECT name FROM character_lists WHERE guild_id = ? AND name LIKE ? ORDER BY name COLLATE NOCASE LIMIT ?')
    .all(guildId, `%${query}%`, limit)
    .map((r) => r.name);
  if (direct.length >= limit || !query) return direct;

  // Fallback: diacritic-insensitive substring match (e.g. "Pokemon" should surface
  // "Pokémon" as a suggestion), merged in after the direct matches, capped at limit.
  const target = normalizeForMatch(query);
  const seen = new Set(direct.map((n) => n.toLowerCase()));
  const extra = listLists(guildId)
    .map((l) => l.name)
    .filter((name) => !seen.has(name.toLowerCase()) && normalizeForMatch(name).includes(target));
  return [...direct, ...extra].slice(0, limit);
}

// Scopes (guild ids, historically) ranked by how much playable content they hold. The web
// frontend has no guild, so it uses this to auto-pick the richest existing scope to play from
// when WEB_SCOPE isn't set explicitly -- otherwise a fresh install would deal from nothing.
function guildsRankedByContent() {
  return db
    .prepare(
      `SELECT cl.guild_id AS guildId,
              SUM(CASE WHEN cl.enabled = 1 THEN 1 ELSE 0 END) AS enabledLists,
              COUNT(DISTINCT c.id) AS characters
         FROM character_lists cl
         LEFT JOIN characters c ON c.list_id = cl.id
        GROUP BY cl.guild_id
        ORDER BY enabledLists DESC, characters DESC`
    )
    .all();
}

function listCategoriesWithCounts(guildId) {
  return db
    .prepare(
      `SELECT COALESCE(category, 'Uncategorized') as category, COUNT(*) as count
       FROM character_lists WHERE guild_id = ? GROUP BY category ORDER BY category COLLATE NOCASE`
    )
    .all(guildId);
}

function listNamesInCategory(guildId, category) {
  if (category === 'Uncategorized') {
    return db
      .prepare('SELECT name FROM character_lists WHERE guild_id = ? AND category IS NULL ORDER BY name COLLATE NOCASE')
      .all(guildId)
      .map((r) => r.name);
  }
  return db
    .prepare('SELECT name FROM character_lists WHERE guild_id = ? AND category = ? ORDER BY name COLLATE NOCASE')
    .all(guildId, category)
    .map((r) => r.name);
}

function getListsByCategory(guildId, category) {
  if (category === 'Uncategorized') {
    return db.prepare('SELECT * FROM character_lists WHERE guild_id = ? AND category IS NULL').all(guildId);
  }
  return db.prepare('SELECT * FROM character_lists WHERE guild_id = ? AND category = ?').all(guildId, category);
}

// ---------------------------------------------------------------------------
// The server's playable selection (`enabled`), curated from /list select
// ---------------------------------------------------------------------------
//
// Only pooled draws consult this. Naming a list outright -- `/lobby create list:Naruto` --
// deliberately bypasses it: the point of the selection is to keep obscure lists out of a
// random deal, not to make them unreachable when somebody asks for one by name.

function getEnabledListsByCategory(guildId, category) {
  if (category === 'Uncategorized') {
    return db
      .prepare('SELECT * FROM character_lists WHERE guild_id = ? AND category IS NULL AND enabled = 1')
      .all(guildId);
  }
  return db
    .prepare('SELECT * FROM character_lists WHERE guild_id = ? AND category = ? AND enabled = 1')
    .all(guildId, category);
}

function getEnabledLists(guildId) {
  return db
    .prepare('SELECT * FROM character_lists WHERE guild_id = ? AND enabled = 1 ORDER BY name COLLATE NOCASE')
    .all(guildId);
}

// Every category with how much of it is switched on -- drives the /list select landing page
// and the "nothing is enabled yet" errors, which need to name what IS available.
function listCategoriesWithEnabledCounts(guildId) {
  return db
    .prepare(
      `SELECT COALESCE(category, 'Uncategorized') as category,
              COUNT(*) as count,
              SUM(enabled) as enabled
       FROM character_lists WHERE guild_id = ? GROUP BY category ORDER BY category COLLATE NOCASE`
    )
    .all(guildId)
    .map((row) => ({ ...row, enabled: row.enabled ?? 0 }));
}

// Ordered most-recognisable-first so the lists worth switching on land on page 1. Lists
// with no fame score (hand-made ones, and anything the backfill couldn't match) sort last
// rather than being treated as unpopular.
function listsForFilter(guildId, category) {
  const where = category === 'Uncategorized' ? 'category IS NULL' : 'category = ?';
  const params = category === 'Uncategorized' ? [guildId] : [guildId, category];
  return db
    .prepare(
      `SELECT cl.*, COUNT(c.id) AS character_count
         FROM character_lists cl
         LEFT JOIN characters c ON c.list_id = cl.id
        WHERE cl.guild_id = ? AND ${where}
        GROUP BY cl.id
        ORDER BY cl.popularity IS NULL, cl.popularity DESC, cl.name COLLATE NOCASE`
    )
    .all(...params);
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
function setTopN(guildId, category, n) {
  const categories =
    category != null ? [category] : listCategoriesWithEnabledCounts(guildId).map((c) => c.category);

  let enabled = 0;
  let disabled = 0;
  for (const cat of categories) {
    const ranked = listsForFilter(guildId, cat);
    const keep = ranked.slice(0, n);
    const drop = ranked.slice(n);
    enabled += setListsEnabled(keep.filter((l) => l.enabled !== 1).map((l) => l.id), true);
    disabled += setListsEnabled(drop.filter((l) => l.enabled === 1).map((l) => l.id), false);
  }
  return { enabled, disabled };
}

function setListsEnabled(listIds, enabled) {
  if (!listIds.length) return 0;
  const placeholders = listIds.map(() => '?').join(',');
  return db
    .prepare(`UPDATE character_lists SET enabled = ? WHERE id IN (${placeholders})`)
    .run(enabled ? 1 : 0, ...listIds).changes;
}

// Clears the whole selection. The only way back to a known state: enableTopN only ever
// adds, so re-cutting a server that has drifted means starting from nothing.
function disableAllLists(guildId) {
  return db.prepare('UPDATE character_lists SET enabled = 0 WHERE guild_id = ?').run(guildId).changes;
}

// Flips one list and reports the state it landed on, so the caller can say what happened
// without a second read.
function toggleListEnabled(listId) {
  db.prepare('UPDATE character_lists SET enabled = 1 - enabled WHERE id = ?').run(listId);
  return db.prepare('SELECT enabled FROM character_lists WHERE id = ?').get(listId)?.enabled === 1;
}

function clearPopularity(guildId) {
  return db.prepare('UPDATE character_lists SET popularity = NULL WHERE guild_id = ?').run(guildId).changes;
}

function setPopularityByName(guildId, name, popularity) {
  return (
    db
      .prepare('UPDATE character_lists SET popularity = ? WHERE guild_id = ? AND name = ? COLLATE NOCASE')
      .run(popularity, guildId, name).changes > 0
  );
}

// Picks one random category (uniformly among distinct categories, not weighted by list
// count) for "category roulette". Only categories with something enabled can be rolled --
// otherwise roulette lands on an empty pool and the lobby dies at Start.
function getRandomCategory(guildId) {
  const categories = listCategoriesWithEnabledCounts(guildId)
    .filter((c) => c.enabled > 0)
    .map((c) => c.category);
  if (!categories.length) return null;
  return categories[Math.floor(Math.random() * categories.length)];
}

function getRandomCharacterExcluding(listIds, excludeNames, difficulty = DEFAULT_DIFFICULTY, { preferImages = false } = {}) {
  const excludeLower = new Set([...excludeNames].map((n) => n.toLowerCase()));
  let candidates = drawablePool(listIds, difficulty).filter((c) => !excludeLower.has(c.name.toLowerCase()));
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
// Looking a character up across the whole server, for /character
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
function searchCharactersInGuild(guildId, query, limit = 25) {
  return db
    .prepare(
      `SELECT ch.id, ch.name, ch.image_url, ch.fame, cl.name AS listName, cl.category, cl.enabled
         FROM characters ch
         JOIN character_lists cl ON cl.id = ch.list_id
        WHERE cl.guild_id = ? AND ch.name LIKE ? ESCAPE '\\'
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
      guildId,
      `%${escapeLike(query)}%`,
      query,
      `${escapeLike(query)}%`,
      `% ${escapeLike(query)}%`,
      limit
    );
}

// Guild-scoped on purpose: the id comes back from an autocomplete value, which is client
// -supplied and so cannot be trusted to belong to this server.
function getCharacterById(guildId, id) {
  return (
    db
      .prepare(
        `SELECT ch.id, ch.name, ch.image_url, ch.fame, ch.list_id,
                cl.name AS listName, cl.category, cl.enabled
           FROM characters ch
           JOIN character_lists cl ON cl.id = ch.list_id
          WHERE cl.guild_id = ? AND ch.id = ?`
      )
      .get(guildId, id) ?? null
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
  guildsRankedByContent,
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
  searchCharactersInGuild,
  getCharacterById,
};
