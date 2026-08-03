const {
  assert,
  createRecorder,
  createFakeClient,
  createButtonInteraction,
  createSlashInteraction,
  attachFakeVoice,
} = require('./harness');

const engine = require('../src/game/engine');
const confirmPhase = require('../src/game/confirmPhase');
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
  db.prepare('DELETE FROM games WHERE guild_id = ?').run(guildId);

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
    await confirmPhase.handleConfirmationButton(
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

    await confirmPhase.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `confirm:${ctx.channelId}`, recorder: ctx.recorder })
    );
    assert.equal(ctx.lobby.status, 'CONFIRMING', 'one confirmation is not enough');

    await confirmPhase.handleConfirmationButton(
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
    // alongside the name rather than matched loosely -- as is the owner's name, because
    // scrolling back to an unlabelled character answers nothing about who it was for.
    assert.equal(
      toP1.payload.embeds[0].data.description,
      "**Userp2's character**: **Luigi**\n*from Flow List (Video Games)*"
    );
    assert.equal(
      toP2.payload.embeds[0].data.description,
      "**Userp1's character**: **Mario**\n*from Flow List (Video Games)*"
    );
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

    // Wrong guesses cost nothing and are not counted anywhere: the bot only ever knew how
    // many a judge remembered to press, which flattered whoever pressed least.
    assert.equal(game.turnsFor('p1'), 1, 'guessing does not consume turns, only the clock does');
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

  // The three tests below are the regression check on the whole scoring change: at two
  // players the new rule must pick the same WINNER the rebuttal rule did in every case. What
  // it deliberately does not preserve is when the game stops -- nobody is cut off any more.
  async 'getting it does not end the game -- the other player plays on'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await guess(ctx, 'p1', true); // ruled correct by p2

    assert.equal(ctx.lobby.status, 'IN_PROGRESS', 'not over -- p2 still has a character to get');
    assert.equal(ctx.lobby.game.finishedBy.get('p1'), 1, 'p1 got it on turn 1');
    assert.equal(ctx.lobby.game.currentPlayerId, 'p2');
    // Publicly revealed the moment they got it: everyone else could already see it, and
    // they have just worked it out themselves.
    assert.match(channelText(ctx), /got it in \*\*1\*\* turn!/);
    cleanup(ctx);
  },

  async 'the player who took fewer turns wins, and the loser is told what they needed'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await guess(ctx, 'p1', true); // p1 done on turn 1

    // p2 is alone now, so Pass would surrender -- running out of time is how their turn
    // ends without giving up. The ruling comes from p1, who has finished but can still see
    // p2's character and so is still the judge.
    await engine.handleTimeout(ctx.client, ctx.lobby);
    await guess(ctx, 'p2', false);
    assert.equal(ctx.lobby.status, 'IN_PROGRESS', 'a lone player is not cut off');
    await guess(ctx, 'p2', true); // gets theirs on turn 2

    assert.equal(ctx.lobby.status, 'FINISHED');
    const final = lastChannelMessage(ctx);
    assert.match(final, /<@p1> wins — got it in \*\*1\*\* turn!/);
    assert.match(final, /<@p2> needed 2/);
    assert.deepEqual(stats.getPlayerStats(ctx.guildId, 'p1').wins, 1);
    assert.deepEqual(stats.getPlayerStats(ctx.guildId, 'p2').losses, 1);
    cleanup(ctx);
  },

  async 'the same turn count is a tie, with no tiebreaker'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await guess(ctx, 'p1', true);
    await guess(ctx, 'p2', true); // both on turn 1

    assert.equal(ctx.lobby.status, 'FINISHED');
    assert.match(lastChannelMessage(ctx), /It's a tie/);
    assert.equal(stats.getPlayerStats(ctx.guildId, 'p1').ties, 1);
    assert.equal(stats.getPlayerStats(ctx.guildId, 'p2').ties, 1);
    cleanup(ctx);
  },

  async 'the second player getting it first still wins, on equal turns'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await pass(ctx, 'p1');
    await guess(ctx, 'p2', true); // p2 done on turn 1, p1 has had a turn and failed it
    // p1 is alone and can no longer even tie, but is not cut off -- they play on.
    assert.equal(ctx.lobby.status, 'IN_PROGRESS');
    await guess(ctx, 'p1', true); // gets theirs on turn 2

    assert.equal(ctx.lobby.status, 'FINISHED');
    const final = lastChannelMessage(ctx);
    assert.match(final, /<@p2> wins/);
    assert.ok(!/rebuttal/i.test(final), 'the rebuttal rule is gone entirely');
    cleanup(ctx);
  },

  // Each character is revealed the moment its wearer gets it, so repeating them in the final
  // message put the same name and artwork in the channel twice running.
  async 'the reveal shows only characters nobody has seen yet'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await guess(ctx, 'p1', true); // Mario revealed here
    await engine.handleTimeout(ctx.client, ctx.lobby);
    await guess(ctx, 'p2', false);
    await guess(ctx, 'p2', true); // Luigi revealed here

    const reveal = ctx.recorder.lastMatching(`channel:${ctx.channelId}`);
    assert.deepEqual(reveal.payload.embeds, [], 'both were already revealed on completion');
    assert.match(reveal.content, /<@p1> wins/);
    // ...but each was still shown exactly once, on the way past.
    const shown = channelText(ctx).match(/They were wearing/g) ?? [];
    assert.equal(shown.length, 2);
    cleanup(ctx);
  },

  async 'a character nobody got is revealed at the end'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await guess(ctx, 'p1', true);
    await pass(ctx, 'p2'); // gives up -- Luigi was never revealed

    const reveal = ctx.recorder.lastMatching(`channel:${ctx.channelId}`);
    assert.equal(reveal.payload.embeds.length, 1, 'only the one still unanswered');
    assert.match(reveal.payload.embeds[0].data.description, /Luigi/);
    cleanup(ctx);
  },

  async 'the last player still guessing can give up, and Pass says so'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await guess(ctx, 'p1', true);
    const game = ctx.lobby.game;

    // p2 is now the only one left, so their control is relabelled before it changes meaning.
    const { buildTurnBoardPayload } = require('../src/game/turnBoard');
    const passBtn = buildTurnBoardPayload(game, ctx.channelId)
      .components[1].toJSON().components[0];
    assert.equal(passBtn.label, 'Give up');
    assert.match(channelText(ctx), /You're the last one guessing/);

    await pass(ctx, 'p2');
    assert.equal(ctx.lobby.status, 'FINISHED');
    assert.match(lastChannelMessage(ctx), /<@p2> gave up/);
    assert.equal(stats.getPlayerStats(ctx.guildId, 'p2').losses, 1);
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

    await confirmPhase.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `reroll:${ctx.channelId}`, recorder: ctx.recorder })
    );
    const afterFirst = game.headByPlayer.p2.name;
    assert.notEqual(afterFirst, originallyShownToP1);
    assert.notEqual(afterFirst, game.headByPlayer.p1.name, 'never collides with the sibling head');
    assert.equal(game.confirmState.p1.rerollsLeft, 1);

    await confirmPhase.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `reroll:${ctx.channelId}`, recorder: ctx.recorder })
    );
    const afterSecond = game.headByPlayer.p2.name;
    assert.notEqual(afterSecond, originallyShownToP1, 'a rejected name is never offered again');
    assert.notEqual(afterSecond, afterFirst);
    assert.equal(game.confirmState.p1.rerollsLeft, 0);

    // Third attempt is refused and changes nothing.
    await confirmPhase.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `reroll:${ctx.channelId}`, recorder: ctx.recorder })
    );
    assert.equal(game.headByPlayer.p2.name, afterSecond);
    cleanup(ctx);
  },

  async 'unlimited rerolls never decrement'() {
    const ctx = await startedGame({ maxRerolls: -1 });
    assert.equal(ctx.lobby.game.confirmState.p1.rerollsLeft, -1);
    for (let i = 0; i < 3; i++) {
      await confirmPhase.handleConfirmationButton(
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
    await pass(ctx, 'p1'); // p1 alone, gives up -- that's what ends it
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
    // Order is no longer swapped: scoring on turns taken means the seat carries no
    // advantage to alternate away.
    assert.deepEqual(fresh.players, ['p1', 'p2'], 'turn order carries over');
    assert.deepEqual(fresh.listIds, ctx.lobby.listIds, 'settings carried over');
    GameManager.endLobby(ctx.channelId);
  },
};
