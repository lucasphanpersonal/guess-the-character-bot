const { assert, createRecorder, createFakeClient, createButtonInteraction, createSlashInteraction } = require('./harness');

const engine = require('../src/game/engine');
const { handleComponentInteraction } = require('../src/components/router');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

// Plays a game through to completion so the reveal (and its buttons) exist.
async function finishedGame() {
  const n = ++counter;
  const guildId = `over-guild-${n}`;
  const channelId = `over-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM game_results WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Over List', 'tester', 'Video Games');
  for (const name of ['Mario', 'Luigi', 'Peach']) lists.addCharacter(listId, name, 'tester');

  const recorder = createRecorder();
  const client = createFakeClient(recorder);
  const lobby = new Lobby({
    guildId,
    channelId,
    hostId: 'p1',
    listIds: [listId],
    listNames: ['Over List'],
    turnSeconds: 90,
    maxRerolls: 2,
  });
  lobby.addPlayer('p1');
  lobby.addPlayer('p2');
  GameManager.createLobby(channelId, lobby);

  await engine.startGame(client, lobby, [
    { name: 'Mario', image_url: null },
    { name: 'Luigi', image_url: null },
  ]);
  for (const userId of ['p1', 'p2']) {
    await engine.handleConfirmationButton(
      createButtonInteraction({ client, userId, customId: `confirm:${channelId}`, recorder })
    );
  }
  // p1 passes, p2 guesses their own head correctly -> immediate win, no rebuttal.
  await engine.submitPass(client, lobby, 'p1');
  await engine.submitJudgement(client, lobby, 'p1', true);

  return { lobby, client, recorder, channelId, guildId };
}

const clickOver = (ctx, userId, action) =>
  handleComponentInteraction(
    createButtonInteraction({
      client: ctx.client,
      userId,
      customId: `over:${action}:${ctx.channelId}`,
      recorder: ctx.recorder,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
    })
  );

module.exports = {
  async 'the reveal carries Rematch and Leaderboard buttons'() {
    const ctx = await finishedGame();
    assert.equal(ctx.lobby.status, 'FINISHED');

    const reveal = ctx.recorder.lastMatching(`channel:${ctx.channelId}`);
    const buttons = reveal.payload.components[0].toJSON().components;
    assert.deepEqual(
      buttons.map((b) => b.custom_id.split(':')[1]).sort(),
      ['leaderboard', 'rematch']
    );
    GameManager.endLobby(ctx.channelId);
  },

  async 'the Rematch button opens a fresh lobby with the players swapped'() {
    const ctx = await finishedGame();
    await clickOver(ctx, 'p2', 'rematch');

    const fresh = GameManager.getLobby(ctx.channelId);
    assert.equal(fresh.status, 'WAITING');
    assert.deepEqual(fresh.players, ['p2', 'p1'], 'order swapped versus the finished game');
    assert.deepEqual(fresh.listIds, ctx.lobby.listIds, 'settings carried over');
    assert.equal(fresh.hostId, 'p2', 'whoever clicked hosts the rematch');
    GameManager.endLobby(ctx.channelId);
  },

  async 'rematch settings survive for an audience-vote lobby too'() {
    const ctx = await finishedGame();
    ctx.lobby.mode = 'audience-vote';
    ctx.lobby.voteOptions = 4;
    ctx.lobby.voteSeconds = 45;

    await clickOver(ctx, 'p1', 'rematch');
    const fresh = GameManager.getLobby(ctx.channelId);
    assert.equal(fresh.mode, 'audience-vote');
    assert.equal(fresh.voteOptions, 4);
    assert.equal(fresh.voteSeconds, 45);
    GameManager.endLobby(ctx.channelId);
  },

  async 'the Leaderboard button replies privately with the standings'() {
    const ctx = await finishedGame();
    await clickOver(ctx, 'someone', 'leaderboard');

    const reply = ctx.recorder.lastMatching('reply:someone');
    assert.match(reply.content, /Leaderboard/);
    // p2 won the game played above.
    assert.match(reply.content, /<@p2>/);
    assert.ok(reply.payload.flags, 'sent ephemerally');
    GameManager.endLobby(ctx.channelId);
  },

  async 'pressing Rematch twice does not stack lobbies'() {
    const ctx = await finishedGame();
    await clickOver(ctx, 'p1', 'rematch');
    const first = GameManager.getLobby(ctx.channelId);

    // The finished lobby is gone now, so a second press has nothing to rematch.
    await clickOver(ctx, 'p1', 'rematch');
    assert.equal(GameManager.getLobby(ctx.channelId), first, 'lobby unchanged');
    assert.match(ctx.recorder.allText(), /already been replaced/);
    GameManager.endLobby(ctx.channelId);
  },

  async '/rematch and the button produce the same result'() {
    const ctx = await finishedGame();
    const rematchCmd = require('../src/commands/rematch');
    await rematchCmd.execute(
      createSlashInteraction({
        client: ctx.client,
        userId: 'p1',
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        recorder: ctx.recorder,
      })
    );
    const fresh = GameManager.getLobby(ctx.channelId);
    assert.equal(fresh.status, 'WAITING');
    assert.deepEqual(fresh.players, ['p2', 'p1']);
    GameManager.endLobby(ctx.channelId);
  },
};
