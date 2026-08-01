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

// Human-readable label for a whole lobby selection, e.g. "Naruto (Manga) + Scrubs (TV Shows)".
function getListLabelForIds(listIds) {
  return getListsByIds(listIds).map(formatListLabel).join(' + ');
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
