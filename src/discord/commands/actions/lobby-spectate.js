const { MessageFlags } = require('discord.js');
const GameManager = require('../../../core/game/GameManager');
const { sendSpectatorDM } = require('../../game/engine');
const { refreshLobbyBoard } = require('../../game/lobbyBoard');

module.exports = {
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby) {
      return interaction.reply({ content: 'No active lobby or game right now.', flags: MessageFlags.Ephemeral });
    }
    if (lobby.status === 'FINISHED') {
      return interaction.reply({
        content: 'That game already finished. Wait for a `/rematch` or a new `/lobby create`, then spectate.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (lobby.players.includes(interaction.user.id)) {
      return interaction.reply({ content: "You're a player in this game, not a spectator!", flags: MessageFlags.Ephemeral });
    }
    lobby.spectators.add(interaction.user.id);
    await refreshLobbyBoard(lobby);

    // Mid-game, there is no opening sweep left to catch them, so the DM goes out now.
    if (lobby.status === 'IN_PROGRESS' && lobby.game) {
      const sent = await sendSpectatorDM(interaction.client, lobby, interaction.user.id);
      return interaction.reply({
        content: sent
          ? `Sent you all ${lobby.game.turnOrder.length} characters via DM!`
          : "You're spectating, but I couldn't DM you -- check your privacy settings.",
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: "You're now spectating -- you'll get a DM with every character once the game starts.",
      flags: MessageFlags.Ephemeral,
    });
  },
};
