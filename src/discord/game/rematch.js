const Lobby = require('../../core/game/Lobby');
const GameManager = require('../../core/game/GameManager');
const { getListLabelForIds } = require('../../compendium/characterLists');

// Shared by /rematch and the game-over board's Rematch button.
//
// The last game's order comes along, so the rematch can be seated UNLIKE it (core/game/seating.js):
// another first player, other "checks the next one" pairs. Not for fairness -- scoring on turns
// taken means the seat gives nobody an edge -- but because carried over unchanged, the same person
// handled your character every game of the night.
/**
 * Who may start a rematch: someone who was in the game -- a player, or its host. Not anyone who
 * clicks: the rematch makes them host, with Start and the character picker, so a passer-by could
 * take over a table's next game. Returns the refusal, or null.
 */
function rematchRefusal(previous, userId) {
  if (previous.players.includes(userId) || previous.hostId === userId) return null;
  return 'Only someone who played that game can start its rematch -- use `/lobby create` for a new one.';
}

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
  lobby.lastOrder = previous.game?.turnOrder ?? previous.lastOrder ?? null;
  GameManager.createLobby(previous.channelId, lobby);
  return { lobby, players: [...lobby.players] };
}

// "A and B", "A, B and C" -- not "A and B and C and D".
const listOf = (items) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// Uses the summarising label rather than lobby.listNames, which is every list by name. A
// lobby opened with `category:Video Games` carries 581 of them, and spelling them all out
// here produced a 14,199-character message -- seven times Discord's 2,000 limit, which the
// API rejects outright rather than truncating.
function rematchAnnouncement(lobby, players) {
  return (
    `🔁 Rematch! ${listOf(players.map((id) => `<@${id}>`))} are back in using ` +
    `**${getListLabelForIds(lobby.listIds)}**. ` +
    'Host can `/lobby set-characters` or just hit **Start game** when ready.'
  );
}

module.exports = { createRematchLobby, rematchAnnouncement, rematchRefusal };
