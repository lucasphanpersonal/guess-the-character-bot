// Judged guesses: the primary way a turn resolves.
//
// Guesses get called out in voice, so the bot never sees most of them. Judging moves the
// input to the player who ISN'T busy -- the one who can see the answer and is only
// listening -- which is both accurate and how the physical game already works.

const { assert, createRecorder, createFakeClient, createButtonInteraction } = require('./harness');
const { buildTurnBoardPayload } = require('../src/game/turnBoard');
const { handleComponentInteraction } = require('../src/components/router');
const engine = require('../src/game/engine');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

async function runningGame() {
  const n = ++counter;
  const guildId = `judge-guild-${n}`;
  const channelId = `judge-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM game_results WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Judge List', 'tester', 'Video Games');
  for (const name of ['Mario', 'Luigi', 'Peach', 'Bowser']) lists.addCharacter(listId, name, 'tester');

  const recorder = createRecorder();
  const client = createFakeClient(recorder);
  const lobby = new Lobby({
    guildId,
    channelId,
    hostId: 'p1',
    listIds: [listId],
    listNames: ['Judge List'],
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
  return { lobby, client, recorder, channelId };
}

const press = (ctx, userId, action) =>
  handleComponentInteraction(
    createButtonInteraction({
      client: ctx.client,
      userId,
      customId: `turn:${action}:${ctx.channelId}`,
      recorder: ctx.recorder,
    })
  );

function cleanup(ctx) {
  if (ctx.lobby.game) engine.clearTimers(ctx.lobby.game);
  GameManager.endLobby(ctx.channelId);
}

const labelOf = (payload, action) => {
  for (const row of payload.components ?? []) {
    for (const c of row.toJSON().components) {
      if (c.custom_id.split(':')[1] === action) return c.label;
    }
  }
  return null;
};

module.exports = {
  async 'the judge is the player who is not guessing'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;
    assert.equal(game.currentPlayerId, 'p1');
    assert.equal(game.judgeId, 'p2', 'the one who can see the answer');
    cleanup(ctx);
  },

  async 'a wrong ruling counts the guess and keeps the turn alive'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;

    await press(ctx, 'p2', 'wrong');
    assert.equal(game.guessLog.length, 1);
    assert.equal(game.guessCountFor('p1'), 1, 'counted against the guesser, not the judge');
    assert.equal(game.currentPlayerId, 'p1', 'a wrong guess never ends a turn');

    await press(ctx, 'p2', 'wrong');
    assert.equal(game.guessCountFor('p1'), 2);
    cleanup(ctx);
  },

  // The bot never heard the name, so it stores none -- inventing a placeholder would be
  // worse than admitting the guess was spoken.
  async 'a judged guess is recorded without a name, and shows only in the count'() {
    const ctx = await runningGame();
    await press(ctx, 'p2', 'wrong');

    const [entry] = ctx.lobby.game.guessLog;
    assert.equal(entry.text, null);
    assert.equal(entry.judged, true);
    assert.equal(entry.correct, false);

    // The board reports a count rather than a list -- there is no name to list.
    const payload = buildTurnBoardPayload(ctx.lobby.game, ctx.channelId);
    const field = payload.embeds[0].toJSON().fields.find((f) => f.name === 'Guesses so far');
    assert.match(field.value, /\*\*1\*\* guess this game/);
    cleanup(ctx);
  },

  async 'the running count rides on the button so the judge sees presses land'() {
    const ctx = await runningGame();
    assert.equal(labelOf(buildTurnBoardPayload(ctx.lobby.game, ctx.channelId), 'wrong'), 'Nope');

    await press(ctx, 'p2', 'wrong');
    await press(ctx, 'p2', 'wrong');
    assert.equal(labelOf(buildTurnBoardPayload(ctx.lobby.game, ctx.channelId), 'wrong'), 'Nope · 2');
    cleanup(ctx);
  },

  async 'a correct ruling ends the turn without the bot matching any text'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;

    await press(ctx, 'p2', 'right');
    assert.equal(game.guessLog.at(-1).correct, true);
    // p1 moved first, so a correct guess buys the other player a rebuttal rather than
    // ending the game outright.
    assert.equal(game.rebuttal, true);
    assert.equal(game.currentPlayerId, 'p2');
    cleanup(ctx);
  },

  async 'the guesser cannot judge their own guess'() {
    const ctx = await runningGame();
    await press(ctx, 'p1', 'right');

    assert.equal(ctx.lobby.game.guessLog.length, 0, 'nothing recorded');
    assert.equal(ctx.lobby.game.rebuttal, false, 'and the turn did not resolve');
    assert.match(ctx.recorder.allText(), /You're guessing this turn/);
    cleanup(ctx);
  },

  async 'a spectator cannot judge either'() {
    const ctx = await runningGame();
    await press(ctx, 'nosy-spectator', 'wrong');
    assert.equal(ctx.lobby.game.guessLog.length, 0);
    assert.match(ctx.recorder.allText(), /Only <@p2> can judge/);
    cleanup(ctx);
  },

  // Once time is up the turn is in its last-chance state, so a ruling either way ends it.
  async 'a ruling after time runs out ends the turn'() {
    const ctx = await runningGame();
    ctx.lobby.game.paused = true;

    await press(ctx, 'p2', 'wrong');
    assert.equal(ctx.lobby.game.currentPlayerId, 'p2', 'turn handed over');
    cleanup(ctx);
  },

  // The tally is per player and spans the whole game, so ending a turn does not wipe what
  // somebody has already spent. Stopping a REPEAT guess is the other player's job now --
  // the bot has no names to compare.
  async 'each player keeps their own running tally across turns'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;

    await press(ctx, 'p2', 'wrong');
    await press(ctx, 'p1', 'pass');
    assert.equal(game.currentPlayerId, 'p2', "now p2's turn");

    // Each player's count is their own.
    await press(ctx, 'p1', 'wrong');
    assert.equal(game.guessCountFor('p2'), 1);
    assert.equal(game.guessCountFor('p1'), 1, "p1's earlier guess survived their turn ending");

    await press(ctx, 'p2', 'pass');
    const payload = buildTurnBoardPayload(game, ctx.channelId);
    const field = payload.embeds[0].toJSON().fields.find((f) => f.name === 'Guesses so far');
    assert.match(field.value, /\*\*1\*\* guess this game/, "p1's count survived a full round");
    cleanup(ctx);
  },

  async 'typed guesses and judged ones share one tally'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;

    await press(ctx, 'p2', 'wrong');
    await engine.submitGuess(ctx.client, ctx.lobby, 'p1', 'Peach');
    assert.equal(game.guessCountFor('p1'), 2, 'both paths count');
    assert.deepEqual(game.triedNames('p1'), ['Peach'], 'only the typed one has a name');
    cleanup(ctx);
  },

  async 'the reveal reports how many guesses it took'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;

    await press(ctx, 'p2', 'wrong');
    await press(ctx, 'p2', 'wrong');
    await press(ctx, 'p2', 'right');
    // p1 was first mover, so p2 gets a rebuttal; passing it hands p1 the win.
    await engine.submitPass(ctx.client, ctx.lobby, 'p2');

    const revealed = ctx.recorder.textMatching(`channel:${ctx.channelId}`);
    assert.match(revealed, /guess \*\*#3\*\*/, 'three guesses, the third of which landed');
    cleanup(ctx);
  },

  async 'judging a game that is over fails gracefully'() {
    const ctx = await runningGame();
    ctx.lobby.status = 'FINISHED';
    await press(ctx, 'p2', 'right');
    assert.match(ctx.recorder.allText(), /no longer running/);
    cleanup(ctx);
  },
};
