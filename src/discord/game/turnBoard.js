// The turn "board": one self-updating message per turn, replacing what used to be a
// turn-start message plus a separate countdown message plus two messages per guess.
//
// It re-renders on every countdown checkpoint and every guess, then gets its buttons
// stripped once the turn ends, so the channel ends up with exactly one tidy block per turn.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { untrackBoard } = require('./boards');

const BAR_WIDTH = 12;

const COLOR_ACTIVE = 0x5865f2; // blurple
const COLOR_PAUSED = 0xfaa61a; // amber -- time's up, last chance
const COLOR_CORRECT = 0x57f287; // green
const COLOR_OVER = 0x4f545c; // grey -- turn handed over

function timerBar(remainingMs, totalMs) {
  const ratio = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

// Who has got theirs and in how many turns, which is the whole of the scoring and is
// otherwise invisible -- without this the players would be reconstructing it by counting
// messages. Rendered as lines in one field rather than a field per player, which stops
// looking like a scoreboard and starts looking like a spreadsheet at about four.
// `turnOver` freezes the "currently guessing" marker off. Without it a board that has been
// retired still points at whoever had just been playing, because currentPlayerId does not
// advance until the next turn starts -- so the dead board in the channel claims a turn is
// live when it is not.
// An embed field's value caps at 1024 characters, which a line like
// "✅ <@192319600095002634> — turn 12" hits at roughly 28 players. Over that Discord rejects
// the whole embed, so the board would fail to post and the game would wedge -- an unacceptable
// way for "no player limit" to turn out to be false.
const MAX_FIELD_VALUE = 1024;

function standingsField(game, { turnOver = false } = {}) {
  const lineFor = (playerId) => {
    const done = game.finishedBy.get(playerId);
    if (done != null) return `✅ <@${playerId}> — turn ${done}`;
    // Surrender is always a deliberate exit now, so it always reads as "gave up".
    if (game.surrendered.has(playerId)) return `🏳️ <@${playerId}> — gave up`;
    const turns = game.turnsFor(playerId);
    const guessing = !turnOver && playerId === game.currentPlayerId;
    // "turn 0" is accurate and reads like a bug, so someone yet to play says so.
    const where = turns === 0 ? 'not started yet' : `turn ${turns}`;
    return `${guessing ? '🎯' : '⏳'} <@${playerId}> — ${where}${guessing ? ' (guessing)' : ''}`;
  };

  // Whoever is up, and whoever has finished, are the two things the standings exist to show,
  // so they are kept first and everyone else fills the space that's left.
  const priority = (playerId) =>
    playerId === game.currentPlayerId ? 0 : game.finishedBy.has(playerId) ? 1 : 2;
  const ordered = [...game.turnOrder].sort((a, b) => priority(a) - priority(b));

  const kept = [];
  let length = 0;
  for (const playerId of ordered) {
    const line = lineFor(playerId);
    // Leave room for the "and N more" line that a truncation will need.
    if (length + line.length + 1 > MAX_FIELD_VALUE - 24) break;
    kept.push(playerId);
    length += line.length + 1;
  }

  // Rendered back in seating order, so the list reads as the table rather than as a ranking.
  const shown = game.turnOrder.filter((id) => kept.includes(id)).map(lineFor);
  const hidden = game.turnOrder.length - shown.length;
  if (hidden > 0) shown.push(`_…and ${hidden} more_`);

  // Mentions resolve in a field's VALUE but not in its name -- see the note below on titles.
  return { name: 'Standings', value: shown.join('\n') };
}

// Two rows, because the players have different jobs and share one message: whoever can see
// the answer rules on it, and the player guessing decides when to stop.
function buildButtons(game, channelId) {
  const gameInstanceId = game.gameInstanceId;
  const judgeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`turn:right:${channelId}:${gameInstanceId}`)
      .setLabel('They got it')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`turn:wrong:${channelId}:${gameInstanceId}`)
      .setLabel('Nope')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
  );

  // The guesser's controls. There is deliberately no "submit a guess" button among them: the
  // judge's ✅ already answers "was that right?", and a second way to answer it would mean two
  // authorities on the same question -- a human who can see the character, and Levenshtein
  // distance. One is better.
  //
  // ⏭️ Pass always just hands the turn on and NEVER removes anyone -- so a player who can no
  // longer win keeps their seat and their shot at their own character (for placement) instead
  // of being pushed out. 🏳️ Give up is a separate red button that surrenders: it advances the
  // rotation like a pass, but drops the player out (recorded as gave-up) and reveals what they
  // were wearing. They are different buttons on purpose -- a pass can never surrender you.
  //
  // Which controls show depends on where the player stands:
  //
  //   - Still in contention: just Pass. Nothing to give up on yet; if they truly must leave,
  //     `/lobby leave` is always there.
  //   - Out of contention but others still playing: Pass AND Give up. They can play on for
  //     placement, or bow out -- both are one tap, and the context note explains the choice.
  //   - Last one guessing: Give up only. There is nobody to pass to (a press would cycle
  //     straight back), so giving up -- which here ends the game -- is the only move left.
  const passButton = new ButtonBuilder()
    .setCustomId(`turn:pass:${channelId}:${gameInstanceId}`)
    .setLabel('Pass')
    .setEmoji('⏭️')
    .setStyle(ButtonStyle.Secondary);
  const giveUpButton = new ButtonBuilder()
    .setCustomId(`turn:giveup:${channelId}:${gameInstanceId}`)
    .setLabel('Give up')
    .setEmoji('🏳️')
    .setStyle(ButtonStyle.Danger);
  // Spectating was only ever offered on the lobby board, which loses its buttons the moment
  // the game starts and is buried up the channel by turn three -- so anyone who wandered in
  // late had to know `/lobby spectate` existed. It lives here because this is the one message
  // that is always at the bottom of the channel, and its audience is exactly complementary to
  // the guesser's: the player whose turn it is cannot spectate, and a spectator has no turn.
  const spectateButton = new ButtonBuilder()
    .setCustomId(`turn:spectate:${channelId}:${gameInstanceId}`)
    .setLabel('Spectate')
    .setEmoji('👁')
    .setStyle(ButtonStyle.Secondary);

  const alone = game.activePlayers.length === 1;
  const outOfContention = !alone && game.isOutOfContention(game.currentPlayerId);
  const guesserControls = [];
  if (alone) {
    guesserControls.push(giveUpButton);
  } else {
    guesserControls.push(passButton);
    if (outOfContention) guesserControls.push(giveUpButton);
  }
  guesserControls.push(spectateButton);
  const guesserRow = new ActionRowBuilder().addComponents(...guesserControls);

  return [judgeRow, guesserRow];
}

/**
 * @param {object} outcome  When present the turn is over: { correct }, { gaveUp } or
 *                          { cancelled }. Buttons are dropped and the board says how it ended.
 */
function buildTurnBoardPayload(game, channelId, outcome = null) {
  // The current player's OWN turn count, not a shared round number: that is the number they
  // are being scored on, and once players start finishing, a global round stops matching it.
  const turn = game.turnsFor(game.currentPlayerId);
  const embed = new EmbedBuilder().setTitle(`🎯 Turn ${turn}`);

  // Discord resolves `<@id>` in an embed's description but NOT in its title or field
  // names, where it renders as the raw `<@192319600095002634>`. So whose turn it is has to
  // live in the description.
  const whoseTurn = `<@${game.currentPlayerId}>'s turn`;
  // Everybody reads the same message, so each row has to say whose it is or the judge buttons
  // look like they're for the person guessing. With more than two at the table the judge is
  // not one nominated person, so naming them all would be a list nobody reads -- and the
  // shared row is the point: whoever is paying attention rules on it, exactly as at a table.
  const judges = game.judges;
  const roles =
    `🗣️ <@${game.currentPlayerId}> guesses out loud · ` +
    `⚖️ ${judges.length === 1 ? `<@${judges[0]}>` : 'everyone else'} hits ✅ or ❌`;

  if (outcome) {
    embed.addFields(standingsField(game, { turnOver: true }));
    if (outcome.cancelled) {
      embed.setColor(COLOR_OVER).setDescription('🛑 Game cancelled.');
    } else if (outcome.correct) {
      embed
        .setColor(COLOR_CORRECT)
        .setDescription(`${whoseTurn}\n✅ **Got it in ${turn} turn${turn === 1 ? '' : 's'}!**`);
    } else if (outcome.gaveUp) {
      embed.setColor(COLOR_OVER).setDescription(`${whoseTurn}\n🏳️ **Gave up.**`);
    } else {
      embed.setColor(COLOR_OVER).setDescription(`${whoseTurn}\n➡️ Turn over.`);
    }
    // The mention is cleared with the buttons: a retired board should stop addressing
    // anybody, and an edit never re-notifies in any case.
    return { content: '', embeds: [embed], components: [] };
  }

  embed.addFields(standingsField(game));

  // A player who can no longer win has no idea they are in that spot, and the whole channel is
  // watching them play it out. Saying so turns a turn that can't change who wins into an
  // informed choice -- keep playing for your own placement, or step out. Nobody is removed
  // either way; the score is turns taken, compared at the end. Two shapes:
  //
  //   - Last one guessing: nobody left to pass to, so the whole game hangs on them, and their
  //     control is the game-ending Give up.
  //   - Out of contention but not last: they can't match the best finish for the win, but their
  //     OWN character is still there to get (for placement), and others are still playing -- so
  //     this is a softer note, and their control stays a plain Pass.
  //
  // Mutually exclusive by construction: the out-of-contention note is gated on NOT being alone,
  // so the two never fire together or contradict each other.
  const alone = game.activePlayers.length === 1;
  const outOfContention = !alone && game.isOutOfContention(game.currentPlayerId);
  let context = '';
  if (alone) {
    context =
      `\n🏳️ You're the last one guessing — everyone else was done by turn ${game.bestTurnCount}. ` +
      'Keep going, or **Give up** to end it.';
  } else if (outOfContention) {
    const best = game.bestTurnCount;
    const leaderId = [...game.finishedBy.entries()].find(([, t]) => t === best)?.[0];
    const leader = leaderId ? `<@${leaderId}>` : 'The leader';
    context =
      `\n🏳️ ${leader} finished on turn ${best}, so you can't win it now — but your turns still ` +
      'count for where you place, so getting your own character is worth it. **Pass** to play ' +
      'on, or **Give up** to bow out.';
  }

  // Discord does NOT notify on a mention inside an embed, only on one in message content. So
  // the description's mention is layout and this one is the actual "you're up" ping -- without
  // it a player four minutes from their last turn has nothing telling them the clock started.
  const content = `<@${game.currentPlayerId}>`;

  if (game.paused) {
    embed
      .setColor(COLOR_PAUSED)
      .setDescription(
        `${whoseTurn}\n⏰ **Time's up — last chance!**\n${roles}\n` +
          // The context note already spells out the alternative, so it isn't offered twice.
          `One more guess${context ? '.' : ', or pass to hand it over.'}${context}`
      );
    return { content, embeds: [embed], components: buildButtons(game, channelId) };
  }

  const totalMs = game.turnSeconds * 1000;
  const remainingMs = game.timer ? game.timer.remainingMs() : totalMs;
  embed
    .setColor(COLOR_ACTIVE)
    .setDescription(
      `${whoseTurn}\n` +
        `⏳ \`${timerBar(remainingMs, totalMs)}\` **${Math.ceil(remainingMs / 1000)}s**\n` +
        `${roles}\n` +
        `A wrong guess does *not* end the turn.${context}`
    );

  return { content, embeds: [embed], components: buildButtons(game, channelId) };
}

async function refreshTurnBoard(game, channelId, outcome = null) {
  if (!game.turnBoardMessage) return;
  const payload = buildTurnBoardPayload(game, channelId, outcome);
  try {
    await game.turnBoardMessage.edit(payload);
    // An outcome means the buttons are gone for good, so a restart has nothing to retire.
    if (!payload.components.length) untrackBoard(game.turnBoardMessage);
  } catch (err) {
    console.warn('[turnBoard] Could not refresh the turn board:', err.message);
  }
}

module.exports = { buildTurnBoardPayload, refreshTurnBoard, timerBar };
