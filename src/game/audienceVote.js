// Audience-vote mode: instead of the bot dealing characters, the audience votes on what
// each player will be wearing.
//
// SPOILER CONSTRAINT -- the single most important rule in this file:
// the candidates for a player's head are exactly what that player has to guess. So the
// PUBLIC vote board must never name a candidate; it shows only a tally and a countdown.
// The actual ballot is delivered ephemerally, per voter, and the players are refused it.
// Any change here should preserve that: `buildVoteBoardPayload` must stay name-free.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { getRandomCharacters } = require('../db/characterLists');
const { untrackBoard } = require('./boards');

// A slot per player, 1-indexed, so slot N maps to lobby.players[N-1].
function slotsFor(lobby) {
  return lobby.players.map((_, i) => String(i + 1));
}

// Discord allows five action rows per message and the ballot spends one on a select menu per
// player, so the ballot is PAGED: a roster that fits inside five rows gets no navigation at
// all, and past that the last row becomes Prev/Next and four players ride on each page.
//
// Paging beat the other candidate design -- a select to choose a player, then a select of
// that player's characters. Paging is the pattern the rest of the bot already uses
// (listBrowser, listFilter), it keeps casting a vote to a single click, and a player-chooser
// select would only move the ceiling from 5 to 25 rather than remove it. Paging has no
// ceiling: the only remaining limit on this mode is having enough distinct characters to
// draw, which drawCandidates already reports for itself.
const MAX_ACTION_ROWS = 5;
const PLAYERS_PER_BALLOT_PAGE = MAX_ACTION_ROWS - 1;

// The slots a voter flips through, one group per page.
function ballotPages(slots) {
  if (slots.length <= MAX_ACTION_ROWS) return [slots];
  const pages = [];
  for (let i = 0; i < slots.length; i += PLAYERS_PER_BALLOT_PAGE) {
    pages.push(slots.slice(i, i + PLAYERS_PER_BALLOT_PAGE));
  }
  return pages;
}

// An embed holds 25 fields and the clock and the ballot count take two of them, so a field
// per player stops rendering somewhere past twenty. Beyond that the tallies collapse into a
// few multi-line columns -- still one line per player, and still nobody named.
const MAX_TALLY_FIELDS = 23;
// Roughly 40 characters a line, against Discord's 1024-character field value.
const TALLY_LINES_PER_FIELD = 20;

// How much one press of the host's ⏱️ button buys. A vote that is still moving when the
// clock runs out used to have only one exit -- Close -- which decides it early rather than
// letting it finish.
const EXTEND_SECONDS = 30;

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
    // slot -> the settled winner. Written once, by resolveSlot; see the note there.
    this.resolvedBySlot = new Map();
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
   * The SHAPE of a slot's tally: how many votes, spread across how many candidates, and
   * the size of the current lead.
   *
   * Deliberately name-free, so it is safe on the public board where the player wearing the
   * character can read it. "Unanimous" and "split three ways" are the dramatic facts of a
   * vote, and none of them say WHO -- which is the whole reason the board could show
   * nothing before this.
   */
  shapeForSlot(slot) {
    const counts = new Map();
    for (const ballot of this.ballots.values()) {
      const pick = ballot[slot];
      if (pick) counts.set(pick, (counts.get(pick) ?? 0) + 1);
    }
    const votes = [...counts.values()].reduce((a, b) => a + b, 0);
    const distinct = counts.size;
    const top = distinct ? Math.max(...counts.values()) : 0;
    const leaders = [...counts.values()].filter((c) => c === top).length;
    return { votes, distinct, top, tied: distinct > 0 && leaders > 1 };
  }

  /** Human summary of shapeForSlot, still name-free. */
  describeSlot(slot) {
    const { votes, distinct, top, tied } = this.shapeForSlot(slot);
    if (!votes) return '_no votes yet_';
    if (distinct === 1) return `**${votes}** vote${votes === 1 ? '' : 's'} — unanimous so far`;
    const spread = `**${votes}** votes across ${distinct} characters`;
    return tied ? `${spread} — currently tied` : `${spread} — leader has ${top}`;
  }

  /**
   * Plurality winner for a slot. Ties are broken randomly, and an empty tally falls back to
   * a random candidate -- so a silent audience can never deadlock the game.
   *
   * Memoized, and that is load-bearing rather than an optimisation: the two random paths
   * above would otherwise return a DIFFERENT winner on every call, so the character dealt
   * to a player and the one named in the end-of-game vote summary could disagree.
   */
  resolveSlot(slot) {
    const cached = this.resolvedBySlot.get(slot);
    if (cached) return cached;

    const candidates = this.candidatesBySlot[slot];
    const counts = new Map();
    for (const ballot of this.ballots.values()) {
      const pick = ballot[slot];
      if (pick) counts.set(pick, (counts.get(pick) ?? 0) + 1);
    }

    let result;
    if (!counts.size) {
      result = { character: candidates[Math.floor(Math.random() * candidates.length)], votes: 0 };
    } else {
      const max = Math.max(...counts.values());
      const tied = [...counts.entries()].filter(([, c]) => c === max).map(([name]) => name);
      const winnerName = tied[Math.floor(Math.random() * tied.length)];
      result = { character: candidates.find((c) => c.name === winnerName), votes: max };
    }
    this.resolvedBySlot.set(slot, result);
    return result;
  }

  get slots() {
    return slotsFor(this.lobby);
  }

  /** @returns {characterRow[]} in players order. */
  resolve() {
    return this.slots.map((slot) => this.resolveSlot(slot).character);
  }

  /**
   * What the audience actually decided, kept for the end-of-game reveal.
   *
   * Named characters, so this can only ever be shown once both are public -- a coin-flip
   * tie or a silent audience is the most interesting thing that can happen in this mode,
   * and until now it was resolved and then silently thrown away.
   */
  summarise() {
    return this.slots.map((slot) => {
      const { votes, character } = this.resolveSlot(slot);
      const { distinct, tied } = this.shapeForSlot(slot);
      return {
        slot,
        playerId: this.playerIdForSlot(slot),
        name: character?.name ?? null,
        votes,
        distinct,
        // Both are "nobody really chose this", but for different reasons worth telling apart.
        tieBroken: tied,
        unopposed: votes > 0 && distinct === 1,
        noVotes: votes === 0,
        totalVoters: this.voterCount,
      };
    });
  }
}

// Draws players * voteOptions distinct characters and splits them into disjoint per-player
// sets -- disjoint because one character can only sit on one head.
function drawCandidates(lobby) {
  const perPlayer = lobby.voteOptions;
  const wanted = perPlayer * lobby.players.length;
  const drawn = getRandomCharacters(lobby.listIds, wanted, [], lobby.difficulty);
  if (drawn.length < wanted) return null;
  return Object.fromEntries(
    lobby.players.map((_, i) => [String(i + 1), drawn.slice(i * perPlayer, (i + 1) * perPlayer)])
  );
}

// The shape of each tally, never its contents -- a board that showed only a total had
// nothing to react to for the whole voting window. Name-free either way; see the top.
function tallyFields(vote) {
  const { slots } = vote;
  if (slots.length <= MAX_TALLY_FIELDS) {
    return slots.map((slot) => ({
      name: `Player ${slot}`,
      value: vote.describeSlot(slot),
      inline: true,
    }));
  }

  // Three inline fields read as three columns; a longer roster takes more only once a column
  // would outgrow the field-value limit.
  const columns = Math.max(3, Math.ceil(slots.length / TALLY_LINES_PER_FIELD));
  const perColumn = Math.ceil(slots.length / Math.min(columns, MAX_TALLY_FIELDS));
  const fields = [];
  for (let i = 0; i < slots.length; i += perColumn) {
    const chunk = slots.slice(i, i + perColumn);
    fields.push({
      name: `Players ${chunk[0]}–${chunk[chunk.length - 1]}`,
      value: chunk.map((slot) => `**${slot}.** ${vote.describeSlot(slot)}`).join('\n'),
      inline: true,
    });
  }
  return fields;
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
        : `The audience decides what ${lobby.players.map((id) => `<@${id}>`).join(', ')} are wearing.\n` +
          '**Players can\'t vote** (and won\'t be shown the options).'
    )
    .addFields(
      ...tallyFields(vote),
      {
        name: vote.closed ? 'Closed' : 'Closes',
        // A relative timestamp ticks down client-side, so no per-second edit loop is needed.
        value: vote.closed ? '—' : `<t:${Math.floor(vote.endsAt / 1000)}:R>`,
        inline: false,
      },
      { name: 'Ballots cast', value: `${vote.voterCount}`, inline: true }
    );

  if (vote.closed) return { embeds: [embed], components: [] };

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vote:open:${lobby.channelId}`)
      .setLabel('Vote')
      .setEmoji('🗳️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`vote:extend:${lobby.channelId}`)
      .setLabel(`+${EXTEND_SECONDS}s`)
      .setEmoji('⏱️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`vote:close:${lobby.channelId}`)
      .setLabel('Close voting')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

// EPHEMERAL ballot -- only ever sent to a single non-player voter.
// `justPicked` names the slot the voter just changed, so the reply confirms the swap rather
// than leaving them to infer that a second pick replaced the first instead of adding to it.
// It also decides which page comes back, so voting never scrolls you away from what you just
// did; `page` is what the Prev/Next buttons pass instead.
function buildBallotPayload(vote, voterId, { justPicked = null, page = null } = {}) {
  const ballot = vote.ballots.get(voterId) ?? {};
  const pages = ballotPages(vote.slots);
  const wanted = page ?? (justPicked ? pages.findIndex((p) => p.includes(justPicked)) : 0);
  const current = Math.min(Math.max(wanted, 0), pages.length - 1);
  const slots = pages[current];

  const rows = slots.map((slot) => {
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

  if (pages.length > 1) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`vote:page:${vote.lobby.channelId}:${current - 1}`)
          .setLabel('Prev')
          .setEmoji('◀')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(current <= 0),
        new ButtonBuilder()
          .setCustomId(`vote:page:${vote.lobby.channelId}:${current + 1}`)
          .setLabel('Next')
          .setEmoji('▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(current >= pages.length - 1)
      )
    );
  }

  const summary = slots.map((slot) => {
    const playerId = vote.playerIdForSlot(slot);
    return `Player ${slot} (<@${playerId}>): ${ballot[slot] ? `**${ballot[slot]}**` : '_no vote yet_'}`;
  }).join('\n');

  const confirmation = justPicked
    ? `✅ Saved — **${ballot[justPicked]}** for player ${justPicked}. That replaces your previous pick.\n`
    : '';

  // The summary above covers only the page you are looking at, so a running total is the
  // only way to tell whether there is still someone left to vote for further along.
  const picked = vote.slots.filter((slot) => ballot[slot]).length;
  const progress =
    pages.length > 1
      ? `-# Page ${current + 1} of ${pages.length} · **${picked}** of ${vote.slots.length} players picked\n`
      : '';

  return {
    content:
      `🗳️ **Your ballot** — pick a character for each player.\n${confirmation}${progress}${summary}\n` +
      '_You can change your picks until voting closes._',
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
  slotsFor,
  EXTEND_SECONDS,
  drawCandidates,
  buildVoteBoardPayload,
  buildBallotPayload,
  refreshVoteBoard,
  clearVoteTimer,
};
