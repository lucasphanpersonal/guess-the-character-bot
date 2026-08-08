// The turn timer and the vote auto-close are setTimeout-based, and this bot runs on a
// desktop that sleeps. These cover the wall-clock pass that enforces the deadline anyway,
// by driving it with a `now` in the future instead of actually waiting.

const { assert, createRecorder, createFakeClient, createButtonInteraction } = require('./harness');

const timerWatchdog = require('../src/game/timerWatchdog');
const engine = require('../src/game/engine');
const confirmPhase = require('../src/game/confirmPhase');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

function makeLobby({ turnSeconds = 90, mode = 'classic', voteSeconds = 60 } = {}) {
  const n = ++counter;
  const guildId = `watchdog-guild-${n}`;
  const channelId = `watchdog-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Watchdog List', 'tester', 'Video Games');
  for (const name of ['Mario', 'Luigi', 'Peach', 'Bowser', 'Toad', 'Yoshi']) {
    lists.addCharacter(listId, name, 'tester');
  }

  const recorder = createRecorder();
  const client = createFakeClient(recorder);
  const lobby = new Lobby({
    guildId,
    channelId,
    hostId: 'p1',
    listIds: [listId],
    listNames: ['Watchdog List'],
    turnSeconds,
    mode,
    voteSeconds,
    voteOptions: 3,
  });
  lobby.addPlayer('p1');
  lobby.addPlayer('p2');
  GameManager.createLobby(channelId, lobby);
  return { lobby, client, recorder, channelId };
}

async function startedGame(options) {
  const ctx = makeLobby(options);
  await engine.startGame(ctx.client, ctx.lobby, [{ name: 'Mario' }, { name: 'Luigi' }]);
  for (const userId of ['p1', 'p2']) {
    await confirmPhase.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId, customId: `confirm:${ctx.channelId}`, recorder: ctx.recorder })
    );
  }
  return ctx;
}

function cleanup({ lobby, channelId }) {
  if (lobby.game) engine.clearTimers(lobby.game);
  require('../src/game/audienceVote').clearVoteTimer(lobby.vote);
  GameManager.endLobby(channelId);
}

module.exports = {
  async 'a turn whose time ran out while the machine slept is expired on the next pass'() {
    const ctx = await startedGame({ turnSeconds: 90 });
    const { lobby, client, recorder, channelId } = ctx;
    assert.equal(lobby.game.paused, false, 'the turn starts live');

    // The setTimeout hasn't run -- this is the wall clock catching up on its own.
    const wokeAt = Date.now() + 95 * 1000;
    const expired = await timerWatchdog.checkOverdue(client, wokeAt);

    assert.equal(expired.turns, 1);
    assert.equal(lobby.game.paused, true, 'the turn is in its last-chance state');
    assert.match(recorder.textMatching(`channel:${channelId}`), /Time's up/, 'and the board says so');
    assert.equal(lobby.game.timer.handle, null, 'the pending setTimeout was dropped, so it cannot fire twice');
    cleanup(ctx);
  },

  async 'a turn still inside its time is left alone'() {
    const ctx = await startedGame({ turnSeconds: 90 });
    const expired = await timerWatchdog.checkOverdue(ctx.client, Date.now() + 30 * 1000);

    assert.equal(expired.turns, 0);
    assert.equal(ctx.lobby.game.paused, false);
    cleanup(ctx);
  },

  // clearTimers drops game.timer entirely rather than leaving a cleared-but-stale object
  // behind. Without that, a turn that ends near its own deadline (a correct guess in the
  // last few seconds, say) leaves game.timer answering expiresAt() with the deadline that
  // JUST passed, for however long endTurn's run of awaited Discord calls takes before
  // startTurn hands out a real timer for the NEXT turn. A watchdog pass landing in that
  // window would see "overdue" and pause a turn that never had a timeout to begin with --
  // this is the mechanism, tested directly rather than by racing real setTimeouts.
  async "a turn just cleared by clearTimers reports no deadline, so the watchdog can't act on the stale one"() {
    const ctx = await startedGame({ turnSeconds: 90 });
    const { lobby } = ctx;
    const oldExpiry = lobby.game.timer.expiresAt();

    engine.clearTimers(lobby.game);
    assert.equal(lobby.game.timer, null, 'the old timer is dropped, not just stopped');

    // Even asked about a `now` well past the turn that just ended, there's nothing left to
    // find overdue -- exactly the window between endTurn clearing the old turn and startTurn
    // assigning the next one.
    const expired = await timerWatchdog.checkOverdue(ctx.client, oldExpiry + 5000);
    assert.equal(expired.turns, 0);
    assert.equal(lobby.game.paused, false, 'nothing paused a turn that was never actually overdue');
    cleanup(ctx);
  },

  async 'an already-paused turn is not expired a second time'() {
    const ctx = await startedGame({ turnSeconds: 90 });
    await engine.handleTimeout(ctx.client, ctx.lobby);
    assert.equal(ctx.lobby.game.paused, true);

    const expired = await timerWatchdog.checkOverdue(ctx.client, Date.now() + 600 * 1000);
    assert.equal(expired.turns, 0, 'nothing left to expire');
    cleanup(ctx);
  },

  async 'an audience vote that outlived its deadline is closed on the next pass'() {
    const ctx = makeLobby({ mode: 'audience-vote', voteSeconds: 60 });
    const { lobby, client } = ctx;
    const started = await engine.startAudienceVote(client, lobby);
    assert.equal(started.ok, true);
    assert.equal(lobby.status, 'VOTING');

    const expired = await timerWatchdog.checkOverdue(client, lobby.vote.endsAt + 1000);

    assert.equal(expired.votes, 1);
    assert.equal(lobby.status, 'CONFIRMING', 'the game moved on to dealing characters');
    cleanup(ctx);
  },

  async 'a vote still open is left alone'() {
    const ctx = makeLobby({ mode: 'audience-vote', voteSeconds: 60 });
    await engine.startAudienceVote(ctx.client, ctx.lobby);

    const expired = await timerWatchdog.checkOverdue(ctx.client, Date.now() + 5 * 1000);
    assert.equal(expired.votes, 0);
    assert.equal(ctx.lobby.status, 'VOTING');
    cleanup(ctx);
  },

  async 'a lobby still waiting for players has no deadline to enforce'() {
    const ctx = makeLobby();
    const expired = await timerWatchdog.checkOverdue(ctx.client, Date.now() + 3600 * 1000);
    assert.deepEqual(expired, { turns: 0, votes: 0 });
    cleanup(ctx);
  },
};
