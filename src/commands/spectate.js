const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const GameManager = require('../game/GameManager');
const { characterMessage } = require('../game/engine');
const { refreshLobbyBoard } = require('../game/lobbyBoard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('spectate')
    .setDescription("Opt in to DMs revealing both players' characters"),
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby) {
      return interaction.reply({ content: 'No active lobby or game right now.', flags: MessageFlags.Ephemeral });
    }
    if (lobby.status === 'FINISHED') {
      return interaction.reply({
        content: 'That game already finished. Wait for a `/rematch` or a new `/create-lobby`, then spectate.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (lobby.players.includes(interaction.user.id)) {
      return interaction.reply({ content: "You're a player in this game, not a spectator!", flags: MessageFlags.Ephemeral });
    }
    lobby.spectators.add(interaction.user.id);
    await refreshLobbyBoard(lobby);

    if (lobby.status === 'IN_PROGRESS' && lobby.game) {
      const game = lobby.game;
      const [p1Id, p2Id] = game.turnOrder;
      try {
        const [p1, p2] = await Promise.all([
          interaction.client.users.fetch(p1Id),
          interaction.client.users.fetch(p2Id),
        ]);
        await interaction.user.send(
          characterMessage('🕵️ Spectator info:', [
            { label: `${p1.username}'s head`, ...game.headByPlayer[p1Id] },
            { label: `${p2.username}'s head`, ...game.headByPlayer[p2Id] },
          ])
        );
      } catch {
        return interaction.reply({ content: "You're spectating, but I couldn't DM you -- check your privacy settings.", flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: 'Sent you both characters via DM!', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({ content: "You're now spectating -- you'll get a DM with both characters once the game starts.", flags: MessageFlags.Ephemeral });
  },
};
