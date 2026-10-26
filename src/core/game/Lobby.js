const MAX_PLAYERS = 8;

class Lobby {
  constructor({
    guildId,
    channelId,
    hostId,
    listIds,
    listNames,
    turnSeconds,
    // Rerolls are always unlimited (-1); there is no UI to set a finite budget. The field and
    // the enforcement in engine/gameSetup are kept so a value could be reintroduced, but nothing
    // sets one. See the note in lobbySettings.js.
    maxRerolls = -1,
    mode = 'classic',
    voteSeconds = 90,
    voteOptions = 5,
    difficulty = 'normal',
  }) {
    this.guildId = guildId;
    this.channelId = channelId;
    this.hostId = hostId;
    this.listIds = listIds;
    this.listNames = listNames;
    this.turnSeconds = turnSeconds;
    this.maxRerolls = maxRerolls; // -1 means unlimited
    // 'classic' -> the bot deals characters and players confirm/reroll them.
    // 'audience-vote' -> the audience votes on each player's character instead.
    this.mode = mode;
    this.voteSeconds = voteSeconds;
    this.voteOptions = voteOptions;
    // How deep into each cast a random deal may go: 'easy' | 'normal' | 'everything'.
    // Separate from the server's list selection on purpose -- that says which franchises
    // this server likes, this says how obscure a character tonight's players will tolerate.
    this.difficulty = difficulty;
    this.vote = null; // AudienceVote while lobby.status === 'VOTING'
    this.players = [];
    this.spectators = new Set();
    this.status = 'WAITING';
    // For evicting a lobby that never got going (GameManager.evictStaleLobbies).
    this.createdAt = Date.now();
    this.game = null;
    // Set via /lobby set-characters: { [playerId]: characterRow }. Used instead of a random pick
    // at /lobby start when both players have an assignment.
    this.assignedCharacters = {};
    // The last game's seating, so the next one can be seated unlike it (./seating.js). A rematch
    // starts with its predecessor's.
    this.lastOrder = null;
  }

  addPlayer(userId) {
    if (this.players.includes(userId)) return { ok: false, reason: 'already-joined' };
    if (this.players.length >= MAX_PLAYERS) return { ok: false, reason: 'full' };
    this.players.push(userId);
    return { ok: true };
  }

  removePlayer(userId) {
    const idx = this.players.indexOf(userId);
    if (idx === -1) return false;
    this.players.splice(idx, 1);
    return true;
  }
}

module.exports = Lobby;
module.exports.MAX_PLAYERS = MAX_PLAYERS;
