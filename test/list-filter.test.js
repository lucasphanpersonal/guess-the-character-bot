// The /list-filter checkbox page, and the rule it exists to enforce: pooled draws see only
// the enabled selection, naming a list outright sees everything.

const { assert, createRecorder, createFakeClient, createSlashInteraction } = require('./harness');
const { handleComponentInteraction } = require('../src/discord/components/router');
const listFilter = require('../src/discord/components/listFilter');
const createLobby = require('../src/discord/commands/actions/lobby-create');
const GameManager = require('../src/core/game/GameManager');
const lists = require('../src/compendium/characterLists');
const db = require('../src/core/db/connection');

let counter = 0;

function freshGuild() {
  const guildId = `filter-guild-${++counter}`;
  db.prepare('DELETE FROM character_lists WHERE owner_scope = ?').run(guildId);
  return guildId;
}

function seed(guildId, name, category, { popularity = null, characters = 2 } = {}) {
  const id = lists.createList(guildId, name, 'tester', category);
  for (let i = 0; i < characters; i++) lists.addCharacter(id, `${name} Char ${i}`, 'tester');
  if (popularity != null) lists.setPopularityByName(guildId, name, popularity);
  return id;
}

// The page is built from real discord.js builders, so assert against the serialised shape
// Discord would actually receive.
function componentsOf(payload) {
  return payload.components.map((row) => row.toJSON().components);
}

function selectsOf(payload) {
  return componentsOf(payload)
    .flat()
    .filter((c) => c.type === 3);
}

function buttonsOf(payload) {
  return componentsOf(payload)
    .flat()
    .filter((c) => c.type === 2);
}

function click({ guildId, customId, recorder, values, canManageGuild = true }) {
  return handleComponentInteraction({
    customId,
    guildId,
    user: { id: 'curator' },
    memberPermissions: { has: () => canManageGuild },
    values,
    update: async (payload) => recorder.record('update:curator', payload, 'chan'),
    reply: async (payload) => recorder.record('reply:curator', payload, 'chan'),
  });
}

module.exports = {
  'the category page counts what is enabled and offers a button per category'() {
    const guildId = freshGuild();
    const a = seed(guildId, 'Naruto', 'Anime');
    seed(guildId, 'Bleach', 'Anime');
    seed(guildId, 'Zelda', 'Video Games');
    lists.setListsEnabled(guildId, [a], true);

    const payload = listFilter.categoriesView(guildId, 0);
    assert.match(payload.content, /1 of 2 enabled/, 'Anime is partly on');
    assert.match(payload.content, /0 of 1 enabled/, 'Video Games is off');
    assert.match(payload.content, /\*\*1\*\* of 3 lists enabled/, 'server total');

    const labels = buttonsOf(payload).map((b) => b.label);
    assert.deepEqual(labels, ['Anime', 'Video Games']);
  },

  'a category renders as checkboxes, pre-ticked to match what is enabled'() {
    const guildId = freshGuild();
    const famous = seed(guildId, 'Famous', 'Anime', { popularity: 400000, characters: 7 });
    seed(guildId, 'Obscure', 'Anime', { popularity: 12 });
    lists.setListsEnabled(guildId, [famous], true);

    const [menu] = selectsOf(listFilter.categoryView(guildId, 0, 0));
    // min 0 is what makes "untick everything" a submittable answer rather than a no-op.
    assert.equal(menu.min_values, 0);
    assert.equal(menu.max_values, 2);
    assert.deepEqual(menu.options.map((o) => o.label), ['Famous', 'Obscure'], 'best-known first');
    assert.equal(menu.options[0].default, true, 'enabled list is ticked');
    assert.equal(menu.options[1].default, false);
    assert.match(menu.options[0].description, /7 characters/);
  },

  'a page splits across menus of 25 and paginates past 75'() {
    const guildId = freshGuild();
    for (let i = 0; i < 80; i++) {
      seed(guildId, `Show ${String(i).padStart(3, '0')}`, 'Anime', { popularity: 1000 - i });
    }

    const first = listFilter.categoryView(guildId, 0, 0);
    const menus = selectsOf(first);
    assert.equal(menus.length, 3, 'three menus fill a page');
    assert.deepEqual(menus.map((m) => m.options.length), [25, 25, 25]);
    assert.equal(menus[0].options[0].label, 'Show 000', 'most popular first');
    assert.match(first.content, /Page 1 of 2/);

    const second = listFilter.categoryView(guildId, 0, 1);
    assert.deepEqual(selectsOf(second).map((m) => m.options.length), [5], 'remainder');
  },

  async 'ticking a menu enables exactly what it returned and disables the rest'() {
    const guildId = freshGuild();
    const keep = seed(guildId, 'Keep', 'Anime', { popularity: 300 });
    const drop = seed(guildId, 'Drop', 'Anime', { popularity: 200 });
    const other = seed(guildId, 'Other', 'Anime', { popularity: 100 });
    lists.setListsEnabled(guildId, [drop, other], true);

    const recorder = createRecorder();
    await click({
      guildId,
      customId: 'filter:pick:0:0:0',
      values: [String(keep), String(other)],
      recorder,
    });

    const enabled = lists.getEnabledLists(guildId).map((l) => l.name).sort();
    assert.deepEqual(enabled, ['Keep', 'Other'], 'unreturned options were switched off');
    assert.match(recorder.allText(), /\*\*2\*\* of 3 enabled/, 'the page re-rendered with the new state');
  },

  async 'Enable page switches on only the current page, not the whole category'() {
    const guildId = freshGuild();
    for (let i = 0; i < 80; i++) {
      seed(guildId, `Show ${String(i).padStart(3, '0')}`, 'Anime', { popularity: 1000 - i });
    }

    const recorder = createRecorder();
    await click({ guildId, customId: 'filter:all:0:0', recorder });
    assert.equal(lists.getEnabledLists(guildId).length, 75, 'page one only');

    // Page 1 is the 75 best-known, which is the point of sorting by fame.
    const names = lists.getEnabledLists(guildId).map((l) => l.name);
    assert.ok(names.includes('Show 000'));
    assert.ok(!names.includes('Show 079'));

    await click({ guildId, customId: 'filter:clear:0:0', recorder });
    assert.equal(lists.getEnabledLists(guildId).length, 0, 'Disable all clears the category');
  },

  async 'Disable page leaves other pages alone'() {
    const guildId = freshGuild();
    for (let i = 0; i < 80; i++) {
      seed(guildId, `Show ${String(i).padStart(3, '0')}`, 'Anime', { popularity: 1000 - i });
    }
    lists.setListsEnabled(
      guildId,
      lists.listsForFilter(guildId, 'Anime').map((l) => l.id),
      true
    );

    const recorder = createRecorder();
    await click({ guildId, customId: 'filter:none:0:0', recorder });
    assert.equal(lists.getEnabledLists(guildId).length, 5, 'only page two survives');
  },

  async 'only managers can change the shared list selection'() {
    const guildId = freshGuild();
    seed(guildId, 'Naruto', 'Anime');
    const recorder = createRecorder();

    await click({ guildId, customId: 'filter:all:0:0', recorder, canManageGuild: false });

    assert.equal(lists.getEnabledLists(guildId).length, 0);
    assert.match(recorder.allText(), /Manage Server permission/);
  },

  // ---------------------------------------------------------------------------
  // What the selection actually governs
  // ---------------------------------------------------------------------------

  async 'a category draw with nothing enabled explains itself instead of failing silently'() {
    const guildId = freshGuild();
    seed(guildId, 'Naruto', 'Anime');
    const channelId = `filter-chan-${guildId}`;
    const recorder = createRecorder();

    await createLobby.execute(
      createSlashInteraction({
        client: createFakeClient(recorder),
        userId: 'host',
        guildId,
        channelId,
        options: { from: '::cat:Anime' },
        recorder,
      })
    );

    assert.equal(GameManager.getLobby(channelId), undefined, 'no lobby');
    assert.match(recorder.allText(), /none of them are enabled/);
    assert.match(recorder.allText(), /list select/, 'says how to fix it');
  },

  async 'everything:true draws only from the enabled selection'() {
    const guildId = freshGuild();
    const on = seed(guildId, 'Enabled Show', 'Anime', { characters: 3 });
    seed(guildId, 'Disabled Show', 'Anime', { characters: 3 });
    lists.setListsEnabled(guildId, [on], true);
    const channelId = `filter-chan-all-${guildId}`;
    const recorder = createRecorder();

    await createLobby.execute(
      createSlashInteraction({
        client: createFakeClient(recorder),
        userId: 'host',
        guildId,
        channelId,
        options: { from: '::everything' },
        recorder,
      })
    );

    const lobby = GameManager.getLobby(channelId);
    assert.deepEqual(lobby.listIds, [on], 'the disabled list was left out');
    GameManager.endLobby(channelId);
  },

  async 'naming a disabled list directly still works'() {
    const guildId = freshGuild();
    seed(guildId, 'Disabled Show', 'Anime', { characters: 3 });
    const channelId = `filter-chan-named-${guildId}`;
    const recorder = createRecorder();

    await createLobby.execute(
      createSlashInteraction({
        client: createFakeClient(recorder),
        userId: 'host',
        guildId,
        channelId,
        options: { from: 'Disabled Show' },
        recorder,
      })
    );

    const lobby = GameManager.getLobby(channelId);
    assert.ok(lobby, 'the lobby was created despite the list being disabled');
    assert.deepEqual(lobby.listNames, ['Disabled Show']);
    GameManager.endLobby(channelId);
  },

  async 'a server with lists but none enabled is told what to do'() {
    const guildId = freshGuild();
    seed(guildId, 'A', 'Anime');
    seed(guildId, 'B', 'Video Games');
    const channelId = `filter-chan-none-${guildId}`;
    const recorder = createRecorder();

    await createLobby.execute(
      createSlashInteraction({
        client: createFakeClient(recorder),
        userId: 'host',
        guildId,
        channelId,
        options: { from: '::random' },
        recorder,
      })
    );

    assert.equal(GameManager.getLobby(channelId), undefined);
    const text = recorder.allText();
    assert.match(text, /None of this server's 2 lists are enabled/);
    assert.doesNotMatch(text, /No character lists exist/, 'a different problem from having none');
  },

  // ---------------------------------------------------------------------------
  // Curating without the checkbox page
  // ---------------------------------------------------------------------------

  'enabling the top N takes the best-known and leaves the tail alone'() {
    const guildId = freshGuild();
    for (let i = 0; i < 20; i++) {
      seed(guildId, `Anime ${String(i).padStart(2, '0')}`, 'Anime', { popularity: 1000 - i });
    }
    for (let i = 0; i < 20; i++) {
      seed(guildId, `Game ${String(i).padStart(2, '0')}`, 'Video Games', { popularity: 500 - i });
    }

    // No category given: every category gets its own top 5, not 5 lists overall.
    lists.setTopN(guildId, null, 5);
    const enabled = lists.getEnabledLists(guildId).map((l) => l.name);
    assert.equal(enabled.length, 10);
    assert.ok(enabled.includes('Anime 00') && enabled.includes('Game 00'));
    assert.ok(!enabled.includes('Anime 05'), 'the tail stays off');
  },

  // Exact, not additive: 'top 50' means the top 50 IS the selection. The additive version
  // could only grow one, so asking a category that already had 150 on for its top 50 did
  // nothing at all while still reporting success.
  'setting the top N switches off everything below the line'() {
    const guildId = freshGuild();
    for (let i = 0; i < 10; i++) {
      seed(guildId, `Show ${String(i).padStart(2, '0')}`, 'Anime', { popularity: 100 - i });
    }
    lists.setListsEnabled(guildId, lists.listsForFilter(guildId, 'Anime').map((l) => l.id), true);
    assert.equal(lists.getEnabledLists(guildId).length, 10);

    const { enabled, disabled } = lists.setTopN(guildId, 'Anime', 3);
    assert.equal(enabled, 0, 'the top 3 were already on');
    assert.equal(disabled, 7);
    assert.deepEqual(
      lists.getEnabledLists(guildId).map((l) => l.name).sort(),
      ['Show 00', 'Show 01', 'Show 02']
    );
  },

  'a hand-picked extra below the line is dropped, and says so via the counts'() {
    const guildId = freshGuild();
    for (let i = 0; i < 10; i++) {
      seed(guildId, `Show ${String(i).padStart(2, '0')}`, 'Anime', { popularity: 100 - i });
    }
    const favourite = lists.getListByName(guildId, 'Show 09').id;
    lists.setListsEnabled(guildId, [favourite], true);

    const { enabled, disabled } = lists.setTopN(guildId, 'Anime', 3);
    assert.equal(enabled, 3);
    assert.equal(disabled, 1, 'the hand-picked one was below the line');
    assert.ok(!lists.getEnabledLists(guildId).some((l) => l.name === 'Show 09'));
  },

  'asking for more than a category holds enables all of it without erroring'() {
    const guildId = freshGuild();
    seed(guildId, 'Only One', 'Anime', { popularity: 5 });
    assert.equal(lists.setTopN(guildId, 'Anime', 100).enabled, 1);
    assert.equal(lists.getEnabledLists(guildId).length, 1);
  },

  'toggling by name flips a list both ways'() {
    const guildId = freshGuild();
    const id = seed(guildId, 'Flip Me', 'Anime');
    assert.equal(lists.toggleListEnabled(guildId, id), true, 'off -> on');
    assert.deepEqual(lists.getEnabledLists(guildId).map((l) => l.name), ['Flip Me']);
    assert.equal(lists.toggleListEnabled(guildId, id), false, 'on -> off');
    assert.deepEqual(lists.getEnabledLists(guildId), []);
  },

  async 'the top option reports what it changed instead of opening the page'() {
    const guildId = freshGuild();
    for (let i = 0; i < 10; i++) {
      seed(guildId, `Show ${String(i).padStart(2, '0')}`, 'Anime', { popularity: 100 - i });
    }
    const recorder = createRecorder();

    await require('../src/discord/commands/actions/list-select').execute(
      createSlashInteraction({
        client: createFakeClient(recorder),
        userId: 'curator',
        guildId,
        channelId: 'chan',
        options: { top: 4 },
        recorder,
        canManageGuild: true,
      })
    );

    assert.equal(lists.getEnabledLists(guildId).length, 4);
    const text = recorder.allText();
    assert.match(text, /top 4/);
    assert.match(text, /\*\*4\*\* lists enabled in total/);
  },

  async 'list-toggle switches one list and says which way it went'() {
    const guildId = freshGuild();
    seed(guildId, 'Cowboy Bebop', 'Anime', { characters: 4 });
    const recorder = createRecorder();
    const toggle = require('../src/discord/commands/actions/list-toggle');

    const run = () =>
      toggle.execute(
        createSlashInteraction({
          client: createFakeClient(recorder),
          userId: 'curator',
          guildId,
          channelId: 'chan',
          options: { list: 'Cowboy Bebop' },
          recorder,
          canManageGuild: true,
        })
      );

    await run();
    assert.equal(lists.getEnabledLists(guildId).length, 1);
    assert.match(recorder.allText(), /now in the pool \(4 characters\)/);

    await run();
    assert.equal(lists.getEnabledLists(guildId).length, 0);
    assert.match(recorder.allText(), /out of the pool/);
  },

  async 'list-toggle autocomplete shows the current state of each match'() {
    const guildId = freshGuild();
    const on = seed(guildId, 'Enabled Show', 'Anime');
    seed(guildId, 'Disabled Show', 'Anime');
    lists.setListsEnabled(guildId, [on], true);
    const recorder = createRecorder();

    await require('../src/discord/commands/actions/list-toggle').autocomplete(
      createSlashInteraction({
        client: createFakeClient(recorder),
        userId: 'curator',
        guildId,
        channelId: 'chan',
        options: { __focused: { name: 'list', value: 'Show' } },
        recorder,
      })
    );

    const choices = JSON.parse(recorder.last().content);
    const byValue = Object.fromEntries(choices.map((c) => [c.value, c.name]));
    assert.match(byValue['Enabled Show'], /^✅/);
    assert.match(byValue['Disabled Show'], /^⬜/);
    // The category too, so picking one list out of thousands doesn't need prior knowledge
    // of which shelf it is on.
    assert.match(byValue['Enabled Show'], /Anime/);
  },

  'a list created by hand is enabled straight away'() {
    const guildId = freshGuild();
    lists.createList(guildId, 'Handmade', 'tester', 'Anime', { enabled: true });
    assert.deepEqual(
      lists.getEnabledLists(guildId).map((l) => l.name),
      ['Handmade']
    );
  },
};
