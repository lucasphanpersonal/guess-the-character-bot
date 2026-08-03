const { MessageFlags } = require('discord.js');
const GameManager = require('../../game/GameManager');
const { refreshLobbyBoard } = require('../../game/lobbyBoard');

module.exports = {
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby || lobby.status !== 'WAITING') {
      return interaction.reply({ content: 'There is no waiting lobby to leave.', flags: MessageFlags.Ephemeral });
    }
    const wasHost = interaction.user.id === lobby.hostId;
    const removed = lobby.removePlayer(interaction.user.id);
    if (!removed && !wasHost) {
      return interaction.reply({ content: "You're not in the lobby.", flags: MessageFlags.Ephemeral });
    }
    if (wasHost) {
      // Retire the board before dropping the lobby -- otherwise it keeps its Join / Start
      // buttons in the channel, pointing at a lobby that no longer exists.
      lobby.status = 'CANCELLED';
      await refreshLobbyBoard(lobby);
      GameManager.endLobby(interaction.channelId);
      return interaction.reply('Host left, so the lobby has been cancelled.');
    }
    await interaction.reply(`<@${interaction.user.id}> left the lobby (${lobby.players.length} left in).`);
    return refreshLobbyBoard(lobby);
  },
};
