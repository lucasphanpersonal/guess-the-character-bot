const { assert, createRecorder, createFakeClient, createButtonInteraction } = require('./harness');

const { buildTurnBoardPayload, timerBar } = require('../src/game/turnBoard');
const { handleComponentInteraction } = require('../src/components/router');
const engine = require('../src/game/engine');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

async function runningGame() {
  const n = ++counter;
  const guildId = `turn-guild-${n}`;
  const channelId = `turn-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM game_results WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Turn List', 'tester', 'Video Games');
  for (const name of ['Mario', 'Luigi', 'Peach']) lists.addCharacter(listId, name, 'tester');

  const recorder = createRecorder();
  const client = createFakeClient(recorder);
  const lobby = new Lobby({
    guildId,
    channelId,
    hostId: 'p1',
    listIds: [listId],
    listNames: ['Turn List'],
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

function buttonsOf(payload) {
  const row = payload.components[0];
  if (!row) return {};
  const out = {};
  for (const c of row.toJSON().components) out[c.custom_id.split(':')[1]] = c;
  return out;
}

const clickButton = (ctx, userId, action) =>
  handleComponentInteraction(
    createButtonInteraction({
      client: ctx.client,
      userId,
      customId: `turn:${action}:${ctx.channelId}`,
      recorder: ctx.recorder,
    })
  );

// A modal submission carries its values in `fields`, not `options`.
function submitGuessModal(ctx, userId, text, { fromMessage = true } = {}) {
  const base = createButtonInteraction({
    client: ctx.client,
    userId,
    customId: `turn:submit:${ctx.channelId}`,
    recorder: ctx.recorder,
  });
  return handleComponentInteraction({
    ...base,
    fields: { getTextInputValue: () => text },
    isFromMessage: () => fromMessage,
    deferReply: async () => ctx.recorder.record(`defer:${userId}`, ''),
  });
}

const cleanup = (ctx) => {
  if (ctx.lobby.game) engine.clearTimers(ctx.lobby.game);
  GameManager.endLobby(ctx.channelId);
};

module.exports = {
  'the timer bar empties as time runs out'() {
    assert.equal(timerBar(1000, 1000), '████████████');
    assert.equal(timerBar(500, 1000), '██████░░░░░░');
    assert.equal(timerBar(0, 1000), '░░░░░░░░░░░░');
  },

  async 'a turn posts exactly one board carrying Guess and Pass'() {
    const ctx = await runningGame();
    const boards = ctx.recorder.sent.filter(
      (m) => m.target === `channel:${ctx.channelId}` && m.payload?.components?.length
    );
    assert.equal(boards.length, 1, 'one board message for the turn');

    const buttons = buttonsOf(boards[0].payload);
    assert.deepEqual(Object.keys(buttons).sort(), ['guess', 'pass']);
    assert.match(boards[0].content, /Round 1/);
    assert.match(boards[0].content, /<@p1>/);
    cleanup(ctx);
  },

  async 'the Guess button opens a modal rather than replying'() {
    const ctx = await runningGame();
    let shown = null;
    await handleComponentInteraction({
      ...createButtonInteraction({
        client: ctx.client,
        userId: 'p1',
        customId: `turn:guess:${ctx.channelId}`,
        recorder: ctx.recorder,
      }),
      showModal: async (modal) => {
        shown = modal.toJSON();
      },
    });
    assert.ok(shown, 'a modal was shown');
    assert.equal(shown.custom_id, `turn:submit:${ctx.channelId}`);
    cleanup(ctx);
  },

  async 'only the player whose turn it is can use the controls'() {
    const ctx = await runningGame();
    await clickButton(ctx, 'p2', 'pass');
    assert.equal(ctx.lobby.game.currentPlayerId, 'p1', 'p2 could not pass p1\'s turn');
    assert.match(ctx.recorder.allText(), /not yours/);
    cleanup(ctx);
  },

  async 'a wrong guess from the modal keeps the turn and shows up on the board'() {
    const ctx = await runningGame();
    await submitGuessModal(ctx, 'p1', 'Definitely Wrong');

    assert.equal(ctx.lobby.game.currentPlayerId, 'p1', 'turn continues');
    assert.deepEqual(
      ctx.lobby.game.turnGuesses.map((g) => `${g.correct ? 'ok' : 'x'} ${g.text}`),
      ['x Definitely Wrong']
    );
    assert.match(ctx.recorder.textMatching(`channel:${ctx.channelId}`), /Definitely Wrong/);
    assert.match(ctx.recorder.allText(), /Not quite/);
    cleanup(ctx);
  },

  async 'a correct guess from the modal advances the game'() {
    const ctx = await runningGame();
    await submitGuessModal(ctx, 'p1', 'Mario'); // p1's own head is Mario

    assert.equal(ctx.lobby.game.rebuttal, true, 'first mover winning grants a rebuttal');
    assert.equal(ctx.lobby.game.currentPlayerId, 'p2');
    assert.match(ctx.recorder.allText(), /Correct/);
    cleanup(ctx);
  },

  async 'an empty guess is rejected without consuming anything'() {
    const ctx = await runningGame();
    await submitGuessModal(ctx, 'p1', '   ');
    assert.equal(ctx.lobby.game.turnGuesses.length, 0);
    assert.match(ctx.recorder.allText(), /Enter a character name/);
    cleanup(ctx);
  },

  async 'the Pass button hands the turn over'() {
    const ctx = await runningGame();
    await clickButton(ctx, 'p1', 'pass');
    assert.equal(ctx.lobby.game.currentPlayerId, 'p2');
    cleanup(ctx);
  },

  async 'an ended turn leaves no clickable buttons behind'() {
    const ctx = await runningGame();
    await clickButton(ctx, 'p1', 'pass');

    // The final edit to the turn-1 board must have dropped its components.
    const edits = ctx.recorder.sent.filter((m) => m.target === `channel:${ctx.channelId}:edit`);
    const finalEdit = edits.at(-1);
    assert.ok(finalEdit, 'the outgoing board was edited');
    assert.deepEqual(finalEdit.payload.components, [], 'buttons stripped');
    assert.match(finalEdit.content, /Turn over/);
    cleanup(ctx);
  },

  async 'each new turn gets its own board and a clean guess tally'() {
    const ctx = await runningGame();
    await submitGuessModal(ctx, 'p1', 'wrong one');
    assert.equal(ctx.lobby.game.turnGuesses.length, 1);

    await clickButton(ctx, 'p1', 'pass');
    assert.equal(ctx.lobby.game.turnGuesses.length, 0, 'tally reset for p2\'s turn');

    const boards = ctx.recorder.sent.filter(
      (m) => m.target === `channel:${ctx.channelId}` && m.payload?.components?.length
    );
    assert.equal(boards.length, 2, 'a second board for the second turn');
    cleanup(ctx);
  },

  'the board switches to a last-chance state when paused'() {
    const game = {
      rebuttal: false,
      round: 1,
      currentPlayerId: 'p1',
      turnSeconds: 90,
      timer: null,
      paused: true,
      turnGuesses: [],
    };
    const payload = buildTurnBoardPayload(game, 'chan');
    assert.match(payload.embeds[0].toJSON().description, /Time's up/);
    assert.equal(payload.components.length, 1, 'still guessable');
  },

  async 'turn controls on a finished game fail gracefully'() {
    const ctx = await runningGame();
    ctx.lobby.status = 'FINISHED';
    await clickButton(ctx, 'p1', 'pass');
    assert.match(ctx.recorder.allText(), /no longer running/);
    cleanup(ctx);
  },
};
