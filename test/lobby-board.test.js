const {
  assert,
  createRecorder,
  createFakeClient,
  createButtonInteraction,
  createSlashInteraction,
} = require('./harness');

const { buildLobbyBoardPayload } = require('../src/game/lobbyBoard');
const { handleComponentInteraction } = require('../src/components/router');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

function makeLobby({ hostId = 'host', players = [] } = {}) {
  const n = ++counter;
  const guildId = `board-guild-${n}`;
  const channelId = `board-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Board List', 'tester', 'Video Games');
  for (const name of ['Mario', 'Luigi', 'Peach']) lists.addCharacter(listId, name, 'tester');

  const lobby = new Lobby({
    guildId,
    channelId,
    hostId,
    listIds: [listId],
    listNames: ['Board List'],
    turnSeconds: 90,
    maxRerolls: 2,
  });
  for (const p of players) lobby.addPlayer(p);
  GameManager.createLobby(channelId, lobby);
  return { lobby, channelId, guildId };
}

// The board's buttons are what users actually click, so assert against their rendered state.
function buttonsOf(payload) {
  const row = payload.components[0];
  if (!row) return {};
  const out = {};
  for (const c of row.toJSON().components) {
    const action = c.custom_id.split(':')[1];
    out[action] = { label: c.label, disabled: Boolean(c.disabled) };
  }
  return out;
}

function click({ channelId, userId, action, recorder, client }) {
  return handleComponentInteraction(
    createButtonInteraction({ client, userId, customId: `lobby:${action}:${channelId}`, recorder })
  );
}

module.exports = {
  'the board shows player count and disables Start until two players have joined'() {
    const { lobby } = makeLobby();
    let buttons = buttonsOf(buildLobbyBoardPayload(lobby));
    assert.equal(buttons.start.disabled, true, 'Start disabled with 0 players');
    assert.match(buttons.start.label, /0\/2/);

    lobby.addPlayer('p1');
    buttons = buttonsOf(buildLobbyBoardPayload(lobby));
    assert.equal(buttons.start.disabled, true, 'still disabled with 1 player');

    lobby.addPlayer('p2');
    buttons = buttonsOf(buildLobbyBoardPayload(lobby));
    assert.equal(buttons.start.disabled, false, 'enabled at 2 players');
    assert.equal(buttons.join.disabled, true, 'Join disabled once full');
    assert.equal(buttons.join.label, 'Lobby full');
  },

  'the board lists the joined players and the host'() {
    const { lobby } = makeLobby({ hostId: 'hostUser', players: ['p1'] });
    const json = buildLobbyBoardPayload(lobby).embeds[0].toJSON();
    assert.match(json.description, /<@hostUser>/, 'host is mentioned');
    const playersField = json.fields.find((f) => f.name.startsWith('Players'));
    assert.match(playersField.name, /1\/2/);
    assert.match(playersField.value, /<@p1>/);
  },

  'buttons past the WAITING phase are dropped so the board never lies'() {
    const { lobby } = makeLobby({ players: ['p1', 'p2'] });
    for (const status of ['CONFIRMING', 'IN_PROGRESS', 'FINISHED']) {
      lobby.status = status;
      const payload = buildLobbyBoardPayload(lobby);
      assert.deepEqual(payload.components, [], `${status} has no buttons`);
      assert.ok(
        payload.embeds[0].toJSON().fields.some((f) => f.value.length > 0),
        `${status} still explains itself`
      );
    }
  },

  async 'the Join button adds the player and re-renders the board in place'() {
    const { lobby, channelId } = makeLobby();
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'p1', action: 'join', recorder, client });
    assert.deepEqual(lobby.players, ['p1']);

    // interaction.update means the click edited the board message itself.
    const update = recorder.sent.find((m) => m.target === 'update:p1');
    assert.ok(update, 'board was updated rather than a new message posted');
    assert.match(update.payload.embeds[0].toJSON().fields[0].name, /1\/2/);
    GameManager.endLobby(channelId);
  },

  async 'joining twice is rejected without changing the lobby'() {
    const { lobby, channelId } = makeLobby({ players: ['p1'] });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'p1', action: 'join', recorder, client });
    assert.deepEqual(lobby.players, ['p1'], 'still only one entry');
    assert.match(recorder.allText(), /already in this lobby/);
    GameManager.endLobby(channelId);
  },

  async 'a third player is told to spectate instead'() {
    const { lobby, channelId } = makeLobby({ players: ['p1', 'p2'] });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'p3', action: 'join', recorder, client });
    assert.equal(lobby.players.length, 2);
    assert.match(recorder.allText(), /Spectate/);
    GameManager.endLobby(channelId);
  },

  async 'the Spectate button toggles, and players cannot spectate their own game'() {
    const { lobby, channelId } = makeLobby({ players: ['p1'] });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'watcher', action: 'spectate', recorder, client });
    assert.ok(lobby.spectators.has('watcher'), 'added');

    await click({ channelId, userId: 'watcher', action: 'spectate', recorder, client });
    assert.ok(!lobby.spectators.has('watcher'), 'toggled back off');

    await click({ channelId, userId: 'p1', action: 'spectate', recorder, client });
    assert.ok(!lobby.spectators.has('p1'));
    assert.match(recorder.allText(), /not a spectator/);
    GameManager.endLobby(channelId);
  },

  async 'joining clears you from the spectator list'() {
    const { lobby, channelId } = makeLobby();
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'p1', action: 'spectate', recorder, client });
    assert.ok(lobby.spectators.has('p1'));
    await click({ channelId, userId: 'p1', action: 'join', recorder, client });
    assert.ok(!lobby.spectators.has('p1'), 'no longer counted as a spectator');
    assert.deepEqual(lobby.players, ['p1']);
    GameManager.endLobby(channelId);
  },

  async 'only the host can press Start'() {
    const { lobby, channelId } = makeLobby({ hostId: 'host', players: ['p1', 'p2'] });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'p1', action: 'start', recorder, client });
    assert.equal(lobby.status, 'WAITING', 'a non-host press changes nothing');
    assert.match(recorder.allText(), /Only the host/);
    GameManager.endLobby(channelId);
  },

  async 'the host pressing Start deals characters and moves the lobby on'() {
    const { lobby, channelId } = makeLobby({ hostId: 'host', players: ['p1', 'p2'] });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'host', action: 'start', recorder, client });
    assert.equal(lobby.status, 'CONFIRMING');
    assert.ok(recorder.sent.some((m) => m.target === 'dm:p1'), 'p1 was DMed a character');
    assert.ok(recorder.sent.some((m) => m.target === 'dm:p2'), 'p2 was DMed a character');

    if (lobby.game) require('../src/game/engine').clearTimers(lobby.game);
    GameManager.endLobby(channelId);
  },

  // Cancelling deletes the lobby outright, so the board it leaves behind has to say so --
  // both of these used to leave it either fully clickable or advertising a /rematch that
  // has nothing left to replay.
  async 'the host leaving retires the lobby board rather than leaving it clickable'() {
    const { lobby, channelId, guildId } = makeLobby({ hostId: 'host', players: ['host', 'p2'] });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    lobby.boardMessage = recorder.record(`channel:${channelId}`, buildLobbyBoardPayload(lobby), channelId);

    await require('../src/commands/leave-lobby').execute(
      createSlashInteraction({ client, userId: 'host', guildId, channelId, recorder })
    );

    assert.equal(GameManager.getLobby(channelId), undefined, 'the lobby is gone');
    const retired = recorder.lastMatching(`channel:${channelId}:edit`);
    assert.ok(retired, 'the board was re-rendered');
    assert.deepEqual(retired.payload.components, [], 'no clickable buttons left behind');
    assert.match(retired.content, /cancelled/i);
    assert.doesNotMatch(retired.content, /rematch/i, 'nothing left to rematch');
  },

  async 'ending a waiting lobby retires its board the same way'() {
    const { lobby, channelId, guildId } = makeLobby({ hostId: 'host', players: ['p1'] });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    lobby.boardMessage = recorder.record(`channel:${channelId}`, buildLobbyBoardPayload(lobby), channelId);

    await require('../src/commands/end-game').execute(
      createSlashInteraction({ client, userId: 'host', guildId, channelId, recorder })
    );

    assert.equal(GameManager.getLobby(channelId), undefined, 'the lobby is gone');
    const retired = recorder.lastMatching(`channel:${channelId}:edit`);
    assert.deepEqual(retired.payload.components, [], 'no clickable buttons left behind');
    assert.doesNotMatch(retired.content, /rematch/i, 'nothing left to rematch');
  },

  async 'board buttons for a lobby that no longer exists fail gracefully'() {
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    await click({ channelId: 'does-not-exist', userId: 'p1', action: 'join', recorder, client });
    assert.match(recorder.allText(), /no longer active/);
  },

  async 'an unknown component namespace is handled instead of throwing'() {
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    await handleComponentInteraction(
      createButtonInteraction({ client, userId: 'p1', customId: 'legacy:whatever:123', recorder })
    );
    assert.match(recorder.allText(), /no longer available/);
  },

  async 'the existing DM confirm/reroll buttons still route correctly'() {
    // Regression guard: those buttons predate the router and live in already-sent DMs.
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    await handleComponentInteraction(
      createButtonInteraction({ client, userId: 'p1', customId: 'confirm:no-such-channel', recorder })
    );
    assert.match(recorder.allText(), /expired/, 'reached the confirmation handler, not the fallback');
  },
};
