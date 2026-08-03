// Handlers for the audience vote (customId `vote:<action>:<channelId>[:<slot|page>]`).
//
// The public board never names a candidate; names only ever reach a voter through the
// ephemeral ballot built here, and only after we've confirmed they aren't playing.

const { MessageFlags } = require('discord.js');
const GameManager = require('../game/GameManager');
const engine = require('../game/engine');
const {
  buildBallotPayload,
  buildVoteBoardPayload,
  refreshVoteBoard,
  clearVoteTimer,
  EXTEND_SECONDS,
} = require('../game/audienceVote');

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

async function handle(interaction) {
  // The last segment is a slot for `pick` and a page number for `page`.
  const [, action, channelId, arg] = interaction.customId.split(':');
  const slot = arg;
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

  if (action === 'extend') {
    if (interaction.user.id !== lobby.hostId) {
      return interaction.reply(ephemeral(`Only the host (<@${lobby.hostId}>) can extend the vote.`));
    }
    // Push the deadline back and re-arm the timer against the NEW deadline, so repeated
    // presses accumulate instead of each one resetting a fixed window.
    vote.endsAt += EXTEND_SECONDS * 1000;
    clearVoteTimer(vote);
    vote.timer = setTimeout(() => {
      engine.closeAudienceVote(interaction.client, lobby, { reason: 'timer' }).catch(console.error);
    }, Math.max(0, vote.endsAt - Date.now()));

    await interaction.update(buildVoteBoardPayload(vote));
    return interaction.followUp(ephemeral(`⏱️ Voting extended by ${EXTEND_SECONDS} seconds.`));
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

  if (action === 'page') {
    // Purely a change of view: nothing is recorded, so the public board has nothing to say.
    return interaction.update(buildBallotPayload(vote, interaction.user.id, { page: Number(arg) || 0 }));
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
    await interaction.update(buildBallotPayload(vote, interaction.user.id, { justPicked: slot }));
    await refreshVoteBoard(vote);
    return undefined;
  }

  return interaction.reply(ephemeral('Unknown vote action.'));
}

module.exports = { handle };
