const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const GameManager = require('../../game/GameManager');
const { refreshLobbyBoard } = require('../../game/lobbyBoard');

module.exports = {
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby) {
      return interaction.reply({ content: 'There is no lobby or game to leave.', flags: MessageFlags.Ephemeral });
    }

    // Leaving a game already under way is forfeiting it, and forfeiting is irreversible --
    // so it asks first, in the same shape as the judge's ✅. The confirmation is ephemeral,
    // so nobody else watches you hesitate.
    if (lobby.status === 'IN_PROGRESS' && lobby.game?.turnOrder.includes(interaction.user.id)) {
      if (!lobby.game.isActive(interaction.user.id)) {
        return interaction.reply({
          content: "You're already out of this game — you don't need to leave it twice.",
          flags: MessageFlags.Ephemeral,
        });
      }
      const still = lobby.game.activePlayers.length - 1;
      return interaction.reply({
        content:
          'Leave the game? You forfeit — no turn count, recorded as having given up, and there ' +
          'is no way back in.' +
          (still > 0
            ? ` The other ${still} player${still === 1 ? '' : 's'} carry on.`
            : ' Nobody else is still guessing, so this ends the game.'),
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`forfeit:${interaction.channelId}`)
              .setLabel('Leave the game')
              .setEmoji('🏳️')
              .setStyle(ButtonStyle.Danger)
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (lobby.status !== 'WAITING') {
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
