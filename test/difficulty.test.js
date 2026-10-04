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
  // Learning from rerolls
  // ---------------------------------------------------------------------------

  'a character is retired once enough different people reject it'() {
    const guildId = freshGuild();
    const id = seedList(guildId, 'Show', { Famous: 900, Nobody: 800, Filler: 700, Extra: 600 });
    const nobody = lists.drawablePool([id], 'everything').find((c) => c.name === 'Nobody');

    assert.equal(lists.recordReroll(nobody.id, 'p1'), 1);
    assert.equal(lists.recordReroll(nobody.id, 'p2'), 2);
    assert.ok(
      lists.drawablePool([id], 'everything').some((c) => c.name === 'Nobody'),
      'still dealt below the threshold'
    );

    assert.equal(lists.recordReroll(nobody.id, 'p3'), lists.REROLL_DEMOTE_THRESHOLD);
    assert.ok(
      !lists.drawablePool([id], 'everything').some((c) => c.name === 'Nobody'),
      'retired once the threshold is met'
    );
  },

  'one person rerolling repeatedly is not mistaken for a consensus'() {
    const guildId = freshGuild();
    const id = seedList(guildId, 'Show', { A: 900, B: 800, C: 700 });
    const b = lists.drawablePool([id], 'everything').find((c) => c.name === 'B');

    for (let i = 0; i < 5; i++) lists.recordReroll(b.id, 'same-person');
    assert.equal(lists.countRerollers(b.id), 1, 'deduped per user');
    assert.ok(lists.drawablePool([id], 'everything').some((c) => c.name === 'B'), 'still in the pool');
  },

  'a retired character is excluded from every random draw, not just the deal'() {
    const guildId = freshGuild();
    const id = seedList(guildId, 'Show', { A: 900, B: 800 });
    const b = lists.drawablePool([id], 'everything').find((c) => c.name === 'B');
    for (const user of ['p1', 'p2', 'p3']) lists.recordReroll(b.id, user);

    assert.deepEqual(lists.demotedCharacterIds([id]), new Set([b.id]));
    // The reroll path and the vote's candidate draw both go through the same pool.
    assert.equal(lists.getRandomCharacterExcluding([id], new Set(), 'everything').name, 'A');
    assert.deepEqual(
      lists.getRandomCharacters([id], 5, [], 'everything').map((c) => c.name),
      ['A']
    );
  },

  'retiring is reversible -- the rows are the whole state'() {
    const guildId = freshGuild();
    const id = seedList(guildId, 'Show', { A: 900, B: 800 });
    const b = lists.drawablePool([id], 'everything').find((c) => c.name === 'B');
    for (const user of ['p1', 'p2', 'p3']) lists.recordReroll(b.id, user);
    assert.equal(lists.drawablePool([id], 'everything').length, 1);

    db.prepare('DELETE FROM character_rerolls WHERE character_id = ?').run(b.id);
    assert.equal(lists.drawablePool([id], 'everything').length, 2);
  },
};
