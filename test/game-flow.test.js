const {
  assert,
  createRecorder,
  createFakeClient,
  failNextChannelSend,
  createButtonInteraction,
  createSlashInteraction,
  attachFakeVoice,
  leaveOnClock,
} = require('./harness');

const engine = require('../src/discord/game/engine');
const confirmPhase = require('../src/discord/game/confirmPhase');
const Lobby = require('../src/core/game/Lobby');
const GameManager = require('../src/core/game/GameManager');
const lists = require('../src/compendium/characterLists');
const stats = require('../src/core/db/stats');
const db = require('../src/core/db/connection');

const MARIO = { name: 'Mario', image_url: null };
const LUIGI = { name: 'Luigi', image_url: null };

let counter = 0;

// Builds a lobby with two joined players and runs it up to IN_PROGRESS (both confirmed).
async function startedGame({ turnSeconds = 90, maxRerolls = 2, characters = [MARIO, LUIGI], start = true } = {}) {
  const n = ++counter;
  const guildId = `flow-guild-${n}`;
  const channelId = `flow-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE owner_scope = ?').run(guildId);
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

  if (start) await engine.startGame(client, lobby, characters);
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

// Give up is a distinct action from Pass now, offered only to the last player left. Pass can
// no longer end a game, so tests that used it to mean "the lone survivor bows out" call this.
function giveUp({ client, lobby }, userId) {
  return engine.submitGiveUp(client, lobby, userId);
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

  async 'simultaneous final confirmations start exactly one turn'() {
    const ctx = await startedGame();
    await Promise.all(
      ['p1', 'p2'].map((userId) =>
        confirmPhase.handleConfirmationButton(
          createButtonInteraction({ client: ctx.client, userId, customId: `confirm:${ctx.channelId}`, recorder: ctx.recorder })
        )
      )
    );

    assert.equal(ctx.lobby.status, 'IN_PROGRESS');
    assert.equal(ctx.lobby.game.turnsFor('p1'), 1, 'the opening turn is handed out once');
    assert.equal(
      ctx.recorder.sent.filter(
        ({ target, content }) =>
          target === `channel:${ctx.channelId}` && content.includes('All 2 players are ready -- starting the game!')
      ).length,
      1,
      'the game-start announcement is sent once'
    );
    cleanup(ctx);
  },

  async 'a player whose DMs are closed returns the lobby to WAITING for a retry'() {
    const ctx = await startedGame({ start: false });
    const fetchUser = ctx.client.users.fetch;
    let dmsBlocked = true;
    ctx.client.users.fetch = async (id) => {
      const user = await fetchUser(id);
      if (id !== 'p2' || !dmsBlocked) return user;
      return { ...user, send: async () => { throw new Error('DMs are disabled'); } };
    };

    const failed = await engine.startGameFromLobby(ctx.client, ctx.lobby);

    assert.equal(failed.ok, false);
    assert.match(failed.error, /Couldn't DM Userp2/);
    assert.equal(ctx.lobby.status, 'WAITING');
    assert.equal(ctx.lobby.game, null);
    assert.match(ctx.recorder.textMatching('dm:p1:edit'), /game did not start/i);

    dmsBlocked = false;
    const retried = await engine.startGameFromLobby(ctx.client, ctx.lobby);
    assert.equal(retried.ok, true);
    assert.equal(ctx.lobby.status, 'CONFIRMING');
    cleanup(ctx);
  },

  // Both the button and /lobby start check WAITING, then await the interaction's defer -- so two
  // quick presses both arrive. Only one may deal.
  async 'two Starts at once deal one game'() {
    const ctx = await startedGame({ start: false });
    const [a, b] = await Promise.all([
      engine.startGameFromLobby(ctx.client, ctx.lobby),
      engine.startGameFromLobby(ctx.client, ctx.lobby),
    ]);
    assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
    assert.match((a.ok ? b : a).error, /already starting/);
    const reviewing = ctx.recorder.sent.filter(({ content }) => content?.includes('are reviewing their assigned characters'));
    assert.equal(reviewing.length, 1, 'one deal announced');
    // And one set of character cards: as many DMs as a single Start sends.
    const once = await startedGame({ start: false });
    await engine.startGameFromLobby(once.client, once.lobby);
    assert.equal(ctx.recorder.textFor('dm:p1').length, once.recorder.textFor('dm:p1').length);
    assert.ok(once.recorder.textFor('dm:p1').length > 0);
    cleanup(once);
    cleanup(ctx);
  },

  async 'a player Discord cannot fetch puts the lobby back, not half-started'() {
    const ctx = await startedGame({ start: false });
    const fetchUser = ctx.client.users.fetch;
    let gone = true;
    ctx.client.users.fetch = async (id) => {
      if (id === 'p2' && gone) throw new Error('Unknown User');
      return fetchUser(id);
    };
    const warn = console.warn;
    console.warn = () => {};
    let failed;
    try {
      failed = await engine.startGameFromLobby(ctx.client, ctx.lobby);
    } finally {
      console.warn = warn;
    }
    assert.equal(failed.ok, false);
    assert.match(failed.error, /didn't start/);
    assert.equal(ctx.lobby.status, 'WAITING', 'the lobby buttons work again');
    assert.equal(ctx.lobby.game, null);

    gone = false;
    assert.equal((await engine.startGameFromLobby(ctx.client, ctx.lobby)).ok, true, 'and Start can be pressed again');
    cleanup(ctx);
  },

  async 'a failed multi-player start retires every character card before retrying'() {
    const ctx = await startedGame({ start: false });
    ctx.lobby.addPlayer('p3');
    const fetchUser = ctx.client.users.fetch;
    let dmsBlocked = true;
    ctx.client.users.fetch = async (id) => {
      const user = await fetchUser(id);
      if (id !== 'p3' || !dmsBlocked) return user;
      return { ...user, send: async () => { throw new Error('DMs are disabled'); } };
    };

    const failed = await engine.startGame(ctx.client, ctx.lobby, [MARIO, LUIGI, { name: 'Peach' }]);

    assert.equal(failed.ok, false);
    const retiredCards = ctx.recorder.sent.filter(
      ({ target, payload }) => target === 'dm:p1:edit' && payload.content.includes('game did not start')
    );
    assert.equal(retiredCards.length, 2, 'p1’s check and reference cards are both retired');
    assert.ok(
      retiredCards.every(({ payload }) => Array.isArray(payload.embeds) && payload.embeds.length === 0),
      'retired cards do not retain stale characters'
    );

    dmsBlocked = false;
    const retried = await engine.startGame(ctx.client, ctx.lobby, [MARIO, LUIGI, { name: 'Bowser' }]);
    assert.equal(retried.ok, true);
    assert.match(ctx.recorder.textFor('dm:p1').at(-1), /Bowser/);
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

  // Nobody is ever removed for going quiet. The last player standing has nobody to pass to,
  // so a lapsed last-chance window just hands them another turn (see checkLastChanceTimeout);
  // leaving is only ever the deliberate Give Up button.
  async "the last player standing isn't removed for going quiet -- they just keep guessing"() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    const game = ctx.lobby.game;

    await guess(ctx, 'p1', true); // p1 done on turn 1, p2 is now alone
    assert.equal(game.activePlayers.length, 1);
    assert.equal(game.currentPlayerId, 'p2');

    await engine.handleTimeout(ctx.client, ctx.lobby); // the ordinary timeout: paused, last chance
    assert.equal(game.paused, true);

    // The 30s grace period after that elapses with no action from p2.
    await engine.checkLastChanceTimeout(ctx.client, ctx.lobby, 'p2');

    assert.equal(ctx.lobby.status, 'IN_PROGRESS', 'not surrendered, not ended');
    assert.equal(game.surrendered.has('p2'), false);
    assert.equal(game.currentPlayerId, 'p2', 'nobody else to hand the turn to -- it comes right back');
    assert.equal(game.turnsFor('p2'), 2, 'a fresh turn was handed out, not a forced game-over');
    assert.equal(game.paused, false, 'the new turn starts live, not still paused');
    cleanup(ctx);
  },

  // A whole table going quiet used to be endless: every turn timed out and armed the next, a board
  // a minute to an empty channel, forever. Two full laps of it end the game, as /lobby end would.
  async 'a table quiet for two full rounds ends the game, keeping finished results'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    const game = ctx.lobby.game;
    await guess(ctx, 'p1', true); // p1 finishes; p2 is the only one guessing
    const idle = async () => {
      const who = game.currentPlayerId;
      await engine.handleTimeout(ctx.client, ctx.lobby);
      await engine.checkLastChanceTimeout(ctx.client, ctx.lobby, who);
    };
    await idle();
    assert.equal(ctx.lobby.status, 'IN_PROGRESS', 'one quiet lap is somebody stepping out, not a deserted table');
    await idle();
    assert.equal(ctx.lobby.status, 'CANCELLED', 'two quiet laps end it');
    assert.equal(GameManager.getLobby(ctx.channelId), undefined, 'and nothing is left ticking');
    assert.equal(game.turnsFor('p2'), 2, 'no turn was handed out for a game that is over');
    assert.match(channelText(ctx), /Nobody has played for two full rounds/);
    assert.match(channelText(ctx), /<@p1> — 1 turn/, "and p1's finished result is kept");
    cleanup(ctx);
  },

  async 'anything anyone does resets the quiet count -- a pass, or a ruling that keeps the turn going'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    const game = ctx.lobby.game;
    const idle = async () => {
      const who = game.currentPlayerId;
      await engine.handleTimeout(ctx.client, ctx.lobby);
      await engine.checkLastChanceTimeout(ctx.client, ctx.lobby, who);
    };
    // Two players: four quiet turns in a row would be two laps. Three, then somebody acts.
    for (let i = 0; i < 3; i++) await idle();
    await guess(ctx, game.currentPlayerId, false); // ruled wrong: the turn goes on, but somebody acted
    for (let i = 0; i < 3; i++) await idle();
    await pass(ctx, game.currentPlayerId);
    for (let i = 0; i < 3; i++) await idle();
    assert.equal(ctx.lobby.status, 'IN_PROGRESS', 'never two full laps without somebody acting');
    cleanup(ctx);
  },

  // A non-last player who goes quiet is NOT removed either: the turn simply passes to the next
  // player, and the quiet player keeps their place in the rotation to be up again later.
  async 'a non-last player who goes quiet is not removed -- the turn just passes on'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    const game = ctx.lobby.game;
    assert.equal(game.activePlayers.length, 2);
    assert.equal(game.currentPlayerId, 'p1');

    await engine.handleTimeout(ctx.client, ctx.lobby);
    await engine.checkLastChanceTimeout(ctx.client, ctx.lobby, 'p1');

    assert.equal(game.surrendered.has('p1'), false, 'never forced out for going quiet');
    assert.equal(game.isActive('p1'), true, 'still in the game');
    assert.equal(game.currentPlayerId, 'p2', 'the turn passed to the other player');
    assert.equal(ctx.lobby.status, 'IN_PROGRESS');
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
    // they have just worked it out themselves. With the time left, which is from now on the
    // time p2 has to beat on the same turn count.
    assert.match(channelText(ctx), /got it in \*\*1\*\* turn, with \*\*\d+s\*\* left!/);
    cleanup(ctx);
  },

  // A transient channel.send failure on the completion announcement must not wedge the game:
  // the turn is already recorded resolved, so if the throw escaped endTurn the rotation would
  // never advance and no new board would post -- leaving the game frozen with only /lobby end
  // as an exit. The announcement is cosmetic, so its failure is swallowed and play continues.
  async 'a failed completion announcement still hands the turn to the next player'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    const game = ctx.lobby.game;

    // Fail only the completion announcement ("... got it in N turn(s)!"), not the board edits.
    failNextChannelSend(ctx.client, (text) => /got it in \*\*\d+\*\* turn/.test(text));

    await guess(ctx, 'p1', true); // ruled correct by p2; announcement send throws

    // The turn still resolved and rotation still advanced despite the failed side-effect.
    assert.equal(game.finishedBy.get('p1'), 1, 'p1 still recorded as finished on turn 1');
    assert.equal(ctx.lobby.status, 'IN_PROGRESS', 'game is not wedged');
    assert.equal(game.currentPlayerId, 'p2', 'the turn advanced to p2');
    assert.equal(game.turnsFor('p2'), 1, 'p2 actually got a fresh turn board');
    cleanup(ctx);
  },

  // The result is the one thing a finished game must not lose, and it used to be written LAST,
  // after the reveal -- so a reveal that failed to send meant the game was never recorded.
  async 'a reveal that fails to send still records the game'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await guess(ctx, 'p1', true); // p1 finishes; p2 is alone
    failNextChannelSend(ctx.client, (text) => /wins/.test(text));
    await giveUp(ctx, 'p2').catch(() => {}); // the reveal's send throws
    const recorded = db.prepare('SELECT COUNT(*) AS n FROM games WHERE guild_id = ?').get(ctx.guildId).n;
    assert.equal(recorded, 1, 'the game is in the record');
    cleanup(ctx);
  },

  // A board that could not be frozen or deleted keeps live buttons. They name their turn, so a
  // press on one cannot rule on -- or pass -- whoever is up now.
  async "a button from an ended turn's board does nothing to the current turn"() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    const game = ctx.lobby.game;
    const oldBoard = ctx.recorder.lastMatching(`channel:${ctx.channelId}`).payload;
    const oldIds = oldBoard.components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
    const oldPass = oldIds.find((id) => id.startsWith('turn:pass:'));
    await engine.submitPass(ctx.client, ctx.lobby, 'p1'); // p2's turn now
    await engine.submitPass(ctx.client, ctx.lobby, 'p2'); // p1's turn 2
    const { handleComponentInteraction } = require('../src/discord/components/router');
    await handleComponentInteraction(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: oldPass, recorder: ctx.recorder })
    );
    assert.equal(game.currentPlayerId, 'p1', "turn 1's Pass did not pass turn 2");
    assert.equal(game.turnsFor('p1'), 2);
    assert.match(ctx.recorder.allText(), /already ended/);
    cleanup(ctx);
  },

  async 'a leave confirmation from an earlier game cannot forfeit you from this one'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    const turnControls = require('../src/discord/components/turnControls');
    const stale = createButtonInteraction({ client: ctx.client, userId: 'p2', customId: `forfeit:${ctx.channelId}:oldgame`, recorder: ctx.recorder });
    await turnControls.handleForfeit(stale);
    assert.ok(ctx.lobby.game.isActive('p2'), 'still playing');
    assert.match(ctx.recorder.allText(), /earlier game/);
    cleanup(ctx);
  },

  async '/lobby end during the confirm phase retires the confirm DMs'() {
    const ctx = await startedGame(); // CONFIRMING: nobody has pressed Good to go
    const lobbyEnd = require('../src/discord/commands/actions/lobby-end');
    await lobbyEnd.execute(
      createSlashInteraction({ client: ctx.client, userId: 'p1', guildId: ctx.guildId, channelId: ctx.channelId, recorder: ctx.recorder })
    );
    const edits = ctx.recorder.sent.filter((m) => m.target.startsWith('dm:') && m.target.endsWith(':edit'));
    assert.ok(edits.length >= 2 && edits.every((m) => (m.payload.components ?? []).length === 0), 'every check DM lost its buttons');
    assert.match(edits.map((m) => m.content).join(' '), /ended this game before it began/);
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

  // Level on turns AND to the second: still a genuine tie.
  async 'the same turn count and the same time left is a tie'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    leaveOnClock(ctx.lobby.game, 50);
    await guess(ctx, 'p1', true);
    leaveOnClock(ctx.lobby.game, 50);
    await guess(ctx, 'p2', true); // both on turn 1, both with 50s left

    assert.equal(ctx.lobby.status, 'FINISHED');
    assert.match(lastChannelMessage(ctx), /It's a tie — .* both got it in \*\*1\*\* turn with \*\*50s\*\* left!/);
    assert.equal(stats.getPlayerStats(ctx.guildId, 'p1').ties, 1);
    assert.equal(stats.getPlayerStats(ctx.guildId, 'p2').ties, 1);
    cleanup(ctx);
  },

  // Equal turns are decided by the clock, and the result has to say so -- otherwise a player
  // who also got it in one is just told they lost.
  async 'on the same turn count, more time left wins -- and says it was on time'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    leaveOnClock(ctx.lobby.game, 70);
    await guess(ctx, 'p1', true);
    leaveOnClock(ctx.lobby.game, 40);
    await guess(ctx, 'p2', true);

    const final = lastChannelMessage(ctx);
    assert.match(final, /<@p1> wins on time — got it in \*\*1\*\* turn with \*\*70s\*\* left!/);
    assert.match(final, /<@p2> also got it in \*\*1\*\* turn, but with \*\*40s\*\* left\./);
    assert.equal(stats.getPlayerStats(ctx.guildId, 'p1').wins, 1);
    assert.equal(stats.getPlayerStats(ctx.guildId, 'p2').losses, 1);
    cleanup(ctx);
  },

  // Order of play is irrelevant: going second and being quicker wins.
  async 'the later player wins on equal turns if they were quicker'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    leaveOnClock(ctx.lobby.game, 10);
    await guess(ctx, 'p1', true);
    leaveOnClock(ctx.lobby.game, 85);
    await guess(ctx, 'p2', true);

    assert.match(lastChannelMessage(ctx), /<@p2> wins on time/);
    cleanup(ctx);
  },

  // After the clock runs out the player gets a last-chance window; getting it there counts as
  // no time left, so anyone who got it in time on the same turn count beats them.
  async 'a guess in the last-chance window counts as no time left'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    leaveOnClock(ctx.lobby.game, 5);
    await guess(ctx, 'p1', true);
    leaveOnClock(ctx.lobby.game, -20); // 20s past the deadline
    await guess(ctx, 'p2', true);

    assert.equal(ctx.lobby.game.secondsLeftBy.get('p2'), 0);
    assert.match(lastChannelMessage(ctx), /<@p1> wins on time/);
    cleanup(ctx);
  },

  // Fewer turns always beats more time: the clock only ever breaks a tie on turns.
  async 'fewer turns beats more time left'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    leaveOnClock(ctx.lobby.game, 1);
    await guess(ctx, 'p1', true); // turn 1, a second to spare
    await pass(ctx, 'p2');
    leaveOnClock(ctx.lobby.game, 89);
    await guess(ctx, 'p2', true); // turn 2, nearly the whole clock

    const final = lastChannelMessage(ctx);
    assert.match(final, /<@p1> wins — got it in \*\*1\*\* turn!/, 'a plain win: turns decided it');
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
    await giveUp(ctx, 'p2'); // gives up -- Luigi was never revealed

    const reveal = ctx.recorder.lastMatching(`channel:${ctx.channelId}`);
    assert.equal(reveal.payload.embeds.length, 1, 'only the one still unanswered');
    assert.match(reveal.payload.embeds[0].data.description, /Luigi/);
    cleanup(ctx);
  },

  async 'the last player still guessing gets a Give up button that ends the game'() {
    const ctx = await startedGame();
    await confirmBoth(ctx);
    await guess(ctx, 'p1', true);
    const game = ctx.lobby.game;

    // p2 is now the only one left, so their control becomes the game-ending Give up button --
    // there is nobody left to pass to.
    const { buildTurnBoardPayload } = require('../src/discord/game/turnBoard');
    const guesserBtn = buildTurnBoardPayload(game, ctx.channelId)
      .components[1].toJSON().components[0];
    assert.equal(guesserBtn.label, 'Give up');
    assert.match(guesserBtn.custom_id, /^turn:giveup:/, 'a give-up action, not a pass');
    assert.match(channelText(ctx), /You're the last one guessing/);

    await giveUp(ctx, 'p2');
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
    await giveUp(ctx, 'p2'); // ends the game -> win sting
    assert.equal(played.length, 3, 'win sound');
    cleanup(ctx);
  },

  async 'rerolling swaps the other player\'s character and never repeats a rejection'() {
    const ctx = await startedGame({ maxRerolls: 2 });
    const game = ctx.lobby.game;
    const originallyShownToP1 = game.headByPlayer.p2.name; // p1 was DM'd p2's head

    ctx.recorder.clear();
    await confirmPhase.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `reroll:${ctx.channelId}`, recorder: ctx.recorder })
    );
    assert.deepEqual(
      ctx.recorder.sent.slice(0, 2).map((message) => message.target),
      ['defer:p1', 'editreply:p1'],
      'the button is acknowledged before its replacement card is rendered'
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
    await giveUp(ctx, 'p1'); // p1 alone, gives up -- that's what ends it
    assert.equal(ctx.lobby.status, 'FINISHED');
    assert.equal(GameManager.getLobby(ctx.channelId), ctx.lobby, 'kept for /rematch');

    const rematch = require('../src/discord/commands/rematch');
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
