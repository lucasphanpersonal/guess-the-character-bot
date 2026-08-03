// Games with more than two players.
//
// The game itself has no cap -- how many a table can stand is the players' call. What does
// have ceilings is a handful of Discord surfaces (five action rows per message, ten embeds),
// and those refuse for themselves rather than shrinking the game to fit.

const { assert, createRecorder, createFakeClient, createButtonInteraction } = require('./harness');
const { handleComponentInteraction } = require('../src/components/router');
const { buildTurnBoardPayload } = require('../src/game/turnBoard');
const { buildBallotPayload } = require('../src/game/audienceVote');
const engine = require('../src/game/engine');
const confirmPhase = require('../src/game/confirmPhase');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

function makeLobby(playerCount, options = {}) {
  const n = ++counter;
  const guildId = `mp-guild-${n}`;
  const channelId = `mp-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM games WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, `MP List ${n}`, 'tester', 'Anime');
  for (let i = 0; i < 60; i++) lists.addCharacter(listId, `Char ${n}-${i}`, 'tester');

  const recorder = createRecorder();
  const client = createFakeClient(recorder);
  const lobby = new Lobby({
    guildId,
    channelId,
    hostId: 'p1',
    listIds: [listId],
    listNames: [`MP List ${n}`],
    turnSeconds: 90,
    maxRerolls: 2,
    voteOptions: 3,
    ...options,
  });
  const players = Array.from({ length: playerCount }, (_, i) => `p${i + 1}`);
  for (const id of players) lobby.addPlayer(id);
  GameManager.createLobby(channelId, lobby);
  return { lobby, client, recorder, channelId, players };
}

async function startedGame(playerCount, options) {
  const ctx = makeLobby(playerCount, options);
  const result = await engine.startGameFromLobby(ctx.client, ctx.lobby);
  assert.equal(result.ok, true, result.error);
  return ctx;
}

async function confirmAll(ctx) {
  for (const id of ctx.players) {
    await confirmPhase.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: id, customId: `confirm:${ctx.channelId}`, recorder: ctx.recorder })
    );
  }
}

const judge = (ctx, guesserId, correct) =>
  engine.submitJudgement(ctx.client, ctx.lobby, ctx.lobby.game.turnOrder.find((id) => id !== guesserId), correct);

function cleanup(ctx) {
  if (ctx.lobby.game) engine.clearTimers(ctx.lobby.game);
  GameManager.endLobby(ctx.channelId);
}

const dmsTo = (ctx, id) => ctx.recorder.sent.filter((m) => m.target === `dm:${id}`);
const embedCount = (messages) => messages.reduce((n, m) => n + (m.payload.embeds?.length ?? 0), 0);

// Every bolded token across a set of messages -- character names and labels alike.
//
// Matched as whole tokens rather than by substring on purpose: the seeded names run
// "Char 1-1" ... "Char 1-59", so "Char 1-1" is a substring of "Char 1-15" and a substring
// check calls a leak whenever a player's own name happens to prefix somebody else's.
function boldTokens(messages) {
  const out = new Set();
  for (const m of messages) {
    for (const embed of m.payload.embeds ?? []) {
      for (const [, token] of (embed.data.description ?? '').matchAll(/\*\*([^*]+)\*\*/g)) out.add(token);
    }
    for (const [, token] of (m.content ?? '').matchAll(/\*\*([^*]+)\*\*/g)) out.add(token);
  }
  return out;
}

module.exports = {
  async 'every player is dealt a different character'() {
    const ctx = await startedGame(5);
    const names = ctx.players.map((id) => ctx.lobby.game.headByPlayer[id].name);
    assert.equal(new Set(names).size, 5, 'one character cannot sit on two heads');
    cleanup(ctx);
  },

  async 'starting is refused when the pool cannot cover everyone'() {
    const ctx = makeLobby(4);
    // Strip the list back to fewer characters than players.
    const [listId] = ctx.lobby.listIds;
    const rows = db.prepare('SELECT id FROM characters WHERE list_id = ?').all(listId);
    for (const row of rows.slice(3)) db.prepare('DELETE FROM characters WHERE id = ?').run(row.id);

    const result = await engine.startGameFromLobby(ctx.client, ctx.lobby);
    assert.equal(result.ok, false);
    assert.match(result.error, /4 players need 4 different characters/);
    cleanup(ctx);
  },

  // Each player checks the next one round the rotation, so every character has exactly one
  // person who may reroll it -- and at two players that is each other, as it always was.
  async 'the check rotation wraps and covers every character exactly once'() {
    const ctx = await startedGame(4);
    const game = ctx.lobby.game;
    const targets = ctx.players.map((id) => game.checkTargetOf(id));
    assert.deepEqual(targets, ['p2', 'p3', 'p4', 'p1']);
    assert.equal(new Set(targets).size, 4, 'every character is checked, none twice');
    for (const id of ctx.players) {
      assert.equal(game.checkerOf(game.checkTargetOf(id)), id, 'checkerOf inverts checkTargetOf');
    }
    cleanup(ctx);
  },

  async 'each player sees everyone else and never their own character'() {
    const ctx = await startedGame(4);
    const game = ctx.lobby.game;

    for (const id of ctx.players) {
      const messages = dmsTo(ctx, id);
      assert.equal(messages.length, 2, 'a check message and a reference message');
      // The one you act on is alone in its message, with the buttons beside it.
      assert.equal(messages[0].payload.embeds.length, 1);
      assert.ok(messages[0].payload.components.length, 'check message carries the controls');
      assert.equal(messages[1].payload.components ?? undefined, undefined, 'reference message has none');
      assert.equal(embedCount(messages), 3, 'the other three characters, once each');

      const shown = boldTokens(messages);
      assert.ok(!shown.has(game.headByPlayer[id].name), `${id} must never see their own character`);
      for (const other of ctx.players.filter((o) => o !== id)) {
        assert.ok(shown.has(game.headByPlayer[other].name), `${id} needs to know ${other}'s`);
      }
    }
    cleanup(ctx);
  },

  // Characters are shared, not per-viewer, so a reroll invalidates what everyone else is
  // holding. At two players that never came up: the roller was the only one looking.
  async 'a reroll fans out to everyone who can see it, and to nobody who cannot'() {
    const ctx = await startedGame(4);
    const game = ctx.lobby.game;
    const before = game.headByPlayer.p3.name;

    // p2 checks p3, so this is p2's to reroll.
    await handleComponentInteraction(
      createButtonInteraction({ client: ctx.client, userId: 'p2', customId: `reroll:${ctx.channelId}`, recorder: ctx.recorder })
    );
    assert.notEqual(game.headByPlayer.p3.name, before, "p3's character was swapped");

    const edited = ctx.recorder.sent.filter((m) => m.target.endsWith(':edit') && m.target.startsWith('dm:'));
    const targets = edited.map((m) => m.target.replace(':edit', ''));
    assert.ok(targets.includes('dm:p1'), 'p1 holds a copy and was re-rendered');
    assert.ok(targets.includes('dm:p4'), 'p4 too');
    assert.ok(!targets.includes('dm:p3'), 'p3 never sees their own character');
    cleanup(ctx);
  },

  async 'a rerolled replacement never collides with a character already in play'() {
    const ctx = await startedGame(4);
    const game = ctx.lobby.game;
    await handleComponentInteraction(
      createButtonInteraction({ client: ctx.client, userId: 'p2', customId: `reroll:${ctx.channelId}`, recorder: ctx.recorder })
    );
    const names = ctx.players.map((id) => game.headByPlayer[id].name);
    assert.equal(new Set(names).size, 4, 'still four distinct heads');
    cleanup(ctx);
  },

  // Locking in is a decision, and until the last person is in it is one you can take back.
  async 'a player can unlock after saying Good to go, and reroll again'() {
    const ctx = await startedGame(4);
    const game = ctx.lobby.game;
    const press = (userId, action) =>
      handleComponentInteraction(
        createButtonInteraction({ client: ctx.client, userId, customId: `${action}:${ctx.channelId}`, recorder: ctx.recorder })
      );

    await press('p1', 'confirm');
    assert.equal(game.confirmState.p1.confirmed, true);
    const locked = ctx.recorder.lastMatching('update:p1');
    assert.match(locked.content, /Locked in/);
    assert.deepEqual(
      locked.payload.components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id.split(':')[0])),
      ['unconfirm'],
      'the way back out is right there'
    );

    await press('p1', 'unconfirm');
    assert.equal(game.confirmState.p1.confirmed, false);
    const reopened = ctx.recorder.lastMatching('update:p1');
    assert.match(reopened.content, /You're checking/, 'and the full prompt is back');

    // ...including the reroll they had not spent.
    const before = game.headByPlayer.p2.name;
    await press('p1', 'reroll');
    assert.notEqual(game.headByPlayer.p2.name, before);
    assert.equal(ctx.lobby.status, 'CONFIRMING', 'still nobody playing');
    cleanup(ctx);
  },

  async 'unlocking is gone once the game is under way'() {
    const ctx = await startedGame(4);
    const game = ctx.lobby.game;
    await confirmAll(ctx);
    assert.equal(ctx.lobby.status, 'IN_PROGRESS');

    // Every check DM is stripped of its button, so "Unlock" cannot sit on a running game.
    for (const id of ctx.players) {
      const last = ctx.recorder.lastMatching(`dm:${id}`);
      assert.deepEqual(last.payload.components, [], `${id}'s unlock button is gone`);
      assert.match(last.content, /game is under way/);
      assert.match(last.content, /character/, 'and it still says whose character it is');
    }

    // A press that raced the start is refused rather than half-applied.
    await handleComponentInteraction(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `unconfirm:${ctx.channelId}`, recorder: ctx.recorder })
    );
    assert.equal(game.confirmState.p1.confirmed, true, 'still locked in');
    assert.match(ctx.recorder.allText(), /expired/);
    cleanup(ctx);
  },

  async 'anyone who is not guessing can judge'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;
    assert.deepEqual(game.judges, ['p2', 'p3', 'p4'], 'everyone but the guesser');

    // The board says so rather than naming one of them.
    const board = buildTurnBoardPayload(game, ctx.channelId).embeds[0].toJSON();
    assert.match(board.description, /everyone else hits/);

    // A judgement from the third player, who is neither guessing nor "the other player".
    const result = await engine.submitJudgement(ctx.client, ctx.lobby, 'p4', true);
    assert.equal(result.ok, true);
    assert.equal(game.finishedBy.get('p1'), 1);
    cleanup(ctx);
  },

  // Several judges can press at the same instant, and the handler yields on its first await
  // before it clears `paused` -- so a second press arriving in that window used to find the
  // turn still endable and resolve it a second time, advancing the rotation twice and
  // silently skipping whoever was next.
  async 'two judges pressing Nope at once end the turn once, not twice'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;
    await engine.handleTimeout(ctx.client, ctx.lobby); // amber: now a Nope ends the turn

    // Deliberately not awaited in sequence -- that is the whole point.
    await Promise.all([
      engine.submitJudgement(ctx.client, ctx.lobby, 'p2', false),
      engine.submitJudgement(ctx.client, ctx.lobby, 'p3', false),
      engine.submitJudgement(ctx.client, ctx.lobby, 'p4', false),
    ]);

    assert.equal(game.currentPlayerId, 'p2', 'exactly one turn passed, so p2 is up');
    assert.equal(game.turnsFor('p2'), 1, 'and p2 got their turn rather than being skipped past');
    assert.equal(game.turnsFor('p3'), 0, 'p3 has not started');
    cleanup(ctx);
  },

  async 'two judges confirming the same correct guess record it once'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    await Promise.all([
      engine.submitJudgement(ctx.client, ctx.lobby, 'p2', true),
      engine.submitJudgement(ctx.client, ctx.lobby, 'p3', true),
    ]);

    assert.equal(game.finishedBy.get('p1'), 1);
    assert.equal(game.currentPlayerId, 'p2', 'the rotation advanced once');
    assert.equal(game.turnsFor('p2'), 1);
    cleanup(ctx);
  },

  async 'double-tapping Pass only passes once'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    await Promise.all([
      engine.submitPass(ctx.client, ctx.lobby, 'p1'),
      engine.submitPass(ctx.client, ctx.lobby, 'p1'),
    ]);

    assert.equal(game.currentPlayerId, 'p2');
    assert.equal(game.turnsFor('p2'), 1, 'p2 was not passed straight over');
    cleanup(ctx);
  },

  async 'players drop out as they finish and the rotation skips them'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    await judge(ctx, 'p1', true); // p1 out
    assert.equal(game.currentPlayerId, 'p2');
    await engine.submitPass(ctx.client, ctx.lobby, 'p2');
    assert.equal(game.currentPlayerId, 'p3');
    await judge(ctx, 'p3', true); // p3 out
    assert.equal(game.currentPlayerId, 'p4', 'skips p1, who is done');
    await engine.submitPass(ctx.client, ctx.lobby, 'p4');
    assert.equal(game.currentPlayerId, 'p2', 'wraps past both finishers');
    cleanup(ctx);
  },

  // Equal turn counts are a tie with no tiebreaker, so numbering the sorted list 1..N would
  // award one the game does not have.
  async 'players on the same turn count share a place'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    await judge(ctx, 'p1', true); // turn 1
    await judge(ctx, 'p2', true); // turn 1
    await judge(ctx, 'p3', true); // turn 1
    await engine.submitPass(ctx.client, ctx.lobby, 'p4'); // alone -> gives up

    const reveal = ctx.recorder.lastMatching(`channel:${ctx.channelId}`).content;
    assert.match(reveal, /1= <@p1> — 1 turn/);
    assert.match(reveal, /1= <@p2> — 1 turn/);
    assert.match(reveal, /1= <@p3> — 1 turn/);
    assert.match(reveal, /4\. <@p4> — _gave up_/, 'and the next place skips past the tie');
    cleanup(ctx);
  },

  // The ballot needs one select menu per player and a message holds five action rows.
  async 'audience vote runs at five players and refuses at six'() {
    const five = makeLobby(5, { mode: 'audience-vote' });
    const ok = await engine.startAudienceVote(five.client, five.lobby);
    assert.equal(ok.ok, true, ok.error);
    assert.equal(buildBallotPayload(five.lobby.vote, 'voter').components.length, 5, 'exactly at the limit');
    cleanup(five);

    const six = makeLobby(6, { mode: 'audience-vote' });
    const refused = await engine.startAudienceVote(six.client, six.lobby);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /tops out at 5 players/);
    assert.match(refused.error, /Turn the vote off/, 'and says what to do about it');
    cleanup(six);
  },

  // The lobby board loses its buttons the moment the game starts and is buried up the channel
  // by turn three, so spectating mid-game used to need knowing a slash command existed.
  async 'a latecomer can start spectating from the turn board'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    await handleComponentInteraction(
      createButtonInteraction({ client: ctx.client, userId: 'latecomer', customId: `turn:spectate:${ctx.channelId}`, recorder: ctx.recorder })
    );

    assert.ok(ctx.lobby.spectators.has('latecomer'));
    const dms = dmsTo(ctx, 'latecomer');
    assert.equal(embedCount(dms), 4, 'every character, not just the first two');
    const shown = boldTokens(dms);
    for (const id of ctx.players) {
      assert.ok(shown.has(game.headByPlayer[id].name), `${id}'s character is there`);
    }
    cleanup(ctx);
  },

  async 'a player pressing Spectate is told they already know'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const before = dmsTo(ctx, 'p2').length;

    await handleComponentInteraction(
      createButtonInteraction({ client: ctx.client, userId: 'p2', customId: `turn:spectate:${ctx.channelId}`, recorder: ctx.recorder })
    );
    assert.ok(!ctx.lobby.spectators.has('p2'));
    assert.equal(dmsTo(ctx, 'p2').length, before, 'and is sent nothing that could spoil their own');
    assert.match(ctx.recorder.allText(), /already know/);
    cleanup(ctx);
  },

  // An embed field caps at 1024 characters, which the standings hit around 28 players. Over
  // that Discord rejects the embed, the board never posts, and "no player limit" turns out to
  // have been false all along.
  'the standings stay inside the field limit however many are playing'() {
    const Game = require('../src/game/Game');
    for (const count of [4, 28, 40, 80]) {
      const players = Array.from({ length: count }, (_, i) => `19231960009500${1000 + i}`);
      const game = new Game({
        lobby: { guildId: 'g', players },
        characters: players.map((_, i) => ({ name: `Char ${i}` })),
        turnSeconds: 90,
      });
      players.forEach((id, i) => game.turnsTaken.set(id, (i % 9) + 1));
      players.slice(0, 3).forEach((id, i) => game.finishedBy.set(id, i + 1));

      const field = buildTurnBoardPayload(game, 'chan').embeds[0].toJSON().fields[0];
      assert.ok(field.value.length <= 1024, `${count} players overflowed at ${field.value.length}`);
      // Whoever is up and whoever has finished are what the standings exist to show, so they
      // survive truncation.
      assert.match(field.value, new RegExp(`<@${game.currentPlayerId}>`), `${count}: current player kept`);
      for (const id of players.slice(0, 3)) {
        assert.match(field.value, new RegExp(`<@${id}>`), `${count}: finisher kept`);
      }
    }
  },

  async 'the spectator DM splits rather than overflowing the embed limit'() {
    const ctx = await startedGame(12);
    ctx.lobby.spectators.add('watcher');
    await confirmAll(ctx);

    const messages = dmsTo(ctx, 'watcher');
    assert.ok(messages.length > 1, 'twelve characters cannot fit in one message');
    for (const m of messages) assert.ok(m.payload.embeds.length <= 10, 'never over the ceiling');
    assert.equal(embedCount(messages), 12, 'and every player is covered');
    cleanup(ctx);
  },
};
