const { assert, createRecorder, createFakeClient, createSlashInteraction } = require('./harness');
const create = require('../src/commands/actions/list-create');
const add = require('../src/commands/actions/list-add');
const remove = require('../src/commands/actions/list-remove');
const image = require('../src/commands/actions/list-image');
const toggle = require('../src/commands/actions/list-toggle');
const select = require('../src/commands/actions/list-select');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

function interaction(recorder, guildId, options) {
  return createSlashInteraction({
    client: createFakeClient(recorder),
    userId: 'member',
    guildId,
    channelId: 'permissions-channel',
    options,
    recorder,
  });
}

module.exports = {
  async 'non-managers cannot mutate shared lists through slash commands'() {
    const guildId = `permissions-guild-${++counter}`;
    db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
    const listId = lists.createList(guildId, 'Existing', 'owner', 'Anime');
    lists.addCharacter(listId, 'Original', 'owner');
    lists.createList(guildId, 'Second', 'owner', 'Anime');
    const recorder = createRecorder();

    await create.execute(interaction(recorder, guildId, { name: 'Denied', category: 'Anime' }));
    await add.execute(interaction(recorder, guildId, { list: 'Existing', character: 'Injected' }));
    await remove.execute(interaction(recorder, guildId, { list: 'Existing', character: 'Original' }));
    await image.execute(interaction(recorder, guildId, {
      list: 'Existing',
      character: 'Original',
      image: 'https://example.com/original.png',
    }));
    await toggle.execute(interaction(recorder, guildId, { list: 'Existing' }));
    await select.execute(interaction(recorder, guildId, { top: 1 }));

    assert.equal(lists.getListByName(guildId, 'Denied'), null);
    assert.equal(lists.getCharacterByNameInLists([listId], 'Injected'), null);
    assert.equal(lists.getCharacterByNameInLists([listId], 'Original').image_url, null);
    assert.equal(lists.getEnabledLists(guildId).length, 0);
    assert.equal((recorder.allText().match(/Manage Server permission/g) ?? []).length, 6);
  },
};
