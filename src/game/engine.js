const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const Game = require('./Game');
const TurnTimer = require('./turnTimer');
const GameManager = require('./GameManager');
const voice = require('./voice');
const {
  getRandomCharacterExcluding,
  getRandomPair,
  getListLabelForIds,
  recordReroll,
  setListsEnabled,
  getListsByIds,
  REROLL_DEMOTE_THRESHOLD,
} = require('../db/characterLists');
const { recordResult } = require('../db/stats');
const { refreshLobbyBoard } = require('./lobbyBoard');
const { buildTurnBoardPayload, refreshTurnBoard } = require('./turnBoard');
const { trackBoard, untrackBoard } = require('./boards');
const {
  AudienceVote,
  drawCandidates,
  buildVoteBoardPayload,
  refreshVoteBoard,
  clearVoteTimer,
} = require('./audienceVote');

async function getChannel(client, lobby) {
  return client.channels.fetch(lobby.channelId);
}

async function displayName(client, userId) {
  const user = await client.users.fetch(userId);
  return user.username;
}

// Remaining-time checkpoints (in seconds) for the in-turn countdown, spread across the
// whole turn by repeated halving -- naturally spaced far apart early on and tight together
// right before time runs out, for any turn length from 15s to 600s.
function countdownCheckpoints(turnSeconds) {
  const checkpoints = [];
  let remaining = turnSeconds;
  // Halving an integer above 1 always lands on 1 or more, so the loop condition is the only
  // guard needed -- the last checkpoint pushed is 1, and that's where it stops.
  while (remaining > 1) {
    remaining = Math.round(remaining / 2);
    checkpoints.push(remaining);
  }
  return checkpoints;
}

// Only clears pending timers -- the turn board message is deliberately left alone so the
// caller can render a final state on it before the next turn replaces it.
function clearTimers(game) {
  game.timer?.clear();
  for (const handle of game.countdownHandles) clearTimeout(handle);
  game.countdownHandles = [];
}

function scheduleCountdown(lobby) {
  const game = lobby.game;
  for (const remainingS of countdownCheckpoints(game.turnSeconds)) {
    const elapsedMs = (game.turnSeconds - remainingS) * 1000;
    const handle = setTimeout(() => {
      // `paused` means the turn already ran out of time (possibly because the machine slept
      // through the rest of it -- see timerWatchdog.js), so the remaining checkpoints have
      // nothing left to count down and would just re-render the same board in a burst.
      if (game.finished || game.paused) return;
      voice.playChime(game);
      // The board renders its own remaining time, so a refresh is all that's needed.
      refreshTurnBoard(game, lobby.channelId).catch((err) => console.error(err));
    }, elapsedMs);
    game.countdownHandles.push(handle);
  }
}

// A character's name plus the work it comes from, on its own line so the name stays the
// thing your eye lands on. Omitted entirely when the source is unknown or would just
// restate the name.
function withSource(line, source) {
  return source ? `${line}\n*from ${source}*` : line;
}

// description: the text shown above the embed(s), e.g. who this character belongs to.
// characters: array of { label, name, imageUrl, source } -- one embed per character.
function characterMessage(description, characters) {
  const embeds = characters.map(({ label, name, imageUrl, source }) => {
    const embed = new EmbedBuilder().setDescription(withSource(`**${label}**: **${name}**`, source));
    if (imageUrl) embed.setImage(imageUrl);
    return embed;
  });
  return { content: description, embeds };
}

function buildConfirmRow(channelId, rerollsLeft, { allowReroll = true, canDropList = false } = {}) {
  const unlimited = rerollsLeft === -1;
  const confirmBtn = new ButtonBuilder()
    .setCustomId(`confirm:${channelId}`)
    .setLabel(allowReroll ? 'Good to go' : 'Ready')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success);
  // In audience-vote mode the crowd already decided, so the reroll button is omitted
  // entirely rather than shown disabled (which would read as a bug).
  if (!allowReroll) return new ActionRowBuilder().addComponents(confirmBtn);

  const rerollBtn = new ButtonBuilder()
    .setCustomId(`reroll:${channelId}`)
    .setLabel(unlimited ? 'Reroll' : rerollsLeft > 0 ? `Reroll (${rerollsLeft} left)` : 'No rerolls left')
    .setEmoji('🔁')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!unlimited && rerollsLeft <= 0);

  const row = new ActionRowBuilder().addComponents(confirmBtn, rerollBtn);
  // The moment somebody is staring at a character they don't recognise is the only moment
  // they will ever want to curate, so the curation lives here rather than in a command they
  // would have to remember twenty minutes later.
  if (canDropList) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`droplist:${channelId}`)
        .setLabel('Never deal this show')
        .setEmoji('🚫')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!unlimited && rerollsLeft <= 0)
    );
  }
  return row;
}

function confirmCharacterEmbed(character) {
  const embed = new EmbedBuilder().setDescription(withSource(`**${character.name}**`, character.source));
  if (character.imageUrl) embed.setImage(character.imageUrl);
  return embed;
}

function confirmPrompt(listLabel) {
  return (
    `🗂️ Playing with: **${listLabel}**\n\n` +
    "You can't see your own character! Use this to answer their questions. Not confident you " +
    '(or they) know this one? You can reroll it instead.'
  );
}

function votedPrompt(listLabel) {
  return (
    `🗂️ Playing with: **${listLabel}**\n\n` +
    "🗳️ The audience picked this one. You can't see your own character! Use this to answer " +
    "their questions, then hit **Ready**."
  );
}

// recipientUser gets DM'd about subjectPlayerId's character (the one recipientUser needs to
// know to answer questions about). Returns false if the DM couldn't be sent at all.
async function sendConfirmDM(recipientUser, subjectPlayerId, game, channelId) {
  const state = game.confirmState[recipientUser.id];
  const character = game.headByPlayer[subjectPlayerId];
  try {
    const dm = await recipientUser.send({
      content: game.rerollAllowed ? confirmPrompt(game.listLabel) : votedPrompt(game.listLabel),
      embeds: [confirmCharacterEmbed(character)],
      components: [
        buildConfirmRow(channelId, state.rerollsLeft, {
          allowReroll: game.rerollAllowed,
          // Only offerable when we know which list the character came from, which rules
          // out hand-assigned characters from /set-characters.
          canDropList: game.rerollAllowed && character.listId != null,
        }),
      ],
    });
    trackBoard('confirm', dm);
    return true;
  } catch {
    return false;
  }
}

async function sendSpectatorDMs(client, lobby) {
  const game = lobby.game;
  const [p1Id, p2Id] = game.turnOrder;
  const [p1, p2] = await Promise.all([client.users.fetch(p1Id), client.users.fetch(p2Id)]);

  const spectatorIds = new Set(lobby.spectators);
  try {
    const guild = await client.guilds.fetch(lobby.guildId);
    const member1 = await guild.members.fetch(p1Id).catch(() => null);
    const voiceChannel = member1?.voice?.channel;
    if (voiceChannel) {
      for (const [, member] of voiceChannel.members) {
        if (member.id !== p1Id && member.id !== p2Id) spectatorIds.add(member.id);
      }
    }
  } catch {
    // best-effort voice detection only
  }

  for (const specId of spectatorIds) {
    try {
      const specUser = await client.users.fetch(specId);
      await specUser.send(
        characterMessage(`🗂️ Playing with: **${game.listLabel}**\nSpectator info for the game in <#${lobby.channelId}>:`, [
          { label: `${p1.username}'s head`, ...game.headByPlayer[p1Id] },
          { label: `${p2.username}'s head`, ...game.headByPlayer[p2Id] },
        ])
      );
    } catch {
      // DMs closed, skip silently
    }
  }
}

// Kicks off the audience-vote phase instead of dealing characters directly. The vote board
// is public but names no candidates -- see the spoiler note in audienceVote.js.
async function startAudienceVote(client, lobby) {
  const candidatesBySlot = drawCandidates(lobby);
  if (!candidatesBySlot) {
    return {
      ok: false,
      error:
        `Audience vote needs ${lobby.voteOptions * 2} distinct characters ` +
        `(${lobby.voteOptions} per player) but this list selection has fewer.`,
    };
  }

  const vote = new AudienceVote({ lobby, candidatesBySlot });
  lobby.vote = vote;
  lobby.status = 'VOTING';
  await refreshLobbyBoard(lobby);

  const channel = await getChannel(client, lobby);
  vote.boardMessage = await channel.send(buildVoteBoardPayload(vote));
  trackBoard('vote', vote.boardMessage);
  vote.timer = setTimeout(() => {
    closeAudienceVote(client, lobby, { reason: 'timer' }).catch(console.error);
  }, lobby.voteSeconds * 1000);

  return { ok: true };
}

// Tallies the ballots and hands the winning characters to the normal game pipeline.
// Idempotent: a timer firing after the host already closed voting is a no-op.
async function closeAudienceVote(client, lobby, { reason } = {}) {
  const vote = lobby.vote;
  if (!vote || vote.closed) return { ok: false, error: 'Voting is already closed.' };

  vote.closed = true;
  clearVoteTimer(vote);
  const characters = vote.resolve();
  // Kept for the reveal. A coin-flip tie or a silent audience is the most interesting thing
  // this mode produces and it was previously resolved and thrown away -- but it names
  // characters, so it can only be shown once both are public.
  const voteSummary = vote.summarise();

  await refreshVoteBoard(vote);
  const channel = await getChannel(client, lobby);
  // Reports the turnout only -- naming the winners here would spoil both players.
  await channel.send(
    `🗳️ Voting ${reason === 'timer' ? 'closed' : 'closed early'} with **${vote.voterCount}** ` +
      `ballot${vote.voterCount === 1 ? '' : 's'} cast. The audience has spoken!`
  );

  lobby.vote = null;
  await startGame(client, lobby, characters);
  lobby.game.voteSummary = voteSummary;
  return { ok: true };
}

// Shared entry point for both `/start-game` and the lobby board's Start button, so the
// validation and character-selection rules can't drift between the two.
async function startGameFromLobby(client, lobby) {
  if (lobby.players.length !== 2) {
    return { ok: false, error: `Need exactly 2 players -- currently ${lobby.players.length}/2.` };
  }

  if (lobby.mode === 'audience-vote') {
    return startAudienceVote(client, lobby);
  }

  const [p1Id, p2Id] = lobby.players;
  const assigned = lobby.assignedCharacters;
  let characters;
  if (assigned?.[p1Id] && assigned?.[p2Id]) {
    characters = [assigned[p1Id], assigned[p2Id]];
  } else {
    characters = getRandomPair(lobby.listIds, lobby.difficulty);
    if (characters.length < 2) {
      return { ok: false, error: 'The character list no longer has enough characters.' };
    }
  }

  await startGame(client, lobby, characters);
  return { ok: true };
}

async function startGame(client, lobby, characters) {
  const game = new Game({ lobby, characters, turnSeconds: lobby.turnSeconds });
  game.listLabel = getListLabelForIds(lobby.listIds);
  // The audience already chose in vote mode, so rerolling would undo their decision.
  game.rerollAllowed = lobby.mode !== 'audience-vote';
  lobby.game = game;
  lobby.status = 'CONFIRMING';
  await refreshLobbyBoard(lobby);

  const [p1Id, p2Id] = game.turnOrder;
  const [p1, p2] = await Promise.all([client.users.fetch(p1Id), client.users.fetch(p2Id)]);
  const channel = await getChannel(client, lobby);

  game.confirmState = {
    [p1Id]: { confirmed: false, rerollsLeft: lobby.maxRerolls, rejectedNames: new Set() },
    [p2Id]: { confirmed: false, rerollsLeft: lobby.maxRerolls, rejectedNames: new Set() },
  };

  const dmFailures = [];
  if (!(await sendConfirmDM(p1, p2Id, game, lobby.channelId))) {
    dmFailures.push(p1.username);
    game.confirmState[p1Id].confirmed = true;
  }
  if (!(await sendConfirmDM(p2, p1Id, game, lobby.channelId))) {
    dmFailures.push(p2.username);
    game.confirmState[p2Id].confirmed = true;
  }

  if (dmFailures.length) {
    await channel.send(
      `⚠️ Couldn't DM: ${dmFailures.join(', ')}. They need to enable DMs from server members to play.`
    );
  }

  await channel.send(
    '🔍 Both players are reviewing their assigned characters (check your DMs) -- the game starts once they confirm.'
  );

  await maybeBeginPlay(client, lobby);
}

async function maybeBeginPlay(client, lobby) {
  const game = lobby.game;
  if (!game.turnOrder.every((id) => game.confirmState[id].confirmed)) return;

  lobby.status = 'IN_PROGRESS';
  await refreshLobbyBoard(lobby);
  await sendSpectatorDMs(client, lobby);
  await voice.joinVoiceForGame(client, lobby);
  const channel = await getChannel(client, lobby);
  await channel.send(`✅ Both players are ready -- starting the game! 🗂️ Playing with: **${game.listLabel}**`);
  await startTurn(client, lobby);
}

async function handleConfirmationButton(interaction) {
  const [action, channelId] = interaction.customId.split(':');
  const lobby = GameManager.getLobby(channelId);
  const game = lobby?.game;
  if (!lobby || !game || lobby.status !== 'CONFIRMING' || !game.confirmState) {
    return interaction.reply({ content: 'This confirmation has expired.', flags: MessageFlags.Ephemeral });
  }

  const playerId = interaction.user.id;
  const state = game.confirmState[playerId];
  if (!state) {
    return interaction.reply({ content: "This isn't your confirmation to respond to.", flags: MessageFlags.Ephemeral });
  }

  if (action === 'confirm') {
    if (state.confirmed) return interaction.deferUpdate();
    state.confirmed = true;
    await interaction.update({
      content: '✅ Locked in! Waiting on the other player...',
      embeds: interaction.message.embeds,
      components: [],
    });
    untrackBoard(interaction.message);
    return maybeBeginPlay(interaction.client, lobby);
  }

  // "Never deal this show again": drop the list from the server's selection, then reroll,
  // because whoever pressed it does not want this character either. One button doing both
  // is the point -- the alternative is rerolling now and remembering to curate later,
  // which nobody does.
  if (action === 'droplist') {
    if (!game.rerollAllowed) {
      return interaction.reply({
        content: "The audience picked this character — it can't be rerolled.",
        flags: MessageFlags.Ephemeral,
      });
    }
    const unlimited = state.rerollsLeft === -1;
    if (!unlimited && state.rerollsLeft <= 0) {
      return interaction.reply({ content: "You're out of rerolls.", flags: MessageFlags.Ephemeral });
    }

    const otherPlayerId = game.turnOrder.find((id) => id !== playerId);
    const rejected = game.headByPlayer[otherPlayerId];
    const [list] = rejected.listId ? getListsByIds([rejected.listId]) : [];
    if (!list) {
      return interaction.reply({
        content: "Couldn't tell which list this character came from, so there's nothing to drop.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Drawn from the lobby's own lists minus this one, so the replacement can't come from
    // the show that was just rejected.
    const remaining = lobby.listIds.filter((id) => id !== list.id);
    const excludeNames = new Set([rejected.name, game.headByPlayer[playerId].name, ...state.rejectedNames]);
    const replacement = remaining.length
      ? getRandomCharacterExcluding(remaining, excludeNames, lobby.difficulty)
      : null;
    if (!replacement) {
      return interaction.reply({
        content:
          `Dropping **${list.name}** would leave nothing else to deal from in this lobby, so ` +
          'nothing was changed. Reroll instead, or add more lists with `/list-filter`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    setListsEnabled([list.id], false);
    recordReroll(rejected.id, playerId);
    state.rejectedNames.add(rejected.name);
    if (!unlimited) state.rerollsLeft -= 1;
    game.headByPlayer[otherPlayerId] = Game.head(lobby, replacement);
    // The lobby's own pool is left alone mid-game: pulling the list out from under a game
    // in progress would change what the other player can be dealt on their next reroll for
    // no benefit. The server-wide switch-off is what was asked for, and it takes effect
    // from the next lobby.

    await interaction.update({
      content: confirmPrompt(game.listLabel),
      embeds: [confirmCharacterEmbed(game.headByPlayer[otherPlayerId])],
      components: [
        buildConfirmRow(channelId, state.rerollsLeft, {
          canDropList: game.headByPlayer[otherPlayerId].listId != null,
        }),
      ],
    });
    return interaction.followUp({
      content:
        `🚫 **${list.name}** is out of the pool for future games. ` +
        'Undo any time with `/list-toggle`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'reroll') {
    if (!game.rerollAllowed) {
      return interaction.reply({
        content: "The audience picked this character — it can't be rerolled.",
        flags: MessageFlags.Ephemeral,
      });
    }
    const unlimited = state.rerollsLeft === -1;
    if (!unlimited && state.rerollsLeft <= 0) {
      return interaction.reply({ content: "You're out of rerolls.", flags: MessageFlags.Ephemeral });
    }
    const otherPlayerId = game.turnOrder.find((id) => id !== playerId);
    const currentName = game.headByPlayer[otherPlayerId].name;
    const excludeNames = new Set([currentName, game.headByPlayer[playerId].name, ...state.rejectedNames]);
    const replacement = getRandomCharacterExcluding(lobby.listIds, excludeNames, lobby.difficulty);
    if (!replacement) {
      return interaction.reply({ content: 'No other characters available in this list to reroll to.', flags: MessageFlags.Ephemeral });
    }

    // Recorded before the swap, while we still know what was rejected. Enough different
    // people rejecting the same character retires it from random draws for good.
    const rejected = game.headByPlayer[otherPlayerId];
    const rejectedBy = recordReroll(rejected.id, playerId);

    state.rejectedNames.add(currentName);
    if (!unlimited) state.rerollsLeft -= 1;
    game.headByPlayer[otherPlayerId] = Game.head(lobby, replacement);

    await interaction.update({
      content: confirmPrompt(game.listLabel),
      embeds: [confirmCharacterEmbed(game.headByPlayer[otherPlayerId])],
      components: [
        buildConfirmRow(channelId, state.rerollsLeft, {
          canDropList: game.headByPlayer[otherPlayerId].listId != null,
        }),
      ],
    });

    // Told only at the moment it takes effect, so the feature explains itself once rather
    // than needing documentation nobody reads.
    if (rejectedBy >= REROLL_DEMOTE_THRESHOLD) {
      return interaction.followUp({
        content:
          `🚮 **${rejected.name}** has now been rerolled by ${rejectedBy} different people, ` +
          'so the bot will stop dealing them.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return undefined;
  }
}

async function startTurn(client, lobby) {
  const game = lobby.game;
  const channel = await getChannel(client, lobby);

  // Fresh board and a clean guess tally for the new turn.
  game.turnGuesses = [];
  game.timer = new TurnTimer(game.turnSeconds * 1000, () => {
    handleTimeout(client, lobby).catch(console.error);
  });
  game.timer.start();

  game.turnBoardMessage = await channel.send(buildTurnBoardPayload(game, lobby.channelId));
  trackBoard('turn', game.turnBoardMessage);
  scheduleCountdown(lobby);
}

async function handleTimeout(client, lobby) {
  const game = lobby.game;
  if (!game || game.finished) return;
  game.paused = true;
  // The board itself switches to the amber "last chance" state -- no extra message needed.
  await refreshTurnBoard(game, lobby.channelId);
}

// Shared by /guess, the turn board's Guess button (via its modal), and any future entry
// point. Presentation-free: it records the guess on the turn board and advances the game,
// and leaves it to the caller to acknowledge the interaction.
async function submitGuess(client, lobby, playerId, guessText) {
  const game = lobby.game;
  if (!game || game.finished || lobby.status !== 'IN_PROGRESS') {
    return { ok: false, error: 'No game in progress.' };
  }
  if (playerId !== game.currentPlayerId) {
    return { ok: false, error: "It's not your turn." };
  }
  const text = (guessText || '').trim();
  if (!text) {
    return { ok: false, error: 'Enter a character name to guess.' };
  }

  const correct = game.checkGuess(playerId, text);
  game.recordGuess(playerId, { text, correct });

  if (correct) {
    voice.playCorrectSound(game);
    await endTurn(client, lobby, { correct: true });
    return { ok: true, correct: true, turnEnded: true };
  }

  voice.playWrongSound(game);
  if (game.paused) {
    // This was their last chance after time already ran out -- now it actually ends.
    await endTurn(client, lobby, { correct: false });
    return { ok: true, correct: false, turnEnded: true };
  }

  // Still within their normal time: a wrong guess costs nothing, so just show it on the
  // board and let them keep going.
  await refreshTurnBoard(game, lobby.channelId);
  return { ok: true, correct: false, turnEnded: false };
}

/**
 * The primary way a turn resolves: the player who can SEE the answer rules on a guess that
 * was said out loud.
 *
 * The bot's inputs assume typing and the game is played by talking, so guesses fired off in
 * voice never reached it -- which made any count built on submitted guesses undercount, and
 * undercount worst for the players conscientious enough to click. Judging moves the input to
 * the one person in the room who isn't busy: the guesser is thinking against a clock, while
 * the other player is only listening, and is already the authority on the answer.
 *
 * It also retires fuzzy matching from this path entirely. A human deciding whether
 * "Shikamaru" counts is better than Levenshtein deciding it.
 */
async function submitJudgement(client, lobby, judgeId, correct) {
  const game = lobby.game;
  if (!game || game.finished || lobby.status !== 'IN_PROGRESS') {
    return { ok: false, error: 'No game in progress.' };
  }
  if (!game.turnOrder.includes(judgeId)) {
    return { ok: false, error: 'Only the two players can judge a guess.' };
  }
  if (judgeId === game.currentPlayerId) {
    return { ok: false, error: "You're the one guessing -- <@" + game.judgeId + "> judges this turn." };
  }

  // text stays null: the guess was spoken, and the bot never heard the name.
  game.recordGuess(game.currentPlayerId, { correct, judged: true });

  if (correct) {
    voice.playCorrectSound(game);
    await endTurn(client, lobby, { correct: true });
    return { ok: true, correct: true, turnEnded: true };
  }

  voice.playWrongSound(game);
  if (game.paused) {
    // Time had already run out, so this was the last chance.
    await endTurn(client, lobby, { correct: false });
    return { ok: true, correct: false, turnEnded: true };
  }

  await refreshTurnBoard(game, lobby.channelId);
  return { ok: true, correct: false, turnEnded: false };
}

async function submitPass(client, lobby, playerId) {
  const game = lobby.game;
  if (!game || game.finished || lobby.status !== 'IN_PROGRESS') {
    return { ok: false, error: 'No game in progress.' };
  }
  if (playerId !== game.currentPlayerId) {
    return { ok: false, error: "It's not your turn." };
  }
  await endTurn(client, lobby, { correct: false });
  return { ok: true };
}

async function handleGuess(interaction, lobby, guessText) {
  const result = await submitGuess(interaction.client, lobby, interaction.user.id, guessText);
  if (!result.ok) {
    return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({
    content: result.correct ? '✅ Correct!' : '❌ Not quite.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePass(interaction, lobby) {
  const result = await submitPass(interaction.client, lobby, interaction.user.id);
  if (!result.ok) {
    return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ content: 'Turn passed.', flags: MessageFlags.Ephemeral });
}

async function endTurn(client, lobby, { correct }) {
  const game = lobby.game;
  clearTimers(game);
  // Freeze the outgoing turn's board (buttons removed, outcome shown) before anything
  // posts a new one, so old boards are never left clickable.
  await refreshTurnBoard(game, lobby.channelId, { correct });
  game.turnBoardMessage = null;
  game.paused = false;
  const finishingPlayerId = game.currentPlayerId;
  const isP1 = game.isFirstMover(finishingPlayerId);

  if (correct) {
    if (game.rebuttal) {
      // Rebuttal is only ever granted to P2, so a correct guess here means both got it -- a tie.
      return finalizeGame(client, lobby, { result: 'tie', rebuttalPlayerId: finishingPlayerId });
    }
    if (isP1) {
      // P1 always moves first each round, so P2 hasn't had this round's turn yet -- give them one shot.
      game.rebuttal = true;
      game.currentTurnIndex = 1;
      const channel = await getChannel(client, lobby);
      await channel.send(
        `🔁 <@${finishingPlayerId}> got it right! Since they went first, <@${game.turnOrder[1]}> gets one rebuttal turn.`
      );
      return startTurn(client, lobby);
    }
    // P2 winning means P1 already had their turn this round -- no rebuttal owed.
    return finalizeGame(client, lobby, { result: 'win', winnerId: finishingPlayerId, viaRebuttal: false });
  }

  if (game.rebuttal) {
    return finalizeGame(client, lobby, {
      result: 'win',
      winnerId: game.turnOrder[0],
      viaRebuttal: true,
      rebuttalPlayerId: finishingPlayerId,
    });
  }

  if (game.currentTurnIndex === 0) {
    game.currentTurnIndex = 1;
  } else {
    game.currentTurnIndex = 0;
    game.round += 1;
  }
  return startTurn(client, lobby);
}

async function finalizeGame(client, lobby, outcome) {
  const game = lobby.game;
  game.finished = true;
  clearTimers(game);
  const wasInVoice = Boolean(game.voiceConnection);
  voice.playWinSound(game); // win/final sting, whether it's an outright win or a tie
  lobby.status = 'FINISHED';
  await refreshLobbyBoard(lobby);
  const channel = await getChannel(client, lobby);
  const [p1Id, p2Id] = game.turnOrder;

  const [p1Name, p2Name] = await Promise.all([displayName(client, p1Id), displayName(client, p2Id)]);
  let resultLine;
  if (outcome.result === 'tie') {
    resultLine = `🤝 <@${outcome.rebuttalPlayerId}> also got it right on the rebuttal turn -- it's a tie!`;
  } else if (outcome.viaRebuttal) {
    resultLine = `❌ <@${outcome.rebuttalPlayerId}> didn't get it on the rebuttal turn. 🏆 <@${outcome.winnerId}> wins!`;
  } else {
    resultLine = `🏆 <@${outcome.winnerId}> guessed correctly and wins!`;
  }

  // The audience chose these characters and then heard nothing about it -- the reveal is
  // the first moment naming them is safe, so it is where the tally belongs.
  const voteLines = (game.voteSummary ?? []).map((s) => {
    const who = `<@${s.playerId}>`;
    if (s.noVotes) return `• ${who}: **${s.name}** — nobody voted, so the bot picked at random`;
    if (s.tieBroken) return `• ${who}: **${s.name}** — tied on ${s.votes}, settled by coin flip`;
    if (s.unopposed) return `• ${who}: **${s.name}** — unanimous, ${s.votes} of ${s.totalVoters}`;
    return `• ${who}: **${s.name}** — ${s.votes} of ${s.totalVoters} votes, over ${s.distinct - 1} other${
      s.distinct === 2 ? '' : 's'
    }`;
  });

  // Now that guesses are judged rather than typed, this count reflects what actually
  // happened at the table instead of only the guesses somebody remembered to submit.
  if (outcome.result !== 'tie' && outcome.winnerId) {
    const taken = game.guessCountFor(outcome.winnerId);
    if (taken > 0) {
      resultLine += ` — on guess **#${taken}**, round **${game.round}**.`;
    }
  }

  const gameOverButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`over:rematch:${lobby.channelId}`)
      .setLabel('Rematch')
      .setEmoji('🔁')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`over:leaderboard:${lobby.channelId}`)
      .setLabel('Leaderboard')
      .setEmoji('🏆')
      .setStyle(ButtonStyle.Secondary)
  );

  const reveal = await channel.send({
    ...characterMessage(
      voteLines.length ? `${resultLine}\n\n🗳️ **How the audience voted**\n${voteLines.join('\n')}` : resultLine,
      [
        { label: `${p1Name}'s character was`, ...game.headByPlayer[p1Id] },
        { label: `${p2Name}'s character was`, ...game.headByPlayer[p2Id] },
      ]
    ),
    components: [gameOverButtons],
  });
  // Rematch needs the FINISHED lobby that only exists in memory, so a restart has to retire
  // this row -- the sweep keeps the Leaderboard button, which reads from SQLite.
  trackBoard('gameover', reveal);

  const result = outcome.result === 'tie' ? 'tie' : outcome.winnerId === p1Id ? 'player1' : 'player2';
  recordResult(lobby.guildId, p1Id, p2Id, result);

  // Give the win sound time to finish before disconnecting, instead of cutting it off.
  if (wasInVoice) {
    setTimeout(() => voice.leaveVoiceForGame(game), voice.WIN_SOUND_DURATION_MS);
  } else {
    voice.leaveVoiceForGame(game);
  }
  // Deliberately NOT calling GameManager.endLobby here -- the FINISHED lobby stays in the
  // map so /rematch can read its settings. /create-lobby treats a FINISHED entry as free
  // to overwrite, and /end-game still deletes it outright if nobody wants a rematch.
}

module.exports = {
  startGame,
  startGameFromLobby,
  startAudienceVote,
  closeAudienceVote,
  submitGuess,
  submitJudgement,
  submitPass,
  handleGuess,
  handlePass,
  handleTimeout,
  handleConfirmationButton,
  characterMessage,
  clearTimers,
};
