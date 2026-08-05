const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const Game = require('./Game');
const { MAX_PLAYERS } = require('./Lobby');
const TurnTimer = require('./turnTimer');
const GameManager = require('./GameManager');
const voice = require('./voice');
const { getRandomCharacters, getListLabelForIds } = require('../db/characterLists');
const { recordGame } = require('../db/stats');
const { refreshLobbyBoard, MIN_PLAYERS } = require('./lobbyBoard');
const { buildTurnBoardPayload, refreshTurnBoard } = require('./turnBoard');
const { trackBoard } = require('./boards');
// Every message that shows a character is composed and sent from one place -- see the note at
// the top of characterDM.js for why that is a rule here rather than a preference.
const {
  characterMessage,
  sendConfirmDMs,
  lockConfirmations,
  cancelConfirmations,
  sendSpectatorDM,
  sendSpectatorDMs,
} = require('./characterDM');
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

// Kicks off the audience-vote phase instead of dealing characters directly. The vote board
// is public but names no candidates -- see the spoiler note in audienceVote.js.
async function startAudienceVote(client, lobby) {
  // The ballot pages beyond five players; the lobby itself is capped at eight. The draw below
  // still needs voteOptions distinct characters per player and says so for itself.
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

  const started = await startResolvedAudienceGame(client, lobby, vote, characters, voteSummary);
  if (!started.ok) {
    await channel.send(`⚠️ ${started.error}`);
  }
  return started;
}

// A closed vote stays on the lobby until every player receives the confirmation cards. If one
// DM fails, retrying must honour the audience's settled result rather than opening a new ballot.
async function startResolvedAudienceGame(client, lobby, vote, characters = vote.resolve(), voteSummary = vote.summarise()) {
  const started = await startGame(client, lobby, characters);
  if (!started.ok) return started;
  lobby.game.voteSummary = voteSummary;
  lobby.vote = null;
  return started;
}

// Shared entry point for both `/lobby start` and the lobby board's Start button, so the
// validation and character-selection rules can't drift between the two.
async function startGameFromLobby(client, lobby) {
  const wanted = lobby.players.length;
  if (wanted < MIN_PLAYERS) {
    return { ok: false, error: `Need at least ${MIN_PLAYERS} players -- currently ${wanted}.` };
  }
  if (wanted > MAX_PLAYERS) {
    return { ok: false, error: `A lobby can have at most ${MAX_PLAYERS} players -- currently ${wanted}.` };
  }

  if (lobby.mode === 'audience-vote') {
    if (lobby.vote?.closed) {
      return startResolvedAudienceGame(client, lobby, lobby.vote);
    }
    return startAudienceVote(client, lobby);
  }

  // Hand-picking a FEW players and leaving the rest to chance is a normal thing to want --
  // "I know Zoro should go to Alex, deal everyone else at random" -- so an assignment covering
  // only some of the table is honoured for those players rather than discarded outright for
  // covering everyone or no one.
  const assigned = lobby.assignedCharacters ?? {};
  const unassignedIds = lobby.players.filter((id) => !assigned[id]);
  let randomFill = [];
  if (unassignedIds.length) {
    randomFill = getRandomCharacters(
      lobby.listIds,
      unassignedIds.length,
      Object.values(assigned).map((c) => c.name),
      lobby.difficulty
    );
    if (randomFill.length < unassignedIds.length) {
      return {
        ok: false,
        error:
          `${unassignedIds.length} more character${unassignedIds.length === 1 ? '' : 's'} ` +
          `needed and this list selection only has ${randomFill.length} left to deal at this ` +
          'difficulty (after the ones already hand-picked).',
      };
    }
  }
  let nextRandom = 0;
  const characters = lobby.players.map((id) => (assigned[id] ? assigned[id] : randomFill[nextRandom++]));

  return startGame(client, lobby, characters);
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
    if (!(await sendConfirmDMs(user, game, lobby.channelId))) {
      dmFailures.push(user.username);
    }
  }

  if (dmFailures.length) {
    // A player who lacks a check or reference card cannot judge every turn. Return the lobby
    // to WAITING rather than treating them as confirmed and starting an unwinnable game.
    lobby.status = 'WAITING';
    await cancelConfirmations(game);
    lobby.game = null;
    await refreshLobbyBoard(lobby);
    return {
      ok: false,
      error:
        `Couldn't DM ${dmFailures.join(', ')}. They need to enable DMs from server members before the host retries.`,
    };
  }

  await channel.send(
    `🔍 All ${game.turnOrder.length} players are reviewing their assigned characters (check your DMs) ` +
      '-- the game starts once everyone confirms.'
  );

  await maybeBeginPlay(client, lobby);
  return { ok: true };
}

async function maybeBeginPlay(client, lobby) {
  const game = lobby.game;
  if (lobby.status !== 'CONFIRMING') return;
  if (!game.turnOrder.every((id) => game.confirmState[id].confirmed)) return;

  // Claim the phase before retiring DM buttons. Two final confirmations can finish their
  // interaction updates together; only the first may start the turn.
  lobby.status = 'IN_PROGRESS';
  await lockConfirmations(game);
  await refreshLobbyBoard(lobby);
  await sendSpectatorDMs(client, lobby);
  const voiceResult = await voice.joinVoiceForGame(client, lobby);
  const channel = await getChannel(client, lobby);
  // A bot holds one voice connection per server, so a second concurrent game cannot have
  // sound. Saying so beats letting people wonder why the countdown went quiet -- the text
  // countdown is the fallback and it works.
  if (voiceResult?.takenBy) {
    await channel.send(
      `🔇 The game in <#${voiceResult.takenBy}> has the bot in voice, so this one is text-only. ` +
        'The countdown still runs on the board.'
    );
  }
  await channel.send(
    `✅ All ${game.turnOrder.length} players are ready -- starting the game! 🗂️ Playing with: **${game.listLabel}**`
  );
  await startTurn(client, lobby);
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
  const finishingPlayerId = game.currentPlayerId;

  /**
   * A turn resolves exactly once.
   *
   * Judging is open to everyone who isn't guessing, so simultaneous presses are routine --
   * and the checks in submitJudgement all pass for each of them, because this function
   * yields on its first await before it clears `paused`. A second press arriving in that
   * window found the turn still endable, ran the whole resolution again, and advanced the
   * rotation a second time: the next player was skipped without ever getting a board, and
   * charged for a turn they never had. Three presses skipped two players.
   *
   * The same hole swallowed a double-tapped Pass and two judges confirming one correct
   * guess, so the guard belongs here rather than on any one button.
   *
   * Keyed by turn rather than kept as a busy flag: it is exact, it cannot get stuck if
   * something throws mid-resolution, and it still lets the *next* turn resolve normally.
   * Checking and writing it before any await is what makes it a lock at all -- nothing else
   * can run in between, because the event loop only switches at an await.
   */
  const turnKey = `${finishingPlayerId}:${game.turnsFor(finishingPlayerId)}`;
  if (game.resolvedTurns.has(turnKey)) return;
  game.resolvedTurns.add(turnKey);

  clearTimers(game);

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

/**
 * A player quitting a game already in progress.
 *
 * Until now the only way out was getting your character, or being the last one guessing and
 * giving up -- so a player who had to leave could not, and the host's only tool ended the game
 * for everyone. That is a two-player assumption surviving into six-player games: one person
 * with a dying laptop should not be able to strand five.
 *
 * They leave with no turn count, recorded as `gave_up`, which is the truth: they chose to
 * stop. Everyone else plays on.
 *
 * If it is their turn, this goes through endTurn so the rotation advances and the resolution
 * guard applies -- a forfeit racing a judgement must not resolve the same turn twice. If it is
 * not their turn, nothing needs advancing: the current player is active by definition, so a
 * forfeit by anybody else can never empty the table.
 */
async function submitForfeit(client, lobby, playerId) {
  const game = lobby.game;
  if (!game || game.finished || lobby.status !== 'IN_PROGRESS') {
    return { ok: false, error: 'No game in progress.' };
  }
  if (!game.turnOrder.includes(playerId)) {
    return { ok: false, error: "You're not playing in this game." };
  }
  if (!game.isActive(playerId)) {
    return { ok: false, error: "You're already out of this game." };
  }

  game.surrendered.add(playerId);
  const channel = await getChannel(client, lobby);
  const left = game.activePlayers.length;
  await channel.send(
    `🏳️ <@${playerId}> has left the game.` +
      (left ? ` ${left} still guessing.` : '')
  );

  if (playerId === game.currentPlayerId) {
    await endTurn(client, lobby, { correct: false, gaveUp: true });
  } else {
    // Their row in the standings changed, so the live board is now out of date.
    await refreshTurnBoard(game, lobby.channelId);
  }
  return { ok: true };
}

/**
 * Writes the results of a game the host ended early, instead of binning them.
 *
 * Not about restarts -- the bot does not realistically restart mid-game. It is about the way
 * a game actually dies: there is no auto-surrender, so a player who stops responding parks
 * their turn in the last-chance state forever, and `/lobby end` is the documented remedy.
 * Until now that remedy threw away everyone else's result too, which at six players means
 * five people lose a finished game to one person's dead laptop.
 *
 * Deliberately narrow. Nothing is written unless somebody actually got their character --
 * a game abandoned in the first round has no result to preserve, and inventing rows for it
 * would put half-games in the leaderboard.
 *
 * @returns the standings if anything was recorded, otherwise null.
 */
function recordAbandonedGame(lobby) {
  const game = lobby?.game;
  if (!game || game.finished || game.finishedBy.size === 0) return null;

  const standings = game.standings();
  recordGame(lobby.guildId, standings);
  // Marked finished so an in-flight turn resolution cannot also finalize and double-record.
  game.finished = true;
  return standings;
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
  submitForfeit,
  handlePass,
  handleTimeout,
  maybeBeginPlay,
  recordAbandonedGame,
  characterMessage,
  sendSpectatorDM,
  clearTimers,
};
