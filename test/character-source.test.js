// Covers getCharacterSource -- the "from <work>" line on the character DMs.
//
// A character usually sits in several lists at once (the codex importer files Pikachu under
// "Anime", "Video Games" and "Pokémon"), so the interesting behaviour is which of them gets
// shown: the point of the line is to disambiguate a name, and "Television Shows" does not
// disambiguate anything.

const { assert } = require('./harness');
const lists = require('../src/compendium/characterLists');
const db = require('../src/core/db/connection');

let guildCounter = 0;
function freshGuild() {
  const guildId = `source-guild-${++guildCounter}`;
  db.prepare('DELETE FROM character_lists WHERE owner_scope = ?').run(guildId);
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

  'the origin comes in parts: the work, and the kind of work'() {
    const guildId = freshGuild();
    seed(guildId, 'Television Shows', 'Television Shows', ['Patrick Star', 'SpongeBob SquarePants', 'Jack']);
    seed(guildId, 'SpongeBob SquarePants', 'Television Shows', ['SpongeBob SquarePants', 'Patrick Star', 'Mr. Krabs']);
    seed(guildId, 'Homebrew', null, ['Somebody']);

    assert.deepEqual(lists.getCharacterOrigin(guildId, 'Patrick Star'), { work: 'SpongeBob SquarePants', category: 'Television Shows' });
    assert.deepEqual(lists.getCharacterOrigin(guildId, 'SpongeBob SquarePants'), { work: null, category: 'Television Shows' }, 'a title character has only the kind');
    assert.deepEqual(lists.getCharacterOrigin(guildId, 'Somebody'), { work: 'Homebrew', category: null });
    assert.equal(lists.getCharacterOrigin(guildId, 'Nobody At All'), null);
    // The joined line is still what it was.
    assert.equal(lists.getCharacterSource(guildId, 'Somebody'), 'Homebrew');
  },

  // Dealt from a game, Luke is still from the film: the best-known work of his franchise.
  'a character is named from the best-known work of the franchise they were dealt from'() {
    const guildId = freshGuild();
    const film = seed(guildId, 'Star Wars: Episode VII', 'Movies', ['Luke Skywalker', 'Han Solo', 'Leia Organa', 'Rey']);
    const lego = seed(guildId, 'Lego Star Wars', 'Video Games', ['Luke Skywalker', 'Han Solo', 'Leia Organa', 'Chewbacca']);
    const games = seed(guildId, 'Star Wars', 'Video Games', ['Luke Skywalker', 'Han Solo', 'Leia Organa', 'Darth Vader']);
    lists.setListReach(film, 1_160_000);
    lists.setListReach(lego, 386_000);
    lists.setListReach(games, 700_000); // its best single game, not twenty games added up
    assert.equal(lists.getCharacterSource(guildId, 'Luke Skywalker', lego), 'Star Wars: Episode VII (Movies)');
    assert.equal(lists.getCharacterSource(guildId, 'Luke Skywalker', games), 'Star Wars: Episode VII (Movies)');
    // The live seed filed the film itself among the games, so both lists' best work is the film.
    lists.setListReach(games, 1_160_000);
    assert.equal(lists.getCharacterSource(guildId, 'Luke Skywalker', lego), 'Star Wars: Episode VII (Movies)', 'a tie is one shared work: name it by its own medium');
  },

  // ONE PIECE has a Batman too. However well-known ONE PIECE is, it shares nobody with the Batman
  // games, so it is not where the Batman dealt from them comes from.
  'a better-known namesake in another franchise never names them'() {
    const guildId = freshGuild();
    const onePiece = seed(guildId, 'ONE PIECE', 'Anime', ['Batman', 'Monkey D. Luffy', 'Roronoa Zoro', 'Nami']);
    const arkham = seed(guildId, 'Batman: Arkham', 'Video Games', ['Batman', 'Robin', 'The Joker', 'Alfred Pennyworth']);
    const cartoon = seed(guildId, 'Beware the Batman', 'Cartoon', ['Batman', 'Alfred Pennyworth', 'The Joker']);
    lists.setListReach(onePiece, 5_000_000);
    lists.setListReach(arkham, 266_000);
    lists.setListReach(cartoon, 70_000);
    assert.equal(lists.getCharacterSource(guildId, 'Batman', arkham), 'Batman: Arkham (Video Games)', 'the best-known of HIS lists');
    assert.equal(lists.getCharacterSource(guildId, 'Batman', onePiece), 'ONE PIECE (Anime)', "and ONE PIECE's Batman is still ONE PIECE's");
  },

  // The games list is named "Batman", so it cannot be shown as his source -- but it still says
  // which Batman he is. Without that, the biggest other "Batman" list answered: ONE PIECE.
  'a list named after them still decides which character they are'() {
    const guildId = freshGuild();
    const onePiece = seed(guildId, 'ONE PIECE', 'Anime', ['Batman', 'Monkey D. Luffy', 'Roronoa Zoro', 'Nami', 'Usopp']);
    const games = seed(guildId, 'Batman', 'Video Games', ['Batman', 'Robin', 'The Joker', 'Alfred Pennyworth']);
    seed(guildId, 'Beware the Batman', 'Cartoon', ['Batman', 'Alfred Pennyworth', 'The Joker']);
    lists.setListReach(onePiece, 5_000_000);
    assert.equal(lists.getCharacterSource(guildId, 'Batman', games), 'Beware the Batman (Cartoon)', 'his own franchise, not the bigger namesake');
    const solo = seed(guildId, 'Lone Wolf', 'Video Games', ['Lone Wolf', 'Nobody Else']);
    seed(guildId, 'Unrelated Saga', 'Anime', ['Lone Wolf', 'Somebody', 'Someone Else']);
    assert.equal(lists.getCharacterSource(guildId, 'Lone Wolf', solo), 'Video Games', 'their own list is a title list: the kind of work, never a namesake\'s show');
  },

  'with no reach known, the list they were dealt from stands'() {
    const guildId = freshGuild();
    seed(guildId, 'Naruto', 'Anime', ['Uzumaki Naruto', 'Uchiha Sasuke', 'Haruno Sakura', 'Hatake Kakashi']);
    const boruto = seed(guildId, 'Boruto', 'Anime', ['Uzumaki Naruto', 'Uchiha Sasuke', 'Haruno Sakura', 'Uzumaki Boruto']);
    assert.equal(lists.getCharacterSource(guildId, 'Uzumaki Naruto', boruto), 'Boruto (Anime)');
  },

  'lookup is case-insensitive, like every other name match in the bot'() {
    const guildId = freshGuild();
    seed(guildId, 'Cowboy Bebop', 'Anime', ['Spike Spiegel', 'Faye Valentine', 'Ed']);

    assert.equal(lists.getCharacterSource(guildId, 'spike spiegel'), 'Cowboy Bebop (Anime)');
  },
};
