// The turn "board": one self-updating message per turn, replacing what used to be a
// turn-start message plus a separate countdown message plus two messages per guess.
//
// It re-renders on every countdown checkpoint and every guess, then gets its buttons
// stripped once the turn ends, so the channel ends up with exactly one tidy block per turn.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { untrackBoard } = require('./boards');

const BAR_WIDTH = 12;
// Enough history to feel like a running tally without risking the 1024-char field cap.
const MAX_SHOWN_GUESSES = 8;

const COLOR_ACTIVE = 0x5865f2; // blurple
const COLOR_PAUSED = 0xfaa61a; // amber -- time's up, last chance
const COLOR_CORRECT = 0x57f287; // green
const COLOR_OVER = 0x4f545c; // grey -- turn handed over

function timerBar(remainingMs, totalMs) {
  const ratio = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function guessHistory(game) {
  if (!game.turnGuesses.length) return null;
  const shown = game.turnGuesses.slice(-MAX_SHOWN_GUESSES);
  const hidden = game.turnGuesses.length - shown.length;
  const lines = shown.map((g) => `${g.correct ? '✅' : '❌'} ${g.text}`).join('\n');
  return hidden > 0 ? `_...and ${hidden} earlier_\n${lines}` : lines;
}

function buildButtons(game, channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`turn:guess:${channelId}`)
      .setLabel('Guess')
      .setEmoji('🎯')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`turn:pass:${channelId}`)
      .setLabel('Pass')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
  );
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

  const history = guessHistory(game);
  if (history) embed.addFields({ name: 'Guesses this turn', value: history });

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
      .setDescription(`${whoseTurn}\n⏰ **Time's up — last chance!**\nGuess now, or pass to hand it over.`);
    return { embeds: [embed], components: [buildButtons(game, channelId)] };
  }

  const totalMs = game.turnSeconds * 1000;
  const remainingMs = game.timer ? game.timer.remainingMs() : totalMs;
  embed
    .setColor(COLOR_ACTIVE)
    .setDescription(
      `${whoseTurn}\n` +
        `⏳ \`${timerBar(remainingMs, totalMs)}\` **${Math.ceil(remainingMs / 1000)}s**\n` +
        'Ask your questions out loud — a wrong guess does *not* end your turn.'
    );

  return { embeds: [embed], components: [buildButtons(game, channelId)] };
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
