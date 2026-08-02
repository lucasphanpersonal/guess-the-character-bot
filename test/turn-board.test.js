const {
  assert,
  createRecorder,
  createFakeClient,
  createButtonInteraction,
  createSlashInteraction,
} = require('./harness');

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

// The board carries two rows now -- the judge's and the guesser's -- so flatten both.
function buttonsOf(payload) {
  const out = {};
  for (const row of payload.components ?? []) {
    for (const c of row.toJSON().components) out[c.custom_id.split(':')[1]] = c;
  }
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

// Typing a guess now only happens through /guess -- the board has no submit control, so
// that the judge's ruling is the single authority on whether a guess was right.
function typeGuess(ctx, userId, text) {
  return require('../src/commands/guess').execute(
    createSlashInteraction({
      client: ctx.client,
      userId,
      guildId: ctx.lobby.guildId,
      channelId: ctx.channelId,
      options: { character: text },
      recorder: ctx.recorder,
    })
  );
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

  async 'a turn posts exactly one board carrying the judge and guesser controls'() {
    const ctx = await runningGame();
    const boards = ctx.recorder.sent.filter(
      (m) => m.target === `channel:${ctx.channelId}` && m.payload?.components?.length
    );
    assert.equal(boards.length, 1, 'one board message for the turn');

    const buttons = buttonsOf(boards[0].payload);
    // Judging leads, because guesses are called out in voice rather than typed.
    // No typed-guess control: the judge's ruling is the only authority on correctness.
    assert.deepEqual(Object.keys(buttons).sort(), ['pass', 'right', 'wrong']);
    assert.equal(boards[0].payload.components.length, 2, 'one row each');
    assert.match(boards[0].content, /Round 1/);
    assert.match(boards[0].content, /<@p1>/);
    cleanup(ctx);
  },

  // Discord resolves `<@id>` in an embed description but not in its title, where it renders
  // as the literal "<@192319600095002634>". The mention has to stay out of the title.
  async "the current player renders as a mention, not raw markup"() {
    const ctx = await runningGame();
    const payload = buildTurnBoardPayload(ctx.lobby.game, ctx.channelId);
    const embed = payload.embeds[0].data;

    assert.ok(!/<@/.test(embed.title || ''), `mention must not be in the title, got ${embed.title}`);
    assert.match(embed.description, /<@p1>/, 'mention belongs in the description');
    for (const field of embed.fields || []) {
      assert.ok(!/<@/.test(field.name), 'mentions do not render in field names either');
    }
    cleanup(ctx);
  },

  async 'only the player whose turn it is can use the controls'() {
    const ctx = await runningGame();
    await clickButton(ctx, 'p2', 'pass');
    assert.equal(ctx.lobby.game.currentPlayerId, 'p1', 'p2 could not pass p1\'s turn');
    assert.match(ctx.recorder.allText(), /not yours/);
    cleanup(ctx);
  },

  async 'a typed guess that is wrong keeps the turn and is counted'() {
    const ctx = await runningGame();
    await typeGuess(ctx, 'p1', 'Definitely Wrong');

    assert.equal(ctx.lobby.game.currentPlayerId, 'p1', 'turn continues');
    assert.deepEqual(
      ctx.lobby.game.turnGuesses.map((g) => `${g.correct ? 'ok' : 'x'} ${g.text}`),
      ['x Definitely Wrong']
    );
    assert.match(ctx.recorder.textMatching(`channel:${ctx.channelId}`), /1\*\* guess this game/);
    assert.match(ctx.recorder.allText(), /Not quite/);
    cleanup(ctx);
  },

  async 'a typed guess that is right advances the game'() {
    const ctx = await runningGame();
    await typeGuess(ctx, 'p1', 'Mario'); // p1's own head is Mario

    assert.equal(ctx.lobby.game.rebuttal, true, 'first mover winning grants a rebuttal');
    assert.equal(ctx.lobby.game.currentPlayerId, 'p2');
    assert.match(ctx.recorder.allText(), /Correct/);
    cleanup(ctx);
  },

  async 'an empty guess is rejected without consuming anything'() {
    const ctx = await runningGame();
    await typeGuess(ctx, 'p1', '   ');
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
    await typeGuess(ctx, 'p1', 'wrong one');
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
      judgeId: 'p2',
      turnSeconds: 90,
      timer: null,
      paused: true,
      turnGuesses: [],
      guessLog: [],
    };
    const payload = buildTurnBoardPayload(game, 'chan');
    assert.match(payload.embeds[0].toJSON().description, /Time's up/);
    assert.equal(payload.components.length, 2, 'judge and guesser rows both still live');
  },

  async 'turn controls on a finished game fail gracefully'() {
    const ctx = await runningGame();
    ctx.lobby.status = 'FINISHED';
    await clickButton(ctx, 'p1', 'pass');
    assert.match(ctx.recorder.allText(), /no longer running/);
    cleanup(ctx);
  },
};
