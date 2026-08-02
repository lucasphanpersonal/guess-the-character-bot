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

// Guesses are called out in voice and ruled on by the other player, so the bot knows how
// many there were but never what they were. A count is therefore the whole truth -- listing
// them would be a column of "said out loud" pretending to be history.
//
// Which means the bot can't stop you re-guessing a name. The other player can, and does,
// because that is what happens at a real table.
function guessTally(game) {
  const n = game.guessLog.filter((g) => g.playerId === game.currentPlayerId).length;
  if (!n) return null;
  return `**${n}** guess${n === 1 ? '' : 'es'} this game`;
}

// Two rows, because the two players have different jobs and share one message: the player
// who can see the answer rules on it, and the player guessing decides when to give up.
function buildButtons(game, channelId) {
  const wrongSoFar = game.turnGuesses.filter((g) => !g.correct).length;

  const judgeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`turn:right:${channelId}`)
      .setLabel('They got it')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`turn:wrong:${channelId}`)
      // The running count lives on the button so the judge can see their presses landing.
      .setLabel(wrongSoFar ? `Nope · ${wrongSoFar}` : 'Nope')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
  );

  // Pass is the guesser's only control. There is deliberately no "submit a guess" button
  // beside it: the judge's ✅ already answers "was that right?", and a second way to answer
  // it would mean two authorities on the same question -- a human who can see the character,
  // and Levenshtein distance. One is better.
  const guesserRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`turn:pass:${channelId}`)
      .setLabel('Pass')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
  );

  return [judgeRow, guesserRow];
}

/**
 * @param {object} outcome  When present the turn is over: { correct } or { cancelled }.
 *                          Buttons are dropped and the board states how it ended.
 */
function buildTurnBoardPayload(game, channelId, outcome = null) {
  const label = game.rebuttal ? '🔁 Rebuttal turn' : `🎯 Round ${game.round}`;
  const embed = new EmbedBuilder().setTitle(label);

  // Discord resolves `<@id>` in an embed's description but NOT in its title or field
  // names, where it renders as the raw `<@192319600095002634>`. So whose turn it is has to
  // live in the description.
  const whoseTurn = `<@${game.currentPlayerId}>'s turn`;
  // Both players read the same message, so each row has to name its owner or the judge
  // buttons look like they're for the person guessing.
  const roles =
    `🗣️ <@${game.currentPlayerId}> guesses out loud · ` +
    `⚖️ <@${game.judgeId}> hits ✅ or ❌`;

  const tally = guessTally(game);
  if (tally) embed.addFields({ name: 'Guesses so far', value: tally });

  if (outcome) {
    if (outcome.cancelled) {
      embed.setColor(COLOR_OVER).setDescription('🛑 Game cancelled.');
    } else if (outcome.correct) {
      embed.setColor(COLOR_CORRECT).setDescription(`${whoseTurn}\n✅ **Correct!**`);
    } else {
      embed.setColor(COLOR_OVER).setDescription(`${whoseTurn}\n➡️ Turn over.`);
    }
    return { embeds: [embed], components: [] };
  }

  if (game.paused) {
    embed
      .setColor(COLOR_PAUSED)
      .setDescription(
        `${whoseTurn}\n⏰ **Time's up — last chance!**\n${roles}\nOne more guess, or pass to hand it over.`
      );
    return { embeds: [embed], components: buildButtons(game, channelId) };
  }

  const totalMs = game.turnSeconds * 1000;
  const remainingMs = game.timer ? game.timer.remainingMs() : totalMs;
  embed
    .setColor(COLOR_ACTIVE)
    .setDescription(
      `${whoseTurn}\n` +
        `⏳ \`${timerBar(remainingMs, totalMs)}\` **${Math.ceil(remainingMs / 1000)}s**\n` +
        `${roles}\n` +
        'A wrong guess does *not* end the turn.'
    );

  return { embeds: [embed], components: buildButtons(game, channelId) };
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
