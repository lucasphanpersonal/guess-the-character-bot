const { assert } = require('./harness');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

// Each test gets its own guild id so suites can't interfere with each other.
let guildCounter = 0;
function freshGuild() {
  const guildId = `test-guild-${++guildCounter}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  return guildId;
}

module.exports = {
  'list names match case- and accent-insensitively'() {
    const guildId = freshGuild();
    lists.createList(guildId, 'Pokémon', 'tester', 'Video Games');

    assert.ok(lists.getListByName(guildId, 'Pokémon'), 'exact');
    assert.ok(lists.getListByName(guildId, 'pokemon'), 'unaccented + lowercase');
    assert.equal(lists.getListByName(guildId, 'Nonexistent'), null);
  },

  'autocomplete search is accent-insensitive too'() {
    const guildId = freshGuild();
    lists.createList(guildId, 'Pokémon', 'tester', 'Video Games');
    assert.deepEqual(lists.searchListNames(guildId, 'Pokemon'), ['Pokémon']);
  },

  'characters merged from several lists are de-duplicated by name'() {
    const guildId = freshGuild();
    const a = lists.createList(guildId, 'List A', 'tester', 'Cat A');
    const b = lists.createList(guildId, 'List B', 'tester', 'Cat B');
    lists.addCharacter(a, 'Mario', 'tester');
    lists.addCharacter(a, 'Luigi', 'tester');
    lists.addCharacter(b, 'Mario', 'tester'); // deliberate cross-list duplicate
    lists.addCharacter(b, 'Peach', 'tester');

    // 4 rows, but only 3 distinct names.
    assert.equal(lists.countDistinctCharacters([a, b]), 3);

    // The same character must never be dealt to both players.
    for (let i = 0; i < 40; i++) {
      const [c1, c2] = lists.getRandomPair([a, b]);
      assert.notEqual(c1.name.toLowerCase(), c2.name.toLowerCase());
    }
  },

  'excluding names spans every selected list'() {
    const guildId = freshGuild();
    const a = lists.createList(guildId, 'List A', 'tester', 'Cat A');
    const b = lists.createList(guildId, 'List B', 'tester', 'Cat B');
    lists.addCharacter(a, 'Mario', 'tester');
    lists.addCharacter(b, 'Mario', 'tester');
    lists.addCharacter(b, 'Peach', 'tester');

    for (let i = 0; i < 20; i++) {
      const picked = lists.getRandomCharacterExcluding([a, b], new Set(['Mario']));
      assert.equal(picked.name, 'Peach');
    }
    assert.equal(lists.getRandomCharacterExcluding([a, b], new Set(['Mario', 'Peach'])), null);
  },

  'getListsByIds preserves the requested order'() {
    const guildId = freshGuild();
    const a = lists.createList(guildId, 'Alpha', 'tester', 'Cat');
    const b = lists.createList(guildId, 'Beta', 'tester', 'Cat');
    assert.deepEqual(
      lists.getListsByIds([b, a]).map((l) => l.name),
      ['Beta', 'Alpha']
    );
  },

  // Roulette landing on a category whose lists are all switched off would produce a lobby
  // that dies at Start, so an unenabled category is not a candidate at all.
  'category roulette only returns categories with something enabled'() {
    const guildId = freshGuild();
    assert.equal(lists.getRandomCategory(guildId), null, 'no lists yet');

    const id = lists.createList(guildId, 'Only List', 'tester', 'Anime');
    assert.equal(lists.getRandomCategory(guildId), null, 'exists but is not enabled');

    lists.setListsEnabled([id], true);
    for (let i = 0; i < 10; i++) {
      assert.equal(lists.getRandomCategory(guildId), 'Anime');
    }
    assert.deepEqual(
      lists.getEnabledListsByCategory(guildId, 'Anime').map((l) => l.name),
      ['Only List']
    );
  },

  'lists start disabled, and enabling is what puts them in a pooled draw'() {
    const guildId = freshGuild();
    const a = lists.createList(guildId, 'Alpha', 'tester', 'Anime');
    const b = lists.createList(guildId, 'Beta', 'tester', 'Anime');
    assert.deepEqual(lists.getEnabledLists(guildId), [], 'nothing is playable by default');

    lists.setListsEnabled([a], true);
    assert.deepEqual(
      lists.getEnabledLists(guildId).map((l) => l.name),
      ['Alpha']
    );

    // The unenabled list is still findable by name -- the filter governs pooled draws only.
    assert.equal(lists.getListByName(guildId, 'Beta').id, b);

    const [counts] = lists.listCategoriesWithEnabledCounts(guildId);
    assert.equal(counts.count, 2);
    assert.equal(counts.enabled, 1);
  },

  'the filter page ranks by fame, with unranked lists last'() {
    const guildId = freshGuild();
    lists.createList(guildId, 'Obscure Show', 'tester', 'Anime');
    lists.createList(guildId, 'Famous Show', 'tester', 'Anime');
    lists.createList(guildId, 'Handmade', 'tester', 'Anime');
    lists.setPopularityByName(guildId, 'Obscure Show', 500);
    lists.setPopularityByName(guildId, 'Famous Show', 460961);

    assert.deepEqual(
      lists.listsForFilter(guildId, 'Anime').map((l) => l.name),
      ['Famous Show', 'Obscure Show', 'Handmade']
    );
  },
};
