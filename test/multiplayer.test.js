// Games with more than two players.
//
// The game itself has no cap -- how many a table can stand is the players' call. What does
// have ceilings is a handful of Discord surfaces (five action rows per message, ten embeds),
// and those refuse for themselves rather than shrinking the game to fit.

const { assert, createRecorder, createFakeClient, createButtonInteraction, createSlashInteraction, leaveOnClock } = require('./harness');
const { handleComponentInteraction } = require('../src/discord/components/router');
const { buildTurnBoardPayload } = require('../src/discord/game/turnBoard');
const { buildBallotPayload } = require('../src/discord/game/audienceVote');
const engine = require('../src/discord/game/engine');
const confirmPhase = require('../src/discord/game/confirmPhase');
const Lobby = require('../src/core/game/Lobby');
const GameManager = require('../src/core/game/GameManager');
const lists = require('../src/compendium/characterLists');
const db = require('../src/core/db/connection');

let counter = 0;

function makeLobby(playerCount, options = {}) {
  const n = ++counter;
  const guildId = `mp-guild-${n}`;
  const channelId = `mp-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE owner_scope = ?').run(guildId);
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
    assert.match(result.error, /4 more characters? needed/);
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

    // "Unlock" cannot sit on a running game, so it's gone -- but the image button stays,
    // since a wrong image is just as likely to be spotted mid-game as before confirming.
    for (const id of ctx.players) {
      const last = ctx.recorder.lastMatching(`dm:${id}`);
      const ids = last.payload.components[0].toJSON().components.map((c) => c.custom_id);
      assert.deepEqual(ids, [`image:${ctx.channelId}:${game.gameInstanceId}`], `${id}'s unlock button is gone`);
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

  // Nobody is ever removed for going quiet, so a player who stops responding keeps being handed
  // turns and the game parks forever -- /lobby end is the remedy. It used to bin everybody
  // else's finished game along with it; here the host ends it directly and the finished results
  // are kept.
  async 'ending a stuck game keeps the results of whoever already finished'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;
    const stats = require('../src/core/db/stats');

    leaveOnClock(game, 60);
    await judge(ctx, 'p1', true); // p1 done on turn 1
    await engine.submitPass(ctx.client, ctx.lobby, 'p2');
    leaveOnClock(game, 60);
    await judge(ctx, 'p3', true); // p3 done on turn 1, level with p1 to the second
    // ...and now p4 goes quiet. The host ends it.

    const endCmd = require('../src/discord/commands/actions/lobby-end');
    await endCmd.execute(
      createSlashInteraction({
        client: ctx.client, userId: 'p1', guildId: ctx.lobby.guildId,
        channelId: ctx.channelId, recorder: ctx.recorder,
      })
    );

    assert.equal(stats.getPlayerStats(ctx.lobby.guildId, 'p1').total, 1, 'p1 kept their game');
    assert.equal(stats.getPlayerStats(ctx.lobby.guildId, 'p1').wins, 0, 'a shared best is a tie');
    assert.equal(stats.getPlayerStats(ctx.lobby.guildId, 'p1').ties, 1);
    assert.equal(stats.getPlayerStats(ctx.lobby.guildId, 'p4').total, 1, 'and p4 is on the record too');
    assert.match(ctx.recorder.allText(), /had\s+already finished, so that result is kept/);
    cleanup(ctx);
  },

  // A game nobody finished has no result worth keeping, and inventing one would put
  // half-games in the leaderboard.
  async 'ending a game nobody finished records nothing'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const stats = require('../src/core/db/stats');
    const guildId = ctx.lobby.guildId;

    const endCmd = require('../src/discord/commands/actions/lobby-end');
    await endCmd.execute(
      createSlashInteraction({
        client: ctx.client, userId: 'p1', guildId, channelId: ctx.channelId, recorder: ctx.recorder,
      })
    );

    for (const id of ctx.players) assert.equal(stats.getPlayerStats(guildId, id).total, 0, `${id} has no record`);
    assert.match(ctx.recorder.allText(), /Lobby\/game cancelled/);
    cleanup(ctx);
  },

  // A player the host cut off did not choose to stop, and recording it as a surrender would
  // put a decision in their mouth.
  async 'being cut off is recorded as a loss, not as giving up'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    await judge(ctx, 'p1', true);

    const standings = ctx.lobby.game.standings();
    const byId = Object.fromEntries(standings.map((s) => [s.playerId, s]));
    assert.equal(byId.p1.outcome, 'won');
    assert.equal(byId.p4.outcome, 'lost', 'still playing when it ended');
    assert.equal(byId.p4.turnsTaken, null);
    cleanup(ctx);
  },

  // Turn counts on their own cannot tell a hard character from a slow table, and a finished
  // game is not reconstructable afterwards -- so the pairing has to be written down at the
  // one moment it exists.
  async 'a finished game records which character each player was wearing'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    await judge(ctx, 'p1', true);
    await judge(ctx, 'p2', true);
    await judge(ctx, 'p3', true);
    await engine.submitGiveUp(ctx.client, ctx.lobby, 'p4'); // alone -> gives up, ending the game

    const rows = db
      .prepare(
        `SELECT gp.user_id, c.name
           FROM game_players gp
           JOIN games g ON g.id = gp.game_id
           JOIN characters c ON c.id = gp.character_id
          WHERE g.guild_id = ?`
      )
      .all(ctx.lobby.guildId);

    assert.equal(rows.length, 4, 'everyone got a character id, including the player who gave up');
    for (const row of rows) {
      assert.equal(row.name, game.headByPlayer[row.user_id].name, `${row.user_id} wore this one`);
    }
    cleanup(ctx);
  },

  // /lobby set-characters hands out names with no row behind them, so there is no id to
  // record -- and a game must still be recordable without one.
  async 'a hand-assigned character records a null id rather than refusing'() {
    const ctx = await startedGame(3);
    await confirmAll(ctx);
    const game = ctx.lobby.game;
    game.headByPlayer.p2.id = null;

    await judge(ctx, 'p1', true);
    await judge(ctx, 'p2', true);
    await judge(ctx, 'p3', true);

    const rows = db
      .prepare(
        `SELECT gp.user_id, gp.character_id AS characterId
           FROM game_players gp JOIN games g ON g.id = gp.game_id
          WHERE g.guild_id = ?`
      )
      .all(ctx.lobby.guildId);
    const byId = Object.fromEntries(rows.map((r) => [r.user_id, r.characterId]));
    assert.equal(byId.p2, null, 'no row behind it, so nothing to point at');
    assert.equal(byId.p1, game.headByPlayer.p1.id, 'and the others are unaffected');
    cleanup(ctx);
  },

  // Players used to leave a game only by finishing it, so somebody who had to go could not,
  // and the host's only tool ended it for everybody.
  async 'a player can leave a game in progress and the rest carry on'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    // p3 quits while p1 is up -- not their turn, so nothing should advance.
    const before = game.currentPlayerId;
    const result = await engine.submitForfeit(ctx.client, ctx.lobby, 'p3');
    assert.equal(result.ok, true);
    assert.ok(game.surrendered.has('p3'));
    assert.equal(game.currentPlayerId, before, 'the turn did not move');
    assert.equal(ctx.lobby.status, 'IN_PROGRESS');

    // ...and the rotation now skips them.
    await engine.submitPass(ctx.client, ctx.lobby, 'p1');
    assert.equal(game.currentPlayerId, 'p2');
    await engine.submitPass(ctx.client, ctx.lobby, 'p2');
    assert.equal(game.currentPlayerId, 'p4', 'p3 is skipped');
    cleanup(ctx);
  },

  async 'leaving on your own turn hands it straight on'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    await engine.submitForfeit(ctx.client, ctx.lobby, 'p1'); // p1 is the current player
    assert.equal(game.currentPlayerId, 'p2', 'the turn advanced');
    assert.ok(game.surrendered.has('p1'));
    cleanup(ctx);
  },

  async 'a player who left is recorded as having given up, with no turn count'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    await engine.submitForfeit(ctx.client, ctx.lobby, 'p4');
    await judge(ctx, 'p1', true);
    await judge(ctx, 'p2', true);
    await judge(ctx, 'p3', true);

    const byId = Object.fromEntries(ctx.lobby.game.standings().map((s) => [s.playerId, s]));
    assert.equal(byId.p4.outcome, 'gave_up');
    assert.equal(byId.p4.turnsTaken, null);
    assert.equal(byId.p1.outcome, 'won');
    cleanup(ctx);
  },

  // Bug: giving up used to leave the player never knowing who they were. Leaving mid-game now
  // reveals their character right then -- it spoils nobody, since everyone else was DM'd it at
  // the start -- and the end-of-game reveal doesn't then show it a second time.
  async 'leaving mid-game reveals the character you never got to guess, exactly once'() {
    const ctx = await startedGame(3);
    await confirmAll(ctx);
    const game = ctx.lobby.game;
    const p3Head = `**${game.headByPlayer.p3.name}**`;

    await engine.submitForfeit(ctx.client, ctx.lobby, 'p3'); // p1 is up; p3 leaves off-turn

    // Their own "left the game" post -- matched on content, since the turn board edits share
    // the channel target.
    const leaveMsg = ctx.recorder.sent
      .filter((m) => m.target === `channel:${ctx.channelId}` && /has left the game/.test(m.content ?? ''))
      .at(-1);
    assert.ok(leaveMsg, 'a "left the game" message was posted');
    assert.equal(leaveMsg.payload.embeds.length, 1, 'their character rode along with the message');
    assert.ok(leaveMsg.payload.embeds[0].data.description.includes(p3Head), 'and it names them');
    assert.ok(game.revealed.has('p3'), 'marked revealed so the end reveal skips it');

    // Finish the game; the end-of-game reveal must not repeat p3's character.
    await judge(ctx, 'p1', true);
    await judge(ctx, 'p2', true);
    const shownAfterLeave = ctx.recorder.sent
      .filter((m) => m.target === `channel:${ctx.channelId}`)
      .flatMap((m) => m.payload?.embeds ?? [])
      .filter((e) => (e.data.description ?? '').includes(p3Head));
    assert.equal(shownAfterLeave.length, 1, "p3's character is shown exactly once, when they left");
    cleanup(ctx);
  },

  async 'leaving twice is refused rather than recorded twice'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    await engine.submitForfeit(ctx.client, ctx.lobby, 'p3');
    const again = await engine.submitForfeit(ctx.client, ctx.lobby, 'p3');
    assert.equal(again.ok, false);
    assert.match(again.error, /already out/);
    assert.equal(ctx.lobby.game.surrendered.size, 1);
    cleanup(ctx);
  },

  // A bot holds exactly one voice connection per server -- getVoiceConnection() takes a guild
  // and nothing else. Two concurrent games therefore cannot both have sound, and before this
  // the second game moved the bot out of the first one's channel and then destroyed the shared
  // connection when it ended.
  async 'two games in one server do not fight over the voice connection'() {
    const voice = require('../src/discord/game/voice');
    const a = await startedGame(2);
    const b = await startedGame(2);
    // Same guild, which is what makes them contend. (makeLobby gives each its own by default.)
    b.lobby.guildId = a.lobby.guildId;
    b.lobby.game.lobby.guildId = a.lobby.guildId;

    assert.equal(voice.claimVoice(a.lobby.game), true, 'the first game gets voice');
    assert.equal(voice.claimVoice(b.lobby.game), false, 'the second is refused rather than stealing it');
    assert.equal(voice.voiceHolder(a.lobby.guildId), a.lobby.game);

    // The second game ending must not release a claim it never held.
    voice.releaseVoice(b.lobby.game);
    assert.equal(voice.voiceHolder(a.lobby.guildId), a.lobby.game, 'first game still holds it');

    // Once the holder finishes, the claim expires and the next game can have it.
    a.lobby.game.finished = true;
    assert.equal(voice.voiceHolder(a.lobby.guildId), null);
    assert.equal(voice.claimVoice(b.lobby.game), true);
    voice.releaseVoice(b.lobby.game);
    cleanup(a);
    cleanup(b);
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

  // A mid-pack player who can no longer win keeps their seat: passing NEVER removes anyone now,
  // so they can play on for placement (or simply wait the game out) and leave only by their own
  // choice via `/lobby leave`. Their control stays a plain Pass. Out of contention is a note,
  // not a removal -- nobody is "eliminated".
  async 'a player out of contention who is not last just passes and stays in the game'() {
    const ctx = await startedGame(3);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    await judge(ctx, 'p1', true); // p1 finishes on turn 1 -> best = 1
    // Round one: p2 and p3 are each on turn 1, so getting it now would tie -- still in it.
    await engine.submitPass(ctx.client, ctx.lobby, 'p2');
    await engine.submitPass(ctx.client, ctx.lobby, 'p3');

    // Round two: p2 is up on turn 2 and can no longer match a turn-1 finish.
    assert.equal(game.currentPlayerId, 'p2');
    assert.equal(game.turnsFor('p2'), 2);
    assert.equal(game.isOutOfContention('p2'), true);

    const result = await engine.submitPass(ctx.client, ctx.lobby, 'p2');
    assert.equal(result.ok, true);
    assert.ok(!game.surrendered.has('p2'), 'passing did not remove the out-of-contention player');
    assert.equal(game.finished, false, 'still running');
    assert.equal(ctx.lobby.status, 'IN_PROGRESS');
    assert.equal(game.currentPlayerId, 'p3', 'p3 plays on');
    assert.ok(game.isActive('p2'), 'and p2 stays in, to be handed another turn');

    // The board offers a plain Pass, not a Give up -- others are still guessing.
    game.currentTurnIndex = game.turnOrder.indexOf('p2');
    const guesserBtn = buildTurnBoardPayload(game, ctx.channelId).components[1].toJSON().components[0];
    assert.equal(guesserBtn.label, 'Pass');
    assert.match(guesserBtn.custom_id, /^turn:pass:/);
    cleanup(ctx);
  },

  // The way out for a not-last player is /lobby leave, and using it must NOT end the game --
  // the others are still guessing.
  async 'a player out of contention can leave via forfeit, and the others play on'() {
    const ctx = await startedGame(3);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    await judge(ctx, 'p1', true); // p1 finishes on turn 1 -> best = 1
    await engine.submitPass(ctx.client, ctx.lobby, 'p2');
    await engine.submitPass(ctx.client, ctx.lobby, 'p3');
    assert.equal(game.currentPlayerId, 'p2');
    assert.equal(game.isOutOfContention('p2'), true);

    await engine.submitForfeit(ctx.client, ctx.lobby, 'p2'); // p2's turn -> hands it on
    assert.ok(game.surrendered.has('p2'));
    assert.equal(game.finished, false, 'others still guessing, so not over');
    assert.equal(ctx.lobby.status, 'IN_PROGRESS');
    assert.equal(game.currentPlayerId, 'p3', 'p3 plays on');

    // p3 finishing wraps it up, and p2 is on the record as having given up.
    await judge(ctx, 'p3', true);
    const byId = Object.fromEntries(game.standings().map((s) => [s.playerId, s]));
    assert.equal(byId.p2.outcome, 'gave_up');
    assert.equal(byId.p2.turnsTaken, null);
    cleanup(ctx);
  },

  // The Give up button, offered alongside Pass once you're out of contention, bows the player
  // out WITHOUT ending the game, and reveals their character right then rather than at the end.
  async 'the Give up button lets an out-of-contention player bow out mid-game, character shown'() {
    const ctx = await startedGame(3);
    await confirmAll(ctx);
    const game = ctx.lobby.game;
    const p2Head = `**${game.headByPlayer.p2.name}**`;

    await judge(ctx, 'p1', true); // p1 finishes on turn 1 -> best = 1
    await engine.submitPass(ctx.client, ctx.lobby, 'p2');
    await engine.submitPass(ctx.client, ctx.lobby, 'p3');
    assert.equal(game.currentPlayerId, 'p2');
    assert.equal(game.isOutOfContention('p2'), true);

    const result = await engine.submitGiveUp(ctx.client, ctx.lobby, 'p2');
    assert.equal(result.ok, true);
    assert.equal(result.gameOver, false, 'others still guessing, so giving up does not end it');
    assert.ok(game.surrendered.has('p2'));
    assert.equal(game.currentPlayerId, 'p3', 'p3 plays on');

    // Their character was revealed on the way out, exactly once.
    const shown = ctx.recorder.sent
      .filter((m) => m.target === `channel:${ctx.channelId}`)
      .flatMap((m) => m.payload?.embeds ?? [])
      .filter((e) => (e.data.description ?? '').includes(p2Head));
    assert.equal(shown.length, 1, "p2's character shown once, when they gave up");
    assert.ok(game.revealed.has('p2'));

    await judge(ctx, 'p3', true); // finish it off
    const stillOnce = ctx.recorder.sent
      .filter((m) => m.target === `channel:${ctx.channelId}`)
      .flatMap((m) => m.payload?.embeds ?? [])
      .filter((e) => (e.data.description ?? '').includes(p2Head));
    assert.equal(stillOnce.length, 1, 'and not repeated in the end-of-game reveal');
    cleanup(ctx);
  },

  // The give-up reveal is sent BEFORE endTurn's resolvedTurns lock, so a double-press could
  // post it twice without the isActive guard in submitGiveUp. Racing two presses proves the
  // guard holds: one surrender, one reveal, one advance.
  async 'double-tapping Give up surrenders and reveals only once'() {
    const ctx = await startedGame(3);
    await confirmAll(ctx);
    const game = ctx.lobby.game;
    const p2Head = `**${game.headByPlayer.p2.name}**`;

    await judge(ctx, 'p1', true); // p1 done, best = 1
    await engine.submitPass(ctx.client, ctx.lobby, 'p2');
    await engine.submitPass(ctx.client, ctx.lobby, 'p3');
    assert.equal(game.currentPlayerId, 'p2', 'p2 is up, out of contention, others still active');

    const [a, b] = await Promise.all([
      engine.submitGiveUp(ctx.client, ctx.lobby, 'p2'),
      engine.submitGiveUp(ctx.client, ctx.lobby, 'p2'),
    ]);
    assert.ok(a.ok !== b.ok, 'exactly one press took effect; the other was refused');
    assert.equal(game.currentPlayerId, 'p3', 'the rotation advanced only once');

    const shown = ctx.recorder.sent
      .filter((m) => m.target === `channel:${ctx.channelId}`)
      .flatMap((m) => m.payload?.embeds ?? [])
      .filter((e) => (e.data.description ?? '').includes(p2Head));
    assert.equal(shown.length, 1, 'the reveal was posted exactly once');
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

  // Level on turns AND time is a genuine tie, so numbering the sorted list 1..N would award a
  // tiebreak the game does not have.
  async 'players level on turns and time share a place'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    for (const p of ['p1', 'p2', 'p3']) {
      leaveOnClock(game, 30);
      await judge(ctx, p, true); // turn 1, 30s left, all three
    }
    await engine.submitGiveUp(ctx.client, ctx.lobby, 'p4'); // alone -> gives up

    const reveal = ctx.recorder.lastMatching(`channel:${ctx.channelId}`).content;
    assert.match(reveal, /1= <@p1> — 1 turn, 30s left/);
    assert.match(reveal, /1= <@p2> — 1 turn, 30s left/);
    assert.match(reveal, /1= <@p3> — 1 turn, 30s left/);
    assert.match(reveal, /4\. <@p4> — _gave up_/, 'and the next place skips past the tie');
    cleanup(ctx);
  },

  // On equal turns the clock orders them -- and two level on BOTH still share, with the next
  // place skipping. The seconds are printed so a split between equal turn counts explains itself.
  async 'on equal turns, places follow time left'() {
    const ctx = await startedGame(4);
    await confirmAll(ctx);
    const game = ctx.lobby.game;

    const left = { p1: 20, p2: 75, p3: 20 };
    for (const p of ['p1', 'p2', 'p3']) {
      leaveOnClock(game, left[p]);
      await judge(ctx, p, true); // all on turn 1
    }
    await engine.submitGiveUp(ctx.client, ctx.lobby, 'p4');

    const reveal = ctx.recorder.lastMatching(`channel:${ctx.channelId}`).content;
    assert.match(reveal, /<@p2> wins on time/);
    assert.match(reveal, /1\. <@p2> — 1 turn, 75s left/);
    assert.match(reveal, /2= <@p1> — 1 turn, 20s left/);
    assert.match(reveal, /2= <@p3> — 1 turn, 20s left/);
    assert.match(reveal, /4\. <@p4> — _gave up_/);
    cleanup(ctx);
  },

  // A message holds five action rows and the ballot spends one per player, so at six the
  // ballot starts paging rather than the mode refusing. See test/audience-vote.test.js for
  // what paging guarantees; this only proves the roster no longer decides whether it runs.
  async 'audience vote runs at five players and pages at six'() {
    const five = makeLobby(5, { mode: 'audience-vote' });
    const ok = await engine.startAudienceVote(five.client, five.lobby);
    assert.equal(ok.ok, true, ok.error);
    assert.equal(buildBallotPayload(five.lobby.vote, 'voter').components.length, 5, 'exactly at the limit');
    cleanup(five);

    const six = makeLobby(6, { mode: 'audience-vote' });
    const stillFine = await engine.startAudienceVote(six.client, six.lobby);
    assert.equal(stillFine.ok, true, stillFine.error);
    const paged = buildBallotPayload(six.lobby.vote, 'voter');
    assert.equal(paged.components.length, 5, 'four selects and a nav row');
    assert.match(paged.content, /Page 1 of 2/);
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

  // Lobbies cap at eight, but keeping the renderer defensive protects an old or corrupted
  // in-memory roster from producing an invalid board.
  'the standings stay inside the field limit however many are playing'() {
    const Game = require('../src/core/game/Game');
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

  async 'the spectator DM fits at the player cap'() {
    const ctx = await startedGame(8);
    ctx.lobby.spectators.add('watcher');
    await confirmAll(ctx);

    const messages = dmsTo(ctx, 'watcher');
    assert.equal(messages.length, 1, 'eight characters fit in one message');
    for (const m of messages) assert.ok(m.payload.embeds.length <= 10, 'never over the ceiling');
    assert.equal(embedCount(messages), 8, 'and every player is covered');
    cleanup(ctx);
  },
};
