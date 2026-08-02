// The ⚙️ Settings modal and 🗳️ mode toggle on the lobby board, plus the shared parsing and
// bounds they enforce. The point of the shared module is that the board can never set
// something /create-lobby would have rejected, so most of these assert a rejection.

const {
  assert,
  createRecorder,
  createFakeClient,
  createButtonInteraction,
  createModalInteraction,
} = require('./harness');

const { buildLobbyBoardPayload } = require('../src/game/lobbyBoard');
const { handleComponentInteraction } = require('../src/components/router');
const settings = require('../src/game/lobbySettings');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

function makeLobby({ hostId = 'host', characters = 20, players = [], ...overrides } = {}) {
  const n = ++counter;
  const guildId = `settings-guild-${n}`;
  const channelId = `settings-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Settings List', 'tester', 'Video Games');
  for (let i = 0; i < characters; i++) lists.addCharacter(listId, `Character ${i}`, 'tester');

  const lobby = new Lobby({
    guildId,
    channelId,
    hostId,
    listIds: [listId],
    listNames: ['Settings List'],
    turnSeconds: 90,
    maxRerolls: 2,
    ...overrides,
  });
  for (const p of players) lobby.addPlayer(p);
  GameManager.createLobby(channelId, lobby);
  return { lobby, channelId, guildId };
}

const click = ({ channelId, userId, action, recorder, client }) =>
  handleComponentInteraction(
    createButtonInteraction({ client, userId, customId: `lobby:${action}:${channelId}`, recorder })
  );

const submit = ({ channelId, userId, fields, recorder, client }) =>
  handleComponentInteraction(
    createModalInteraction({
      client,
      userId,
      customId: `lobby:save-settings:${channelId}`,
      fields,
      recorder,
    })
  );

// The board's second row is the host's settings controls.
function settingsButtonsOf(payload) {
  const out = {};
  for (const c of payload.components[1].toJSON().components) {
    out[c.custom_id.split(':')[1]] = { label: c.label };
  }
  return out;
}

module.exports = {
  'bounds and blank fields are handled the same for every setting'() {
    assert.deepEqual(settings.parseField('turnSeconds', '120'), { ok: true, value: 120 });
    assert.equal(settings.parseField('turnSeconds', '5').ok, false, 'below the minimum');
    assert.equal(settings.parseField('turnSeconds', '9999').ok, false, 'above the maximum');
    assert.equal(settings.parseField('turnSeconds', 'ninety').ok, false, 'not a number');
    // Blank means "leave this one alone", not zero and not an error.
    assert.deepEqual(settings.parseField('turnSeconds', '  '), { ok: true, value: undefined });

    // -1 is the slash command's convention for unlimited; a text box should take the word.
    assert.deepEqual(settings.parseField('maxRerolls', 'unlimited'), { ok: true, value: -1 });
    assert.deepEqual(settings.parseField('maxRerolls', '-1'), { ok: true, value: -1 });
    assert.equal(settings.parseField('maxRerolls', '-2').ok, false);
  },

  'one bad field rejects the whole submission'() {
    const { ok, errors, values } = settings.parseSettings({ turnSeconds: '120', maxRerolls: 'lots' });
    assert.equal(ok, false);
    assert.equal(errors.length, 1);
    // values still holds the good field, but the caller is expected not to apply any of it.
    assert.equal(values.turnSeconds, 120);
  },

  'the board carries host-only Settings and mode controls that reflect current state'() {
    const { lobby } = makeLobby();
    let buttons = settingsButtonsOf(buildLobbyBoardPayload(lobby));
    assert.equal(buttons.settings.label, 'Settings');
    assert.equal(buttons.mode.label, 'Audience vote: off');

    lobby.mode = 'audience-vote';
    buttons = settingsButtonsOf(buildLobbyBoardPayload(lobby));
    assert.equal(buttons.mode.label, 'Audience vote: on');
  },

  'settings controls disappear along with the rest once the lobby leaves WAITING'() {
    const { lobby } = makeLobby();
    lobby.status = 'IN_PROGRESS';
    assert.deepEqual(buildLobbyBoardPayload(lobby).components, []);
  },

  async 'the host opens a modal prefilled with the settings in force'() {
    const { lobby, channelId } = makeLobby({ turnSeconds: 45, maxRerolls: -1 });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'host', action: 'settings', recorder, client });
    const modal = recorder.lastMatching('modal:host');
    assert.ok(modal, 'a modal was shown');
    assert.match(modal.content, /"value":"45"/, 'turn seconds prefilled');
    assert.match(modal.content, /"value":"unlimited"/, '-1 rerolls reads as unlimited');
    // Classic mode has no vote to tune, so the modal does not ask about one.
    assert.doesNotMatch(modal.content, /voteSeconds/);
    GameManager.endLobby(channelId);
  },

  async 'the modal asks about the vote instead once audience-vote mode is on'() {
    const { lobby, channelId } = makeLobby({ mode: 'audience-vote' });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'host', action: 'settings', recorder, client });
    const modal = recorder.lastMatching('modal:host');
    assert.match(modal.content, /voteOptions/);
    assert.match(modal.content, /voteSeconds/);
    assert.doesNotMatch(modal.content, /maxRerolls/, 'vote mode has no rerolls to allow');
    assert.equal(lobby.mode, 'audience-vote');
    GameManager.endLobby(channelId);
  },

  async 'submitting the modal applies the settings and re-renders the board in place'() {
    const { lobby, channelId } = makeLobby();
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await submit({ channelId, userId: 'host', fields: { turnSeconds: '150', maxRerolls: '5' }, recorder, client });
    assert.equal(lobby.turnSeconds, 150);
    assert.equal(lobby.maxRerolls, 5);

    const update = recorder.lastMatching('update:host');
    assert.ok(update, 'the board was updated rather than a new message posted');
    assert.match(update.content, /150s turns/);
    assert.match(update.content, /5 rerolls/);
    GameManager.endLobby(channelId);
  },

  async 'a blank field leaves that setting alone'() {
    const { lobby, channelId } = makeLobby({ turnSeconds: 60, maxRerolls: 3 });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await submit({ channelId, userId: 'host', fields: { turnSeconds: '', maxRerolls: '4' }, recorder, client });
    assert.equal(lobby.turnSeconds, 60, 'untouched');
    assert.equal(lobby.maxRerolls, 4);
    GameManager.endLobby(channelId);
  },

  async 'an out-of-range value changes nothing at all, not just the bad field'() {
    const { lobby, channelId } = makeLobby({ turnSeconds: 90, maxRerolls: 2 });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await submit({ channelId, userId: 'host', fields: { turnSeconds: '9000', maxRerolls: '7' }, recorder, client });
    assert.equal(lobby.turnSeconds, 90);
    assert.equal(lobby.maxRerolls, 2, 'the valid field was not applied either');
    assert.match(recorder.allText(), /Nothing changed/);
    GameManager.endLobby(channelId);
  },

  async 'only the host can open or submit the settings'() {
    const { lobby, channelId } = makeLobby({ hostId: 'host' });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'someone', action: 'settings', recorder, client });
    assert.equal(recorder.lastMatching('modal:someone'), undefined, 'no modal for a non-host');

    await submit({ channelId, userId: 'someone', fields: { turnSeconds: '15' }, recorder, client });
    assert.equal(lobby.turnSeconds, 90, 'unchanged');
    assert.match(recorder.allText(), /Only the host/);
    GameManager.endLobby(channelId);
  },

  async 'the mode button toggles audience vote on and back off'() {
    const { lobby, channelId } = makeLobby();
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'host', action: 'mode', recorder, client });
    assert.equal(lobby.mode, 'audience-vote');
    assert.match(recorder.lastMatching('update:host').content, /audience vote/);

    await click({ channelId, userId: 'host', action: 'mode', recorder, client });
    assert.equal(lobby.mode, 'classic');
    GameManager.endLobby(channelId);
  },

  // Two players need disjoint candidate sets, so vote mode needs twice the options in
  // distinct characters -- the same guard /create-lobby applies up front.
  async 'audience vote is refused when the pool is too small to fill both ballots'() {
    const { lobby, channelId } = makeLobby({ characters: 6 });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'host', action: 'mode', recorder, client });
    assert.equal(lobby.mode, 'classic', 'the toggle was refused');
    assert.match(recorder.allText(), /needs 10 distinct characters/);
    GameManager.endLobby(channelId);
  },

  async 'raising vote options past what the pool supports is refused too'() {
    const { lobby, channelId } = makeLobby({ characters: 20, mode: 'audience-vote' });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await submit({
      channelId,
      userId: 'host',
      fields: { turnSeconds: '90', voteOptions: '15', voteSeconds: '60' },
      recorder,
      client,
    });
    assert.equal(lobby.voteOptions, 5, 'unchanged');
    assert.match(recorder.allText(), /Nothing changed/);

    // 10 per player fits exactly in a 20-character pool.
    await submit({
      channelId,
      userId: 'host',
      fields: { turnSeconds: '90', voteOptions: '10', voteSeconds: '60' },
      recorder,
      client,
    });
    assert.equal(lobby.voteOptions, 10);
    GameManager.endLobby(channelId);
  },

  async 'turning on audience vote warns a host who already ran /set-characters'() {
    const { lobby, channelId } = makeLobby();
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    lobby.assignedCharacters = { p1: { name: 'Mario' }, p2: { name: 'Luigi' } };

    await click({ channelId, userId: 'host', action: 'mode', recorder, client });
    assert.equal(lobby.mode, 'audience-vote');
    assert.match(recorder.allText(), /set-characters` picks are ignored/);
    GameManager.endLobby(channelId);
  },

  async 'the difficulty button cycles and reports the pool it leaves'() {
    const { lobby, channelId } = makeLobby({ characters: 20 });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    assert.equal(lobby.difficulty, 'normal', 'the default');

    await click({ channelId, userId: 'host', action: 'difficulty', recorder, client });
    assert.equal(lobby.difficulty, 'everything');
    assert.match(recorder.allText(), /characters in the pool/);

    await click({ channelId, userId: 'host', action: 'difficulty', recorder, client });
    assert.equal(lobby.difficulty, 'easy');

    await click({ channelId, userId: 'host', action: 'difficulty', recorder, client });
    assert.equal(lobby.difficulty, 'normal', 'wraps around');
    GameManager.endLobby(channelId);
  },

  'the board shows the difficulty and counts characters at that setting'() {
    const { lobby } = makeLobby();
    lobby.difficulty = 'easy';
    const json = buildLobbyBoardPayload(lobby).embeds[0].toJSON();
    const settings = json.fields.find((f) => f.name === 'Settings');
    assert.match(settings.value, /Easy/);

    const buttons = {};
    for (const c of buildLobbyBoardPayload(lobby).components[1].toJSON().components) {
      buttons[c.custom_id.split(':')[1]] = c.label;
    }
    assert.equal(buttons.difficulty, 'Difficulty: Easy');
  },

  async 'only the host can change difficulty'() {
    const { lobby, channelId } = makeLobby({ hostId: 'host' });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await click({ channelId, userId: 'someone', action: 'difficulty', recorder, client });
    assert.equal(lobby.difficulty, 'normal', 'unchanged');
    assert.match(recorder.allText(), /Only the host/);
    GameManager.endLobby(channelId);
  },

  async 'settings cannot be changed once the game has started'() {
    const { lobby, channelId } = makeLobby();
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    lobby.status = 'IN_PROGRESS';

    await submit({ channelId, userId: 'host', fields: { turnSeconds: '15' }, recorder, client });
    assert.equal(lobby.turnSeconds, 90, 'unchanged');
    assert.match(recorder.allText(), /already started/);
    GameManager.endLobby(channelId);
  },

  // Hand-picking characters was the last lobby setting living only in a slash command.
  async 'the host can set both characters from the board'() {
    const { lobby, channelId, guildId } = makeLobby({ players: ['p1', 'p2'] });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    const listId = lists.getEnabledLists(guildId)[0]?.id ?? lobby.listIds[0];
    lists.addCharacter(listId, 'Hero One', 'tester');
    lists.addCharacter(listId, 'Hero Two', 'tester');

    await handleComponentInteraction(
      createModalInteraction({
        client,
        userId: 'host',
        customId: `lobby:save-characters:${channelId}`,
        fields: { player1: 'Hero One', player2: 'Hero Two' },
        recorder,
      })
    );

    assert.equal(lobby.assignedCharacters.p1.name, 'Hero One');
    assert.equal(lobby.assignedCharacters.p2.name, 'Hero Two');
    // The board may never name them -- the players are reading it.
    const update = recorder.lastMatching('update:host');
    assert.doesNotMatch(update.content, /Hero One/, 'the board must never name them');
    const label = update.payload.components[1]
      .toJSON()
      .components.find((c) => c.custom_id.split(':')[1] === 'characters').label;
    assert.equal(label, 'Characters: set', 'but it does say that they are set');
    GameManager.endLobby(channelId);
  },

  async 'an unknown character changes nothing and says which one failed'() {
    const { lobby, channelId } = makeLobby({ players: ['p1', 'p2'] });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    await handleComponentInteraction(
      createModalInteraction({
        client,
        userId: 'host',
        customId: `lobby:save-characters:${channelId}`,
        fields: { player1: 'Nobody At All', player2: 'Character 1' },
        recorder,
      })
    );

    assert.deepEqual(lobby.assignedCharacters, {}, 'nothing assigned');
    assert.match(recorder.allText(), /Nobody At All/);
    GameManager.endLobby(channelId);
  },

  async 'clearing both boxes goes back to a random deal'() {
    const { lobby, channelId } = makeLobby({ players: ['p1', 'p2'] });
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    lobby.assignedCharacters = { p1: { name: 'Character 1' }, p2: { name: 'Character 2' } };

    await handleComponentInteraction(
      createModalInteraction({
        client,
        userId: 'host',
        customId: `lobby:save-characters:${channelId}`,
        fields: { player1: '  ', player2: '' },
        recorder,
      })
    );

    assert.deepEqual(lobby.assignedCharacters, {});
    assert.match(recorder.allText(), /dealt at random/);
    GameManager.endLobby(channelId);
  },

  'the set-characters button waits for both players'() {
    const { lobby } = makeLobby({ players: ['p1'] });
    const row = buildLobbyBoardPayload(lobby).components[1].toJSON().components;
    const button = row.find((c) => c.custom_id.split(':')[1] === 'characters');
    assert.equal(button.disabled, true, 'nothing to assign with one player');
  },
};
