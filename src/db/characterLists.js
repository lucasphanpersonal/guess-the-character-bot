const db = require('./connection');
const { foldDiacritics } = require('../util/text');

function createList(guildId, name, createdBy, category = null) {
  const info = db
    .prepare('INSERT INTO character_lists (guild_id, name, created_by, created_at, category) VALUES (?, ?, ?, ?, ?)')
    .run(guildId, name, createdBy, Date.now(), category);
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

function countCharacters(listId) {
  return db.prepare('SELECT COUNT(*) as count FROM characters WHERE list_id = ?').get(listId).count;
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
  const sameName = (a, b) => normalizeForMatch(a).toLowerCase() === normalizeForMatch(b).toLowerCase();
  const candidates = rows.filter((row) => !sameName(row.name, characterName));
  if (!candidates.length) return null;

  // A list is a specific work unless it is just its own category ("Anime", "Video Games").
  // A null category counts as a work: the Pokémon and League seeds set no category, and
  // treating them as generic sent Pikachu's source to "Video Games" instead of "Pokémon".
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
 * A selection can cover a whole category -- `/create-lobby category:Video Games` pools 127
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

function countDistinctCharacters(listIds) {
  return dedupeByName(getCharactersForLists(listIds)).length;
}

// Up to `count` distinct characters drawn from the merged, de-duplicated pool. Returns
// fewer than requested only when the pool itself is too small.
function getRandomCharacters(listIds, count, excludeNames = []) {
  const excludeLower = new Set([...excludeNames].map((n) => n.toLowerCase()));
  const pool = dedupeByName(getCharactersForLists(listIds)).filter(
    (c) => !excludeLower.has(c.name.toLowerCase())
  );
  // Partial Fisher-Yates: only shuffle as far as we need to.
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

function getRandomPair(listIds) {
  return getRandomCharacters(listIds, 2);
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

// Picks one random category (uniformly among distinct categories, not weighted by list
// count) for "category roulette" -- returns null if the guild has no lists yet.
function getRandomCategory(guildId) {
  const categories = listCategoriesWithCounts(guildId).map((c) => c.category);
  if (!categories.length) return null;
  return categories[Math.floor(Math.random() * categories.length)];
}

function getRandomCharacterExcluding(listIds, excludeNames) {
  const excludeLower = new Set([...excludeNames].map((n) => n.toLowerCase()));
  const candidates = dedupeByName(getCharactersForLists(listIds)).filter((c) => !excludeLower.has(c.name.toLowerCase()));
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function getCharacterByNameInLists(listIds, name) {
  return dedupeByName(getCharactersForLists(listIds)).find((c) => c.name.toLowerCase() === name.toLowerCase()) || null;
}

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
  searchListNames,
  listCategoriesWithCounts,
  listNamesInCategory,
  getListsByCategory,
  getRandomCategory,
  getCharacterByNameInLists,
  searchCharactersInLists,
};
