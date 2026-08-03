const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const Game = require('./Game');
const TurnTimer = require('./turnTimer');
const GameManager = require('./GameManager');
const voice = require('./voice');
const {
  getRandomCharacterExcluding,
  getRandomCharacters,
  getListLabelForIds,
  recordReroll,
  setListsEnabled,
  getListsByIds,
  REROLL_DEMOTE_THRESHOLD,
} = require('../db/characterLists');
const { recordGame } = require('../db/stats');
const { refreshLobbyBoard, MIN_PLAYERS } = require('./lobbyBoard');
const { buildTurnBoardPayload, refreshTurnBoard } = require('./turnBoard');
const { trackBoard, untrackBoard } = require('./boards');
const {
  AudienceVote,
  drawCandidates,
  buildVoteBoardPayload,
  refreshVoteBoard,
  clearVoteTimer,
  MAX_VOTE_PLAYERS,
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

// Discord renders at most 10 embeds per message.
const MAX_EMBEDS = 10;

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// The characters a player needs to recognise but is NOT the checker for: everyone except
// themselves and their check target. Empty at two players, which is why the reference
// message only exists from three up.
function referenceHeadsFor(game, playerId) {
  const target = game.checkTargetOf(playerId);
  return game.turnOrder.filter((id) => id !== playerId && id !== target);
}

/**
 * The DM each player gets when characters are dealt, as TWO messages.
 *
 * Discord renders components after every embed, so a single message would strand the button
 * row below N-1 character cards with nothing saying which one it acts on. Splitting puts the
 * controls back beside their subject, and confines the 10-embed ceiling to the message that
 * has no buttons.
 *
 * Returns false only if the DM could not be sent at all.
 */
async function sendConfirmDMs(recipientUser, game, channelId, client) {
  const state = game.confirmState[recipientUser.id];
  const targetId = game.checkTargetOf(recipientUser.id);
  const character = game.headByPlayer[targetId];

  try {
    const dm = await recipientUser.send({
      content: game.rerollAllowed ? confirmPrompt(game.listLabel) : votedPrompt(game.listLabel),
      embeds: [confirmCharacterEmbed(character)],
      components: [
        buildConfirmRow(channelId, state.rerollsLeft, {
          allowReroll: game.rerollAllowed,
          // Only offerable when we know which list the character came from, which rules
          // out hand-assigned characters from /lobby set-characters.
          canDropList: game.rerollAllowed && character.listId != null,
        }),
      ],
    });
    trackBoard('confirm', dm);
    state.checkMessage = dm;
  } catch {
    return false;
  }

  // Best-effort: the check message is the one that gates the game starting, so a reference
  // message that fails to send is not worth refusing to play over.
  state.referenceMessages = [];
  const others = referenceHeadsFor(game, recipientUser.id);
  if (others.length) {
    for (const page of chunk(others, MAX_EMBEDS)) {
      try {
        state.referenceMessages.push(await recipientUser.send(referencePayload(game, page)));
      } catch {
        break;
      }
    }
  }
  return true;
}

// The read-only half of the DM. No components at all -- everything here belongs to somebody
// else to check, and a control that isn't yours is just noise you have to read past.
function referencePayload(game, playerIds) {
  return characterMessage(
    '📖 **The others**, so you can answer questions about them. Nothing here is yours to check.',
    playerIds.map((id) => ({ label: `${game.nameOf(id)}'s character`, ...game.headByPlayer[id] }))
  );
}

/**
 * Re-renders the reference message of everybody who can see `changedPlayerId`'s character,
 * after a reroll swapped it.
 *
 * Unavoidable, and the price of characters being shared rather than per-viewer: at two
 * players a reroll is private to the one person looking at it, and from three up it
 * invalidates what everyone else is holding. Confirmed players are included -- their message
 * has had its buttons stripped, but they still have to answer questions about the character
 * all game.
 */
async function fanOutReference(game, changedPlayerId) {
  await Promise.all(
    game.turnOrder.map(async (viewerId) => {
      if (viewerId === changedPlayerId) return; // never sees their own
      if (game.checkTargetOf(viewerId) === changedPlayerId) return; // it's on their check message
      const state = game.confirmState[viewerId];
      const pages = state?.referenceMessages ?? [];
      if (!pages.length) return;
      const heads = chunk(referenceHeadsFor(game, viewerId), MAX_EMBEDS);
      await Promise.all(
        pages.map((message, i) =>
          heads[i] ? message.edit(referencePayload(game, heads[i])).catch(() => {}) : null
        )
      );
    })
  );
}

async function sendSpectatorDMs(client, lobby) {
  const game = lobby.game;
  const playing = new Set(game.turnOrder);

  const spectatorIds = new Set(lobby.spectators);
  try {
    const guild = await client.guilds.fetch(lobby.guildId);
    const member = await guild.members.fetch(game.turnOrder[0]).catch(() => null);
    const voiceChannel = member?.voice?.channel;
    if (voiceChannel) {
      for (const [, m] of voiceChannel.members) {
        if (!playing.has(m.id)) spectatorIds.add(m.id);
      }
    }
  } catch {
    // best-effort voice detection only
  }

  // One embed per player, against a 10-embed ceiling, so a big table needs several messages.
  const pages = chunk(game.turnOrder, MAX_EMBEDS);
  for (const specId of spectatorIds) {
    try {
      const specUser = await client.users.fetch(specId);
      for (const [i, page] of pages.entries()) {
        const header =
          i === 0
            ? `🗂️ Playing with: **${game.listLabel}**\nSpectator info for the game in <#${lobby.channelId}>:`
            : `…continued (${i + 1}/${pages.length})`;
        await specUser.send(
          characterMessage(
            header,
            page.map((id) => ({ label: `${game.nameOf(id)}'s head`, ...game.headByPlayer[id] }))
          )
        );
      }
    } catch {
      // DMs closed, skip silently
    }
  }
}

// Kicks off the audience-vote phase instead of dealing characters directly. The vote board
// is public but names no candidates -- see the spoiler note in audienceVote.js.
async function startAudienceVote(client, lobby) {
  // The ballot puts one select menu per player in a message that holds five rows, so this
  // mode has a ceiling the rest of the game does not. It refuses for itself rather than
  // capping how many people may play.
  if (lobby.players.length > MAX_VOTE_PLAYERS) {
    return {
      ok: false,
      error:
        `Audience vote tops out at ${MAX_VOTE_PLAYERS} players (the ballot needs a menu each, and ` +
        `Discord allows five per message) — this lobby has ${lobby.players.length}. ` +
        'Turn the vote off on the board to play normally.',
    };
  }

  const candidatesBySlot = drawCandidates(lobby);
  if (!candidatesBySlot) {
    const wanted = lobby.voteOptions * lobby.players.length;
    return {
      ok: false,
      error:
        `Audience vote needs ${wanted} distinct characters ` +
        `(${lobby.voteOptions} each for ${lobby.players.length} players) but this list selection has fewer.`,
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

// Shared entry point for both `/lobby start` and the lobby board's Start button, so the
// validation and character-selection rules can't drift between the two.
async function startGameFromLobby(client, lobby) {
  const wanted = lobby.players.length;
  if (wanted < MIN_PLAYERS) {
    return { ok: false, error: `Need at least ${MIN_PLAYERS} players -- currently ${wanted}.` };
  }

  if (lobby.mode === 'audience-vote') {
    return startAudienceVote(client, lobby);
  }

  const assigned = lobby.assignedCharacters;
  let characters;
  if (lobby.players.every((id) => assigned?.[id])) {
    characters = lobby.players.map((id) => assigned[id]);
  } else {
    characters = getRandomCharacters(lobby.listIds, wanted, [], lobby.difficulty);
    if (characters.length < wanted) {
      return {
        ok: false,
        error:
          `${wanted} players need ${wanted} different characters, and this list selection ` +
          `only has ${characters.length} to deal at this difficulty.`,
      };
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

  const users = await Promise.all(game.turnOrder.map((id) => client.users.fetch(id)));
  // Resolved once and cached on the game: names label characters in the confirm, reference
  // and spectator DMs, which is several lookups per player per reroll otherwise.
  game.setNames(Object.fromEntries(users.map((u) => [u.id, u.username])));
  const channel = await getChannel(client, lobby);

  game.confirmState = Object.fromEntries(
    game.turnOrder.map((id) => [
      id,
      { confirmed: false, rerollsLeft: lobby.maxRerolls, rejectedNames: new Set() },
    ])
  );

  const dmFailures = [];
  for (const user of users) {
    if (!(await sendConfirmDMs(user, game, lobby.channelId, client))) {
      dmFailures.push(user.username);
      // Nobody can confirm a DM they never got, and one closed inbox must not wedge the
      // whole table -- so they are treated as ready and simply never get a reroll.
      game.confirmState[user.id].confirmed = true;
    }
  }

  if (dmFailures.length) {
    await channel.send(
      `⚠️ Couldn't DM: ${dmFailures.join(', ')}. They need to enable DMs from server members to play.`
    );
  }

  await channel.send(
    `🔍 All ${game.turnOrder.length} players are reviewing their assigned characters (check your DMs) ` +
      '-- the game starts once everyone confirms.'
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
      content: '✅ Locked in! Waiting on everyone else...',
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

    // The character this player checks -- at two players that is the other one, exactly as
    // before; from three up it is specifically theirs to rule on.
    const otherPlayerId = game.checkTargetOf(playerId);
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
    // Every head in play is excluded, not just the roller's own -- two players wearing the
    // same character would make the game unplayable for both.
    const excludeNames = new Set([
      ...game.turnOrder.map((id) => game.headByPlayer[id].name),
      ...state.rejectedNames,
    ]);
    const replacement = remaining.length
      ? getRandomCharacterExcluding(remaining, excludeNames, lobby.difficulty)
      : null;
    if (!replacement) {
      return interaction.reply({
        content:
          `Dropping **${list.name}** would leave nothing else to deal from in this lobby, so ` +
          'nothing was changed. Reroll instead, or add more lists with `/list select`.',
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
    // Everyone else is holding a card that just changed under them.
    await fanOutReference(game, otherPlayerId);
    return interaction.followUp({
      content:
        `🚫 **${list.name}** is out of the pool for future games. ` +
        'Undo any time with `/list toggle`.',
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
    const otherPlayerId = game.checkTargetOf(playerId);
    const currentName = game.headByPlayer[otherPlayerId].name;
    const excludeNames = new Set([
      ...game.turnOrder.map((id) => game.headByPlayer[id].name),
      ...state.rejectedNames,
    ]);
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
    // Everyone else is holding a card that just changed under them.
    await fanOutReference(game, otherPlayerId);

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

/**
 * Drops the board of the turn that just ended, so the channel holds exactly one.
 *
 * A board per turn is right at two players and a short game; five players over four rounds
 * is twenty of them, and the live one is never where you left it. Deleting is better than
 * editing one board in place, because a fresh post re-anchors at the bottom and marks the
 * channel unread -- an edit does neither, and that is what tells somebody they are up.
 *
 * The board is frozen first (endTurn) and deleted after, rather than simply deleted: if the
 * delete fails -- gone already, channel unreachable -- what is left behind is an inert board
 * rather than a live one with working buttons. The extra edit is cheap insurance.
 *
 * What survives a game is therefore the completion messages and the final result, which are
 * the parts worth scrolling back to. Boards are scaffolding.
 */
async function dropRetiredBoard(game) {
  const message = game.retiredBoardMessage;
  if (!message) return;
  game.retiredBoardMessage = null;
  try {
    await message.delete();
  } catch {
    // Already gone, or the channel is unreachable. It has had its buttons stripped either
    // way, so leaving it there is untidy rather than harmful.
  }
}

async function startTurn(client, lobby) {
  const game = lobby.game;
  const channel = await getChannel(client, lobby);
  await dropRetiredBoard(game);

  // The score is counted here, where turns are handed out, rather than anywhere a player
  // has to remember to press something.
  game.turnsTaken.set(game.currentPlayerId, game.turnsFor(game.currentPlayerId) + 1);
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
    return { ok: false, error: 'Only players in this game can judge a guess.' };
  }
  if (judgeId === game.currentPlayerId) {
    return { ok: false, error: "You're the one guessing -- anybody else at the table judges this turn." };
  }

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

  // A wrong guess costs nothing and is not recorded -- the turn simply carries on. The
  // buzzer above is the whole of its effect.
  await refreshTurnBoard(game, lobby.channelId);
  return { ok: true, correct: false, turnEnded: false };
}

/**
 * Pass hands the turn on -- except when you are the last player still guessing, where there
 * is nobody to hand it to and a press would only cycle straight back to you. There it means
 * give up, and the board says so (see turnBoard.buildButtons).
 *
 * Because players otherwise leave the rotation only by finishing, this is reachable exactly
 * once per game: everyone else has already got theirs.
 */
async function submitPass(client, lobby, playerId) {
  const game = lobby.game;
  if (!game || game.finished || lobby.status !== 'IN_PROGRESS') {
    return { ok: false, error: 'No game in progress.' };
  }
  if (playerId !== game.currentPlayerId) {
    return { ok: false, error: "It's not your turn." };
  }
  const gaveUp = game.activePlayers.length === 1;
  if (gaveUp) game.surrendered.add(playerId);
  await endTurn(client, lobby, { correct: false, gaveUp });
  return { ok: true, gaveUp };
}

async function handlePass(interaction, lobby) {
  const result = await submitPass(interaction.client, lobby, interaction.user.id);
  if (!result.ok) {
    return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({
    content: result.gaveUp ? 'You gave up -- that ends the game.' : 'Turn passed.',
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Announces that somebody got theirs, and reveals the character they were wearing.
 *
 * Safe to make public: everyone else could already see it, and the player themselves has
 * just worked it out. Its own message rather than an edit to the turn board, so it survives
 * as the game's actual history while the boards come and go.
 */
async function announceCompletion(client, lobby, playerId) {
  const game = lobby.game;
  const turns = game.finishedBy.get(playerId);
  const stillGuessing = game.activePlayers.length;
  const channel = await getChannel(client, lobby);
  const tail = stillGuessing ? ` ${stillGuessing} still guessing.` : '';
  await channel.send(
    characterMessage(
      `✅ <@${playerId}> got it in **${turns}** turn${turns === 1 ? '' : 's'}!${tail}`,
      [{ label: 'They were wearing', ...game.headByPlayer[playerId] }]
    )
  );
}

async function endTurn(client, lobby, { correct, gaveUp = false }) {
  const game = lobby.game;
  clearTimers(game);
  const finishingPlayerId = game.currentPlayerId;

  // Recorded before the board is frozen, so the outgoing board can state the outcome.
  if (correct) game.finishedBy.set(finishingPlayerId, game.turnsFor(finishingPlayerId));

  // Freeze the outgoing turn's board (buttons removed, outcome shown) before anything
  // posts a new one, so old boards are never left clickable.
  await refreshTurnBoard(game, lobby.channelId, { correct, gaveUp });
  // Held rather than forgotten: the next turn deletes it as it posts its own. If the game
  // ends here instead, it stays as the last thing in the channel.
  game.retiredBoardMessage = game.turnBoardMessage;
  game.turnBoardMessage = null;
  game.paused = false;

  if (correct) await announceCompletion(client, lobby, finishingPlayerId);

  // Everyone plays until they get their character, so one player finishing ends only their
  // own involvement. The game is over when nobody is left guessing -- which, since players
  // otherwise leave only by finishing, means all of them got there or all but the last one did.
  const next = game.nextActiveIndex();
  if (next === null) return finalizeGame(client, lobby);
  game.currentTurnIndex = next;
  return startTurn(client, lobby);
}

async function finalizeGame(client, lobby) {
  const game = lobby.game;
  game.finished = true;
  clearTimers(game);
  // No turn follows to clear it, and the two messages below say everything it does.
  await dropRetiredBoard(game);
  const wasInVoice = Boolean(game.voiceConnection);
  voice.playWinSound(game); // win/final sting, whether it's an outright win or a tie
  lobby.status = 'FINISHED';
  await refreshLobbyBoard(lobby);
  const channel = await getChannel(client, lobby);

  const standings = game.standings();
  const winners = standings.filter((s) => s.outcome === 'won');
  const best = game.bestTurnCount;
  const turnWord = (n) => `**${n}** turn${n === 1 ? '' : 's'}`;

  let resultLine;
  if (!winners.length) {
    // Unreachable in normal play -- giving up requires everyone else to have finished --
    // but a game cut short some other way shouldn't crash the reveal.
    resultLine = '🛑 Nobody got their character.';
  } else if (winners.length > 1) {
    resultLine = `🤝 It's a tie — ${winners.map((s) => `<@${s.playerId}>`).join(' and ')} both got it in ${turnWord(best)}!`;
  } else {
    resultLine = `🏆 <@${winners[0].playerId}> wins — got it in ${turnWord(best)}!`;
  }

  // The full order, which is the only place the losing turn counts are ever stated. Skipped
  // at two players, where the result line has already said everything there is to say.
  if (standings.length > 2) {
    // Competition ranking, so equal turn counts share a place and the next one skips. Simply
    // numbering the sorted list 1..N would quietly award a tiebreaker the game does not have
    // -- two players on three turns are second and second, not second and third.
    const finishers = standings.filter((s) => s.turnsTaken !== null);
    const places = standings.map((s) => {
      if (s.turnsTaken === null) return `${finishers.length + 1}. <@${s.playerId}> — _gave up_`;
      const rank = finishers.filter((o) => o.turnsTaken < s.turnsTaken).length + 1;
      const shared = finishers.filter((o) => o.turnsTaken === s.turnsTaken).length > 1;
      return `${rank}${shared ? '=' : '.'} <@${s.playerId}> — ${s.turnsTaken} turn${s.turnsTaken === 1 ? '' : 's'}`;
    });
    resultLine += `\n\n**Final standings**\n${places.join('\n')}`;
  } else {
    const loser = standings.find((s) => s.outcome !== 'won');
    if (loser) {
      resultLine +=
        loser.turnsTaken === null
          ? ` <@${loser.playerId}> gave up.`
          : ` <@${loser.playerId}> needed ${loser.turnsTaken}.`;
    }
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

  // Only the characters nobody has seen yet. Everyone who got theirs had it revealed at that
  // moment, so repeating it here put the same name and artwork in the channel twice in a row
  // -- and in a game where everybody finished, the whole reveal was a duplicate of the two
  // messages above it. What is left is the one genuinely unanswered question: what the player
  // who gave up was wearing.
  const unrevealed = game.turnOrder.filter((id) => !game.finishedBy.has(id));
  const names = await Promise.all(unrevealed.map((id) => displayName(client, id)));
  const reveal = await channel.send({
    ...characterMessage(
      voteLines.length ? `${resultLine}\n\n🗳️ **How the audience voted**\n${voteLines.join('\n')}` : resultLine,
      unrevealed.map((id, i) => ({
        label: `${names[i]}'s character was`,
        ...game.headByPlayer[id],
      }))
    ),
    components: [gameOverButtons],
  });
  // Rematch needs the FINISHED lobby that only exists in memory, so a restart has to retire
  // this row -- the sweep keeps the Leaderboard button, which reads from SQLite.
  trackBoard('gameover', reveal);

  recordGame(lobby.guildId, standings);

  // Give the win sound time to finish before disconnecting, instead of cutting it off.
  if (wasInVoice) {
    setTimeout(() => voice.leaveVoiceForGame(game), voice.WIN_SOUND_DURATION_MS);
  } else {
    voice.leaveVoiceForGame(game);
  }
  // Deliberately NOT calling GameManager.endLobby here -- the FINISHED lobby stays in the
  // map so /rematch can read its settings. /lobby create treats a FINISHED entry as free
  // to overwrite, and /lobby end still deletes it outright if nobody wants a rematch.
}

module.exports = {
  startGame,
  startGameFromLobby,
  startAudienceVote,
  closeAudienceVote,
  submitJudgement,
  submitPass,
  handlePass,
  handleTimeout,
  handleConfirmationButton,
  characterMessage,
  clearTimers,
};
