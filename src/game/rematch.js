const Lobby = require('./Lobby');
const GameManager = require('./GameManager');
const { getListLabelForIds } = require('../db/characterLists');

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
    difficulty: previous.difficulty,
  });
  lobby.addPlayer(prevP2);
  lobby.addPlayer(prevP1);
  GameManager.createLobby(previous.channelId, lobby);
  return { lobby, firstPlayer: prevP2, secondPlayer: prevP1 };
}

// Uses the summarising label rather than lobby.listNames, which is every list by name. A
// lobby opened with `category:Video Games` carries 581 of them, and spelling them all out
// here produced a 14,199-character message -- seven times Discord's 2,000 limit, which the
// API rejects outright rather than truncating.
function rematchAnnouncement(lobby, firstPlayer, secondPlayer) {
  return (
    `🔁 Rematch! <@${firstPlayer}> and <@${secondPlayer}> are back in (going in that order this time) using ` +
    `**${getListLabelForIds(lobby.listIds)}**. ` +
    'Host can `/set-characters` or just hit **Start game** when ready.'
  );
}

module.exports = { createRematchLobby, rematchAnnouncement };
