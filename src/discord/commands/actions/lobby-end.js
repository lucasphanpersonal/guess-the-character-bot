const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const GameManager = require('../../../core/game/GameManager');
// The teardown itself is the engine's, shared with a game that ends because its table has gone.
const { cancelLobby, keptResults } = require('../../game/engine');

module.exports = {
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby) {
      return interaction.reply({ content: 'No active lobby or game.', flags: MessageFlags.Ephemeral });
    }

    const isHost = interaction.user.id === lobby.hostId;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!isHost && !isAdmin) {
      return interaction.reply({ content: 'Only the host or a server admin can end this.', flags: MessageFlags.Ephemeral });
    }

    // Whoever already got their character keeps that result: cancelling is the remedy for one
    // player going quiet, and it should not cost everybody else the game they finished.
    const recorded = await cancelLobby(lobby);
    if (!recorded) return interaction.reply('🛑 Lobby/game cancelled.');
    return interaction.reply(`🛑 Game cancelled — but ${keptResults(recorded)}`);
  },
};
