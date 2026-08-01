// Audience-vote mode: instead of the bot dealing characters, the audience votes on what
// each player will be wearing.
//
// SPOILER CONSTRAINT -- the single most important rule in this file:
// the candidates for a player's head are exactly what that player has to guess. So the
// PUBLIC vote board must never name a candidate; it shows only a tally and a countdown.
// The actual ballot is delivered ephemerally, per voter, and the two players are refused.
// Any change here should preserve that: `buildVoteBoardPayload` must stay name-free.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { getRandomCharacters } = require('../db/characterLists');
const { untrackBoard } = require('./boards');

const SLOTS = ['1', '2'];

class AudienceVote {
  constructor({ lobby, candidatesBySlot }) {
    this.lobby = lobby;
    // { '1': [characterRow, ...], '2': [...] } -- disjoint sets, slot N maps to players[N-1]
    this.candidatesBySlot = candidatesBySlot;
    /** @type {Map<string, {1?: string, 2?: string}>} voterId -> chosen character names */
    this.ballots = new Map();
    this.endsAt = Date.now() + lobby.voteSeconds * 1000;
    this.timer = null;
    this.boardMessage = null;
    this.closed = false;
  }

  playerIdForSlot(slot) {
    return this.lobby.players[Number(slot) - 1];
  }

  recordVote(voterId, slot, characterName) {
    const ballot = this.ballots.get(voterId) ?? {};
    ballot[slot] = characterName;
    this.ballots.set(voterId, ballot);
  }

  get voterCount() {
    return this.ballots.size;
  }

  /**
   * Plurality winner for a slot. Ties are broken randomly, and an empty tally falls back to
   * a random candidate -- so a silent audience can never deadlock the game.
   */
  resolveSlot(slot) {
    const candidates = this.candidatesBySlot[slot];
    const counts = new Map();
    for (const ballot of this.ballots.values()) {
      const pick = ballot[slot];
      if (pick) counts.set(pick, (counts.get(pick) ?? 0) + 1);
    }
    if (!counts.size) {
      return { character: candidates[Math.floor(Math.random() * candidates.length)], votes: 0 };
    }
    const max = Math.max(...counts.values());
    const tied = [...counts.entries()].filter(([, c]) => c === max).map(([name]) => name);
    const winnerName = tied[Math.floor(Math.random() * tied.length)];
    return { character: candidates.find((c) => c.name === winnerName), votes: max };
  }

  /** @returns {[characterRow, characterRow]} in players order. */
  resolve() {
    return SLOTS.map((slot) => this.resolveSlot(slot).character);
  }
}

// Draws 2 * voteOptions distinct characters and splits them into disjoint per-player sets.
function drawCandidates(lobby) {
  const wanted = lobby.voteOptions * 2;
  const drawn = getRandomCharacters(lobby.listIds, wanted);
  if (drawn.length < wanted) return null;
  return { 1: drawn.slice(0, lobby.voteOptions), 2: drawn.slice(lobby.voteOptions) };
}

// PUBLIC board. Deliberately contains no character names -- see the note at the top.
function buildVoteBoardPayload(vote) {
  const { lobby } = vote;
  const embed = new EmbedBuilder()
    .setTitle('🗳️ Audience vote')
    .setColor(vote.closed ? 0x4f545c : 0xeb459e)
    .setDescription(
      vote.closed
        ? 'Voting is closed — characters locked in!'
        : `The audience decides what <@${lobby.players[0]}> and <@${lobby.players[1]}> are wearing.\n` +
          '**Players can\'t vote** (and won\'t be shown the options).'
    )
    .addFields(
      { name: 'Votes cast', value: `${vote.voterCount}`, inline: true },
      {
        name: vote.closed ? 'Closed' : 'Closes',
        // A relative timestamp ticks down client-side, so no per-second edit loop is needed.
        value: vote.closed ? '—' : `<t:${Math.floor(vote.endsAt / 1000)}:R>`,
        inline: true,
      }
    );

  if (vote.closed) return { embeds: [embed], components: [] };

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vote:open:${lobby.channelId}`)
      .setLabel('Vote')
      .setEmoji('🗳️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`vote:close:${lobby.channelId}`)
      .setLabel('Close voting')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

// EPHEMERAL ballot -- only ever sent to a single non-player voter.
function buildBallotPayload(vote, voterId) {
  const ballot = vote.ballots.get(voterId) ?? {};
  const rows = SLOTS.map((slot) => {
    const playerId = vote.playerIdForSlot(slot);
    const chosen = ballot[slot];
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`vote:pick:${vote.lobby.channelId}:${slot}`)
        .setPlaceholder(`Character for player ${slot}`)
        .addOptions(
          vote.candidatesBySlot[slot].map((c) => ({
            label: c.name.slice(0, 100),
            value: c.name.slice(0, 100),
            default: c.name === chosen,
          }))
        )
    );
  });

  const summary = SLOTS.map((slot) => {
    const playerId = vote.playerIdForSlot(slot);
    return `Player ${slot} (<@${playerId}>): ${ballot[slot] ? `**${ballot[slot]}**` : '_no vote yet_'}`;
  }).join('\n');

  return {
    content: `🗳️ **Your ballot** — pick a character for each player.\n${summary}\n_You can change your picks until voting closes._`,
    components: rows,
  };
}

async function refreshVoteBoard(vote) {
  if (!vote.boardMessage) return;
  const payload = buildVoteBoardPayload(vote);
  try {
    await vote.boardMessage.edit(payload);
    // A closed vote board keeps no buttons, so a restart has nothing to retire on it.
    if (!payload.components.length) untrackBoard(vote.boardMessage);
  } catch (err) {
    console.warn('[audienceVote] Could not refresh the vote board:', err.message);
  }
}

function clearVoteTimer(vote) {
  if (vote?.timer) {
    clearTimeout(vote.timer);
    vote.timer = null;
  }
}

module.exports = {
  AudienceVote,
  SLOTS,
  drawCandidates,
  buildVoteBoardPayload,
  buildBallotPayload,
  refreshVoteBoard,
  clearVoteTimer,
};
