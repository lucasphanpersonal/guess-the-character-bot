// Finished lobbies are kept in memory so /rematch can read their settings, then swept on a
// TTL by an hourly interval (started in src/index.js clientReady). These drive
// evictStaleLobbies directly with an explicit `now` rather than waiting on the interval.

const { assert } = require('./harness');

const GameManager = require('../src/core/game/GameManager');
const Lobby = require('../src/core/game/Lobby');

const TTL_MS = 24 * 60 * 60 * 1000; // must match finishedLobbyTTL in GameManager

let counter = 0;
function makeLobby() {
  const channelId = `evict-chan-${++counter}`;
  const lobby = new Lobby({
    guildId: `evict-guild-${counter}`,
    channelId,
    hostId: 'p1',
    listIds: [1],
    listNames: ['List'],
    turnSeconds: 90,
  });
  GameManager.createLobby(channelId, lobby);
  return channelId;
}

module.exports = {
  async 'a finished lobby past the TTL is evicted'() {
    const channelId = makeLobby();
    const finishedAt = Date.now();
    GameManager.markFinished(channelId);

    // Just past the TTL from when it was marked finished.
    GameManager.evictStaleLobbies(finishedAt + TTL_MS + 1);

    assert.equal(GameManager.getLobby(channelId), undefined, 'the stale finished lobby is gone');
  },

  async 'a finished lobby still inside the TTL survives'() {
    const channelId = makeLobby();
    const finishedAt = Date.now();
    GameManager.markFinished(channelId);

    GameManager.evictStaleLobbies(finishedAt + TTL_MS - 1000);

    assert.ok(GameManager.getLobby(channelId), 'a recently finished lobby is kept for /rematch');
    GameManager.endLobby(channelId);
  },

  async 'a game being played is never evicted, however long it runs'() {
    for (const status of ['IN_PROGRESS', 'VOTING']) {
      const channelId = makeLobby();
      GameManager.getLobby(channelId).status = status;
      GameManager.evictStaleLobbies(Date.now() + TTL_MS * 1000);
      assert.ok(GameManager.getLobby(channelId), `${status} stays`);
      GameManager.endLobby(channelId);
    }
  },

  async 'a lobby that never got going is evicted a day after it opened'() {
    for (const status of ['WAITING', 'CONFIRMING']) {
      const channelId = makeLobby();
      const lobby = GameManager.getLobby(channelId);
      lobby.status = status;
      assert.deepEqual(GameManager.evictStaleLobbies(lobby.createdAt + TTL_MS - 1000), [], `${status}: not yet`);
      assert.ok(GameManager.getLobby(channelId));
      assert.deepEqual(GameManager.evictStaleLobbies(lobby.createdAt + TTL_MS + 1), [lobby], `${status}: reported`);
      assert.equal(GameManager.getLobby(channelId), undefined, `${status}: gone, so the channel is free again`);
    }
  },
};
