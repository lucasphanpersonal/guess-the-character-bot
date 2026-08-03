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
const Game = require('../src/game/Game');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

// A real Game rather than an object literal shaped like one, so the board's actual
// dependencies are exercised instead of a stub that silently drifts from them.
function fakeGame() {
  const game = new Game({
    lobby: { guildId: 'board-guild', players: ['p1', 'p2'] },
    characters: [{ name: 'Mario' }, { name: 'Luigi' }],
    turnSeconds: 90,
  });
  game.turnsTaken.set('p1', 1);
  return game;
}

async function runningGame() {
  const n = ++counter;
  const guildId = `turn-guild-${n}`;
  const channelId = `turn-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM games WHERE guild_id = ?').run(guildId);

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
    assert.match(boards[0].content, /Turn 1/);
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

  async 'each new turn gets its own board'() {
    const ctx = await runningGame();
    await engine.submitJudgement(ctx.client, ctx.lobby, 'p2', false);
    await clickButton(ctx, 'p1', 'pass');

    const boards = ctx.recorder.sent.filter(
      (m) => m.target === `channel:${ctx.channelId}` && m.payload?.components?.length
    );
    assert.equal(boards.length, 2, 'a second board for the second turn');
    assert.equal(ctx.lobby.game.turnsFor('p2'), 1, "and p2's own count started");
    cleanup(ctx);
  },

  // A board per turn is fine for a short two-player game and becomes a wall at five players.
  // Each one is deleted as its replacement posts, so the channel holds exactly the live one.
  async 'a superseded board is deleted, so only the live one remains'() {
    const ctx = await runningGame();
    assert.equal(ctx.recorder.deleted.length, 0, 'the first board has nothing to replace');

    await clickButton(ctx, 'p1', 'pass');
    assert.equal(ctx.recorder.deleted.length, 1, "p1's board went when p2's posted");
    await clickButton(ctx, 'p2', 'pass');
    assert.equal(ctx.recorder.deleted.length, 2);

    // Deleting is safe because the board is frozen first: a failed delete leaves an inert
    // board rather than a live one.
    const frozen = ctx.recorder.sent.filter((m) => m.target.endsWith(':edit') && !m.payload.components?.length);
    assert.ok(frozen.length >= 2, 'each retired board had its buttons stripped before going');
    cleanup(ctx);
  },

  async 'no turn board outlives the game'() {
    const ctx = await runningGame();
    await engine.submitJudgement(ctx.client, ctx.lobby, 'p2', true); // p1 finishes
    await engine.submitPass(ctx.client, ctx.lobby, 'p2'); // alone, gives up -> game over

    const posted = ctx.recorder.sent.filter(
      (m) => m.target === `channel:${ctx.channelId}` && m.payload?.components?.length
    ).length;
    // Every board posted was deleted; the reveal's buttons are a different message.
    assert.equal(ctx.recorder.deleted.length, posted - 1, 'only the reveal keeps its buttons');
    cleanup(ctx);
  },

  'the board switches to a last-chance state when paused'() {
    const game = fakeGame();
    game.paused = true;
    const payload = buildTurnBoardPayload(game, 'chan');
    assert.match(payload.embeds[0].toJSON().description, /Time's up/);
    assert.equal(payload.components.length, 2, 'judge and guesser rows both still live');
  },

  'the board titles the turn with the current player\'s own count'() {
    const game = fakeGame();
    game.turnsTaken.set('p1', 4);
    assert.equal(buildTurnBoardPayload(game, 'chan').embeds[0].toJSON().title, '🎯 Turn 4');
  },

  // currentPlayerId doesn't move until the next turn starts, so a board frozen in between
  // would otherwise sit in the channel insisting somebody is still guessing.
  'a retired board stops claiming a turn is live'() {
    const game = fakeGame();
    const live = buildTurnBoardPayload(game, 'chan');
    assert.match(live.embeds[0].toJSON().fields[0].value, /🎯 <@p1> — turn 1 \(guessing\)/);
    assert.equal(live.content, '<@p1>', 'a live board pings whoever is up');

    const over = buildTurnBoardPayload(game, 'chan', { correct: false });
    const standings = over.embeds[0].toJSON().fields[0].value;
    assert.ok(!/guessing/.test(standings), 'nobody is guessing on a dead board');
    assert.match(standings, /⏳ <@p1> — turn 1/);
    assert.equal(over.content, '', 'and it stops addressing anyone');
  },

  'a player yet to take a turn is not described as being on "turn 0"'() {
    const standings = buildTurnBoardPayload(fakeGame(), 'chan').embeds[0].toJSON().fields[0].value;
    assert.match(standings, /<@p2> — not started yet/);
  },

  async 'turn controls on a finished game fail gracefully'() {
    const ctx = await runningGame();
    ctx.lobby.status = 'FINISHED';
    await clickButton(ctx, 'p1', 'pass');
    assert.match(ctx.recorder.allText(), /no longer running/);
    cleanup(ctx);
  },
};
