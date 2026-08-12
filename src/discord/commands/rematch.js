const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const GameManager = require('../../core/game/GameManager');
const { createRematchLobby, rematchAnnouncement } = require('../game/rematch');
const { buildLobbyBoardPayload, attachLobbyBoard } = require('../game/lobbyBoard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rematch')
    .setDescription('Replay the last finished game in this channel with the same players'),
  async execute(interaction) {
    const previous = GameManager.getLobby(interaction.channelId);
    if (!previous || previous.status !== 'FINISHED') {
      return interaction.reply({
        content: 'No finished game in this channel to rematch.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const { lobby, players } = createRematchLobby(previous, interaction.user.id);
    // The rematch reply doubles as the new lobby board.
    const response = await interaction.reply({
      content: rematchAnnouncement(lobby, players),
      ...buildLobbyBoardPayload(lobby),
      withResponse: true,
    });
    await attachLobbyBoard(lobby, response, interaction);
    return undefined;
  },
};
