// Covers the label summarising behind `/create-lobby category:<name>`.
//
// Pooling a category is the only practical way to play "any video game character": naming
// 127 lists individually does not fit in Discord's 100-character option value. The risk it
// introduces is on the other side -- a lobby board that tries to print all 127 names would
// blow past what Discord will render, so the label has to collapse.

const { assert } = require('./harness');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let guildCounter = 0;
function freshGuild() {
  const guildId = `pool-guild-${++guildCounter}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  return guildId;
}

function seed(guildId, name, category, names) {
  const listId = lists.createList(guildId, name, 'tester', category);
  for (const n of names) lists.addCharacter(listId, n, 'tester');
  return listId;
}

// Discord renders at most 4096 characters in an embed description, and the label shares
// that space with the rest of the board.
const EMBED_LIMIT = 4096;

module.exports = {
  'a small selection still names each list'() {
    const guildId = freshGuild();
    const a = seed(guildId, 'Naruto', 'Anime', ['Naruto Uzumaki']);
    const b = seed(guildId, 'Bleach', 'Anime', ['Ichigo Kurosaki']);

    assert.equal(lists.getListLabelForIds([a, b]), 'Naruto (Anime) + Bleach (Anime)');
  },

  'a whole category collapses to a summary instead of 127 names'() {
    const guildId = freshGuild();
    const ids = [];
    for (let i = 0; i < 127; i++) {
      ids.push(seed(guildId, `Game Number ${i} With A Long Title`, 'Video Games', [`Hero ${i}`, `Villain ${i}`]));
    }

    const label = lists.getListLabelForIds(ids);
    assert.equal(label, 'Video Games (127 lists)');
    assert.ok(label.length <= EMBED_LIMIT, 'label fits in an embed');
  },

  'a mixed selection is counted rather than mislabelled with one category'() {
    const guildId = freshGuild();
    const ids = [
      seed(guildId, 'A', 'Anime', ['X']),
      seed(guildId, 'B', 'Movies', ['Y']),
      seed(guildId, 'C', 'Video Games', ['Z']),
      seed(guildId, 'D', 'Anime', ['W']),
    ];

    assert.equal(lists.getListLabelForIds(ids), '4 lists');
  },

  'pooling a category reaches every character in it'() {
    const guildId = freshGuild();
    seed(guildId, 'Zelda', 'Video Games', ['Link', 'Ganon']);
    seed(guildId, 'Metal Gear', 'Video Games', ['Solid Snake', 'Big Boss']);
    seed(guildId, 'Naruto', 'Anime', ['Naruto Uzumaki']);

    const pooled = lists.getListsByCategory(guildId, 'Video Games');
    assert.equal(pooled.length, 2, 'only the video game lists');
    assert.equal(
      lists.countDistinctCharacters(pooled.map((l) => l.id)),
      4,
      'every character across both lists, and nothing from Anime'
    );
  },
};
