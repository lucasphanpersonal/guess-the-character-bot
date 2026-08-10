// `/list add` autocomplete -- the character box suggests names already in the named list.
//
// Regression guard: this used to call searchCharactersInLists(guildId, value, [listName]),
// passing a guildId string where an array of list ids was expected. getCharactersForLists
// ran listIds.map(...) on a string and threw TypeError on every keystroke, which the global
// autocomplete try/catch swallowed into an empty, silent field.

const { assert, createRecorder, createFakeClient, createSlashInteraction } = require('./harness');
const add = require('../src/commands/actions/list-add');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;
function seed() {
  const guildId = `list-add-ac-guild-${++counter}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  const mario = lists.createList(guildId, 'Mario Bros', 'tester', 'Video Games');
  lists.addCharacter(mario, 'Mario', 'tester');
  lists.addCharacter(mario, 'Luigi', 'tester');
  lists.addCharacter(mario, 'Princess Peach', 'tester');
  // A second list whose characters must NOT leak into the first list's suggestions.
  const zelda = lists.createList(guildId, 'Zelda', 'tester', 'Video Games');
  lists.addCharacter(zelda, 'Marin', 'tester'); // also starts with "Mar"
  return { guildId };
}

const autocomplete = async (guildId, options) => {
  const recorder = createRecorder();
  const client = createFakeClient(recorder);
  await add.autocomplete(
    createSlashInteraction({ client, userId: 'u', guildId, channelId: 'ch', recorder, options })
  );
  return JSON.parse(recorder.lastMatching('autocomplete:u').content);
};

module.exports = {
  async 'character autocomplete suggests matching names from the named list (and does not throw)'() {
    const { guildId } = seed();
    const results = await autocomplete(guildId, { list: 'Mario Bros', __focused: { name: 'character', value: 'mar' } });
    const names = results.map((r) => r.name);
    assert.deepEqual(names, ['Mario']);
    // The value is the plain name, so picking a suggestion fills the box with it.
    assert.equal(results[0].value, 'Mario');
  },

  async 'character autocomplete is scoped to the named list, not the whole guild'() {
    const { guildId } = seed();
    // "Marin" lives in the Zelda list and starts with "Mar" too -- it must not appear when
    // adding to Mario Bros.
    const names = (await autocomplete(guildId, { list: 'Mario Bros', __focused: { name: 'character', value: 'mar' } })).map((r) => r.name);
    assert.ok(!names.includes('Marin'), `Zelda's Marin leaked into Mario Bros suggestions: ${names.join(', ')}`);
  },

  async 'character autocomplete before a list is chosen suggests nothing'() {
    const { guildId } = seed();
    assert.deepEqual(await autocomplete(guildId, { list: null, __focused: { name: 'character', value: 'mar' } }), []);
  },

  async 'character autocomplete for an unknown list suggests nothing rather than throwing'() {
    const { guildId } = seed();
    assert.deepEqual(await autocomplete(guildId, { list: 'No Such List', __focused: { name: 'character', value: 'mar' } }), []);
  },

  async 'list autocomplete still suggests list names'() {
    const { guildId } = seed();
    const names = (await autocomplete(guildId, { __focused: { name: 'list', value: 'mario' } })).map((r) => r.name);
    assert.ok(names.includes('Mario Bros'));
  },
};
