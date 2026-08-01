// Covers getCharacterSource -- the "from <work>" line on the character DMs.
//
// A character usually sits in several lists at once (the codex importer files Pikachu under
// "Anime", "Video Games" and "Pokémon"), so the interesting behaviour is which of them gets
// shown: the point of the line is to disambiguate a name, and "Television Shows" does not
// disambiguate anything.

const { assert } = require('./harness');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let guildCounter = 0;
function freshGuild() {
  const guildId = `source-guild-${++guildCounter}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  return guildId;
}

// Creates a list and fills it, so list size (used as a specificity tiebreak) is realistic.
function seed(guildId, name, category, names) {
  const listId = lists.createList(guildId, name, 'tester', category);
  for (const n of names) lists.addCharacter(listId, n, 'tester');
  return listId;
}

module.exports = {
  'a franchise list beats the broad category the character also sits in'() {
    const guildId = freshGuild();
    seed(guildId, 'Television Shows', 'Television Shows', ['Patrick Star', 'Walter White', 'Jack']);
    seed(guildId, 'SpongeBob SquarePants', 'Television Shows', ['SpongeBob SquarePants', 'Patrick Star', 'Mr. Krabs']);

    assert.equal(lists.getCharacterSource(guildId, 'Patrick Star'), 'SpongeBob SquarePants (Television Shows)');
  },

  // A title character would otherwise read "SpongeBob SquarePants, from SpongeBob
  // SquarePants", so the show list is skipped and the broader one used instead.
  'a title character falls back past the show named after them'() {
    const guildId = freshGuild();
    seed(guildId, 'Television Shows', 'Television Shows', ['SpongeBob SquarePants', 'Walter White', 'Jack']);
    seed(guildId, 'SpongeBob SquarePants', 'Television Shows', ['SpongeBob SquarePants', 'Patrick Star', 'Mr. Krabs']);

    assert.equal(lists.getCharacterSource(guildId, 'SpongeBob SquarePants'), 'Television Shows');
  },

  // Ranking by smallest list looked "most specific" but picked spin-offs and tie-in films
  // over the show people actually know the character from.
  'the flagship show beats its spin-offs'() {
    const guildId = freshGuild();
    seed(guildId, 'SpongeBob SquarePants', 'Television Shows',
      Array.from({ length: 30 }, (_, i) => `Bikini Bottomite ${String.fromCharCode(65 + i)}`).concat('Squidward Tentacles'));
    seed(guildId, 'The Patrick Star Show', 'Television Shows', ['Squidward Tentacles', 'Patrick Star', 'Bunny Star']);

    assert.equal(
      lists.getCharacterSource(guildId, 'Squidward Tentacles'),
      'SpongeBob SquarePants (Television Shows)'
    );
  },

  // Two unrelated characters can share a name, and no ranking over the name alone can tell
  // them apart -- only the list the character was dealt from can.
  'the list a character was drawn from wins over the more famous namesake'() {
    const guildId = freshGuild();
    seed(guildId, 'Pokemon', null, Array.from({ length: 40 }, (_, i) => `Mon ${i}`).concat('Ditto'));
    const benTen = seed(guildId, 'Ben 10', 'Television Shows', ['Ditto', 'Gwen Tennyson', 'Kevin Levin']);

    assert.equal(lists.getCharacterSource(guildId, 'Ditto'), 'Pokemon', 'name alone picks the bigger list');
    assert.equal(
      lists.getCharacterSource(guildId, 'Ditto', benTen),
      'Ben 10 (Television Shows)',
      'drawn from Ben 10 says Ben 10'
    );
  },

  // The Pokémon and League seeds set no category at all; treating that as "generic" sent
  // Pikachu's source to "Video Games" instead of "Pokémon".
  'a list with no category still counts as a specific work'() {
    const guildId = freshGuild();
    seed(guildId, 'Video Games', 'Video Games', ['Pikachu', 'Mario', 'Link']);
    seed(guildId, 'Pokemon', null, ['Pikachu', 'Ditto', 'Eevee']);

    assert.equal(lists.getCharacterSource(guildId, 'Pikachu'), 'Pokemon');
  },

  'a bare category is still better than nothing'() {
    const guildId = freshGuild();
    seed(guildId, 'Mythology', 'Mythology', ['Anansi', 'Loki', 'Thor']);

    assert.equal(lists.getCharacterSource(guildId, 'Anansi'), 'Mythology');
  },

  // A list somebody named after the one character in it would render as
  // "**Pikachu** / from Pikachu", which is noise at best.
  'a list named after the character itself is not shown as its source'() {
    const guildId = freshGuild();
    seed(guildId, 'Pikachu', 'Pikachu', ['Pikachu']);

    assert.equal(lists.getCharacterSource(guildId, 'Pikachu'), null);
  },

  'an unknown character has no source'() {
    const guildId = freshGuild();
    seed(guildId, 'Anime', 'Anime', ['Naruto Uzumaki', 'Goku', 'Luffy']);

    assert.equal(lists.getCharacterSource(guildId, 'Nobody At All'), null);
  },

  'lookup is case-insensitive, like every other name match in the bot'() {
    const guildId = freshGuild();
    seed(guildId, 'Cowboy Bebop', 'Anime', ['Spike Spiegel', 'Faye Valentine', 'Ed']);

    assert.equal(lists.getCharacterSource(guildId, 'spike spiegel'), 'Cowboy Bebop (Anime)');
  },
};
