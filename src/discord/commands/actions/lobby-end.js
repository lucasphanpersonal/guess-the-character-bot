const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const GameManager = require('../../../core/game/GameManager');
const { clearTimers, recordAbandonedGame } = require('../../game/engine');
const { refreshTurnBoard } = require('../../game/turnBoard');
const { clearVoteTimer, refreshVoteBoard } = require('../../game/audienceVote');
const { cancelConfirmations } = require('../../game/characterDM');
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

    // An audience vote may be mid-flight with a pending auto-close timer. Closed, and its board
    // re-rendered, so the Vote button stops looking live.
    if (lobby.vote && !lobby.vote.closed) {
      clearVoteTimer(lobby.vote);
      lobby.vote.closed = true;
      lobby.vote.cancelled = true;
      await refreshVoteBoard(lobby.vote);
    }
    clearVoteTimer(lobby.vote);
    lobby.vote = null;

    // Ended while players were still checking their characters: their DMs carry Good to go and
    // Reroll buttons for a game that will never start.
    if (lobby.status === 'CONFIRMING' && lobby.game?.confirmState) {
      await cancelConfirmations(lobby.game, '🛑 The host ended this game before it began.');
    }

    // Whoever already got their character keeps that result. Cancelling is the remedy for one
    // player going quiet, and it should not cost everybody else the game they finished.
    // Recorded BEFORE the game is torn down, while the turn counts still exist.
    const recorded = recordAbandonedGame(lobby);

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

    if (!recorded) return interaction.reply('🛑 Lobby/game cancelled.');
    const finishers = recorded.filter((s) => s.turnsTaken !== null);
    return interaction.reply(
      `🛑 Game cancelled — but ${finishers.length} player${finishers.length === 1 ? '' : 's'} had ` +
        `already finished, so that result is kept:\n` +
        finishers.map((s) => `• <@${s.playerId}> — ${s.turnsTaken} turn${s.turnsTaken === 1 ? '' : 's'}`).join('\n')
    );
  },
};
