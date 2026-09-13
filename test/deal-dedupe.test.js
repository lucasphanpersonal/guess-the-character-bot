// The draw must never put two players in the same character. Merging lists is where that gets
// hard: the same character appears under different spellings in different lists, and the bar for
// "the same character" is whatever the judge would accept as one answer -- so the pool is keyed
// the same way guesses are.

const { assert } = require('./harness');
const lists = require('../src/core/db/characterLists');
const db = require('../src/core/db/connection');

let n = 0;
function seedTwoLists(namesA, namesB) {
  const guildId = `dedupe-${++n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  const a = lists.createList(guildId, 'List A', 'tester', 'Test', { enabled: true });
  const b = lists.createList(guildId, 'List B', 'tester', 'Test', { enabled: true });
  for (const name of namesA) lists.addCharacter(a, name, 'tester', null);
  for (const name of namesB) lists.addCharacter(b, name, 'tester', null);
  return [a, b];
}

// Two players wearing "Spider-Man" and "Spiderman" is unplayable: either name is one answer to
// the judge, so whoever is guessed, one of the two is wrong for a reason nobody in the room can
// see. A plain lowercase key let every pair like this through.
function punctuationVariantsCountAsOneCharacter() {
  const listIds = seedTwoLists(['Spider-Man', 'Mario'], ['Spiderman', 'Luigi']);
  assert.equal(lists.countDistinctCharacters(listIds, 'everything'), 3);
  const drawn = lists.getRandomCharacters(listIds, 10, [], 'everything').map((c) => c.name);
  assert.equal(drawn.length, 3);
  assert.equal(drawn.filter((name) => name.toLowerCase().startsWith('spider')).length, 1);
}

function accentVariantsCountAsOneCharacter() {
  const listIds = seedTwoLists(['Pokémon Ash'], ['Pokemon Ash']);
  assert.equal(lists.countDistinctCharacters(listIds, 'everything'), 1);
}

function spacingVariantsCountAsOneCharacter() {
  const listIds = seedTwoLists(["Kai'Sa"], ['Kai Sa']);
  assert.equal(lists.countDistinctCharacters(listIds, 'everything'), 1);
}

// The counter and the draw read the same pool, so a room is never told it has enough characters
// to deal and then handed fewer.
function genuinelyDifferentNamesAllSurvive() {
  const listIds = seedTwoLists(['Ash', 'Misty'], ['Brock']);
  assert.equal(lists.countDistinctCharacters(listIds, 'everything'), 3);
  assert.equal(lists.getRandomCharacters(listIds, 3, [], 'everything').length, 3);
}

module.exports = {
  'punctuation variants count as one character': punctuationVariantsCountAsOneCharacter,
  'accent variants count as one character': accentVariantsCountAsOneCharacter,
  'spacing variants count as one character': spacingVariantsCountAsOneCharacter,
  'genuinely different names all survive': genuinelyDifferentNamesAllSurvive,
};
