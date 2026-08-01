const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const GameManager = require('../game/GameManager');
const { refreshLobbyBoard } = require('../game/lobbyBoard');

module.exports = {
  data: new SlashCommandBuilder().setName('join-lobby').setDescription('Join the active lobby as a player'),
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby || lobby.status !== 'WAITING') {
      return interaction.reply({ content: 'No lobby waiting for players right now. Create one with `/create-lobby`.', flags: MessageFlags.Ephemeral });
    }
    const result = lobby.addPlayer(interaction.user.id);
    if (!result.ok) {
      const msg =
        result.reason === 'already-joined'
          ? "You're already in this lobby."
          : 'The lobby already has 2 players. Use `/spectate` to follow along instead.';
      return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
    lobby.spectators.delete(interaction.user.id);
    await interaction.reply(`✅ <@${interaction.user.id}> joined the lobby (${lobby.players.length}/2).`);
    await refreshLobbyBoard(lobby);
  },
};
