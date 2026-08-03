// Judged guesses: the primary way a turn resolves.
//
// Guesses get called out in voice, so the bot never sees most of them. Judging moves the
// input to the player who ISN'T busy -- the one who can see the answer and is only
// listening -- which is both accurate and how the physical game already works.

const { assert, createRecorder, createFakeClient, createButtonInteraction } = require('./harness');
const { buildTurnBoardPayload } = require('../src/game/turnBoard');
const { handleComponentInteraction } = require('../src/components/router');
const engine = require('../src/game/engine');
const confirmPhase = require('../src/game/confirmPhase');
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
  db.prepare('DELETE FROM games WHERE guild_id = ?').run(guildId);

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
    await confirmPhase.handleConfirmationButton(
      createButtonInteraction({ client, userId, customId: `confirm:${channelId}`, recorder })
    );
  }
  return { lobby, client, recorder, channelId };
}

const pressId = (ctx, userId, customId) =>
  handleComponentInteraction(
    createButtonInteraction({ client: ctx.client, userId, customId, recorder: ctx.recorder })
  );

const press = (ctx, userId, action) => pressId(ctx, userId, `turn:${action}:${ctx.channelId}`);

// ✅ is a two-step control: the board button raises an ephemeral confirmation, and the
// confirmation is what actually records it. ❌ stays a single press.
async function rule(ctx, userId, correct) {
  if (!correct) return press(ctx, userId, 'wrong');
  const game = ctx.lobby.game;
  const who = game.currentPlayerId;
  const turn = game.turnsFor(who);
  await press(ctx, userId, 'right');
  return pressId(ctx, userId, `turn:yes:${ctx.channelId}:${who}:${turn}`);
}

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

  // Wrong guesses are deliberately not counted anywhere. The only count that survived is
  // turns, because the bot hands those out itself rather than depending on a judge
  // remembering to press -- which undercounted, worst for whoever pressed most honestly.
  async 'a wrong ruling costs nothing and keeps the turn alive'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;

    await press(ctx, 'p2', 'wrong');
    assert.equal(game.currentPlayerId, 'p1', 'a wrong guess never ends a turn');
    assert.equal(game.turnsFor('p1'), 1, 'and never costs a turn');

    await press(ctx, 'p2', 'wrong');
    assert.equal(game.currentPlayerId, 'p1');
    assert.equal(game.turnsFor('p1'), 1);
    cleanup(ctx);
  },

  async 'the Nope button carries no tally to keep'() {
    const ctx = await runningGame();
    assert.equal(labelOf(buildTurnBoardPayload(ctx.lobby.game, ctx.channelId), 'wrong'), 'Nope');

    await press(ctx, 'p2', 'wrong');
    await press(ctx, 'p2', 'wrong');
    assert.equal(labelOf(buildTurnBoardPayload(ctx.lobby.game, ctx.channelId), 'wrong'), 'Nope');
    cleanup(ctx);
  },

  // The board shows turns rather than guesses: it is the score, and it is the only thing
  // here the bot observes directly.
  async 'the board shows who has finished and on what turn'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;

    const before = buildTurnBoardPayload(game, ctx.channelId).embeds[0].toJSON();
    const standings = before.fields.find((f) => f.name === 'Standings');
    assert.match(standings.value, /🎯 <@p1> — turn 1 \(guessing\)/);
    assert.match(standings.value, /⏳ <@p2> — not started yet/);

    await rule(ctx, 'p2', true);
    const after = buildTurnBoardPayload(game, ctx.channelId).embeds[0].toJSON();
    assert.match(after.fields.find((f) => f.name === 'Standings').value, /✅ <@p1> — turn 1/);
    cleanup(ctx);
  },

  // ✅ ends a turn AND publishes that player's character, which no undo can retract -- they
  // would have seen their own answer. ❌ costs nothing, so only one of the two asks first.
  async 'the check mark asks before it lands, and Nope does not'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;

    await press(ctx, 'p2', 'right');
    assert.equal(game.finishedBy.size, 0, 'nothing recorded on the first press');
    const prompt = ctx.recorder.lastMatching('reply:p2');
    assert.match(prompt.content, /no taking it back/);
    assert.ok(prompt.payload.flags, 'asked privately, so the channel sees no hesitation');

    await pressId(ctx, 'p2', `turn:yes:${ctx.channelId}:p1:1`);
    assert.equal(game.finishedBy.get('p1'), 1, 'the confirmation is what records it');
    cleanup(ctx);
  },

  // The confirmation names the turn it was raised on. Left sitting while that turn timed out
  // and moved on, it must not land on whoever is up now.
  async 'a stale confirmation cannot land on a later turn'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;

    await press(ctx, 'p2', 'right'); // raised against p1, turn 1
    await press(ctx, 'p1', 'pass'); // ...but p1 passes instead, so it is p2's turn now

    await pressId(ctx, 'p2', `turn:yes:${ctx.channelId}:p1:1`);
    assert.equal(game.finishedBy.size, 0, 'nobody was marked finished');
    assert.match(ctx.recorder.allText(), /Too late/);
    cleanup(ctx);
  },

  async 'a correct ruling finishes that player without the bot matching any text'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;

    await rule(ctx, 'p2', true);
    assert.equal(game.finishedBy.get('p1'), 1);
    assert.equal(game.currentPlayerId, 'p2', 'p2 plays on -- nobody is cut off');
    cleanup(ctx);
  },

  async 'the guesser cannot judge their own guess'() {
    const ctx = await runningGame();
    await press(ctx, 'p1', 'right');

    assert.equal(ctx.lobby.game.finishedBy.size, 0, 'nothing recorded');
    assert.equal(ctx.lobby.game.currentPlayerId, 'p1', 'and the turn did not resolve');
    assert.match(ctx.recorder.allText(), /You're guessing this turn/);
    cleanup(ctx);
  },

  async 'a spectator cannot judge either'() {
    const ctx = await runningGame();
    await press(ctx, 'nosy-spectator', 'wrong');
    assert.equal(ctx.lobby.game.finishedBy.size, 0);
    assert.match(ctx.recorder.allText(), /Only the players in this game can judge/);
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

  // Turns are counted per player, not as a shared round number -- which is what keeps the
  // score meaningful once players start dropping out of the rotation.
  async 'each player accrues their own turns'() {
    const ctx = await runningGame();
    const game = ctx.lobby.game;

    await press(ctx, 'p1', 'pass');
    assert.equal(game.currentPlayerId, 'p2', "now p2's turn");
    assert.deepEqual([game.turnsFor('p1'), game.turnsFor('p2')], [1, 1]);

    await press(ctx, 'p2', 'pass');
    assert.equal(game.currentPlayerId, 'p1');
    assert.deepEqual([game.turnsFor('p1'), game.turnsFor('p2')], [2, 1], 'p1 is on their second');
    cleanup(ctx);
  },

  async 'the reveal reports how many turns it took'() {
    const ctx = await runningGame();

    await press(ctx, 'p2', 'wrong');
    await press(ctx, 'p2', 'wrong');
    await press(ctx, 'p1', 'pass'); // p1 into turn 2 without getting it
    await press(ctx, 'p2', 'pass');
    await rule(ctx, 'p2', true); // p1 gets it on turn 2
    await engine.submitPass(ctx.client, ctx.lobby, 'p2'); // alone, gives up

    const revealed = ctx.recorder.textMatching(`channel:${ctx.channelId}`);
    assert.match(revealed, /got it in \*\*2\*\* turns/, 'wrong guesses cost nothing, the clock does');
    assert.match(revealed, /<@p1> wins/);
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
