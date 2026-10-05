// The web's view of the compendium -- shared by every web game.
//
// Everything a web game needs from the content, in the web's own terms: which scope it plays as,
// how a room's pool is chosen, the per-room curation, and dealing. A game module (party/, and the
// computer games to come) takes these and never touches the compendium itself, so "what the web
// deals from" is decided in exactly one place.
//
// The web plays as its own compendium scope (WEB_SCOPE, 'web' by default): it sees the shared
// lists and deals from its own playable selection. That used to be the richest Discord server's
// id, which meant reading -- and risking writing -- that server's selection.

const characterLists = require('../compendium/characterLists');

// Resolved in the compendium, because /list create in Discord switches new lists on for this
// same scope. Curate its selection with `npm run select:lists`.
const { WEB_SCOPE } = characterLists;

// The dealing calls a game's setup makes, injected rather than imported there so the game logic
// stays testable with fakes.
const content = {
  demoteThreshold: characterLists.REROLL_DEMOTE_THRESHOLD,
  rerollOne: (listIds, excludeNames, difficulty, opts) =>
    characterLists.getRandomCharacterExcluding(listIds, [...excludeNames], difficulty, opts),
  recordReject: (characterId, playerId) => characterLists.recordReroll(characterId, playerId),
  // Host-picks mode. Scope-checked, because the id comes from a client.
  characterById: (id) => characterLists.getCharacterById(WEB_SCOPE, id),
  freeform: (name) => characterLists.freeformCharacter(name),
  randomCharacters: (listIds, n, excludeNames, difficulty, opts) =>
    characterLists.getRandomCharacters(listIds, n, excludeNames, difficulty, opts),
  countDistinct: (listIds, difficulty) => characterLists.countDistinctCharacters(listIds, difficulty),
  // Every name a game was dealt from, for the guess-checker: one word of a name only counts as
  // the whole of it when nobody else in the pool has that word (src/compendium/answers.js).
  poolNames: (listIds) => characterLists.getCharactersForLists(listIds).map((c) => c.name),
};

// `excluded` is the room's own opt-outs, applied on top of the web's selection rather than
// written back into it -- see the note on Room.excludedListIds.
function resolvePool({ poolType, category, excluded = new Set() }) {
  const keep = (lists) => lists.map((l) => l.id).filter((id) => !excluded.has(id));
  if (poolType === 'category' && category) {
    return { listIds: keep(characterLists.getEnabledListsByCategory(WEB_SCOPE, category)), label: category };
  }
  if (poolType === 'random') {
    const cat = characterLists.getRandomCategory(WEB_SCOPE);
    if (!cat) return { listIds: [], label: 'nothing enabled' };
    return { listIds: keep(characterLists.getEnabledListsByCategory(WEB_SCOPE, cat)), label: `Random: ${cat}` };
  }
  // Default: everything enabled in this scope.
  return { listIds: keep(characterLists.getEnabledLists(WEB_SCOPE)), label: 'Everything' };
}

// What the host's config screen offers: the categories with something playable, and the
// difficulty cuts.
function poolOptions() {
  const categories = characterLists
    .listCategoriesWithEnabledCounts(WEB_SCOPE)
    .filter((c) => c.enabled > 0)
    .map((c) => ({ category: c.category, enabled: c.enabled }));
  const difficulties = Object.entries(characterLists.DIFFICULTIES).map(([key, d]) => ({
    key,
    label: d.label,
    blurb: d.blurb,
  }));
  return { categories, difficulties, defaultDifficulty: characterLists.DEFAULT_DIFFICULTY };
}

// Curation for one room only. Shows the lists already in the web's playable selection and lets
// the host drop some for THIS game; it never writes to the selection, so one party can't reshape
// what the next party gets dealt.
function listsInCategory(category, room) {
  return characterLists
    .listsForFilter(WEB_SCOPE, category)
    .filter((l) => l.enabled === 1)
    .map((l) => ({ id: l.id, name: l.name, count: l.character_count, playing: !room.excludedListIds.has(l.id) }));
}

// The id arrives from a client, so it is NOT trusted -- it must name a list that really is in
// this scope's playable selection before the room may act on it.
function toggleList(listId, room) {
  const [list] = characterLists.getListsByIds([listId], WEB_SCOPE);
  if (!characterLists.isVisibleTo(list, WEB_SCOPE) || list.enabled !== 1) return { ok: false, error: 'Unknown list.' };
  if (room.excludedListIds.has(list.id)) room.excludedListIds.delete(list.id);
  else room.excludedListIds.add(list.id);
  return { ok: true, playing: !room.excludedListIds.has(list.id) };
}

module.exports = {
  WEB_SCOPE,
  DEFAULT_DIFFICULTY: characterLists.DEFAULT_DIFFICULTY,
  content,
  resolvePool,
  poolOptions,
  listsInCategory,
  toggleList,
};
