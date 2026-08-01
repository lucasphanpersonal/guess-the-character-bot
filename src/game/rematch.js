const Lobby = require('./Lobby');
const GameManager = require('./GameManager');

// Shared by /rematch and the game-over board's Rematch button.
// Turn order is swapped so the rebuttal-timing (dis)advantage doesn't land on the same
// person two games running.
function createRematchLobby(previous, hostId) {
  const [prevP1, prevP2] = previous.players;
  const lobby = new Lobby({
    guildId: previous.guildId,
    channelId: previous.channelId,
    hostId,
    listIds: previous.listIds,
    listNames: previous.listNames,
    turnSeconds: previous.turnSeconds,
    maxRerolls: previous.maxRerolls,
    mode: previous.mode,
    voteSeconds: previous.voteSeconds,
    voteOptions: previous.voteOptions,
  });
  lobby.addPlayer(prevP2);
  lobby.addPlayer(prevP1);
  GameManager.createLobby(previous.channelId, lobby);
  return { lobby, firstPlayer: prevP2, secondPlayer: prevP1 };
}

function rematchAnnouncement(lobby, firstPlayer, secondPlayer) {
  return (
    `🔁 Rematch! <@${firstPlayer}> and <@${secondPlayer}> are back in (going in that order this time) using ` +
    `${lobby.listNames.map((n) => `**${n}**`).join(' + ')}. ` +
    'Host can `/set-characters` or just hit **Start game** when ready.'
  );
}

module.exports = { createRematchLobby, rematchAnnouncement };
