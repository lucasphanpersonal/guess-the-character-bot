// Seating (src/core/game/seating.js): a fresh order every game, unlike the last.
//
// The runner keeps seating fixed for every other suite (GTC_FIXED_SEATING); these switch it off
// with `fixed: false`, and use many trials because the shuffle is random -- one green run proves
// little (CLAUDE.md).

const { assert, createRecorder, createFakeClient } = require('./harness');
const { freshSeating } = require('../src/core/game/seating');

const seat = (players, previous) => freshSeating(players, previous, { fixed: false });
const sameSet = (a, b) => [...a].sort().join() === [...b].sort().join();
const nextOf = (order) => new Map(order.map((id, i) => [id, order[(i + 1) % order.length]]));

module.exports = {
  'a seating is the same players, reordered'() {
    const players = ['a', 'b', 'c', 'd', 'e'];
    for (let t = 0; t < 200; t++) {
      const s = seat(players, null);
      assert.equal(s.length, players.length);
      assert.ok(sameSet(s, players));
    }
  },

  'with no game before, anyone may go first'() {
    const firsts = new Set();
    for (let t = 0; t < 400; t++) firsts.add(seat(['a', 'b', 'c', 'd'], null)[0]);
    assert.equal(firsts.size, 4, 'the host is not always first');
  },

  'the next game never starts with the same player'() {
    for (const n of [2, 3, 4, 6, 8]) {
      const players = Array.from({ length: n }, (_, i) => `p${i}`);
      let last = [...players];
      for (let t = 0; t < 200; t++) {
        const s = seat(players, last);
        assert.notEqual(s[0], last[0], `${n} players, game ${t}`);
        last = s;
      }
    }
  },

  // Everyone checks -- and, picking for each other, picks for -- the next player round.
  'from three players up, nobody checks the same person two games running'() {
    for (const n of [3, 4, 5, 8]) {
      const players = Array.from({ length: n }, (_, i) => `p${i}`);
      let last = [...players];
      for (let t = 0; t < 100; t++) {
        const s = seat(players, last);
        const before = nextOf(last);
        const now = nextOf(s);
        assert.ok(players.every((id) => now.get(id) !== before.get(id)), `${n} players, game ${t}: ${last} then ${s}`);
        last = s;
      }
    }
  },

  'someone who left, or someone new, does not upset it'() {
    const s = seat(['b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd']); // a left, e joined
    assert.ok(sameSet(s, ['b', 'c', 'd', 'e']));
    assert.notEqual(s[0], 'b', 'b went first among those still here');
  },

  'fixed seating keeps the order as given, for the test suites'() {
    assert.deepEqual(freshSeating(['a', 'b', 'c'], ['c', 'b', 'a'], { fixed: true }), ['a', 'b', 'c']);
  },

  // The part that can go wrong: each character must stay with its player when the order moves.
  async 'Discord: a reseated game keeps every character with its player'() {
    const engine = require('../src/discord/game/engine');
    const Lobby = require('../src/core/game/Lobby');
    const GameManager = require('../src/core/game/GameManager');
    const was = process.env.GTC_FIXED_SEATING;
    process.env.GTC_FIXED_SEATING = '0';
    try {
      const firsts = new Set();
      for (let t = 0; t < 12; t++) {
        const channelId = `seat-chan-${t}`;
        const lobby = new Lobby({ guildId: 'seat-guild', channelId, hostId: 'p1', listIds: [], listNames: [], turnSeconds: 90, maxRerolls: 2 });
        for (const id of ['p1', 'p2', 'p3', 'p4']) lobby.addPlayer(id);
        GameManager.createLobby(channelId, lobby);
        const chars = ['Mario', 'Luigi', 'Peach', 'Bowser'].map((name) => ({ name, image_url: null }));
        const res = await engine.startGame(createFakeClient(createRecorder()), lobby, chars);
        assert.equal(res.ok, true);
        const game = lobby.game;
        assert.deepEqual(['p1', 'p2', 'p3', 'p4'].map((id) => game.headByPlayer[id].name), ['Mario', 'Luigi', 'Peach', 'Bowser']);
        assert.ok(sameSet(game.turnOrder, lobby.players));
        assert.deepEqual(lobby.lastOrder, game.turnOrder, 'kept for the next game to be unlike');
        firsts.add(game.turnOrder[0]);
        engine.clearTimers(game);
        GameManager.endLobby(channelId);
      }
      assert.ok(firsts.size > 1, 'not always the host first');
    } finally {
      process.env.GTC_FIXED_SEATING = was;
    }
  },

  'web: a reseated deal keeps every hand-picked character with its player'() {
    const { createSetup, dealWithPicks } = require('../src/web/guess/gameSetup');
    // The service seats first, then deals in that order: picks are by player, so wherever each
    // player sits, their pick is theirs.
    const order = seat(['a', 'b', 'c'], ['a', 'b', 'c']);
    const picks = { a: { name: 'Zorblax', typed: true }, b: { name: 'Mirelle', typed: true }, c: { name: 'Tavish', typed: true } };
    const content = { randomCharacters: () => [], freeform: (name) => ({ name, image_url: null, id: null, list_id: null }) };
    const dealt = dealWithPicks({ order, picks, names: {}, content, listIds: [], difficulty: 'normal' });
    assert.equal(dealt.ok, true);
    const game = createSetup({ order, guildId: 'web', listIds: [], difficulty: 'normal', characters: dealt.characters });
    assert.deepEqual(['a', 'b', 'c'].map((id) => game.headByPlayer[id].name), ['Zorblax', 'Mirelle', 'Tavish']);
    assert.deepEqual(game.turnOrder, order);
  },
};
