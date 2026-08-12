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
const confirmPhase = require('../src/game/confirmPhase');
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

// Three players with p1 already finished, so p2 -- who is up -- may or may not still be in
// contention depending on the turn counts. `p2Turns` past the leader's count means p2 can no
// longer match it (out of contention for the win), and p3 is still active so p2 is out-of-
// contention-but-not-last.
function threeWayGame({ leaderTurn = 1, p2Turns = 2, p3Turns = 1 } = {}) {
  const game = new Game({
    lobby: { guildId: 'board-guild', players: ['p1', 'p2', 'p3'] },
    characters: [{ name: 'Mario' }, { name: 'Luigi' }, { name: 'Peach' }],
    turnSeconds: 90,
  });
  game.finishedBy.set('p1', leaderTurn);
  game.turnsTaken.set('p2', p2Turns);
  game.turnsTaken.set('p3', p3Turns);
  game.currentTurnIndex = 1; // p2 is up
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
    await confirmPhase.handleConfirmationButton(
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
    // Spectate rides along because this is the only message reliably at the bottom of the
    // channel; its audience is exactly the people the other three refuse.
    assert.deepEqual(Object.keys(buttons).sort(), ['pass', 'right', 'spectate', 'wrong']);
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
    await engine.submitGiveUp(ctx.client, ctx.lobby, 'p2'); // alone, gives up -> game over

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

  // Out of contention for the win (can't match the best finish) but not the last one guessing
  // -- the board owes them the context note, and gives them BOTH controls: a plain Pass to play
  // on for placement (passing never removes anyone), and a Give up to bow out. Being out of
  // contention is a note, not a removal -- nobody is "eliminated".
  'an out-of-contention but not-last player gets both Pass and Give up, and is told they cannot win'() {
    const game = threeWayGame({ leaderTurn: 1, p2Turns: 2, p3Turns: 1 });
    assert.equal(game.isOutOfContention('p2'), true, 'p2 is on turn 2 with the leader done on turn 1');

    const payload = buildTurnBoardPayload(game, 'chan');
    const desc = payload.embeds[0].toJSON().description;
    assert.match(desc, /<@p1> finished on turn 1/, 'names the leader and their count');
    assert.match(desc, /can't win it now/);
    assert.match(desc, /turns still count for where you place/, 'their turns still matter for placement');
    assert.match(desc, /getting your own character/, 'and their own is still worth getting');
    assert.match(desc, /\*\*Give up\*\*/, 'and points to the Give up button as the way out');
    assert.ok(!/lobby leave/.test(desc), 'the note refers to buttons, not typed commands');
    assert.ok(!/last one guessing/.test(desc), 'not the lone-survivor note -- others are still in');

    const buttons = buttonsOf(payload);
    assert.equal(buttons.pass.label, 'Pass', 'a plain Pass -- passing plays on, it does not surrender');
    assert.equal(buttons.pass.style, 2, 'grey (Secondary)');
    assert.equal(buttons.giveup.label, 'Give up', 'and a Give up button beside it');
    assert.equal(buttons.giveup.style, 4, 'red (Danger)');
  },

  // The boundary: the leader finished on the same turn number p2 is on now, so p2 can still
  // TIE by getting it this very turn. They are still in contention, and get no note.
  'a player who can still tie keeps the grey Pass and gets no out-of-contention note'() {
    const game = threeWayGame({ leaderTurn: 2, p2Turns: 2, p3Turns: 1 });
    assert.equal(game.isOutOfContention('p2'), false, 'getting it on this turn would tie the leader');

    const payload = buildTurnBoardPayload(game, 'chan');
    const desc = payload.embeds[0].toJSON().description;
    assert.ok(!/can't win it now/.test(desc), 'no out-of-contention note while still in contention');

    const buttons = buttonsOf(payload);
    assert.equal(buttons.pass.label, 'Pass', 'still a plain Pass');
    assert.equal(buttons.pass.style, 2, 'still grey (Secondary)');
  },

  async 'the Give up button asks first, then ends the game for the last player'() {
    const ctx = await runningGame();
    await engine.submitJudgement(ctx.client, ctx.lobby, 'p2', true); // p1 finishes; p2 now alone
    const game = ctx.lobby.game;

    // The board's guesser control is now a give-up action, not a pass.
    const payload = buildTurnBoardPayload(game, ctx.channelId);
    const buttons = buttonsOf(payload);
    assert.ok(buttons.giveup, 'the lone survivor gets a give-up button');
    assert.equal(buttons.pass, undefined, 'and no pass -- nobody to pass to');

    // Clicking Give up only opens an ephemeral confirmation -- like ✅ and /lobby leave, it does
    // NOT surrender on a single tap.
    await clickButton(ctx, 'p2', 'giveup');
    assert.equal(ctx.lobby.status, 'IN_PROGRESS', 'the button only asks first');
    const confirm = ctx.recorder.lastMatching('reply:p2');
    assert.match(confirm.content, /Give up\?/, 'it asks before doing anything');
    const confirmBtn = confirm.payload.components[0].toJSON().components[0];
    assert.match(confirmBtn.custom_id, /^turn:giveupyes:/, 'and carries the confirm button');

    // Confirming it ends the game.
    await handleComponentInteraction(
      createButtonInteraction({
        client: ctx.client,
        userId: 'p2',
        customId: `turn:giveupyes:${ctx.channelId}:p2:${game.turnsFor('p2')}:${game.gameInstanceId}`,
        recorder: ctx.recorder,
      })
    );
    assert.equal(ctx.lobby.status, 'FINISHED', 'confirming ends the game');
    cleanup(ctx);
  },

  // A confirmation raised on one turn but pressed after the turn has moved on must not surrender
  // whoever is up now -- it answers "too late" and records nothing.
  async 'a stale give-up confirmation is refused rather than surrendering the wrong turn'() {
    const ctx = await runningGame(); // p1 and p2, p1 up on turn 1
    const game = ctx.lobby.game;
    // Build a confirm as if raised for p1 on turn 1, but press it after p1 has passed.
    await clickButton(ctx, 'p1', 'pass'); // now p2 is up; p1's turn is over
    assert.equal(game.currentPlayerId, 'p2');

    await handleComponentInteraction(
      createButtonInteraction({
        client: ctx.client,
        userId: 'p1',
        customId: `turn:giveupyes:${ctx.channelId}:p1:1:${game.gameInstanceId}`,
        recorder: ctx.recorder,
      })
    );
    assert.equal(ctx.lobby.status, 'IN_PROGRESS', 'nothing was ended');
    assert.ok(!game.surrendered.has('p1'), 'and nobody was surrendered');
    assert.match(ctx.recorder.allText(), /Too late/);
    cleanup(ctx);
  },

  async 'turn controls on a finished game fail gracefully'() {
    const ctx = await runningGame();
    ctx.lobby.status = 'FINISHED';
    await clickButton(ctx, 'p1', 'pass');
    assert.match(ctx.recorder.allText(), /no longer running/);
    cleanup(ctx);
  },
};
