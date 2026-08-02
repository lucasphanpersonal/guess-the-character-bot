const {
  assert,
  createRecorder,
  createFakeClient,
  createButtonInteraction,
  createSlashInteraction,
  attachFakeVoice,
} = require('./harness');

const engine = require('../src/game/engine');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const stats = require('../src/db/stats');
const db = require('../src/db/connection');

const MARIO = { name: 'Mario', image_url: null };
const LUIGI = { name: 'Luigi', image_url: null };

let counter = 0;

// Builds a lobby with two joined players and runs it up to IN_PROGRESS (both confirmed).
async function startedGame({ turnSeconds = 90, maxRerolls = 2, characters = [MARIO, LUIGI] } = {}) {
  const n = ++counter;
  const guildId = `flow-guild-${n}`;
  const channelId = `flow-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM game_results WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Flow List', 'tester', 'Video Games');
  for (const c of [MARIO, LUIGI, { name: 'Peach' }, { name: 'Bowser' }]) {
    lists.addCharacter(listId, c.name, 'tester');
  }

  const recorder = createRecorder();
  const client = createFakeClient(recorder);
  const lobby = new Lobby({
    guildId,
    channelId,
    hostId: 'p1',
    listIds: [listId],
    listNames: ['Flow List'],
    turnSeconds,
    maxRerolls,
  });
  lobby.addPlayer('p1');
  lobby.addPlayer('p2');
  GameManager.createLobby(channelId, lobby);

  await engine.startGame(client, lobby, characters);
  return { lobby, client, recorder, guildId, channelId, listId };
}

async function confirmBoth({ client, recorder, channelId }) {
  for (const userId of ['p1', 'p2']) {
    await engine.handleConfirmationButton(
      createButtonInteraction({ client, userId, customId: `confirm:${channelId}`, recorder })
    );
  }
}

// Guesses are called out in voice and ruled on by the other player, so a test "guess" is
// the judge's verdict, not a string. `userId` is still the guesser, for readability.
function guess({ client, lobby }, userId, correct) {
  const judgeId = lobby.game.turnOrder.find((id) => id !== userId);
  return engine.submitJudgement(client, lobby, judgeId, correct);
}

function pass({ client, recorder, lobby }, userId) {
  return engine.handlePass(
    createSlashInteraction({ client, userId, guildId: lobby.guildId, channelId: lobby.channelId, recorder }),
    lobby
  );
}

function cleanup(ctx) {
  if (ctx.lobby.game) engine.clearTimers(ctx.lobby.game);
  GameManager.endLobby(ctx.channelId);
}

// Everything the bot posted or edited in the game channel (turn boards are edits).
const channelText = (ctx) => ctx.recorder.textMatching(`channel:${ctx.channelId}`);
const lastChannelMessage = (ctx) => ctx.recorder.lastMatching(`channel:${ctx.channelId}`).content;

module.exports = {
  async 'a game waits in CONFIRMING until both players confirm'() {
    const ctx = await startedGame();
    assert.equal(ctx.lobby.status, 'CONFIRMING');

    await engine.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `confirm:${ctx.channelId}`, recorder: ctx.recorder })
    );
    assert.equal(ctx.lobby.status, 'CONFIRMING', 'one confirmation is not enough');

    await engine.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p2', customId: `confirm:${ctx.channelId}`, recorder: ctx.recorder })
    );
    assert.equal(ctx.lobby.status, 'IN_PROGRESS');
    cleanup(ctx);
  },

  async 'each player is DM\'d the OTHER player\'s character'() {
    const ctx = await startedGame();
    // p1 must be told Luigi (p2's head) so they can answer p2's questions -- never Mario.
    const toP1 = ctx.recorder.sent.find((m) => m.target === 'dm:p1');
    const toP2 = ctx.recorder.sent.find((m) => m.target === 'dm:p2');
    // The source line matters when a name is ambiguous across shows, so it is asserted
    // alongside the name rather than matched loosely.
    assert.equal(toP1.payload.embeds[0].data.description, '**Luigi**\n*from Flow List (Video Games)*');
    assert.equal(toP2.payload.embeds[0].data.description, '**Mario**\n*from Flow List (Video Games)*');
    cleanup(ctx);
  },

  async 'the list and category are announced in DMs and in the channel'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    assert.match(ctx.recorder.textFor('dm:p1').join('\n'), /Flow List \(Video Games\)/);
    assert.match(ctx.recorder.textFor('dm:p2').join('\n'), /Flow List \(Video Games\)/);
    assert.match(ctx.recorder.textFor(`channel:${ctx.channelId}`).join('\n'), /Flow List \(Video Games\)/);
    cleanup(ctx);
  },

  async 'a wrong guess during your own time does NOT end your turn'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    const game = ctx.lobby.game;

    await guess(ctx, 'p1', false);
    assert.equal(game.currentPlayerId, 'p1', 'still p1 after one wrong guess');
    await guess(ctx, 'p1', false);
    assert.equal(game.currentPlayerId, 'p1', 'still p1 after a second wrong guess');

    // Tallied on the turn board rather than spamming the channel -- as a count, because a
    // guess called out in voice has no text for the bot to print.
    assert.equal(game.turnGuesses.length, 2);
    assert.match(channelText(ctx), /\*\*2\*\* guesses this game/);
    cleanup(ctx);
  },

  async 'passing hands the turn over'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await pass(ctx, 'p1');
    assert.equal(ctx.lobby.game.currentPlayerId, 'p2');
    cleanup(ctx);
  },

  async 'running out of time pauses for one final guess instead of ending the turn'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    const game = ctx.lobby.game;

    await engine.handleTimeout(ctx.client, ctx.lobby);
    assert.equal(game.paused, true);
    assert.equal(game.currentPlayerId, 'p1', 'turn has not moved on yet');
    assert.match(channelText(ctx), /last chance/i);

    await guess(ctx, 'p1', false);
    assert.equal(game.paused, false);
    assert.equal(game.currentPlayerId, 'p2', 'now it moves on');
    cleanup(ctx);
  },

  async 'first mover guessing right grants the opponent a rebuttal turn'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await guess(ctx, 'p1', true); // ruled correct by p2
    assert.equal(ctx.lobby.game.rebuttal, true);
    assert.equal(ctx.lobby.game.currentPlayerId, 'p2');
    assert.equal(ctx.lobby.status, 'IN_PROGRESS', 'not over yet');
    cleanup(ctx);
  },

  async 'a failed rebuttal gives the first mover the win, and says so'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await guess(ctx, 'p1', true);
    await pass(ctx, 'p2'); // rebuttal squandered

    assert.equal(ctx.lobby.status, 'FINISHED');
    const final = lastChannelMessage(ctx);
    assert.match(final, /didn't get it on the rebuttal turn/);
    assert.match(final, /p1> wins/);
    assert.deepEqual(stats.getPlayerStats(ctx.guildId, 'p1'), { wins: 1, losses: 0, ties: 0, total: 1 });
    assert.deepEqual(stats.getPlayerStats(ctx.guildId, 'p2'), { wins: 0, losses: 1, ties: 0, total: 1 });
    cleanup(ctx);
  },

  async 'a successful rebuttal is a tie'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await guess(ctx, 'p1', true);
    await guess(ctx, 'p2', true);

    assert.equal(ctx.lobby.status, 'FINISHED');
    assert.match(lastChannelMessage(ctx), /tie/);
    assert.equal(stats.getPlayerStats(ctx.guildId, 'p1').ties, 1);
    assert.equal(stats.getPlayerStats(ctx.guildId, 'p2').ties, 1);
    cleanup(ctx);
  },

  async 'the second player winning ends the game immediately (no rebuttal owed)'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await pass(ctx, 'p1');
    await guess(ctx, 'p2', true);

    assert.equal(ctx.lobby.status, 'FINISHED');
    const final = lastChannelMessage(ctx);
    assert.match(final, /guessed correctly and wins/);
    assert.ok(!/rebuttal/i.test(final), 'must not mention a rebuttal that never happened');
    cleanup(ctx);
  },

  async 'sound effects fire for wrong, correct and win'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    const played = attachFakeVoice(ctx.lobby.game);

    await guess(ctx, 'p1', false);
    assert.equal(played.length, 1, 'wrong-guess sound');
    await guess(ctx, 'p1', true);
    assert.equal(played.length, 2, 'correct-guess sound');
    await pass(ctx, 'p2'); // ends the game -> win sting
    assert.equal(played.length, 3, 'win sound');
    cleanup(ctx);
  },

  async 'rerolling swaps the other player\'s character and never repeats a rejection'() {
    const ctx = await startedGame({ maxRerolls: 2 });
    const game = ctx.lobby.game;
    const originallyShownToP1 = game.headByPlayer.p2.name; // p1 was DM'd p2's head

    await engine.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `reroll:${ctx.channelId}`, recorder: ctx.recorder })
    );
    const afterFirst = game.headByPlayer.p2.name;
    assert.notEqual(afterFirst, originallyShownToP1);
    assert.notEqual(afterFirst, game.headByPlayer.p1.name, 'never collides with the sibling head');
    assert.equal(game.confirmState.p1.rerollsLeft, 1);

    await engine.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `reroll:${ctx.channelId}`, recorder: ctx.recorder })
    );
    const afterSecond = game.headByPlayer.p2.name;
    assert.notEqual(afterSecond, originallyShownToP1, 'a rejected name is never offered again');
    assert.notEqual(afterSecond, afterFirst);
    assert.equal(game.confirmState.p1.rerollsLeft, 0);

    // Third attempt is refused and changes nothing.
    await engine.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `reroll:${ctx.channelId}`, recorder: ctx.recorder })
    );
    assert.equal(game.headByPlayer.p2.name, afterSecond);
    cleanup(ctx);
  },

  async 'unlimited rerolls never decrement'() {
    const ctx = await startedGame({ maxRerolls: -1 });
    assert.equal(ctx.lobby.game.confirmState.p1.rerollsLeft, -1);
    for (let i = 0; i < 3; i++) {
      await engine.handleConfirmationButton(
        createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `reroll:${ctx.channelId}`, recorder: ctx.recorder })
      );
      assert.equal(ctx.lobby.game.confirmState.p1.rerollsLeft, -1);
    }
    cleanup(ctx);
  },

  async 'two channels run independent games at the same time'() {
    const a = await startedGame();
    const b = await startedGame();
    assert.notEqual(a.channelId, b.channelId);

    // Confirming in channel A must not touch channel B -- the button customId is scoped
    // by channel, which is what makes concurrent games safe.
    await confirmBoth(a);
    assert.equal(a.lobby.status, 'IN_PROGRESS');
    assert.equal(b.lobby.status, 'CONFIRMING');

    await confirmBoth(b);
    assert.equal(b.lobby.status, 'IN_PROGRESS');
    cleanup(a);
    cleanup(b);
  },

  async 'a finished lobby stays available for /rematch but does not block a new lobby'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await pass(ctx, 'p1');
    await guess(ctx, 'p2', true);
    assert.equal(ctx.lobby.status, 'FINISHED');
    assert.equal(GameManager.getLobby(ctx.channelId), ctx.lobby, 'kept for /rematch');

    const rematch = require('../src/commands/rematch');
    await rematch.execute(
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
    assert.deepEqual(fresh.players, ['p2', 'p1'], 'turn order swaps between games');
    assert.deepEqual(fresh.listIds, ctx.lobby.listIds, 'settings carried over');
    GameManager.endLobby(ctx.channelId);
  },
};
