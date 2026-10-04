// The draw must never put two players in the same character. Merging lists is where that gets
// hard: the same character appears under different spellings in different lists, and the bar for
// "the same character" is whatever the judge would accept as one answer -- so the pool is keyed
// the same way guesses are.

const { assert } = require('./harness');
const lists = require('../src/compendium/characterLists');
const db = require('../src/core/db/connection');

let n = 0;
function seedTwoLists(namesA, namesB) {
  const guildId = `dedupe-${++n}`;
  db.prepare('DELETE FROM character_lists WHERE owner_scope = ?').run(guildId);
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

// Once the checker accepted the words in any order and a quoted nickname on its own, those became
// "one answer" too -- and the live compendium had 67 such pairs INSIDE single lists (Black
// Clover's "Noelle Silva" and "Silva Noelle"), every one of them dealable to two players at once.
function wordOrderVariantsCountAsOneCharacter() {
  const listIds = seedTwoLists(['Noelle Silva', 'Asta'], ['Silva Noelle']);
  assert.equal(lists.countDistinctCharacters(listIds, 'everything'), 2);
}

function aNicknameAndTheFullNameCountAsOneCharacter() {
  const listIds = seedTwoLists(['Miles "Tails" Prower', 'Sonic'], ['Tails']);
  assert.equal(lists.countDistinctCharacters(listIds, 'everything'), 2);
}

function anyKeyInPlayKeepsTheOtherSpellingOut() {
  const listIds = seedTwoLists(['Miles "Tails" Prower', 'Knuckles'], []);
  for (let i = 0; i < 10; i++) {
    const drawn = lists.getRandomCharacters(listIds, 5, ['Tails'], 'everything').map((c) => c.name);
    assert.deepEqual(drawn, ['Knuckles'], 'Tails is in play, so Miles "Tails" Prower is too');
  }
  // ...and a typed name finds the pool's spelling of the same character.
  assert.equal(lists.getCharacterByNameInLists(listIds, 'Tails')?.name, 'Miles "Tails" Prower');
}

// The keys are the WHOLE name's forms, never a single word: "Sasuke Uchiha" and "Itachi Uchiha"
// share "Uchiha", and they are two people.
function sharingOneWordIsNotBeingTheSameCharacter() {
  const listIds = seedTwoLists(['Sasuke Uchiha', 'Itachi Uchiha'], ['Naruto Uzumaki', 'Kushina Uzumaki']);
  assert.equal(lists.countDistinctCharacters(listIds, 'everything'), 4);
}

// The counter and the draw read the same pool, so a room is never told it has enough characters
// to deal and then handed fewer.
function genuinelyDifferentNamesAllSurvive() {
  const listIds = seedTwoLists(['Ash', 'Misty'], ['Brock']);
  assert.equal(lists.countDistinctCharacters(listIds, 'everything'), 3);
  assert.equal(lists.getRandomCharacters(listIds, 3, [], 'everything').length, 3);
}

// What is already in play need not have come from the pool: a hand-picked or typed-in name can be
// spelled differently from the pool's copy of the same character. Excluding it by plain
// lowercase let the pool's spelling straight back in, 50/50 on a two-character pool.
function aRandomFillSkipsSpellingsOfCharactersInPlay() {
  const listIds = seedTwoLists(['Spider-Man', 'Batman'], []);
  for (let i = 0; i < 50; i++) {
    const [drawn] = lists.getRandomCharacters(listIds, 1, ['Spiderman'], 'everything');
    assert.equal(drawn.name, 'Batman');
  }
  assert.equal(lists.getRandomCharacters(listIds, 5, ['spider man'], 'everything').length, 1);
}

function aRerollSkipsSpellingsOfCharactersInPlay() {
  const listIds = seedTwoLists(['Spider-Man', 'Batman'], []);
  for (let i = 0; i < 50; i++) {
    assert.equal(lists.getRandomCharacterExcluding(listIds, new Set(['Spiderman']), 'everything').name, 'Batman');
  }
}

module.exports = {
  'a random fill skips spellings of characters in play': aRandomFillSkipsSpellingsOfCharactersInPlay,
  'a reroll skips spellings of characters in play': aRerollSkipsSpellingsOfCharactersInPlay,
  'punctuation variants count as one character': punctuationVariantsCountAsOneCharacter,
  'accent variants count as one character': accentVariantsCountAsOneCharacter,
  'spacing variants count as one character': spacingVariantsCountAsOneCharacter,
  'word-order variants count as one character': wordOrderVariantsCountAsOneCharacter,
  'a nickname and the full name count as one character': aNicknameAndTheFullNameCountAsOneCharacter,
  'any key in play keeps the other spelling out': anyKeyInPlayKeepsTheOtherSpellingOut,
  'sharing one word is not being the same character': sharingOneWordIsNotBeingTheSameCharacter,
  'genuinely different names all survive': genuinelyDifferentNamesAllSurvive,
};
