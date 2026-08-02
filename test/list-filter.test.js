// The /list-filter checkbox page, and the rule it exists to enforce: pooled draws see only
// the enabled selection, naming a list outright sees everything.

const { assert, createRecorder, createFakeClient, createSlashInteraction } = require('./harness');
const { handleComponentInteraction } = require('../src/components/router');
const listFilter = require('../src/components/listFilter');
const createLobby = require('../src/commands/actions/lobby-create');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

function freshGuild() {
  const guildId = `filter-guild-${++counter}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
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

function click({ guildId, customId, recorder, values }) {
  return handleComponentInteraction({
    customId,
    guildId,
    user: { id: 'curator' },
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
    lists.setListsEnabled([a], true);

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
    lists.setListsEnabled([famous], true);

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
    lists.setListsEnabled([drop, other], true);

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
      lists.listsForFilter(guildId, 'Anime').map((l) => l.id),
      true
    );

    const recorder = createRecorder();
    await click({ guildId, customId: 'filter:none:0:0', recorder });
    assert.equal(lists.getEnabledLists(guildId).length, 5, 'only page two survives');
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
    lists.setListsEnabled([on], true);
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
    lists.enableTopN(guildId, null, 5);
    const enabled = lists.getEnabledLists(guildId).map((l) => l.name);
    assert.equal(enabled.length, 10);
    assert.ok(enabled.includes('Anime 00') && enabled.includes('Game 00'));
    assert.ok(!enabled.includes('Anime 05'), 'the tail stays off');
  },

  'enabling the top N is additive, so a curated pick survives a re-run'() {
    const guildId = freshGuild();
    for (let i = 0; i < 10; i++) {
      seed(guildId, `Show ${String(i).padStart(2, '0')}`, 'Anime', { popularity: 100 - i });
    }
    const favourite = lists.getListByName(guildId, 'Show 09').id;
    lists.setListsEnabled([favourite], true);

    const added = lists.enableTopN(guildId, 'Anime', 3);
    assert.equal(added, 3, 'only counts the newly switched on');
    const enabled = lists.getEnabledLists(guildId).map((l) => l.name);
    assert.equal(enabled.length, 4, 'the hand-picked one was not dropped');
    assert.ok(enabled.includes('Show 09'));
  },

  'asking for more than a category holds enables all of it without erroring'() {
    const guildId = freshGuild();
    seed(guildId, 'Only One', 'Anime', { popularity: 5 });
    assert.equal(lists.enableTopN(guildId, 'Anime', 100), 1);
    assert.equal(lists.getEnabledLists(guildId).length, 1);
  },

  'toggling by name flips a list both ways'() {
    const guildId = freshGuild();
    const id = seed(guildId, 'Flip Me', 'Anime');
    assert.equal(lists.toggleListEnabled(id), true, 'off -> on');
    assert.deepEqual(lists.getEnabledLists(guildId).map((l) => l.name), ['Flip Me']);
    assert.equal(lists.toggleListEnabled(id), false, 'on -> off');
    assert.deepEqual(lists.getEnabledLists(guildId), []);
  },

  async 'the top option reports what it changed instead of opening the page'() {
    const guildId = freshGuild();
    for (let i = 0; i < 10; i++) {
      seed(guildId, `Show ${String(i).padStart(2, '0')}`, 'Anime', { popularity: 100 - i });
    }
    const recorder = createRecorder();

    await require('../src/commands/actions/list-select').execute(
      createSlashInteraction({
        client: createFakeClient(recorder),
        userId: 'curator',
        guildId,
        channelId: 'chan',
        options: { top: 4 },
        recorder,
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
    const toggle = require('../src/commands/actions/list-toggle');

    const run = () =>
      toggle.execute(
        createSlashInteraction({
          client: createFakeClient(recorder),
          userId: 'curator',
          guildId,
          channelId: 'chan',
          options: { list: 'Cowboy Bebop' },
          recorder,
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
    lists.setListsEnabled([on], true);
    const recorder = createRecorder();

    await require('../src/commands/actions/list-toggle').autocomplete(
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
