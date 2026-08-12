// Handlers for the buttons attached to the end-of-game reveal
// (customId `over:<action>:<channelId>`).

const { MessageFlags } = require('discord.js');
const GameManager = require('../../core/game/GameManager');
const { createRematchLobby, rematchAnnouncement } = require('../game/rematch');
const { buildLobbyBoardPayload, attachLobbyBoard } = require('../game/lobbyBoard');
const { getLeaderboard } = require('../../core/db/stats');

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

function formatLeaderboard(guildId) {
  const rows = getLeaderboard(guildId, 10);
  if (!rows.length) return 'No finished games yet in this server.';
  return (
    '🏆 **Leaderboard**\n' +
    rows.map((r, i) => `${i + 1}. <@${r.playerId}> -- **${r.wins}W-${r.losses}L-${r.ties}T**`).join('\n')
  );
}

async function handle(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const channelId = parts[2];
  const gameInstanceId = parts[3];

  if (action === 'leaderboard') {
    return interaction.reply(ephemeral(formatLeaderboard(interaction.guildId)));
  }

  if (action === 'rematch') {
    const previous = GameManager.getLobby(channelId);
    if (!previous || previous.status !== 'FINISHED') {
      return interaction.reply(
        ephemeral('That game has already been replaced -- use `/lobby create` to start a new one.')
      );
    }

    // Validate gameInstanceId to prevent stale controls from old games (if present)
    if (gameInstanceId && gameInstanceId !== previous.game?.gameInstanceId) {
      return interaction.reply(
        ephemeral('That game has already been replaced -- use `/lobby create` to start a new one.')
      );
    }

    const { lobby, players } = createRematchLobby(previous, interaction.user.id);
    // A fresh board is posted rather than editing the reveal, so the finished game's
    // result stays readable in the channel history.
    const message = await interaction.reply({
      content: rematchAnnouncement(lobby, players),
      ...buildLobbyBoardPayload(lobby),
      withResponse: true,
    });
    await attachLobbyBoard(lobby, message, interaction);
    return undefined;
  }

  return interaction.reply(ephemeral('Unknown action.'));
}

module.exports = { handle };
