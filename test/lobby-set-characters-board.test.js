// The board's 🎭 Set characters modal -- lobbyButtons.js action 'save-characters'.
//
// Unlike /lobby set-characters (two fixed, required options), this modal's boxes are all
// optional, so it is the one place "hand-pick SOME players, randomize the rest" has to work.
// A blank box meant "randomize this player" was only honoured when EVERY box was blank; any
// other mix looked up "" as a character name for each blank one and reported it back as
// "(blank)" alongside anything genuinely misspelled -- so filling in a single player's
// character always failed.

const {
  assert,
  createRecorder,
  createFakeClient,
  createButtonInteraction,
  createModalInteraction,
} = require('./harness');

const { handleComponentInteraction } = require('../src/discord/components/router');
const engine = require('../src/discord/game/engine');
const Lobby = require('../src/core/game/Lobby');
const GameManager = require('../src/core/game/GameManager');
const lists = require('../src/core/db/characterLists');
const db = require('../src/core/db/connection');

let counter = 0;

function makeLobby(playerCount = 4) {
  const n = ++counter;
  const guildId = `setchar-guild-${n}`;
  const channelId = `setchar-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Set-Chars List', 'tester', 'Anime');
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
    listNames: ['Set-Chars List'],
    turnSeconds: 90,
    maxRerolls: 2,
  });
  const players = Array.from({ length: playerCount }, (_, i) => `p${i + 1}`);
  for (const id of players) lobby.addPlayer(id);
  GameManager.createLobby(channelId, lobby);
  return { lobby, client, recorder, channelId, players };
}

// fields keyed 'player1'..'playerN' in lobby.players order, blank string for "leave random".
function submit(ctx, fields) {
  return handleComponentInteraction(
    createModalInteraction({
      client: ctx.client,
      userId: 'host',
      customId: `lobby:save-characters:${ctx.channelId}`,
      fields,
      recorder: ctx.recorder,
    })
  );
}

function cleanup(ctx) {
  GameManager.endLobby(ctx.channelId);
}

module.exports = {
  async 'hand-picking one player and leaving the rest blank is accepted'() {
    const ctx = makeLobby(4);
    await submit(ctx, { player1: 'Zoro', player2: '', player3: '', player4: '' });

    assert.deepEqual(Object.keys(ctx.lobby.assignedCharacters), ['p1'], 'only the filled box was assigned');
    assert.equal(ctx.lobby.assignedCharacters.p1.name, 'Zoro');
    assert.ok(!/Couldn't find/.test(ctx.recorder.allText()), 'blanks are not reported as missing characters');
    cleanup(ctx);
  },

  async 'a partial assignment is honoured when the game starts -- not silently discarded'() {
    const ctx = makeLobby(4);
    await submit(ctx, { player1: 'Zoro', player2: '', player3: '', player4: '' });

    const result = await engine.startGameFromLobby(ctx.client, ctx.lobby);
    assert.equal(result.ok, true, result.error);
    assert.equal(ctx.lobby.game.headByPlayer.p1.name, 'Zoro', 'the hand-picked player got what was picked');
    // p2-p4 got SOMETHING, and none of them collided with Zoro or each other.
    const names = ctx.lobby.players.map((id) => ctx.lobby.game.headByPlayer[id].name);
    assert.equal(new Set(names).size, 4, 'no two players share a character');
    engine.clearTimers(ctx.lobby.game);
    cleanup(ctx);
  },

  async 'every box blank still clears to a fully random deal'() {
    const ctx = makeLobby(4);
    await submit(ctx, { player1: 'Zoro', player2: '', player3: '', player4: '' });
    await submit(ctx, { player1: '', player2: '', player3: '', player4: '' });

    assert.deepEqual(ctx.lobby.assignedCharacters, {});
    assert.match(ctx.recorder.allText(), /dealt at random/);
    cleanup(ctx);
  },

  async 'a name outside the lobby\'s lists is worn as typed, not refused'() {
    const ctx = makeLobby(4);
    await submit(ctx, { player1: 'Zoroo', player2: 'Luffy', player3: '', player4: '' });

    assert.equal(ctx.lobby.assignedCharacters.p1.name, 'Zoroo');
    assert.equal(ctx.lobby.assignedCharacters.p1.id, null, 'nothing to record a reroll against');
    assert.equal(ctx.lobby.assignedCharacters.p2.name, 'Luffy');
    assert.ok(ctx.lobby.assignedCharacters.p2.id, 'the real character still resolves to its row');
    cleanup(ctx);
  },

  async 'two hand-picked players cannot be given the same character'() {
    const ctx = makeLobby(4);
    await submit(ctx, { player1: 'Zoro', player2: 'zoro', player3: '', player4: '' });

    assert.match(ctx.recorder.allText(), /different character/);
    assert.deepEqual(ctx.lobby.assignedCharacters, {});
    cleanup(ctx);
  },
};
