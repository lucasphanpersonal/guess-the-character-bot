// Finished lobbies are kept in memory so /rematch can read their settings, then swept on a
// TTL by an hourly interval (started in src/index.js clientReady). These drive
// evictStaleLobbies directly with an explicit `now` rather than waiting on the interval.

const { assert } = require('./harness');

const GameManager = require('../src/game/GameManager');
const Lobby = require('../src/game/Lobby');

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

  async 'a lobby that never finished is never evicted, however old'() {
    const channelId = makeLobby();
    // No markFinished call -- this lobby is still live.

    GameManager.evictStaleLobbies(Date.now() + TTL_MS * 1000);

    assert.ok(GameManager.getLobby(channelId), 'an unfinished lobby has no finish time, so it stays');
    GameManager.endLobby(channelId);
  },
};
