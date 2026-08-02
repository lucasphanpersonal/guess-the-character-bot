const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const GameManager = require('../../game/GameManager');
const { clearTimers } = require('../../game/engine');
const { refreshTurnBoard } = require('../../game/turnBoard');
const { clearVoteTimer } = require('../../game/audienceVote');
const { refreshLobbyBoard } = require('../../game/lobbyBoard');
const voice = require('../../game/voice');

module.exports = {
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby) {
      return interaction.reply({ content: 'No active lobby or game.', flags: MessageFlags.Ephemeral });
    }

    const isHost = interaction.user.id === lobby.hostId;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!isHost && !isAdmin) {
      return interaction.reply({ content: 'Only the host or a server admin can end this.', flags: MessageFlags.Ephemeral });
    }

    // An audience vote may be mid-flight with a pending auto-close timer.
    clearVoteTimer(lobby.vote);
    lobby.vote = null;

    if (lobby.game) {
      clearTimers(lobby.game);
      // Otherwise the cancelled turn's board keeps live-looking Guess/Pass buttons.
      await refreshTurnBoard(lobby.game, interaction.channelId, { cancelled: true });
      voice.leaveVoiceForGame(lobby.game);
    }
    // CANCELLED, not FINISHED: the lobby is deleted below, so the board must not offer
    // `/rematch` -- there would be nothing left for it to replay.
    lobby.status = 'CANCELLED';
    await refreshLobbyBoard(lobby);
    GameManager.endLobby(interaction.channelId);
    return interaction.reply('🛑 Lobby/game cancelled.');
  },
};
