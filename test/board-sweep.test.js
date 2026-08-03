// Restart handling: the boards a dead process left behind get retired on the next startup,
// and boards that lose their buttons during normal play are never tracked into that sweep.

const { assert, createRecorder, createFakeClient, createButtonInteraction } = require('./harness');

const { trackBoard, sweepBoards } = require('../src/game/boards');
const { allBoards } = require('../src/db/activeBoards');
const { buildLobbyBoardPayload, refreshLobbyBoard } = require('../src/game/lobbyBoard');
const { refreshTurnBoard } = require('../src/game/turnBoard');
const { refreshVoteBoard, AudienceVote } = require('../src/game/audienceVote');
const engine = require('../src/game/engine');
const confirmPhase = require('../src/game/confirmPhase');
const Game = require('../src/game/Game');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

const rowsFor = (channelId) => allBoards().filter((r) => r.channelId === channelId);

function editsTo(recorder, channelId) {
  return recorder.sent.filter((m) => m.target === `channel:${channelId}:edit`);
}

// A stand-in for a board the previous process posted: recorded like any other sent message,
// so the fake client can fetch it back by id exactly as the sweep does.
function postedBoard(recorder, channelId, payload) {
  return recorder.record(`channel:${channelId}`, payload);
}

// Minimal lobby with a real character list behind it, for the untracking checks.
function makeLobby(channelId, { players = ['p1', 'p2'] } = {}) {
  const guildId = `sweep-guild-${channelId}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  const listId = lists.createList(guildId, 'Sweep List', 'tester', 'Video Games');
  for (const name of ['Mario', 'Luigi', 'Peach', 'Bowser']) lists.addCharacter(listId, name, 'tester');

  const lobby = new Lobby({
    guildId,
    channelId,
    hostId: 'p1',
    listIds: [listId],
    listNames: ['Sweep List'],
    turnSeconds: 90,
  });
  for (const p of players) lobby.addPlayer(p);
  GameManager.createLobby(channelId, lobby);
  return lobby;
}

module.exports = {
  async 'a board left over from a dead process is stripped of its buttons and says why'() {
    const channelId = `sweep-chan-${++counter}`;
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    const board = postedBoard(recorder, channelId, {
      content: '🎲 Random category rolled: **Video Games**!',
      components: [{ placeholder: 'buttons' }],
    });
    trackBoard('lobby', board);
    assert.equal(rowsFor(channelId).length, 1, 'the board is tracked while it is live');

    await sweepBoards(client);

    const [edit] = editsTo(recorder, channelId);
    assert.ok(edit, 'the leftover board was edited');
    assert.deepEqual(edit.payload.components, [], 'no clickable buttons survive');
    assert.match(edit.payload.content, /bot restarted/i, 'it explains itself');
    assert.match(edit.payload.content, /lobby create/, 'and says what to do next');
    assert.match(edit.payload.content, /Random category rolled/, 'the original content is kept');
    assert.equal(rowsFor(channelId).length, 0, 'the row is gone once swept');
  },

  async 'the sweep leaves the embeds alone so the board is still readable'() {
    const channelId = `sweep-chan-${++counter}`;
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    trackBoard('turn', postedBoard(recorder, channelId, { embeds: [{ title: 'Round 3' }] }));
    await sweepBoards(client);

    const [edit] = editsTo(recorder, channelId);
    assert.ok(!('embeds' in edit.payload), 'the edit does not touch embeds');
    assert.match(edit.payload.content, /game ended/i);
  },

  async 'the reveal keeps its Leaderboard button, which never needed the lost lobby'() {
    const channelId = `sweep-chan-${++counter}`;
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    trackBoard('gameover', postedBoard(recorder, channelId, { content: '🏆 <@p1> wins!' }));
    await sweepBoards(client);

    const [edit] = editsTo(recorder, channelId);
    const buttons = edit.payload.components[0].toJSON().components;
    assert.equal(buttons.length, 1, 'only one button left');
    assert.equal(buttons[0].custom_id, `over:leaderboard:${channelId}`, 'and it is the Leaderboard');
    assert.match(edit.payload.content, /Rematch/, 'the note names what went away');
  },

  async 'a board whose message is gone is dropped without throwing'() {
    const channelId = `sweep-chan-${++counter}`;
    const recorder = createRecorder();
    const client = createFakeClient(recorder);

    // Never recorded, so the fake client raises Unknown Message like Discord would.
    trackBoard('turn', { id: 'deleted-message', channelId });
    const result = await sweepBoards(client);

    assert.equal(editsTo(recorder, channelId).length, 0, 'nothing to edit');
    assert.equal(result.retired, 0, 'and nothing counted as retired');
    assert.equal(rowsFor(channelId).length, 0, 'but the row still goes');
  },

  async 'an unreachable channel does not stop the rest of the sweep'() {
    const goneChannel = `sweep-chan-${++counter}`;
    const liveChannel = `sweep-chan-${++counter}`;
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    const realFetch = client.channels.fetch;
    client.channels.fetch = async (id) => {
      if (id === goneChannel) throw new Error('Missing Access');
      return realFetch(id);
    };

    trackBoard('lobby', { id: 'whatever', channelId: goneChannel });
    trackBoard('lobby', postedBoard(recorder, liveChannel, { content: 'live board' }));
    await sweepBoards(client);

    assert.equal(rowsFor(goneChannel).length, 0);
    assert.equal(editsTo(recorder, liveChannel).length, 1, 'the reachable board was still retired');
  },

  async 'only the newest board of a kind in a channel is tracked'() {
    const channelId = `sweep-chan-${++counter}`;
    const recorder = createRecorder();

    // One turn board per turn: if a crash skips the untrack, the stale row is replaced
    // rather than piling up.
    trackBoard('turn', postedBoard(recorder, channelId, { content: 'turn 1' }));
    const newest = postedBoard(recorder, channelId, { content: 'turn 2' });
    trackBoard('turn', newest);

    const rows = rowsFor(channelId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].messageId, newest.id, 'the live one is the one kept');
  },

  async 'a lobby board that moves past WAITING is no longer swept'() {
    const channelId = `sweep-chan-${++counter}`;
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    const lobby = makeLobby(channelId);

    lobby.boardMessage = postedBoard(recorder, channelId, buildLobbyBoardPayload(lobby));
    trackBoard('lobby', lobby.boardMessage);

    lobby.status = 'IN_PROGRESS';
    await refreshLobbyBoard(lobby);
    assert.equal(rowsFor(channelId).length, 0, 'the board lost its buttons, so there is nothing to retire');

    const editsBefore = editsTo(recorder, channelId).length;
    await sweepBoards(client);
    assert.equal(editsTo(recorder, channelId).length, editsBefore, 'the sweep left it alone');
    GameManager.endLobby(channelId);
  },

  async 'an ended turn board and a closed vote board are untracked too'() {
    const channelId = `sweep-chan-${++counter}`;
    const recorder = createRecorder();

    const game = new Game({
      lobby: { guildId: 'sweep-guild', players: ['p1', 'p2'] },
      characters: [{ name: 'Mario' }, { name: 'Luigi' }],
      turnSeconds: 90,
    });
    game.turnBoardMessage = postedBoard(recorder, channelId, { content: 'turn board' });
    trackBoard('turn', game.turnBoardMessage);
    await refreshTurnBoard(game, channelId, { correct: true });
    assert.equal(rowsFor(channelId).length, 0, 'a finished turn leaves nothing to retire');

    // A real AudienceVote rather than a stub, so the board builder's actual dependencies
    // (per-slot tallies included) are exercised instead of a shape that drifts from it.
    const vote = new AudienceVote({
      lobby: { channelId, players: ['p1', 'p2'], voteSeconds: 60 },
      candidatesBySlot: { 1: [{ name: 'A' }], 2: [{ name: 'B' }] },
    });
    vote.closed = true;
    vote.boardMessage = postedBoard(recorder, channelId, { content: 'vote board' });
    trackBoard('vote', vote.boardMessage);
    await refreshVoteBoard(vote);
    assert.equal(rowsFor(channelId).length, 0, 'a closed vote leaves nothing to retire');
  },

  async 'a live game tracks its turn board, and confirming untracks the DM'() {
    const channelId = `sweep-chan-${++counter}`;
    const recorder = createRecorder();
    const client = createFakeClient(recorder);
    const lobby = makeLobby(channelId);

    await engine.startGame(client, lobby, [{ name: 'Mario' }, { name: 'Luigi' }]);
    // Both players were DM'd a character to confirm -- those buttons die on a restart too.
    assert.equal(rowsFor('p1').length, 1, "p1's confirm DM is tracked");
    assert.equal(rowsFor('p2').length, 1, "p2's confirm DM is tracked");

    for (const userId of ['p1', 'p2']) {
      const dmMessage = recorder.messageAt(userId, rowsFor(userId)[0].messageId);
      const interaction = createButtonInteraction({ client, userId, customId: `confirm:${channelId}`, recorder });
      // A real click carries the DM it was attached to; that's how the row is found again.
      interaction.message = { id: dmMessage.id, channelId: dmMessage.channelId, embeds: [] };
      await confirmPhase.handleConfirmationButton(interaction);
    }
    assert.equal(rowsFor('p1').length, 0, 'a confirmed DM has no buttons left');
    assert.equal(rowsFor('p2').length, 0);

    const turnRows = rowsFor(channelId).filter((r) => r.kind === 'turn');
    assert.equal(turnRows.length, 1, 'the live turn board is tracked');
    assert.equal(turnRows[0].messageId, lobby.game.turnBoardMessage.id);

    // What a restart mid-turn would do to it.
    await sweepBoards(client);
    const lastEdit = editsTo(recorder, channelId).at(-1);
    assert.deepEqual(lastEdit.payload.components, [], 'Guess/Pass are gone');
    assert.match(lastEdit.payload.content, /bot restarted/i);

    engine.clearTimers(lobby.game);
    GameManager.endLobby(channelId);
  },
};
