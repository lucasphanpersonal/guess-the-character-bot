const { MessageFlags } = require('discord.js');
const GameManager = require('../../../core/game/GameManager');
const { refreshLobbyBoard } = require('../../game/lobbyBoard');

module.exports = {
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby || lobby.status !== 'WAITING') {
      return interaction.reply({ content: 'No lobby waiting for players right now. Create one with `/lobby create`.', flags: MessageFlags.Ephemeral });
    }
    const result = lobby.addPlayer(interaction.user.id);
    if (!result.ok) {
      const content =
        result.reason === 'full'
          ? 'This lobby is full (8 players). You can spectate instead.'
          : "You're already in this lobby.";
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    lobby.spectators.delete(interaction.user.id);
    await interaction.reply(`✅ <@${interaction.user.id}> joined the lobby (${lobby.players.length} in).`);
    await refreshLobbyBoard(lobby);
  },
};
