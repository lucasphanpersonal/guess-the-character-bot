const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const GameManager = require('../game/GameManager');
const { handleGuess } = require('../game/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('guess')
    .setDescription('Guess the character on your own head')
    .addStringOption((opt) => opt.setName('character').setDescription('Your guess').setRequired(true)),
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby || lobby.status !== 'IN_PROGRESS') {
      return interaction.reply({ content: 'No game in progress.', flags: MessageFlags.Ephemeral });
    }
    const guessText = interaction.options.getString('character');
    await handleGuess(interaction, lobby, guessText);
  },
};
