const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const GameManager = require('../game/GameManager');
const { createRematchLobby, rematchAnnouncement } = require('../game/rematch');
const { buildLobbyBoardPayload } = require('../game/lobbyBoard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rematch')
    .setDescription('Replay the last finished game in this channel with the same two players'),
  async execute(interaction) {
    const previous = GameManager.getLobby(interaction.channelId);
    if (!previous || previous.status !== 'FINISHED') {
      return interaction.reply({
        content: 'No finished game in this channel to rematch.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const { lobby, firstPlayer, secondPlayer } = createRematchLobby(previous, interaction.user.id);
    // The rematch reply doubles as the new lobby board.
    const response = await interaction.reply({
      content: rematchAnnouncement(lobby, firstPlayer, secondPlayer),
      ...buildLobbyBoardPayload(lobby),
      withResponse: true,
    });
    lobby.boardMessage = response?.resource?.message ?? (await interaction.fetchReply().catch(() => null));
    return undefined;
  },
};
