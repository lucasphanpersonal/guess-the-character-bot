// Covers `/list-show` pagination. The thing worth testing is that no page can exceed
// Discord's 2000-character message limit -- that limit is why pagination exists, and a
// seeded server has lists with hundreds of characters in them.

const { assert } = require('./harness');
const lists = require('../src/core/db/characterLists');
const db = require('../src/core/db/connection');
const browser = require('../src/discord/components/listBrowser');

let guildCounter = 0;
function freshGuild() {
  const guildId = `browse-guild-${++guildCounter}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  return guildId;
}

function seed(guildId, name, category, names) {
  const listId = lists.createList(guildId, name, 'tester', category);
  for (const n of names) lists.addCharacter(listId, n, 'tester');
  return listId;
}

const DISCORD_LIMIT = 2000;

module.exports = {
  'the categories view paginates and never exceeds the message limit'() {
    const guildId = freshGuild();
    for (let i = 0; i < 40; i++) seed(guildId, `List ${i}`, `Category ${i % 25}`, ['A', 'B', 'C']);

    const first = browser.buildBrowsePayload(guildId, 'cat', 0, 0);
    assert.ok(first.content.length <= DISCORD_LIMIT, 'page 1 within limit');
    assert.ok(/Page 1 of \d+/.test(first.content), 'shows page position');
    assert.equal(first.components.length, 1, 'has a nav row');

    const [prev, next] = first.components[0].components;
    assert.equal(prev.data.disabled, true, 'Prev disabled on the first page');
    assert.equal(next.data.disabled, false, 'Next enabled when more pages exist');
  },

  'a list with hundreds of characters splits into pages that all fit'() {
    const guildId = freshGuild();
    // One Piece-sized, with long names -- the case that used to truncate.
    const names = Array.from({ length: 800 }, (_, i) => `Character Number ${i} Of The Grand Line`);
    const listId = seed(guildId, 'One Piece', 'Anime', names);

    let page = 0;
    let seen = 0;
    for (;;) {
      const payload = browser.buildBrowsePayload(guildId, 'chars', listId, page);
      assert.ok(
        payload.content.length <= DISCORD_LIMIT,
        `page ${page + 1} is ${payload.content.length} chars, over the limit`
      );
      seen += browser.CHARACTERS_PER_PAGE;
      const next = payload.components[0].components[1];
      if (next.data.disabled) break;
      page++;
      if (page > 50) throw new Error('pagination did not terminate');
    }
    assert.ok(seen >= names.length, 'every character is reachable by paging');
  },

  'paging past the end clamps to the last page rather than showing nothing'() {
    const guildId = freshGuild();
    const listId = seed(guildId, 'Tiny', 'Anime', ['Ed', 'Edd', 'Eddy']);

    const payload = browser.buildBrowsePayload(guildId, 'chars', listId, 99);
    assert.ok(payload.content.includes('Ed'), 'still renders the only page');
    assert.ok(/Page 1 of 1/.test(payload.content), 'clamped to page 1');
  },

  'opening a category lists it, and the character view offers a way back'() {
    const guildId = freshGuild();
    const listId = seed(guildId, 'Cowboy Bebop', 'Anime', ['Spike Spiegel', 'Faye Valentine', 'Jet Black']);

    const category = browser.payloadForCategory(guildId, 'Anime');
    assert.ok(category.content.includes('Cowboy Bebop'), 'category lists its lists');

    const chars = browser.payloadForList(guildId, 'Cowboy Bebop');
    assert.ok(chars.content.includes('Spike Spiegel'), 'shows characters');
    const labels = chars.components[0].components.map((b) => b.data.label);
    assert.deepEqual(labels, ['Prev', 'Next', 'Back'], 'has a Back button');
    void listId;
  },

  'a missing list or category reports it instead of throwing'() {
    const guildId = freshGuild();
    seed(guildId, 'Anime', 'Anime', ['A', 'B', 'C']);

    assert.ok(browser.payloadForList(guildId, 'Nope').content.includes('No list named'));
    assert.ok(browser.payloadForCategory(guildId, 'Nope').content.includes('No lists in category'));
    assert.equal(browser.buildBrowsePayload(guildId, 'chars', 999999, 0).content, 'That list no longer exists.');
  },
};
