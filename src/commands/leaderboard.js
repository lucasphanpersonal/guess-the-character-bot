const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getPlayerStats, getLeaderboard } = require('../db/stats');

function formatRecord(wins, losses, ties) {
  return `${wins}W-${losses}L-${ties}T`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the server win/loss leaderboard, or one player\'s record')
    .addUserOption((opt) => opt.setName('player').setDescription('Show this player\'s record instead of the leaderboard')),
  async execute(interaction) {
    const player = interaction.options.getUser('player');

    if (player) {
      const stats = getPlayerStats(interaction.guildId, player.id);
      if (!stats.total) {
        return interaction.reply({ content: `<@${player.id}> hasn't finished a game yet.`, flags: MessageFlags.Ephemeral });
      }
      // Turn counts only exist for games played under turn-count scoring, so games migrated
      // from before it are silently left out of this rather than guessed at.
      const turns = stats.bestTurns
        ? ` — best **${stats.bestTurns}** turn${stats.bestTurns === 1 ? '' : 's'}, averaging **${stats.avgTurns.toFixed(1)}**`
        : '';
      return interaction.reply(
        `📊 <@${player.id}>: **${formatRecord(stats.wins, stats.losses, stats.ties)}** (${stats.total} game${stats.total === 1 ? '' : 's'})${turns}`
      );
    }

    const rows = getLeaderboard(interaction.guildId, 10);
    if (!rows.length) {
      return interaction.reply({ content: 'No finished games yet in this server.', flags: MessageFlags.Ephemeral });
    }
    const lines = rows.map(
      (row, i) => `${i + 1}. <@${row.playerId}> -- **${formatRecord(row.wins, row.losses, row.ties)}**`
    );
    return interaction.reply(`🏆 **Leaderboard**\n${lines.join('\n')}`);
  },
};
