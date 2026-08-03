const { MessageFlags } = require('discord.js');
const GameManager = require('../../game/GameManager');
const { refreshLobbyBoard } = require('../../game/lobbyBoard');

module.exports = {
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby || lobby.status !== 'WAITING') {
      return interaction.reply({ content: 'No lobby waiting for players right now. Create one with `/lobby create`.', flags: MessageFlags.Ephemeral });
    }
    // Already-joined is the only way this fails now: there is no lobby size limit.
    const result = lobby.addPlayer(interaction.user.id);
    if (!result.ok) {
      return interaction.reply({ content: "You're already in this lobby.", flags: MessageFlags.Ephemeral });
    }
    lobby.spectators.delete(interaction.user.id);
    await interaction.reply(`✅ <@${interaction.user.id}> joined the lobby (${lobby.players.length} in).`);
    await refreshLobbyBoard(lobby);
  },
};
