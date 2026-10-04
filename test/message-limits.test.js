// Guards every player-facing message that names a lobby's lists against Discord's
// 2,000-character content limit.
//
// This is a regression suite for a real outage. `/create-lobby category:Video Games` opens
// a lobby holding 581 lists, and the rematch announcement spelled every one of them out by
// name -- a 14,199-character message. Discord rejects an over-length body outright rather
// than truncating it, so hitting Rematch threw DiscordAPIError 50035 and took the bot down.
//
// The lobby board itself was already fixed to summarise, which is what made the miss easy:
// two other places format lobby.listNames directly and so bypassed that fix entirely.

const { assert } = require('./harness');
const lists = require('../src/compendium/characterLists');
const db = require('../src/core/db/connection');
const { rematchAnnouncement } = require('../src/discord/game/rematch');

const DISCORD_CONTENT_LIMIT = 2000;

let guildCounter = 0;
function freshGuild() {
  const guildId = `limits-guild-${++guildCounter}`;
  db.prepare('DELETE FROM character_lists WHERE owner_scope = ?').run(guildId);
  return guildId;
}

// A category-sized lobby: enough lists, with realistic name lengths, to blow the limit if
// anything spells them out.
function seedCategory(guildId, count = 581) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = lists.createList(guildId, `Some Video Game With A Longish Title ${i}`, 'tester', 'Video Games');
    lists.addCharacter(id, `Hero ${i}`, 'tester');
    ids.push(id);
  }
  return ids;
}

module.exports = {
  'the rematch announcement survives a lobby covering a whole category'() {
    const guildId = freshGuild();
    const listIds = seedCategory(guildId);

    const message = rematchAnnouncement({ listIds }, ['player-one', 'player-two']);
    assert.ok(
      message.length <= DISCORD_CONTENT_LIMIT,
      `rematch announcement is ${message.length} chars, over Discord's ${DISCORD_CONTENT_LIMIT}`
    );
    assert.match(message, /Video Games \(581 lists\)/, 'summarises rather than listing every name');
    assert.match(message, /<@player-one>/, 'still names the players');
  },

  'the lobby label itself stays well inside the limit at category scale'() {
    const guildId = freshGuild();
    const listIds = seedCategory(guildId);

    const label = lists.getListLabelForIds(listIds);
    assert.ok(label.length <= DISCORD_CONTENT_LIMIT, `label is ${label.length} chars`);
    assert.equal(label, 'Video Games (581 lists)');
  },

  // The guard has to hold for a mixed selection too, which cannot be summarised by a
  // shared category name.
  'a large mixed-category selection is counted rather than listed'() {
    const guildId = freshGuild();
    const ids = [];
    for (let i = 0; i < 200; i++) {
      const category = ['Anime', 'Movies', 'Video Games'][i % 3];
      const id = lists.createList(guildId, `A Reasonably Long List Name Number ${i}`, 'tester', category);
      lists.addCharacter(id, `Character ${i}`, 'tester');
      ids.push(id);
    }

    const label = lists.getListLabelForIds(ids);
    assert.ok(label.length <= DISCORD_CONTENT_LIMIT, `label is ${label.length} chars`);
    assert.equal(label, '200 lists');

    const message = rematchAnnouncement({ listIds: ids }, ['a', 'b']);
    assert.ok(message.length <= DISCORD_CONTENT_LIMIT, `rematch is ${message.length} chars`);
  },

  'a small lobby still names its lists exactly'() {
    const guildId = freshGuild();
    const a = lists.createList(guildId, 'Naruto', 'tester', 'Anime');
    const b = lists.createList(guildId, 'Bleach', 'tester', 'Anime');
    lists.addCharacter(a, 'Naruto Uzumaki', 'tester');
    lists.addCharacter(b, 'Ichigo Kurosaki', 'tester');

    assert.match(rematchAnnouncement({ listIds: [a, b] }, ['a', 'b']), /Naruto \(Anime\) \+ Bleach \(Anime\)/);
  },
};
