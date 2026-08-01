// Handlers for the audience vote (customId `vote:<action>:<channelId>[:<slot>]`).
//
// The public board never names a candidate; names only ever reach a voter through the
// ephemeral ballot built here, and only after we've confirmed they aren't playing.

const { MessageFlags } = require('discord.js');
const GameManager = require('../game/GameManager');
const engine = require('../game/engine');
const { buildBallotPayload, refreshVoteBoard } = require('../game/audienceVote');

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

async function handle(interaction) {
  const [, action, channelId, slot] = interaction.customId.split(':');
  const lobby = GameManager.getLobby(channelId);
  const vote = lobby?.vote;

  if (!lobby || !vote || vote.closed || lobby.status !== 'VOTING') {
    return interaction.reply(ephemeral('That vote is no longer open.'));
  }

  if (action === 'close') {
    if (interaction.user.id !== lobby.hostId) {
      return interaction.reply(ephemeral(`Only the host (<@${lobby.hostId}>) can close the vote.`));
    }
    // Closing tallies, posts, and starts the game (DMs) -- well past the 3s window.
    await interaction.deferUpdate();
    await engine.closeAudienceVote(interaction.client, lobby, { reason: 'host' }).catch((err) => {
      console.error(err);
    });
    return undefined;
  }

  // THE spoiler guard: a player must never see their own candidate list.
  if (lobby.players.includes(interaction.user.id)) {
    return interaction.reply(
      ephemeral("You're playing this round — you can't vote, and you don't get to see the options!")
    );
  }

  if (action === 'open') {
    return interaction.reply({ ...buildBallotPayload(vote, interaction.user.id), flags: MessageFlags.Ephemeral });
  }

  if (action === 'pick') {
    const choice = interaction.values?.[0];
    if (!choice) return interaction.reply(ephemeral('No option selected.'));
    // Ignore anything not actually on this slot's ballot.
    if (!vote.candidatesBySlot[slot]?.some((c) => c.name === choice)) {
      return interaction.reply(ephemeral('That option is not on the ballot.'));
    }

    vote.recordVote(interaction.user.id, slot, choice);
    // Update the voter's own ephemeral ballot, then the public tally.
    await interaction.update(buildBallotPayload(vote, interaction.user.id));
    await refreshVoteBoard(vote);
    return undefined;
  }

  return interaction.reply(ephemeral('Unknown vote action.'));
}

module.exports = { handle };
