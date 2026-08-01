const { assert, createRecorder, createFakeClient, createButtonInteraction } = require('./harness');

const engine = require('../src/game/engine');
const { AudienceVote, drawCandidates, buildVoteBoardPayload, buildBallotPayload } = require('../src/game/audienceVote');
const { handleComponentInteraction } = require('../src/components/router');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

const CHARACTERS = [
  'Mario', 'Luigi', 'Peach', 'Bowser', 'Yoshi',
  'Toad', 'Daisy', 'Wario', 'Waluigi', 'Rosalina',
  'Kirby', 'Link', 'Zelda', 'Samus', 'Fox',
];

let counter = 0;

function makeLobby({ voteOptions = 5, voteSeconds = 60, mode = 'audience-vote' } = {}) {
  const n = ++counter;
  const guildId = `vote-guild-${n}`;
  const channelId = `vote-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM game_results WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Vote List', 'tester', 'Video Games');
  for (const name of CHARACTERS) lists.addCharacter(listId, name, 'tester');

  const recorder = createRecorder();
  const client = createFakeClient(recorder);
  const lobby = new Lobby({
    guildId,
    channelId,
    hostId: 'host',
    listIds: [listId],
    listNames: ['Vote List'],
    turnSeconds: 90,
    maxRerolls: 2,
    mode,
    voteOptions,
    voteSeconds,
  });
  lobby.addPlayer('p1');
  lobby.addPlayer('p2');
  GameManager.createLobby(channelId, lobby);
  return { lobby, client, recorder, channelId, guildId };
}

const click = (ctx, userId, action, extra = {}) =>
  handleComponentInteraction({
    ...createButtonInteraction({
      client: ctx.client,
      userId,
      customId: `vote:${action}:${ctx.channelId}`,
      recorder: ctx.recorder,
    }),
    ...extra,
  });

// A string-select interaction carries its choice in `values`.
const pick = (ctx, userId, slot, characterName) =>
  handleComponentInteraction({
    ...createButtonInteraction({
      client: ctx.client,
      userId,
      customId: `vote:pick:${ctx.channelId}:${slot}`,
      recorder: ctx.recorder,
    }),
    values: [characterName],
  });

function cleanup(ctx) {
  if (ctx.lobby.vote?.timer) clearTimeout(ctx.lobby.vote.timer);
  if (ctx.lobby.game) engine.clearTimers(ctx.lobby.game);
  GameManager.endLobby(ctx.channelId);
}

// Flatten every string in a payload so we can prove a name appears nowhere in it.
function payloadStrings(payload) {
  return JSON.stringify(payload, (key, value) =>
    value && typeof value.toJSON === 'function' ? value.toJSON() : value
  );
}

module.exports = {
  'candidate sets are disjoint and correctly sized'() {
    const { lobby } = makeLobby({ voteOptions: 5 });
    const candidates = drawCandidates(lobby);
    assert.equal(candidates['1'].length, 5);
    assert.equal(candidates['2'].length, 5);
    const names1 = new Set(candidates['1'].map((c) => c.name));
    for (const c of candidates['2']) {
      assert.ok(!names1.has(c.name), `${c.name} must not appear in both slots`);
    }
    GameManager.endLobby(lobby.channelId);
  },

  'drawing fails cleanly when the pool is too small for two disjoint sets'() {
    const { lobby } = makeLobby({ voteOptions: 20 }); // needs 40, list has 15
    assert.equal(drawCandidates(lobby), null);
    GameManager.endLobby(lobby.channelId);
  },

  async 'THE SPOILER GUARD: the public vote board never names a candidate'() {
    const ctx = await (async () => {
      const c = makeLobby();
      await engine.startAudienceVote(c.client, c.lobby);
      return c;
    })();

    const vote = ctx.lobby.vote;
    const allCandidateNames = [...vote.candidatesBySlot['1'], ...vote.candidatesBySlot['2']].map((c) => c.name);

    // Check the rendered payload AND everything actually sent to the channel.
    const boardText = payloadStrings(buildVoteBoardPayload(vote));
    const channelText = ctx.recorder.textMatching(`channel:${ctx.channelId}`);
    for (const name of allCandidateNames) {
      assert.ok(!boardText.includes(name), `board leaked candidate "${name}"`);
      assert.ok(!channelText.includes(name), `channel leaked candidate "${name}"`);
    }
    cleanup(ctx);
  },

  async 'players are refused the ballot so they never see their own options'() {
    const ctx = makeLobby();
    await engine.startAudienceVote(ctx.client, ctx.lobby);

    for (const playerId of ['p1', 'p2']) {
      await click(ctx, playerId, 'open');
      const reply = ctx.recorder.lastMatching(`reply:${playerId}`);
      assert.match(reply.content, /can't vote/);
      // Nothing resembling a ballot (select menus) may reach a player.
      assert.ok(!reply.payload.components, 'no ballot components sent to a player');
    }
    cleanup(ctx);
  },

  async 'a non-player gets an ephemeral ballot with both slots'() {
    const ctx = makeLobby({ voteOptions: 3 });
    await engine.startAudienceVote(ctx.client, ctx.lobby);

    await click(ctx, 'watcher', 'open');
    const reply = ctx.recorder.lastMatching('reply:watcher');
    assert.equal(reply.payload.components.length, 2, 'one select per player');
    const options = reply.payload.components[0].toJSON().components[0].options;
    assert.equal(options.length, 3, 'voteOptions candidates offered');
    cleanup(ctx);
  },

  async 'votes are recorded and the public tally updates without leaking names'() {
    const ctx = makeLobby();
    await engine.startAudienceVote(ctx.client, ctx.lobby);
    const vote = ctx.lobby.vote;
    const choice = vote.candidatesBySlot['1'][0].name;

    await pick(ctx, 'watcher', '1', choice);
    assert.equal(vote.voterCount, 1);
    assert.equal(vote.ballots.get('watcher')['1'], choice);

    // The board refresh must still not name anything.
    const edits = ctx.recorder.textMatching(`channel:${ctx.channelId}:edit`);
    assert.ok(!edits.includes(choice), 'tally refresh leaked the chosen name');
    assert.match(payloadStrings(buildVoteBoardPayload(vote)), /Votes cast/);
    cleanup(ctx);
  },

  async 'a voter can change their pick, and it still counts as one ballot'() {
    const ctx = makeLobby();
    await engine.startAudienceVote(ctx.client, ctx.lobby);
    const vote = ctx.lobby.vote;
    const [first, second] = vote.candidatesBySlot['1'];

    await pick(ctx, 'watcher', '1', first.name);
    await pick(ctx, 'watcher', '1', second.name);
    assert.equal(vote.voterCount, 1, 'still one voter');
    assert.equal(vote.ballots.get('watcher')['1'], second.name, 'latest pick wins');
    cleanup(ctx);
  },

  async 'an option that is not on the ballot is rejected'() {
    const ctx = makeLobby();
    await engine.startAudienceVote(ctx.client, ctx.lobby);
    await pick(ctx, 'watcher', '1', 'Definitely Not A Candidate');
    assert.equal(ctx.lobby.vote.voterCount, 0);
    assert.match(ctx.recorder.allText(), /not on the ballot/);
    cleanup(ctx);
  },

  'the plurality winner is chosen, and ties resolve to one of the tied names'() {
    const { lobby } = makeLobby();
    const candidates = drawCandidates(lobby);
    const vote = new AudienceVote({ lobby, candidatesBySlot: candidates });
    const [a, b] = candidates['1'];

    vote.recordVote('v1', '1', a.name);
    vote.recordVote('v2', '1', a.name);
    vote.recordVote('v3', '1', b.name);
    assert.equal(vote.resolveSlot('1').character.name, a.name, 'clear plurality');

    const tie = new AudienceVote({ lobby, candidatesBySlot: candidates });
    tie.recordVote('v1', '1', a.name);
    tie.recordVote('v2', '1', b.name);
    assert.ok([a.name, b.name].includes(tie.resolveSlot('1').character.name), 'tie picks one of them');
    GameManager.endLobby(lobby.channelId);
  },

  'with zero votes a character is still chosen from the right candidate set'() {
    const { lobby } = makeLobby();
    const candidates = drawCandidates(lobby);
    const vote = new AudienceVote({ lobby, candidatesBySlot: candidates });
    for (const slot of ['1', '2']) {
      const { character, votes } = vote.resolveSlot(slot);
      assert.equal(votes, 0);
      assert.ok(
        candidates[slot].some((c) => c.name === character.name),
        'fallback stays within that slot\'s candidates'
      );
    }
    GameManager.endLobby(lobby.channelId);
  },

  async 'only the host can close voting'() {
    const ctx = makeLobby();
    await engine.startAudienceVote(ctx.client, ctx.lobby);
    await click(ctx, 'watcher', 'close');
    assert.equal(ctx.lobby.status, 'VOTING', 'a non-host cannot close it');
    assert.match(ctx.recorder.allText(), /Only the host/);
    cleanup(ctx);
  },

  async 'closing tallies the vote and hands off to the normal game pipeline'() {
    const ctx = makeLobby();
    await engine.startAudienceVote(ctx.client, ctx.lobby);
    const vote = ctx.lobby.vote;
    const wanted1 = vote.candidatesBySlot['1'][0].name;
    const wanted2 = vote.candidatesBySlot['2'][0].name;
    await pick(ctx, 'watcher', '1', wanted1);
    await pick(ctx, 'watcher', '2', wanted2);

    await click(ctx, 'host', 'close');

    assert.equal(ctx.lobby.status, 'CONFIRMING', 'moved into the normal confirm phase');
    assert.equal(ctx.lobby.vote, null, 'vote state torn down');
    // Slot N maps to players[N-1], i.e. that player's OWN head.
    assert.equal(ctx.lobby.game.headByPlayer.p1.name, wanted1);
    assert.equal(ctx.lobby.game.headByPlayer.p2.name, wanted2);
    cleanup(ctx);
  },

  async 'the close announcement reports turnout but never the winning names'() {
    const ctx = makeLobby();
    await engine.startAudienceVote(ctx.client, ctx.lobby);
    const vote = ctx.lobby.vote;
    const w1 = vote.candidatesBySlot['1'][0].name;
    const w2 = vote.candidatesBySlot['2'][0].name;
    await pick(ctx, 'watcher', '1', w1);
    await pick(ctx, 'watcher', '2', w2);

    ctx.recorder.clear();
    await click(ctx, 'host', 'close');

    const publicText = ctx.recorder.textMatching(`channel:${ctx.channelId}`);
    assert.match(publicText, /\*\*1\*\* ballot cast/);
    assert.ok(!publicText.includes(w1), 'winner for player 1 leaked publicly');
    assert.ok(!publicText.includes(w2), 'winner for player 2 leaked publicly');
    cleanup(ctx);
  },

  async 'closing twice is harmless'() {
    const ctx = makeLobby();
    await engine.startAudienceVote(ctx.client, ctx.lobby);
    await click(ctx, 'host', 'close');
    const statusAfterFirst = ctx.lobby.status;
    // The auto-close timer firing after a manual close must be a no-op.
    const second = await engine.closeAudienceVote(ctx.client, ctx.lobby, { reason: 'timer' });
    assert.equal(second.ok, false);
    assert.equal(ctx.lobby.status, statusAfterFirst);
    cleanup(ctx);
  },

  async 'audience mode DMs have no reroll button, classic mode still does'() {
    const voted = makeLobby({ mode: 'audience-vote' });
    await engine.startAudienceVote(voted.client, voted.lobby);
    await click(voted, 'host', 'close');
    const votedDm = voted.recorder.lastMatching('dm:p1');
    const votedButtons = votedDm.payload.components[0].toJSON().components;
    assert.equal(votedButtons.length, 1, 'confirm only');
    assert.equal(votedButtons[0].label, 'Ready');
    assert.match(votedDm.content, /audience picked/i);
    cleanup(voted);

    const classic = makeLobby({ mode: 'classic' });
    await engine.startGame(classic.client, classic.lobby, [
      { name: 'Mario', image_url: null },
      { name: 'Luigi', image_url: null },
    ]);
    const classicButtons = classic.recorder.lastMatching('dm:p1').payload.components[0].toJSON().components;
    assert.equal(classicButtons.length, 2, 'confirm + reroll');
    cleanup(classic);
  },

  async 'rerolling is refused in audience mode'() {
    const ctx = makeLobby();
    await engine.startAudienceVote(ctx.client, ctx.lobby);
    await click(ctx, 'host', 'close');
    const headBefore = ctx.lobby.game.headByPlayer.p2.name;

    await handleComponentInteraction(
      createButtonInteraction({
        client: ctx.client,
        userId: 'p1',
        customId: `reroll:${ctx.channelId}`,
        recorder: ctx.recorder,
      })
    );
    assert.equal(ctx.lobby.game.headByPlayer.p2.name, headBefore, 'character unchanged');
    assert.match(ctx.recorder.allText(), /can't be rerolled/);
    cleanup(ctx);
  },

  async 'vote controls after the vote is gone fail gracefully'() {
    const ctx = makeLobby();
    await click(ctx, 'watcher', 'open'); // never started
    assert.match(ctx.recorder.allText(), /no longer open/);
    cleanup(ctx);
  },
};
