// Difficulty (how deep into a cast a draw may go) and the reroll feedback loop.
//
// These are the two mechanisms that address obscurity where it actually lives -- inside a
// list -- which list-level curation cannot reach.

const { assert } = require('./harness');
const lists = require('../src/compendium/characterLists');
const db = require('../src/core/db/connection');

let counter = 0;
function freshGuild() {
  const guildId = `diff-guild-${++counter}`;
  db.prepare('DELETE FROM character_lists WHERE owner_scope = ?').run(guildId);
  return guildId;
}

// `fames` maps character name -> fame, or null for an unranked character.
function seedList(guildId, name, fames) {
  const listId = lists.createList(guildId, name, 'tester', 'Anime', { enabled: true });
  for (const [character, fame] of Object.entries(fames)) {
    lists.addCharacter(listId, character, 'tester');
    if (fame != null) lists.setCharacterFame(listId, character, fame);
  }
  return listId;
}

module.exports = {
  'difficulty keeps the best-known share of a cast'() {
    const guildId = freshGuild();
    // 8 characters: fame descending, so the cut is easy to state exactly.
    const id = seedList(guildId, 'Big Show', {
      Lead: 800, Second: 700, Third: 600, Fourth: 500,
      Fifth: 400, Sixth: 300, Seventh: 200, Eighth: 100,
    });

    const namesAt = (d) => lists.drawablePool([id], d).map((c) => c.name).sort();
    // easy keeps 25% of 8 = 2, normal 60% of 8 = 4.8 -> 5, everything all 8.
    assert.deepEqual(namesAt('easy'), ['Lead', 'Second']);
    assert.equal(namesAt('normal').length, 5);
    assert.ok(namesAt('normal').includes('Fifth'));
    assert.ok(!namesAt('normal').includes('Sixth'));
    assert.equal(namesAt('everything').length, 8);
  },

  // The cut is per list because the two fame scales are incomparable -- a pool-wide
  // threshold would delete every Wikidata-sourced character outright.
  'the cut is applied per list, not across the pooled selection'() {
    const guildId = freshGuild();
    // Wildly different scales, as AniList favourites vs Wikipedia sitelinks really are.
    const anime = seedList(guildId, 'Anime Show', { A1: 40000, A2: 30000, A3: 20000, A4: 10000 });
    const game = seedList(guildId, 'Game Series', { G1: 40, G2: 30, G3: 20, G4: 10 });

    const names = lists.drawablePool([anime, game], 'easy').map((c) => c.name).sort();
    // One from each, rather than four anime and nothing from the game.
    assert.deepEqual(names, ['A1', 'G1']);
  },

  'an unranked list passes through untouched rather than being cut to one'() {
    const guildId = freshGuild();
    const id = seedList(guildId, 'Handmade', { One: null, Two: null, Three: null, Four: null });
    assert.equal(lists.drawablePool([id], 'easy').length, 4, 'unranked is not the same as unpopular');
  },

  'within a partly ranked list, unranked characters are cut first'() {
    const guildId = freshGuild();
    const id = seedList(guildId, 'Mixed', { Known: 500, AlsoKnown: 400, Mystery: null, Other: null });
    assert.deepEqual(
      lists.drawablePool([id], 'normal').map((c) => c.name).sort(),
      ['AlsoKnown', 'Known', 'Mystery']
    );
  },

  'a tiny list still yields something at the harshest setting'() {
    const guildId = freshGuild();
    const id = seedList(guildId, 'Two Hander', { Star: 900, Sidekick: 100 });
    assert.equal(lists.drawablePool([id], 'easy').length, 1, 'never cut to zero');
  },

  'the character count reported for a lobby reflects its difficulty'() {
    const guildId = freshGuild();
    const id = seedList(guildId, 'Show', { A: 400, B: 300, C: 200, D: 100 });
    assert.equal(lists.countDistinctCharacters([id], 'everything'), 4);
    assert.equal(lists.countDistinctCharacters([id], 'easy'), 1);
  },

  // ---------------------------------------------------------------------------
  // The list cut: a pooled draw skips the most obscure shows below Everything
  // ---------------------------------------------------------------------------

  'a pooled draw keeps the best-known lists of each category, and Everything keeps them all'() {
    const guildId = freshGuild();
    const n = lists.POOLED_LISTS * 2;
    const ids = [];
    for (let i = 0; i < n; i++) {
      // Popularity falls with i; five ranked characters each, so no list is tiny.
      const id = seedList(guildId, `Pooled ${i}`, Object.fromEntries([1, 2, 3, 4, 5].map((k) => [`P${i}-${k}`, 10 * k])));
      lists.setListPopularity(id, 1000 - i);
      ids.push(id);
    }
    const listsIn = (d) => new Set(lists.drawablePool(ids, d).map((c) => c.list_id));
    assert.equal(listsIn('everything').size, n, 'nothing is removed');
    assert.equal(listsIn('normal').size, Math.ceil(n * lists.DIFFICULTIES.normal.lists));
    const easy = listsIn('easy');
    assert.equal(easy.size, Math.ceil(n * lists.DIFFICULTIES.easy.lists));
    assert.ok(easy.has(ids[0]) && !easy.has(ids[n - 1]), 'the best-known survive, the most obscure go');
  },

  'tiny lists drop out of a pooled draw, but not out of Everything'() {
    const guildId = freshGuild();
    const ids = [];
    for (let i = 0; i < lists.POOLED_LISTS; i++) {
      const size = i === 0 ? 3 : 5;
      const id = seedList(guildId, `Sized ${i}`, Object.fromEntries([...Array(size)].map((_, k) => [`S${i}-${k}`, 10 + k])));
      lists.setListPopularity(id, 5000); // the tiny one is as popular as any
      ids.push(id);
    }
    assert.ok(!lists.drawablePool(ids, 'normal').some((c) => c.list_id === ids[0]));
    assert.ok(lists.drawablePool(ids, 'everything').some((c) => c.list_id === ids[0]));
  },

  'named lists are never cut, however obscure'() {
    const guildId = freshGuild();
    const ids = [];
    for (let i = 0; i < lists.POOLED_LISTS - 1; i++) {
      const id = seedList(guildId, `Named ${i}`, { [`N${i}`]: 5 });
      lists.setListPopularity(id, i);
      ids.push(id);
    }
    assert.equal(new Set(lists.drawablePool(ids, 'easy').map((c) => c.list_id)).size, ids.length);
  },

  // ---------------------------------------------------------------------------
  // Rerolls are recorded, never acted on
  // ---------------------------------------------------------------------------

  'a character stays in every draw however many people reroll them'() {
    // Rerolls used to retire a character after three different people. They no longer decide
    // anything: one table not knowing someone is no reason to stop dealing them to every table.
    const guildId = freshGuild();
    const id = seedList(guildId, 'Show', { A: 900, B: 800 });
    const b = lists.drawablePool([id], 'everything').find((c) => c.name === 'B');
    for (const user of ['p1', 'p2', 'p3', 'p4', 'p5', 'web-visitor']) lists.recordReroll(b.id, user);

    assert.equal(lists.countRerollers(b.id), 6, 'every reroller is recorded');
    assert.ok(lists.drawablePool([id], 'everything').some((c) => c.name === 'B'), 'still in the pool');
    // The reroll path and the vote's candidate draw both go through the same pool.
    assert.deepEqual(lists.getRandomCharacters([id], 5, [], 'everything').map((c) => c.name).sort(), ['A', 'B']);
    assert.equal(lists.getRandomCharacterExcluding([id], new Set(['A']), 'everything').name, 'B');
  },

  'one person rerolling repeatedly is recorded once'() {
    const guildId = freshGuild();
    const id = seedList(guildId, 'Show', { A: 900, B: 800, C: 700 });
    const b = lists.drawablePool([id], 'everything').find((c) => c.name === 'B');

    for (let i = 0; i < 5; i++) lists.recordReroll(b.id, 'same-person');
    assert.equal(lists.countRerollers(b.id), 1, 'deduped per user');
  },
};
