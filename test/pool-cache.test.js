// The drawable pool is cached (src/compendium/characterLists.js drawablePool), because building it
// for the web's whole selection blocked the event loop for ~130ms on every deal and reroll. A cache
// is only right while the content is unchanged -- so these pin that every kind of write refreshes it.

const Database = require('better-sqlite3');
const { assert } = require('./harness');
const lists = require('../src/compendium/characterLists');
const db = require('../src/core/db/connection');

let n = 0;
function freshList(names) {
  const scope = `pool-cache-${++n}`;
  db.prepare('DELETE FROM character_lists WHERE owner_scope = ?').run(scope);
  const id = lists.createList(scope, `List ${n}`, 'tester', 'Anime');
  for (const name of names) lists.addCharacter(id, name, 'tester');
  return id;
}
const names = (pool) => pool.map((c) => c.name).sort();

module.exports = {
  'the same pool is served from cache until something changes'() {
    const id = freshList(['A', 'B']);
    const first = lists.drawablePool([id], 'everything');
    assert.equal(lists.drawablePool([id], 'everything'), first, 'the very same array: no rebuild');
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first[0]), 'shared, so frozen against edits');
  },

  'a write through the compendium refreshes it'() {
    const id = freshList(['A', 'B']);
    lists.drawablePool([id], 'everything');
    lists.addCharacter(id, 'C', 'tester');
    assert.deepEqual(names(lists.drawablePool([id], 'everything')), ['A', 'B', 'C']);
    lists.removeCharacter(id, 'A');
    assert.deepEqual(names(lists.drawablePool([id], 'everything')), ['B', 'C']);
    lists.setCharacterImage(id, 'B', 'https://example.com/b.png');
    assert.equal(lists.drawablePool([id], 'everything').find((c) => c.name === 'B').image_url, 'https://example.com/b.png');
  },

  'a write by another process -- a seed script, the bot -- refreshes it too'() {
    const id = freshList(['A', 'B']);
    lists.drawablePool([id], 'everything');
    const other = new Database(process.env.BOT_DB_PATH);
    try {
      other.prepare('INSERT INTO characters (list_id, name, added_by, created_at) VALUES (?, ?, ?, ?)').run(id, 'From Elsewhere', 'script', Date.now());
    } finally {
      other.close();
    }
    assert.ok(names(lists.drawablePool([id], 'everything')).includes('From Elsewhere'));
  },

  'each difficulty and each set of lists is its own pool, in any order'() {
    const a = freshList(['A1', 'A2']);
    const b = freshList(['B1']);
    assert.deepEqual(names(lists.drawablePool([a, b], 'everything')), names(lists.drawablePool([b, a], 'everything')));
    assert.equal(lists.drawablePool([a, b], 'everything'), lists.drawablePool([b, a], 'everything'), 'order does not split the cache');
    assert.equal(lists.drawablePool([a], 'everything').length, 2);
  },

  'drawing from a cached pool never edits it'() {
    const id = freshList(['A', 'B', 'C', 'D', 'E']);
    const before = lists.drawablePool([id], 'everything').map((c) => c.name);
    for (let i = 0; i < 20; i++) lists.getRandomCharacters([id], 3, ['A'], 'everything');
    assert.deepEqual(lists.drawablePool([id], 'everything').map((c) => c.name), before);
  },
};
