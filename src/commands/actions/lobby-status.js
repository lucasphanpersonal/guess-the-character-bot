const { MessageFlags } = require('discord.js');
const GameManager = require('../../game/GameManager');

module.exports = {
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby) {
      return interaction.reply({ content: 'No active lobby or game.', flags: MessageFlags.Ephemeral });
    }

    if (lobby.status === 'FINISHED') {
      return interaction.reply({
        content: 'Last game in this channel finished. `/rematch` to play again with the same players, or `/lobby create` to start something new.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (lobby.status === 'WAITING') {
      return interaction.reply({
        content: `Lobby waiting for players (${lobby.players.length}/2): ${
          lobby.players.map((id) => `<@${id}>`).join(', ') || 'none yet'
        }`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (lobby.status === 'VOTING') {
      const vote = lobby.vote;
      return interaction.reply({
        content: vote
          ? `🗳️ Audience vote in progress — **${vote.voterCount}** ballot${vote.voterCount === 1 ? '' : 's'} so far, closes <t:${Math.floor(vote.endsAt / 1000)}:R>.`
          : 'Audience vote in progress.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (lobby.status === 'CONFIRMING') {
      const waitingOn = lobby.game.turnOrder.filter((id) => !lobby.game.confirmState[id].confirmed);
      return interaction.reply({
        content: waitingOn.length
          ? `Waiting on ${waitingOn.map((id) => `<@${id}>`).join(' and ')} to confirm their character (check DMs).`
          : 'Finalizing...',
        flags: MessageFlags.Ephemeral,
      });
    }

    const game = lobby.game;
    const label = `Turn ${game.turnsFor(game.currentPlayerId)}`;
    // Everyone plays until they get theirs, so who's already out is half the state.
    const done = game.turnOrder
      .filter((id) => game.finishedBy.has(id))
      .map((id) => `<@${id}> (turn ${game.finishedBy.get(id)})`);
    const doneLine = done.length ? `\nAlready done: ${done.join(', ')}.` : '';

    if (game.paused) {
      return interaction.reply({
        content: `${label} -- time's up for <@${game.currentPlayerId}>, waiting on a final ruling or a pass.${doneLine}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    const remainingS = Math.ceil((game.timer?.remainingMs() ?? 0) / 1000);
    return interaction.reply({
      content: `${label} -- it's <@${game.currentPlayerId}>'s turn, ~${remainingS}s left.${doneLine}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
