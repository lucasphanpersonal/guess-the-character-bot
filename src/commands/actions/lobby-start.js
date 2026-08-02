const { MessageFlags } = require('discord.js');
const GameManager = require('../../game/GameManager');
const { startGameFromLobby } = require('../../game/engine');

module.exports = {
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby || lobby.status !== 'WAITING') {
      return interaction.reply({ content: 'No waiting lobby to start.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.user.id !== lobby.hostId) {
      return interaction.reply({
        content: 'Only the host who created the lobby can start the game.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Starting sends DMs and posts messages, which can exceed Discord's 3s acknowledgement
    // window -- defer first, then edit the reply once it's done.
    await interaction.deferReply();

    // Validation and character selection live in the engine so this command and the lobby
    // board's Start button behave identically.
    const result = await startGameFromLobby(interaction.client, lobby);
    if (!result.ok) {
      return interaction.editReply({ content: result.error });
    }
    return interaction.editReply('🎬 Starting the game! Check your DMs.');
  },
};
