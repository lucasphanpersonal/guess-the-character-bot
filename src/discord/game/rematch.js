const Lobby = require('../../core/game/Lobby');
const GameManager = require('../../core/game/GameManager');
const { getListLabelForIds } = require('../../compendium/characterLists');

// Shared by /rematch and the game-over board's Rematch button.
//
// Turn order is carried over unchanged. It used to be swapped, because stopping at the first
// correct guess handed the player who moved first a turn the other hadn't had -- but scoring
// on turns taken means everyone races their own count and the seat no longer matters.
function createRematchLobby(previous, hostId) {
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
  for (const playerId of previous.players) lobby.addPlayer(playerId);
  GameManager.createLobby(previous.channelId, lobby);
  return { lobby, players: [...lobby.players] };
}

// Uses the summarising label rather than lobby.listNames, which is every list by name. A
// lobby opened with `category:Video Games` carries 581 of them, and spelling them all out
// here produced a 14,199-character message -- seven times Discord's 2,000 limit, which the
// API rejects outright rather than truncating.
function rematchAnnouncement(lobby, players) {
  return (
    `🔁 Rematch! ${players.map((id) => `<@${id}>`).join(' and ')} are back in using ` +
    `**${getListLabelForIds(lobby.listIds)}**. ` +
    'Host can `/lobby set-characters` or just hit **Start game** when ready.'
  );
}

module.exports = { createRematchLobby, rematchAnnouncement };
