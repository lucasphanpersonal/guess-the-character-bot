const { assert, createRecorder, createFakeClient, createButtonInteraction } = require('./harness');

const engine = require('../src/game/engine');
const confirmPhase = require('../src/game/confirmPhase');
const {
  AudienceVote,
  drawCandidates,
  buildVoteBoardPayload,
  buildBallotPayload,
  clearVoteTimer,
} = require('../src/game/audienceVote');
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

// `extraCharacters` is opt-in rather than sized from the roster, because one test proves the
// draw fails cleanly when the pool is too small and must keep the 15-name pool it relies on.
// The padding names are two digits so none of them is a substring of another -- the spoiler
// assertions are `includes` checks, and "Extra 1" inside "Extra 10" would fail falsely.
function makeLobby({
  voteOptions = 5,
  voteSeconds = 60,
  mode = 'audience-vote',
  playerCount = 2,
  extraCharacters = 0,
} = {}) {
  const n = ++counter;
  const guildId = `vote-guild-${n}`;
  const channelId = `vote-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM games WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Vote List', 'tester', 'Video Games');
  for (const name of CHARACTERS) lists.addCharacter(listId, name, 'tester');
  for (let i = 0; i < extraCharacters; i++) {
    lists.addCharacter(listId, `Extra${String(i).padStart(2, '0')}`, 'tester');
  }

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
  for (let i = 1; i <= playerCount; i++) lobby.addPlayer(`p${i}`);
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

// Prev / Next on a paged ballot.
const turnPage = (ctx, userId, page) =>
  handleComponentInteraction(
    createButtonInteraction({
      client: ctx.client,
      userId,
      customId: `vote:page:${ctx.channelId}:${page}`,
      recorder: ctx.recorder,
    })
  );

// Which players a rendered ballot page can actually vote for.
const slotsOn = (payload) =>
  payload.components
    .flatMap((row) => row.toJSON().components)
    .filter((c) => c.custom_id?.startsWith('vote:pick:'))
    .map((c) => c.custom_id.split(':')[3]);

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
    assert.match(payloadStrings(buildVoteBoardPayload(vote)), /Ballots cast/);
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
    assert.match(votedDm.content, /chosen by the audience/i);
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

  // ---------------------------------------------------------------------------
  // Board shape, extension, and the reveal
  // ---------------------------------------------------------------------------

  'the public board describes the shape of each tally without naming anybody'() {
    const ctx = makeLobby();
    const candidatesBySlot = drawCandidates(ctx.lobby);
    const vote = new AudienceVote({ lobby: ctx.lobby, candidatesBySlot });

    assert.match(payloadStrings(buildVoteBoardPayload(vote)), /no votes yet/);

    // Two voters agreeing is "unanimous"; a third disagreeing makes it a split. Neither
    // phrasing may contain a candidate name, since the player wearing it reads this board.
    vote.recordVote('v1', '1', candidatesBySlot['1'][0].name);
    vote.recordVote('v2', '1', candidatesBySlot['1'][0].name);
    let text = payloadStrings(buildVoteBoardPayload(vote));
    assert.match(text, /unanimous so far/);

    vote.recordVote('v3', '1', candidatesBySlot['1'][1].name);
    text = payloadStrings(buildVoteBoardPayload(vote));
    assert.match(text, /3\*\* votes across 2 characters/);
    assert.match(text, /leader has 2/);

    for (const c of [...candidatesBySlot['1'], ...candidatesBySlot['2']]) {
      assert.doesNotMatch(text, new RegExp(c.name), `board leaked ${c.name}`);
    }
    GameManager.endLobby(ctx.channelId);
  },

  'a dead heat is reported as tied, still without names'() {
    const ctx = makeLobby();
    const candidatesBySlot = drawCandidates(ctx.lobby);
    const vote = new AudienceVote({ lobby: ctx.lobby, candidatesBySlot });
    vote.recordVote('v1', '2', candidatesBySlot['2'][0].name);
    vote.recordVote('v2', '2', candidatesBySlot['2'][1].name);

    const text = payloadStrings(buildVoteBoardPayload(vote));
    assert.match(text, /currently tied/);
    for (const c of candidatesBySlot['2']) assert.doesNotMatch(text, new RegExp(c.name));
    GameManager.endLobby(ctx.channelId);
  },

  'the ballot confirms that a new pick replaced the old one'() {
    const ctx = makeLobby();
    const vote = new AudienceVote({ lobby: ctx.lobby, candidatesBySlot: drawCandidates(ctx.lobby) });
    const first = vote.candidatesBySlot['1'][0].name;
    vote.recordVote('v1', '1', first);

    assert.doesNotMatch(buildBallotPayload(vote, 'v1').content, /Saved/, 'silent when just opening');
    const after = buildBallotPayload(vote, 'v1', { justPicked: '1' }).content;
    assert.match(after, /Saved/);
    assert.match(after, /replaces your previous pick/);
    GameManager.endLobby(ctx.channelId);
  },

  async 'the host can extend voting, and repeated presses accumulate'() {
    const ctx = makeLobby({ voteSeconds: 60 });
    await engine.startGameFromLobby(ctx.client, ctx.lobby);
    const vote = ctx.lobby.vote;
    const before = vote.endsAt;

    await click(ctx, 'host', 'extend');
    assert.equal(vote.endsAt - before, 30000, 'first press');
    await click(ctx, 'host', 'extend');
    assert.equal(vote.endsAt - before, 60000, 'presses stack rather than resetting');
    assert.match(ctx.recorder.allText(), /extended by 30 seconds/);

    clearVoteTimer(vote);
    GameManager.endLobby(ctx.channelId);
  },

  async 'only the host can extend'() {
    const ctx = makeLobby();
    await engine.startGameFromLobby(ctx.client, ctx.lobby);
    const vote = ctx.lobby.vote;
    const before = vote.endsAt;

    await click(ctx, 'someone', 'extend');
    assert.equal(vote.endsAt, before, 'unchanged');
    assert.match(ctx.recorder.allText(), /Only the host/);

    clearVoteTimer(vote);
    GameManager.endLobby(ctx.channelId);
  },

  // The tie-break and the empty-audience fallback are both random, so resolving twice used
  // to be able to disagree -- the character dealt vs the one named in the summary.
  'the winner is decided once, so the summary can never contradict the deal'() {
    const ctx = makeLobby();
    const candidatesBySlot = drawCandidates(ctx.lobby);
    const vote = new AudienceVote({ lobby: ctx.lobby, candidatesBySlot });
    // No votes at all: the fallback is a random candidate.
    const dealt = vote.resolve().map((c) => c.name);
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(vote.resolve().map((c) => c.name), dealt, 'stable across calls');
    }
    assert.deepEqual(vote.summarise().map((s) => s.name), dealt, 'summary matches what was dealt');
    GameManager.endLobby(ctx.channelId);
  },

  'the summary distinguishes unanimous, tie-broken and unvoted outcomes'() {
    const ctx = makeLobby();
    const candidatesBySlot = drawCandidates(ctx.lobby);
    const vote = new AudienceVote({ lobby: ctx.lobby, candidatesBySlot });
    vote.recordVote('v1', '1', candidatesBySlot['1'][0].name);
    vote.recordVote('v2', '1', candidatesBySlot['1'][0].name);

    const [slot1, slot2] = vote.summarise();
    assert.equal(slot1.unopposed, true);
    assert.equal(slot1.votes, 2);
    assert.equal(slot2.noVotes, true, 'nobody voted for player 2');
    GameManager.endLobby(ctx.channelId);
  },

  async 'the reveal tells the audience how their vote turned out'() {
    const ctx = makeLobby();
    await engine.startGameFromLobby(ctx.client, ctx.lobby);
    const vote = ctx.lobby.vote;
    const pick = vote.candidatesBySlot['1'][0].name;
    vote.recordVote('v1', '1', pick);
    vote.recordVote('v2', '1', pick);

    await engine.closeAudienceVote(ctx.client, ctx.lobby, { reason: 'host' });
    const game = ctx.lobby.game;
    assert.ok(game.voteSummary, 'the tally survived the close');

    // Nothing about it may reach the channel before the reveal.
    assert.doesNotMatch(ctx.recorder.textMatching(`channel:${ctx.channelId}`), new RegExp(pick));

    // Play it out for real: confirm both, then guess correctly, so the reveal is produced
    // by the same path a live game takes.
    for (const userId of ['p1', 'p2']) {
      await confirmPhase.handleConfirmationButton(
        createButtonInteraction({
          client: ctx.client,
          userId,
          customId: `confirm:${ctx.channelId}`,
          recorder: ctx.recorder,
        })
      );
    }
    // A correct guess by whoever moved first only earns the OTHER player a rebuttal turn,
    // so the game needs both halves before a reveal exists.
    const first = game.currentPlayerId;
    await engine.submitJudgement(ctx.client, ctx.lobby, game.judgeId, true);
    // A wrong guess deliberately does NOT end a turn, so the rebuttal is closed by passing.
    const second = game.turnOrder.find((id) => id !== first);
    await engine.submitPass(ctx.client, ctx.lobby, second);

    const revealed = ctx.recorder.textMatching(`channel:${ctx.channelId}`);
    assert.match(revealed, /How the audience voted/);
    assert.match(revealed, /unanimous/);

    engine.clearTimers(game);
    GameManager.endLobby(ctx.channelId);
  },

  // ---------------------------------------------------------------------------
  // Rosters too big for one ballot
  // ---------------------------------------------------------------------------

  async 'a roster that fits in five action rows still gets an unpaged ballot'() {
    const ctx = makeLobby({ playerCount: 5, voteOptions: 3, extraCharacters: 10 });
    assert.equal((await engine.startAudienceVote(ctx.client, ctx.lobby)).ok, true);

    await click(ctx, 'watcher', 'open');
    const payload = ctx.recorder.lastMatching('reply:watcher').payload;
    assert.equal(payload.components.length, 5, 'five selects, no room and no need for nav');
    assert.deepEqual(slotsOn(payload), ['1', '2', '3', '4', '5']);
    assert.doesNotMatch(payload.content, /Page 1 of/, 'nothing to page through');
    cleanup(ctx);
  },

  async 'a roster too big for one page is paged, and every player is votable'() {
    const ctx = makeLobby({ playerCount: 8, voteOptions: 3, extraCharacters: 15 });
    const started = await engine.startAudienceVote(ctx.client, ctx.lobby);
    assert.equal(started.ok, true, started.error);

    await click(ctx, 'watcher', 'open');
    let payload = ctx.recorder.lastMatching('reply:watcher').payload;

    const seen = new Set(slotsOn(payload));
    for (let page = 0; page < 2; page++) {
      assert.ok(payload.components.length <= 5, `page ${page} exceeds Discord's five action rows`);
      // The nav row is the last one, and it is the only row that is not a candidate select.
      const nav = payload.components.at(-1).toJSON().components;
      assert.deepEqual(nav.map((b) => b.label), ['Prev', 'Next'], `page ${page} has Prev/Next`);
      assert.equal(nav[0].disabled, page === 0, 'Prev is dead on the first page');
      assert.equal(nav[1].disabled, page === 1, 'Next is dead on the last page');

      if (page === 1) break;
      await turnPage(ctx, 'watcher', page + 1);
      payload = ctx.recorder.lastMatching('update:watcher').payload;
      for (const slot of slotsOn(payload)) seen.add(slot);
    }

    assert.deepEqual([...seen].sort((a, b) => a - b), ctx.lobby.vote.slots, 'no player is unreachable');
    cleanup(ctx);
  },

  async 'a pick on a later page can still be changed, and says so'() {
    const ctx = makeLobby({ playerCount: 8, voteOptions: 3, extraCharacters: 15 });
    await engine.startAudienceVote(ctx.client, ctx.lobby);
    const vote = ctx.lobby.vote;
    const [first, second] = vote.candidatesBySlot['8'];

    await pick(ctx, 'watcher', '8', first.name);
    // Confirming a pick must not navigate away from the page it was made on.
    const afterFirst = ctx.recorder.lastMatching('update:watcher').payload;
    assert.ok(slotsOn(afterFirst).includes('8'), 'stayed on player 8\'s page');
    assert.match(afterFirst.content, /Page 2 of 2/);

    await pick(ctx, 'watcher', '8', second.name);
    const afterSecond = ctx.recorder.lastMatching('update:watcher').payload;
    assert.equal(vote.voterCount, 1, 'still one ballot');
    assert.equal(vote.ballots.get('watcher')['8'], second.name, 'latest pick wins');
    assert.match(afterSecond.content, /replaces your previous pick/);
    assert.match(afterSecond.content, /\*\*1\*\* of 8 players picked/);
    cleanup(ctx);
  },

  async 'a paged vote leaves the public board just as name-free'() {
    const ctx = makeLobby({ playerCount: 8, voteOptions: 3, extraCharacters: 15 });
    await engine.startAudienceVote(ctx.client, ctx.lobby);
    const vote = ctx.lobby.vote;
    // Vote for everyone, so every tally on the board has something to describe.
    for (const slot of vote.slots) await pick(ctx, 'watcher', slot, vote.candidatesBySlot[slot][0].name);

    const boardText = payloadStrings(buildVoteBoardPayload(vote));
    const channelText = ctx.recorder.textMatching(`channel:${ctx.channelId}`);
    for (const slot of vote.slots) {
      for (const c of vote.candidatesBySlot[slot]) {
        assert.ok(!boardText.includes(c.name), `board leaked candidate "${c.name}"`);
        assert.ok(!channelText.includes(c.name), `channel leaked candidate "${c.name}"`);
      }
    }
    assert.equal(buildVoteBoardPayload(vote).embeds[0].toJSON().fields.length, 10, 'a field each, plus the two footers');
    cleanup(ctx);
  },

  'a roster at the player cap keeps every tally within embed limits'() {
    const ctx = makeLobby({ playerCount: 8, voteOptions: 2, extraCharacters: 5 });
    const candidatesBySlot = drawCandidates(ctx.lobby);
    const vote = new AudienceVote({ lobby: ctx.lobby, candidatesBySlot });
    vote.recordVote('v1', '8', candidatesBySlot['8'][0].name);

    const { fields } = buildVoteBoardPayload(vote).embeds[0].toJSON();
    assert.ok(fields.length <= 25, `${fields.length} fields exceeds the embed limit`);
    for (const field of fields) assert.ok(field.value.length <= 1024, 'field value within limits');

    const text = payloadStrings(buildVoteBoardPayload(vote));
    assert.match(text, /Player 8.*\*\*1\*\* vote — unanimous so far/);
    for (const slot of vote.slots) {
      for (const c of candidatesBySlot[slot]) assert.ok(!text.includes(c.name), `board leaked ${c.name}`);
    }
    GameManager.endLobby(ctx.channelId);
  },
};
