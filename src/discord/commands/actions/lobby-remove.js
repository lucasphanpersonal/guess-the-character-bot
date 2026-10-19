const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const GameManager = require('../../../core/game/GameManager');
// What removing means at each stage is the engine's (removePlayer): this is who may, and the words.
const { removePlayer } = require('../../game/engine');

module.exports = {
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby) {
      return interaction.reply({ content: 'No active lobby or game.', flags: MessageFlags.Ephemeral });
    }

    // The same people who may end the game: removing one player is the lighter remedy for the same
    // problem, somebody who has gone quiet.
    const isHost = interaction.user.id === lobby.hostId;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!isHost && !isAdmin) {
      return interaction.reply({ content: 'Only the host or a server admin can remove a player.', flags: MessageFlags.Ephemeral });
    }

    const target = interaction.options.getUser('player');
    if (!target) return interaction.reply({ content: 'Name the player to remove.', flags: MessageFlags.Ephemeral });
    // The lobby is the host's: without them nobody could start it, change it or rematch it.
    if (target.id === lobby.hostId) {
      return interaction.reply({
        content: "The host can't be removed. To stop playing, use `/lobby leave`; to stop the game, `/lobby end`.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Mid-game this reveals a character and can start the next turn: longer than Discord's 3s.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await removePlayer(interaction.client, lobby, target.id);
    if (!res.ok) return interaction.editReply({ content: res.error });

    // Mid-game the engine has already announced it in the channel, with the character they wore.
    if (lobby.status === 'IN_PROGRESS' || lobby.status === 'FINISHED') {
      return interaction.editReply({ content: `Removed <@${target.id}>.` });
    }
    const channel = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
    await channel
      ?.send(
        `🚪 The host removed <@${target.id}> from the lobby (${lobby.players.length} left in).` +
          (res.redealt ? ' The characters already dealt are cancelled — press Start to deal again.' : '')
      )
      .catch(() => {});
    return interaction.editReply({ content: `Removed <@${target.id}>.` });
  },
};
