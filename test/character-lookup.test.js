// `/character <name>` -- looking a character up just to see them.
//
// The ranking is the part worth pinning down. Ranking on STRING prefix alone answered "Zoro"
// with Zorome and Zoroark while burying Roronoa Zoro, and "Einstein" with Einstein Nina while
// burying Albert Einstein, because the word people search by is frequently not the first one.

const { assert, createRecorder, createFakeClient, createSlashInteraction } = require('./harness');
const command = require('../src/discord/commands/character');
const { searchCharactersInScope, getCharacterById } = require('../src/compendium/characterLists');
const lists = require('../src/compendium/characterLists');
const db = require('../src/core/db/connection');

let counter = 0;

function seed() {
  const n = ++counter;
  const guildId = `charlookup-guild-${n}`;
  db.prepare('DELETE FROM character_lists WHERE owner_scope = ?').run(guildId);

  // One enabled list with artwork, one disabled without -- so both halves of the embed's
  // "would this server deal them" answer are exercised.
  const pirates = lists.createList(guildId, 'ONE PIECE', 'tester', 'Anime', { enabled: true });
  const misc = lists.createList(guildId, 'Zoo Show', 'tester', 'Cartoon');

  const zoro = lists.addCharacter(pirates, 'Roronoa Zoro', 'tester', 'https://example.test/zoro.png');
  lists.setCharacterFame(pirates, 'Roronoa Zoro', 28790);
  lists.addCharacter(misc, 'Zorome', 'tester');
  lists.setCharacterFame(misc, 'Zorome', 12);
  lists.addCharacter(misc, 'Zoroark', 'tester');

  return { guildId, zoro, pirates, misc };
}

function ctx() {
  const recorder = createRecorder();
  return { recorder, client: createFakeClient(recorder) };
}

const autocomplete = async (c, guildId, value) => {
  await command.autocomplete(
    createSlashInteraction({ client: c.client, userId: 'u', guildId, channelId: 'ch', recorder: c.recorder, options: { __focused: { value } } })
  );
  return JSON.parse(c.recorder.lastMatching('autocomplete:u').content);
};

const execute = async (c, guildId, options) => {
  await command.execute(
    createSlashInteraction({ client: c.client, userId: 'u', guildId, channelId: 'ch', recorder: c.recorder, options })
  );
  return c.recorder.lastMatching('reply:u');
};

module.exports = {
  'a match on a later word outranks an obscure match on the first'() {
    const { guildId } = seed();
    const names = searchCharactersInScope(guildId, 'Zoro', 25).map((c) => c.name);
    assert.equal(names[0], 'Roronoa Zoro', `expected Roronoa Zoro first, got ${names.join(', ')}`);
    assert.ok(names.includes('Zorome') && names.includes('Zoroark'), 'the others are still offered');
  },

  'an exact name wins outright, however famous the alternatives'() {
    const { guildId, misc } = seed();
    lists.addCharacter(misc, 'Zoro', 'tester'); // exact, and deliberately unranked
    const names = searchCharactersInScope(guildId, 'Zoro', 25).map((c) => c.name);
    assert.equal(names[0], 'Zoro');
  },

  async 'autocomplete labels carry the list, because a name alone is often ambiguous'() {
    const { guildId } = seed();
    const c = ctx();
    const results = await autocomplete(c, guildId, 'Zoro');
    assert.match(results[0].name, /Roronoa Zoro — ONE PIECE/);
    // The value is the row id, so picking a suggestion resolves to exactly one character
    // rather than to whichever happens to share the name.
    assert.match(results[0].value, /^\d+$/);
    assert.equal(getCharacterById(guildId, Number(results[0].value)).name, 'Roronoa Zoro');
  },

  async 'an empty box suggests nothing rather than an arbitrary 25'() {
    const { guildId } = seed();
    const c = ctx();
    assert.deepEqual(await autocomplete(c, guildId, '   '), []);
  },

  async 'picking a suggestion shows the character, privately by default'() {
    const { guildId, zoro } = seed();
    const c = ctx();
    const reply = await execute(c, guildId, { name: String(zoro) });
    const embed = reply.payload.embeds[0].toJSON();
    assert.equal(embed.title, 'Roronoa Zoro');
    assert.equal(embed.image.url, 'https://example.test/zoro.png');
    assert.match(embed.fields[0].value, /ONE PIECE/);
    assert.match(embed.fields[0].value, /in the playable pool/);
    assert.ok(reply.payload.flags, 'ephemeral unless sharing was asked for');
  },

  async 'share:true posts it to the channel instead'() {
    const { guildId, zoro } = seed();
    const c = ctx();
    const reply = await execute(c, guildId, { name: String(zoro), share: true });
    assert.ok(!reply.payload.flags, 'not ephemeral');
    assert.equal(reply.payload.embeds[0].toJSON().title, 'Roronoa Zoro');
  },

  // Typing a name freehand and pressing enter is normal; refusing a near-miss is what makes
  // /lobby set-characters frustrating, and a lookup has nothing at stake in guessing.
  async 'a freehand partial name resolves to the best match rather than being refused'() {
    const { guildId } = seed();
    const c = ctx();
    const reply = await execute(c, guildId, { name: 'Zoro' });
    assert.equal(reply.payload.embeds[0].toJSON().title, 'Roronoa Zoro');
  },

  async 'a character with no artwork says so instead of showing an empty card'() {
    const { guildId } = seed();
    const c = ctx();
    const reply = await execute(c, guildId, { name: 'Zoroark' });
    const embed = reply.payload.embeds[0].toJSON();
    assert.equal(embed.image, undefined);
    assert.match(embed.fields[0].value, /no artwork/);
    assert.match(embed.fields[0].value, /not in the playable pool/);
  },

  async 'a name that matches nothing says so, and points at the suggestions'() {
    const { guildId } = seed();
    const c = ctx();
    const reply = await execute(c, guildId, { name: 'Nobody At All' });
    assert.match(reply.content, /Nothing here called/);
    assert.ok(reply.payload.flags, 'a miss is private too');
  },

  // The id comes from a client-supplied autocomplete value, so it cannot be trusted to
  // belong to the server the command was run in.
  'an id from another server does not resolve'() {
    const a = seed();
    const b = seed();
    assert.equal(getCharacterById(b.guildId, a.zoro), null);
    assert.ok(getCharacterById(a.guildId, a.zoro));
  },
};
