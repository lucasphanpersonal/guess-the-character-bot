// /lobby set-characters -- the slash-command form, which has autocomplete on every character
// field (the board's 🎭 modal cannot: Discord does not support autocomplete inside a modal at
// all, only on slash-command string options).
//
// Generalised from a fixed two required pairs to up to five, matching MAX_ASSIGNABLE_PLAYERS.
// Unlike the modal, this command has no way to show what is already assigned, so it edits
// only the slots given in this call rather than re-declaring the whole assignment -- naming a
// player with no character clears just that one back to random.

const { assert, createRecorder, createFakeClient, createSlashInteraction } = require('./harness');
const setChars = require('../src/commands/actions/lobby-set-characters');
const GameManager = require('../src/game/GameManager');
const Lobby = require('../src/game/Lobby');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

function makeLobby(playerCount = 4) {
  const n = ++counter;
  const guildId = `setcmd-guild-${n}`;
  const channelId = `setcmd-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Set-Cmd List', 'tester', 'Anime');
  for (const name of ['Zoro', 'Luffy', 'Nami', 'Sanji', 'Usopp', 'Chopper']) {
    lists.addCharacter(listId, name, 'tester');
  }

  const recorder = createRecorder();
  const client = createFakeClient(recorder);
  const lobby = new Lobby({
    guildId,
    channelId,
    hostId: 'host',
    listIds: [listId],
    listNames: ['Set-Cmd List'],
    turnSeconds: 90,
    maxRerolls: 2,
  });
  const players = Array.from({ length: playerCount }, (_, i) => `p${i + 1}`);
  for (const id of players) lobby.addPlayer(id);
  GameManager.createLobby(channelId, lobby);
  return { lobby, client, recorder, channelId, players };
}

function run(ctx, options) {
  return setChars.execute(
    createSlashInteraction({
      client: ctx.client,
      userId: 'host',
      guildId: ctx.lobby.guildId,
      channelId: ctx.channelId,
      recorder: ctx.recorder,
      options,
    })
  );
}

function cleanup(ctx) {
  GameManager.endLobby(ctx.channelId);
}

module.exports = {
  async 'assigns one player, three, or five -- not just exactly two'() {
    const ctx = makeLobby(5);
    await run(ctx, { player1: { id: 'p3' }, character1: 'Nami' });
    assert.deepEqual(Object.keys(ctx.lobby.assignedCharacters), ['p3']);
    assert.equal(ctx.lobby.assignedCharacters.p3.name, 'Nami');
    cleanup(ctx);
  },

  async 'a later call adds to the assignment rather than replacing it'() {
    const ctx = makeLobby(5);
    await run(ctx, { player1: { id: 'p1' }, character1: 'Zoro' });
    await run(ctx, { player1: { id: 'p2' }, character1: 'Luffy' });
    assert.equal(ctx.lobby.assignedCharacters.p1.name, 'Zoro', 'the first call is still in effect');
    assert.equal(ctx.lobby.assignedCharacters.p2.name, 'Luffy');
    cleanup(ctx);
  },

  async 'naming a player with no character clears just that one back to random'() {
    const ctx = makeLobby(5);
    await run(ctx, { player1: { id: 'p1' }, character1: 'Zoro', player2: { id: 'p2' }, character2: 'Luffy' });
    await run(ctx, { player1: { id: 'p1' } }); // character1 omitted entirely
    assert.ok(!('p1' in ctx.lobby.assignedCharacters), 'p1 cleared');
    assert.equal(ctx.lobby.assignedCharacters.p2.name, 'Luffy', 'p2 untouched by the second call');
    cleanup(ctx);
  },

  async 'a character without a matching player is refused'() {
    const ctx = makeLobby(4);
    await run(ctx, { character1: 'Zoro' }); // player1 omitted
    assert.match(ctx.recorder.lastMatching('reply:host').content, /without a matching player1/);
    assert.deepEqual(ctx.lobby.assignedCharacters, {});
    cleanup(ctx);
  },

  async 'the same player named twice in one call is refused'() {
    const ctx = makeLobby(4);
    await run(ctx, { player1: { id: 'p1' }, character1: 'Zoro', player2: { id: 'p1' }, character2: 'Luffy' });
    assert.match(ctx.recorder.lastMatching('reply:host').content, /both player1 and player2/);
    cleanup(ctx);
  },

  async 'a player who has not joined the lobby is refused'() {
    const ctx = makeLobby(2);
    await run(ctx, { player1: { id: 'not-in-lobby' }, character1: 'Zoro' });
    assert.match(ctx.recorder.lastMatching('reply:host').content, /hasn't joined this lobby/);
    cleanup(ctx);
  },

  async 'a genuine typo is reported and nothing is changed'() {
    const ctx = makeLobby(4);
    await run(ctx, { player1: { id: 'p1' }, character1: 'Zoroo' });
    assert.match(ctx.recorder.lastMatching('reply:host').content, /Couldn't find \*\*Zoroo\*\*/);
    assert.deepEqual(ctx.lobby.assignedCharacters, {});
    cleanup(ctx);
  },

  async 'assigning a character already given to someone else is refused, across calls'() {
    const ctx = makeLobby(4);
    await run(ctx, { player1: { id: 'p1' }, character1: 'Zoro' });
    await run(ctx, { player1: { id: 'p2' }, character1: 'zoro' }); // case-insensitive collision
    assert.match(ctx.recorder.lastMatching('reply:host').content, /same character/);
    assert.ok(!('p2' in ctx.lobby.assignedCharacters), 'the second call did not go through');
    cleanup(ctx);
  },

  async 'calling it with nothing at all is refused rather than silently accepted'() {
    const ctx = makeLobby(2);
    await run(ctx, {});
    assert.match(ctx.recorder.lastMatching('reply:host').content, /Nothing to do/);
    cleanup(ctx);
  },
};
