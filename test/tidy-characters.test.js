// The one-off library tidy: merges, pair splits, image clears and fills, and an exact undo.

const { assert } = require('./harness');
const db = require('../src/core/db/connection');
const lists = require('../src/compendium/characterLists');
const { plan, apply, undo } = require('../scripts/tidy-characters');

const snapshot = () => ({
  characters: db.prepare('SELECT * FROM characters ORDER BY id').all(),
  rerolls: db.prepare('SELECT * FROM character_rerolls ORDER BY id').all(),
});

// Shared lists named as the script names them. Built once: list names are unique in the shared
// compendium, and the script finds its rows by those names.
let built = null;
function library() {
  if (built) return built;
  const fate = lists.createList(null, 'Fate/stay night', 'tester', 'Anime');
  const keep = lists.addCharacter(fate, 'Rin Tohsaka', 'tester');
  const gone = lists.addCharacter(fate, 'Tohsaka Rin', 'tester', 'https://s4.anilist.co/rin.png');
  lists.setCharacterFame(fate, 'Tohsaka Rin', 900);
  lists.recordReroll(gone, 'someone');

  const splatoon = lists.createList(null, 'Splatoon', 'tester', 'Video Games');
  lists.addCharacter(splatoon, 'Callie and Marie', 'tester', 'https://static.wikia.nocookie.net/splatoon/pair.png');
  lists.setCharacterFame(splatoon, 'Callie and Marie', 40);

  const shrek = lists.createList(null, 'Shrek 2', 'tester', 'Movies');
  lists.addCharacter(shrek, 'Shrek', 'tester');
  lists.addCharacter(shrek, 'Princess Fiona', 'tester');
  lists.addCharacter(shrek, 'Shrek and Fiona', 'tester');

  // A longer name starting with a member's is somebody else: Max must still be added.
  const lookism = lists.createList(null, 'Lookism', 'tester', 'Manga');
  lists.addCharacter(lookism, 'Max and Derrick', 'tester');
  lists.addCharacter(lookism, 'Max Zhang', 'tester');

  const dragonAge = lists.createList(null, 'Dragon Age', 'tester', 'Video Games');
  const leliana = lists.addCharacter(dragonAge, 'Leliana', 'tester', 'https://s4.anilist.co/default.jpg');
  const morrigan = lists.addCharacter(dragonAge, 'Morrigan', 'tester');

  built = { fate, keep, gone, splatoon, shrek, lookism, dragonAge, leliana, morrigan };
  return built;
}

const namesIn = (listId) => db.prepare('SELECT name FROM characters WHERE list_id = ? ORDER BY name').all(listId).map((r) => r.name);

module.exports = {
  'apply merges duplicates, splits pairs, clears placeholders and fills images; undo puts it all back'() {
    const lib = library();
    const before = snapshot();
    const fills = [{ id: lib.morrigan, list_id: lib.dragonAge, name: 'Morrigan', image_url: 'https://static.wikia.nocookie.net/dragonage/morrigan.png' }];

    const p = plan(db, { images: fills });
    const added = apply(db, p);

    assert.deepEqual(namesIn(lib.fate), ['Rin Tohsaka']);
    const rin = db.prepare('SELECT fame, image_url FROM characters WHERE id = ?').get(lib.keep);
    assert.equal(rin.fame, 900, 'the kept row takes the fame');
    assert.equal(rin.image_url, 'https://s4.anilist.co/rin.png', 'and the picture');
    assert.equal(lists.countRerollers(lib.keep), 1, 'and the reroll');

    assert.deepEqual(namesIn(lib.splatoon), ['Callie', 'Marie'], 'a pair with no members is split');
    const callie = db.prepare('SELECT fame, image_url FROM characters WHERE list_id = ? AND name = ?').get(lib.splatoon, 'Callie');
    assert.equal(callie.fame, 40, 'members keep the pair\'s fame');
    assert.equal(callie.image_url, null, 'but not its two-person picture');
    assert.deepEqual(namesIn(lib.shrek), ['Princess Fiona', 'Shrek'], 'members already there are not added twice');

    const img = (id) => db.prepare('SELECT image_url FROM characters WHERE id = ?').get(id).image_url;
    assert.equal(img(lib.leliana), null, 'placeholder cleared');
    assert.equal(img(lib.morrigan), fills[0].image_url, 'image filled');
    assert.deepEqual(namesIn(lib.lookism), ['Derrick', 'Max', 'Max Zhang'], 'Max Zhang is not Max');
    assert.equal(added.length, 4);

    undo(db, { merges: p.merges, pairs: p.pairs, cleared: p.cleared, filled: p.filled, added });
    assert.deepEqual(snapshot(), before, 'undo restores every row exactly');
  },

  'a fill never overwrites an image, and a missing row is reported rather than guessed'() {
    const lib = library();
    const p = plan(db, {
      images: [
        { id: lib.leliana, list_id: lib.dragonAge, name: 'Leliana', image_url: 'https://example.invalid/x.png' },
        { id: lib.morrigan, list_id: lib.dragonAge, name: 'Somebody Else', image_url: 'https://example.invalid/y.png' },
        { id: lib.morrigan, list_id: lib.dragonAge, name: 'Morrigan', image_url: 'http://example.invalid/z.png' },
      ],
    });
    assert.equal(p.filled.length, 0, 'not over an image, not when the name has drifted, not over http');
    assert.ok(p.missing.some((m) => m.includes('Big Hero 6')), 'lists absent from this database are reported');
  },
};
