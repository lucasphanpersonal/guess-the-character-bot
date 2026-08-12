// Keyed by channelId (globally unique across Discord, not just within a guild) so
// different channels in the same server can each run their own lobby/game concurrently.
// A FINISHED lobby is deliberately left in the map after a game ends (see engine.js
// finalizeGame) so /rematch can read its settings -- /lobby create treats a FINISHED entry
// as free to overwrite, and /lobby end deletes regardless of status.
//
// Finished lobbies are evicted after a TTL (24 hours) to prevent indefinite in-memory
// accumulation on long-running bots. Rematch is available immediately after game end;
// after 24 hours a player who wants to rematch creates a fresh lobby with /lobby create.
const lobbies = new Map();
const finishedLobbyTTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const finishTimes = new Map(); // channelId -> time lobby was marked FINISHED

module.exports = {
  getLobby(channelId) {
    return lobbies.get(channelId);
  },
  createLobby(channelId, lobby) {
    lobbies.set(channelId, lobby);
    finishTimes.delete(channelId); // clear any prior finish time
  },
  endLobby(channelId) {
    lobbies.delete(channelId);
    finishTimes.delete(channelId);
  },
  markFinished(channelId) {
    // Called when a game ends and the lobby is marked FINISHED for rematch purposes.
    // Record the time so we can evict it after the TTL expires.
    finishTimes.set(channelId, Date.now());
  },
  allLobbies() {
    return [...lobbies.values()];
  },
  clear() {
    lobbies.clear();
    finishTimes.clear();
  },
  // Evict finished lobbies older than the TTL to keep memory bounded. Driven by an hourly
  // interval started in the bot's clientReady handler (src/index.js); tests pass an explicit
  // `now` to advance the clock rather than waiting on the interval.
  evictStaleLobbies(now = Date.now()) {
    for (const [channelId, finishTime] of finishTimes.entries()) {
      if (now - finishTime > finishedLobbyTTL) {
        lobbies.delete(channelId);
        finishTimes.delete(channelId);
      }
    }
  },
};
