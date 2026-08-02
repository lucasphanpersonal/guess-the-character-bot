// Keyed by channelId (globally unique across Discord, not just within a guild) so
// different channels in the same server can each run their own lobby/game concurrently.
// A FINISHED lobby is deliberately left in the map after a game ends (see engine.js
// finalizeGame) so /rematch can read its settings -- /lobby create treats a FINISHED entry
// as free to overwrite, and /lobby end deletes regardless of status.
const lobbies = new Map();

module.exports = {
  getLobby(channelId) {
    return lobbies.get(channelId);
  },
  createLobby(channelId, lobby) {
    lobbies.set(channelId, lobby);
  },
  endLobby(channelId) {
    lobbies.delete(channelId);
  },
  allLobbies() {
    return [...lobbies.values()];
  },
  clear() {
    lobbies.clear();
  },
};
