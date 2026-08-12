const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const GameManager = require('../../core/game/GameManager');
const { handlePass } = require('../game/engine');

module.exports = {
  data: new SlashCommandBuilder().setName('pass').setDescription('End your turn without guessing'),
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby || lobby.status !== 'IN_PROGRESS') {
      return interaction.reply({ content: 'No game in progress.', flags: MessageFlags.Ephemeral });
    }
    await handlePass(interaction, lobby);
  },
};
