const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const Game = require('../../core/game/Game');
const { freshSeating } = require('../../core/game/seating');
const { MAX_PLAYERS } = require('../../core/game/Lobby');
const TurnTimer = require('./turnTimer');
const GameManager = require('../../core/game/GameManager');
// The turn rules -- the same ones the web runs. This file is the bot's I/O around them.
const rules = require('../../core/game/turnRules');
const voice = require('./voice');
const { getRandomCharacters, getListLabelForIds } = require('../../compendium/characterLists');
const { recordGame } = require('../../core/db/stats');
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
//
// game.timer is dropped, not just cleared: endTurn calls this before its own run of awaited
// Discord API calls (refreshTurnBoard, announceCompletion, startTurn's channel.send), and the
// timerWatchdog's periodic pass can land in that window. A cleared-but-still-referenced timer
// still answers expiresAt() with the OLD turn's deadline, which is in the past by the time a
// turn is ending near its own limit -- so the watchdog would call handleTimeout on a turn that
// is already over (or, worse, already replaced by the next one), pausing a player who just
// started their turn. With game.timer null in that window, expiresAt() reads as "nothing to
// enforce" until startTurn hands out a real one.
function clearTimers(game) {
  game.timer?.clear();
  game.timer = null;
  for (const handle of game.countdownHandles) clearTimeout(handle);
  game.countdownHandles = [];
  if (game.lastChanceHandle) {
    clearTimeout(game.lastChanceHandle);
    game.lastChanceHandle = null;
  }
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
  // The one claim on starting. Both callers check WAITING before an await of their own (the
  // interaction's defer), so two quick Starts both reached here and dealt two games, DMs and all.
  // Every path below moves the lobby off WAITING before its first await, so this check, made
  // synchronously, lets exactly one through.
  if (lobby.status !== 'WAITING') return { ok: false, error: 'This game is already starting.' };
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
  // `characters` arrive in the lobby's join order (one per player, however they were chosen:
  // dealt, hand-picked or voted). Seated afresh (seating.js), each character staying with its
  // player: who goes first and who checks whom change from game to game, rematches included.
  const order = freshSeating(lobby.players, lobby.lastOrder);
  const byPlayer = new Map(lobby.players.map((id, i) => [id, characters[i]]));
  const game = new Game({ lobby, characters: order.map((id) => byPlayer.get(id)), turnSeconds: lobby.turnSeconds, order });
  lobby.lastOrder = order;
  game.listLabel = getListLabelForIds(lobby.listIds);
  // The audience already chose in vote mode, so rerolling would undo their decision.
  game.rerollAllowed = lobby.mode !== 'audience-vote';
  lobby.game = game;
  lobby.status = 'CONFIRMING';
  await refreshLobbyBoard(lobby);

  // Nothing has been sent yet, so a failure here (a player who left Discord, an API hiccup) puts
  // the lobby back as it was. Thrown out of here instead, it left the lobby CONFIRMING with no DMs
  // out: every lobby button refused ("already started") and nobody could confirm.
  let users;
  let channel;
  try {
    users = await Promise.all(game.turnOrder.map((id) => client.users.fetch(id)));
    channel = await getChannel(client, lobby);
  } catch (err) {
    console.warn('[engine] Could not start the game:', err.message);
    lobby.status = 'WAITING';
    lobby.game = null;
    await refreshLobbyBoard(lobby);
    return { ok: false, error: "Couldn't reach every player on Discord, so the game didn't start. Try Start again." };
  }
  // Resolved once and cached on the game: names label characters in the confirm, reference
  // and spectator DMs, which is several lookups per player per reroll otherwise.
  game.setNames(Object.fromEntries(users.map((u) => [u.id, u.username])));

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
  await lockConfirmations(game, lobby.channelId);
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
  rules.beginTurn(game); // the first turn; every later one is begun by rules.advance
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

  // The turn has already been counted -- by rules.beginTurn for the first, rules.advance for every
  // other: turns are counted where they are handed out, never where someone must press something.
  // This posts its board and starts its clock.
  game.timer = new TurnTimer(game.turnSeconds * 1000, () => {
    handleTimeout(client, lobby).catch(console.error);
  });
  game.timer.start();

  game.turnBoardMessage = await channel.send(buildTurnBoardPayload(game, lobby.channelId));
  trackBoard('turn', game.turnBoardMessage);
  scheduleCountdown(lobby);
}

/**
 * Runs 30 seconds after a turn's last-chance timeout, if the player never acted on it --
 * exported (rather than inlined in the setTimeout below) so the tests can drive it directly
 * instead of waiting on the real 30 seconds, the same way timerWatchdog.checkOverdue is
 * driven directly instead of waiting on its interval.
 *
 * Nobody is ever removed from the game for going quiet. Leaving is always a deliberate act --
 * the ⏭️ Pass / 🏳️ Give up button or `/lobby leave` -- so a player who is simply thinking, or
 * briefly away, must not be pushed out. When their last-chance window lapses the turn just
 * PASSES: the rotation moves on, and everyone (including an AFK player) keeps their place and
 * will be up again. For a lone survivor nextActiveIndex() finds nobody else and loops straight
 * back to them, so they get another turn and their count keeps climbing -- exactly as if they
 * had pressed Pass. `/lobby end` is the escape hatch for a player who is genuinely gone.
 */
async function checkLastChanceTimeout(client, lobby, currentPlayerId) {
  const game = lobby.game;
  // Double-check the game is still running and it's still the same player's turn.
  if (!game || game.finished || game.currentPlayerId !== currentPlayerId || !game.paused) return;

  // Pass the turn on -- never a forfeit. Advancing the rotation (or looping back to a lone
  // player) keeps the game flowing without removing anyone who didn't choose to leave. Idle:
  // nobody chose this, which is what counts towards a deserted table (turnRules.deserted).
  await endTurn(client, lobby, { correct: false, gaveUp: false, idle: true });
}

async function handleTimeout(client, lobby) {
  const game = lobby.game;
  if (!game || game.finished) return;
  game.paused = true;
  // The board itself switches to the amber "last chance" state -- no extra message needed.
  await refreshTurnBoard(game, lobby.channelId);

  // Give one final window to guess, then pass the turn on rather than parking in amber forever.
  // This does NOT remove the player -- see checkLastChanceTimeout. Clear any prior grace timer
  // from a previous turn first.
  //
  // LIMITATION: this is a plain setTimeout and is NOT enforced by timerWatchdog, which only
  // re-checks turn timers and vote deadlines against the wall clock (see timerWatchdog.js). If
  // the host machine sleeps or the event loop stalls while this timer is pending, it fires late
  // by however long the process was frozen rather than at the wall-clock deadline. The turn
  // timer that precedes it IS watchdog-enforced, so a sleeping machine still reaches the
  // last-chance state on wake; only the 30s grace after it can drift. Left as-is deliberately:
  // promoting this to a watchdog-tracked deadline is possible but not worth the extra state for
  // a 30s grace window that only decides when a turn passes, never whether anyone is removed.
  if (game.lastChanceHandle) {
    clearTimeout(game.lastChanceHandle);
  }

  const currentPlayerId = game.currentPlayerId;
  game.lastChanceHandle = setTimeout(() => {
    checkLastChanceTimeout(client, lobby, currentPlayerId).catch((err) => console.error(err));
  }, 30000); // 30 seconds for the last-chance window
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
  // buzzer above is the whole of its effect -- that, and showing the table is not deserted.
  rules.noteActivity(game);
  await refreshTurnBoard(game, lobby.channelId);
  return { ok: true, correct: false, turnEnded: false };
}

/**
 * Pass hands the turn on, and only ever that -- it NEVER removes anyone.
 *
 * The board only offers Pass while other players are still guessing (turnBoard.buildButtons),
 * so there is always somebody to hand the turn to: endTurn's nextActiveIndex advances the
 * rotation and the passing player keeps their seat, even once they can no longer win. Leaving
 * is a separate, deliberate act -- 🏳️ Give up (submitGiveUp) or `/lobby leave` (submitForfeit)
 * -- and keeping those off Pass is what stops a pass ever surrendering a player who only meant
 * to hand the turn over.
 *
 * If Pass is somehow reached with nobody else active (e.g. the `/pass` command run by a lone
 * survivor), nextActiveIndex simply loops back and deals them another turn -- harmless, and
 * still never a surrender.
 */
async function submitPass(client, lobby, playerId) {
  const game = lobby.game;
  if (!game || game.finished || lobby.status !== 'IN_PROGRESS') {
    return { ok: false, error: 'No game in progress.' };
  }
  const r = rules.pass(game, playerId);
  if (r.duplicate) return { ok: true }; // a double tap: the first one already passed
  if (!r.ok) return r;
  await finishTurn(client, lobby, { correct: false, gaveUp: false });
  return { ok: true };
}

/**
 * Give up surrenders the current player: they drop out of the rotation (recorded as gave-up)
 * and the turn advances like a pass. The board offers it in two spots (turnBoard.buildButtons):
 * to a player out of contention who would rather bow out than play the epilogue, and to the
 * last player left, for whom it is the only move and ends the game.
 *
 * Either way it reveals what they were wearing -- they never got to work it out (bug: a give-up
 * used to leave the player never told). While others are still guessing that reveal is its own
 * message, posted now rather than made them wait for the end. When they were the LAST one, the
 * game ends here and finalizeGame shows the character in the result message instead, so it
 * isn't posted twice.
 */
async function submitGiveUp(client, lobby, playerId) {
  const game = lobby.game;
  if (!game || game.finished || lobby.status !== 'IN_PROGRESS') {
    return { ok: false, error: 'No game in progress.' };
  }
  // Validated, marked and resolved synchronously, before the reveal's first await -- so a second
  // give-up racing the first finds them already out and posts nothing.
  const r = rules.giveUp(game, playerId);
  if (!r.ok) return r;
  // activePlayers now excludes them, so this counts only the OTHERS still guessing. If any
  // remain the game plays on, so reveal their character right away and mark it revealed so the
  // end-of-game reveal doesn't repeat it. If none remain, finalizeGame does the reveal.
  const stillGuessing = game.activePlayers.length;
  if (stillGuessing > 0) {
    game.revealed.add(playerId);
    const channel = await getChannel(client, lobby);
    await channel.send(
      characterMessage(
        `🏳️ <@${playerId}> gave up. ${stillGuessing} still guessing.`,
        [{ label: 'They were wearing', ...game.headByPlayer[playerId] }]
      )
    );
  }
  await finishTurn(client, lobby, { correct: false, gaveUp: true });
  // game.finished is set only when the table emptied -- i.e. the last survivor gave up.
  return { ok: true, gameOver: game.finished };
}

async function handlePass(interaction, lobby) {
  const result = await submitPass(interaction.client, lobby, interaction.user.id);
  if (!result.ok) {
    return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ content: 'Turn passed.', flags: MessageFlags.Ephemeral });
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
  // Said now because it is now the time to beat: anyone who gets theirs in as many turns needs
  // more than this left on the clock to win outright (see Game.standings).
  const secondsLeft = game.secondsLeftBy.get(playerId);
  const left = secondsLeft == null ? '' : `, with **${secondsLeft}s** left`;
  const stillGuessing = game.activePlayers.length;
  const channel = await getChannel(client, lobby);
  const tail = stillGuessing ? ` ${stillGuessing} still guessing.` : '';
  // Best-effort: this is a cosmetic history message. A transient send failure (rate limit,
  // momentary 5xx, channel briefly unreachable) must never propagate, because endTurn has
  // already recorded the turn resolved -- letting it throw here would skip rotation
  // advancement (startTurn/finalizeGame) with no way to re-drive it, wedging the game.
  try {
    await channel.send(
      characterMessage(
        `✅ <@${playerId}> got it in **${turns}** turn${turns === 1 ? '' : 's'}${left}!${tail}`,
        [{ label: 'They were wearing', ...game.headByPlayer[playerId] }]
      )
    );
  } catch (err) {
    console.warn('[engine] Could not announce completion:', err.message);
  }
}

/**
 * Ends the turn in hand -- a judge's ruling, or the clock -- exactly once.
 *
 * The lock is rules.resolveTurn, taken before any await. Judging is open to everyone who isn't
 * guessing, so simultaneous presses are routine, and every extra resolution used to advance the
 * rotation again: three presses skipped two players. See src/core/game/turnRules.js.
 */
async function endTurn(client, lobby, { correct, gaveUp = false, idle = false }) {
  const game = lobby.game;
  // Read first -- clearTimers drops the timer it comes from. It is the tiebreak between equal
  // turn counts (Game.standings), taken when the turn resolved: for a judged guess, when the
  // judge ruled; in the last-chance window, 0.
  const msLeft = game.timer?.remainingMs() ?? null;
  if (!rules.resolveTurn(game, { correct, msLeft, idle }).ok) return undefined;
  return finishTurn(client, lobby, { correct, gaveUp });
}

/**
 * The bot's side of a turn already resolved: freeze its board, announce a finish, then move on
 * (rules.advance) -- in that order, so the board and the announcement still describe the turn
 * that just ended rather than the next one.
 */
async function finishTurn(client, lobby, { correct, gaveUp = false }) {
  const game = lobby.game;
  const finishingPlayerId = game.currentPlayerId;
  clearTimers(game);

  // Freeze the outgoing turn's board (buttons removed, outcome shown) before anything
  // posts a new one, so old boards are never left clickable.
  await refreshTurnBoard(game, lobby.channelId, { correct, gaveUp });
  // Held rather than forgotten: the next turn deletes it as it posts its own. If the game
  // ends here instead, it stays as the last thing in the channel.
  game.retiredBoardMessage = game.turnBoardMessage;
  game.turnBoardMessage = null;
  game.paused = false;

  if (correct) await announceCompletion(client, lobby, finishingPlayerId);

  // Two full laps of turns that timed out with nobody touching anything: the table has gone.
  // Checked before advancing, so nobody is charged a turn for a game that is over. Ended the way
  // /lobby end ends one -- whoever already finished keeps that result -- rather than posting a
  // board a minute to an empty channel for as long as the process runs.
  if (rules.deserted(game)) return endDesertedGame(client, lobby);

  // Everyone plays until they get their character, so one player finishing ends only their own
  // involvement. The game is over when nobody is left guessing.
  if (rules.advance(game).gameOver) return finalizeGame(client, lobby);
  return startTurn(client, lobby);
}

/**
 * Ends a lobby or a game before it is finished: shared by `/lobby end` and a deserted game, so the
 * two cannot tear a game down differently. Closes a vote in flight, retires confirmation DMs, keeps
 * the result of anyone who already finished (recordAbandonedGame), stops the clocks, retires the
 * live board and leaves voice. The lobby is deleted, not kept FINISHED: nothing is left to rematch.
 *
 * @returns the standings recorded, or null when nobody had finished.
 */
async function cancelLobby(lobby) {
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

  // Whoever already got their character keeps that result. Recorded BEFORE the game is torn down,
  // while the turn counts still exist.
  const recorded = recordAbandonedGame(lobby);

  if (lobby.game) {
    clearTimers(lobby.game);
    // Otherwise the cancelled turn's board keeps live-looking buttons.
    await refreshTurnBoard(lobby.game, lobby.channelId, { cancelled: true });
    voice.leaveVoiceForGame(lobby.game);
  }
  // CANCELLED, not FINISHED: the lobby is deleted below, so the board must not offer /rematch.
  lobby.status = 'CANCELLED';
  await refreshLobbyBoard(lobby);
  GameManager.endLobby(lobby.channelId);
  return recorded;
}

/** The line naming whoever's finished result survived an early end, or '' when nobody had. */
function keptResults(recorded) {
  if (!recorded) return '';
  const finishers = recorded.filter((s) => s.turnsTaken !== null);
  return (
    `${finishers.length} player${finishers.length === 1 ? '' : 's'} had already finished, so that result is kept:\n` +
    finishers.map((s) => `• <@${s.playerId}> — ${s.turnsTaken} turn${s.turnsTaken === 1 ? '' : 's'}`).join('\n')
  );
}

async function endDesertedGame(client, lobby) {
  const recorded = await cancelLobby(lobby);
  try {
    const channel = await getChannel(client, lobby);
    const kept = keptResults(recorded);
    await channel.send(`🛑 Nobody has played for two full rounds, so the game has ended.${kept ? ` ${kept}` : ''}`);
  } catch (err) {
    console.warn('[engine] Could not announce the deserted game:', err.message);
  }
}

/**
 * A player quitting a game already in progress.
 *
 * Until now the only way out was getting your character, or being the last one guessing and
 * giving up -- so a player who had to leave could not, and the host's only tool ended the game
 * for everyone. That is a two-player assumption surviving into six-player games: one person
 * with a dying laptop should not be able to strand five.
 *
 * Always a deliberate leave (`/lobby leave`): no turn count, recorded as `gave_up`, which is
 * the truth -- they chose to stop. There is no involuntary path here; a player who merely goes
 * quiet is never removed (see checkLastChanceTimeout), so the only way out is this choice or
 * getting your character. Everyone else plays on.
 *
 * If it is their turn, rules.forfeit resolves it under the same lock as everything else -- a
 * forfeit racing a judgement must not resolve the same turn twice -- and it advances. If it is
 * not their turn, nothing needs advancing: the current player is active by definition, so a
 * forfeit by anybody else can never empty the table.
 */
async function submitForfeit(client, lobby, playerId, { removed = false } = {}) {
  const game = lobby.game;
  // `removed`: the host took them out (/lobby remove) -- the same exit, said as what it was.
  const out = removed ? "They're already out of this game." : "You're already out of this game.";
  if (!game || game.finished || lobby.status !== 'IN_PROGRESS') {
    return { ok: false, error: 'No game in progress.' };
  }
  if (!game.turnOrder.includes(playerId)) {
    return { ok: false, error: removed ? "They're not playing in this game." : "You're not playing in this game." };
  }
  if (!game.isActive(playerId)) {
    return { ok: false, error: out };
  }

  // Marked and, if it was their turn, resolved -- synchronously, before the reveal below awaits.
  const r = rules.forfeit(game, playerId);
  if (!r.ok) return { ok: false, error: out };
  // Reveal what they were wearing at the moment they leave, not only if they stay to the end:
  // they never got to work it out, and it spoils nobody -- everyone else was DM'd it at the
  // start. Marked revealed so the end-of-game reveal (finalizeGame) doesn't show it again.
  game.revealed.add(playerId);
  const channel = await getChannel(client, lobby);
  const left = game.activePlayers.length;
  await channel.send(
    characterMessage(
      (removed ? `🚪 The host removed <@${playerId}> from the game.` : `🏳️ <@${playerId}> has left the game.`) +
        (left ? ` ${left} still guessing.` : ''),
      [{ label: 'They were wearing', ...game.headByPlayer[playerId] }]
    )
  );

  if (r.resolved) {
    await finishTurn(client, lobby, { correct: false, gaveUp: true });
  } else {
    // Their row in the standings changed, so the live board is now out of date.
    await refreshTurnBoard(game, lobby.channelId);
  }
  return { ok: true };
}

/**
 * The host takes someone out: `/lobby remove`, at whatever stage the lobby is at.
 *
 * Mid-game it is that player leaving (submitForfeit): their character revealed, the turn moved
 * on if it was theirs. A player who has gone quiet otherwise costs everyone a full turn and its
 * last chance every lap, and `/lobby end` was the only remedy -- ending the game for everyone.
 *
 * Before play it undoes the deal, which was made for a table with them at it: character checks
 * retired, an audience vote closed, the lobby back to WAITING for the host to Start again. That
 * is also the way past someone who never confirms. The game waits for every confirmation, so one
 * player who walked off held the whole table there, with no way on but to cancel the lobby.
 *
 * @returns {{ok: false, error: string} | {ok: true, redealt?: boolean}} redealt: a deal or vote was
 *   undone, so the host has to Start again
 */
async function removePlayer(client, lobby, playerId) {
  if (lobby.status === 'IN_PROGRESS') return submitForfeit(client, lobby, playerId, { removed: true });
  if (lobby.status !== 'WAITING' && lobby.status !== 'CONFIRMING' && lobby.status !== 'VOTING') {
    return { ok: false, error: 'That game is over -- there is nobody to remove.' };
  }
  if (!lobby.players.includes(playerId)) return { ok: false, error: "They're not in this lobby." };

  const redealt = lobby.status !== 'WAITING' || !!lobby.vote;
  if (lobby.status === 'CONFIRMING' && lobby.game?.confirmState) {
    await cancelConfirmations(lobby.game, '🛑 The host removed a player, so this deal was cancelled. A new one comes when the host starts again.');
  }
  // A vote dealt per player -- even a closed one kept for a retry after a failed DM -- is a vote
  // for a table that no longer exists.
  if (lobby.vote) {
    if (!lobby.vote.closed) {
      clearVoteTimer(lobby.vote);
      lobby.vote.closed = true;
      lobby.vote.cancelled = true;
      await refreshVoteBoard(lobby.vote);
    }
    clearVoteTimer(lobby.vote);
    lobby.vote = null;
  }
  if (lobby.game) clearTimers(lobby.game);
  lobby.game = null;
  lobby.status = 'WAITING';
  lobby.removePlayer(playerId);
  if (lobby.assignedCharacters) delete lobby.assignedCharacters[playerId];
  await refreshLobbyBoard(lobby);
  return { ok: true, redealt };
}

/**
 * Writes the results of a game the host ended early, instead of binning them.
 *
 * Not about restarts -- the bot does not realistically restart mid-game. It is about the way
 * a game can stall: nobody is ever auto-removed for going quiet (see checkLastChanceTimeout),
 * so a player who stops responding keeps being handed turns and the game never ends on its own.
 * `/lobby end` is the documented remedy for that case (and for a host who simply wants to stop
 * early). Until now that remedy threw away everyone else's result too, which at six players
 * means five people lose a finished game to one person's dead laptop.
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
  GameManager.markFinished(lobby.channelId);

  // Recorded FIRST, before any Discord call. Everything below is presentation and can fail -- a
  // rate limit, a channel that went away -- and recording used to come last, so a failed reveal
  // meant the game was never written at all.
  const standings = game.standings();
  recordGame(lobby.guildId, standings);

  await refreshLobbyBoard(lobby);
  const channel = await getChannel(client, lobby);

  const winners = standings.filter((s) => s.outcome === 'won');
  const best = game.bestTurnCount;
  const turnWord = (n) => `**${n}** turn${n === 1 ? '' : 's'}`;
  const secondsWord = (s) => (s.secondsLeft == null ? '' : ` with **${s.secondsLeft}s** left`);
  const onTime = game.wonOnTime;

  let resultLine;
  if (!winners.length) {
    // Unreachable in normal play -- giving up requires everyone else to have finished --
    // but a game cut short some other way shouldn't crash the reveal.
    resultLine = '🛑 Nobody got their character.';
  } else if (winners.length > 1) {
    // Level on turns AND to the second (or no clock was read), so a tie is genuinely a tie.
    resultLine = `🤝 It's a tie — ${winners.map((s) => `<@${s.playerId}>`).join(' and ')} both got it in ${turnWord(best)}${secondsWord(winners[0])}!`;
  } else if (onTime) {
    resultLine = `🏆 <@${winners[0].playerId}> wins on time — got it in ${turnWord(best)}${secondsWord(winners[0])}!`;
  } else {
    resultLine = `🏆 <@${winners[0].playerId}> wins — got it in ${turnWord(best)}!`;
  }

  // The full order, which is the only place the losing turn counts are ever stated. Skipped
  // at two players, where the result line has already said everything there is to say.
  if (standings.length > 2) {
    // Places come from Game.standings -- competition ranking, where players level on turns and
    // time share a place and the next one skips -- rather than being re-derived here, so this
    // and the web's over screen cannot rank the same game two ways. Seconds are shown so a
    // difference in place between equal turn counts explains itself.
    const finishers = standings.filter((s) => s.turnsTaken !== null);
    const places = standings.map((s) => {
      if (s.turnsTaken === null) return `${finishers.length + 1}. <@${s.playerId}> — _gave up_`;
      const shared = finishers.filter((o) => o.place === s.place).length > 1;
      const left = s.secondsLeft == null ? '' : `, ${s.secondsLeft}s left`;
      return `${s.place}${shared ? '=' : '.'} <@${s.playerId}> — ${s.turnsTaken} turn${s.turnsTaken === 1 ? '' : 's'}${left}`;
    });
    resultLine += `\n\n**Final standings**\n${places.join('\n')}`;
  } else {
    const loser = standings.find((s) => s.outcome !== 'won');
    if (loser) {
      resultLine +=
        loser.turnsTaken === null
          ? ` <@${loser.playerId}> gave up.`
          : loser.turnsTaken === best
            ? ` <@${loser.playerId}> also got it in ${turnWord(best)}, but${secondsWord(loser)}.`
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
      .setCustomId(`over:rematch:${lobby.channelId}:${game.gameInstanceId}`)
      .setLabel('Rematch')
      .setEmoji('🔁')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`over:leaderboard:${lobby.channelId}:${game.gameInstanceId}`)
      .setLabel('Leaderboard')
      .setEmoji('🏆')
      .setStyle(ButtonStyle.Secondary)
  );

  // Only the characters nobody has seen yet. Everyone who got theirs had it revealed at that
  // moment, so repeating it here put the same name and artwork in the channel twice in a row
  // -- and in a game where everybody finished, the whole reveal was a duplicate of the two
  // messages above it. What is left is the one genuinely unanswered question: what the player
  // who gave up was wearing -- unless they left mid-game, in which case submitForfeit already
  // showed it and marked them revealed, so it isn't repeated here.
  const unrevealed = game.turnOrder.filter((id) => !game.finishedBy.has(id) && !game.revealed.has(id));
  // The names resolved when the game started -- no fresh lookup that could fail at the last step.
  const names = unrevealed.map((id) => game.nameOf(id));
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
  submitGiveUp,
  submitForfeit,
  removePlayer,
  handlePass,
  handleTimeout,
  checkLastChanceTimeout,
  maybeBeginPlay,
  recordAbandonedGame,
  cancelLobby,
  keptResults,
  characterMessage,
  sendSpectatorDM,
  clearTimers,
};
