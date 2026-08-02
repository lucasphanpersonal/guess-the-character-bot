// Restart handling for the bot's persistent, button-bearing messages ("boards").
//
// Lobby and game state is deliberately in-memory (see GameManager), so a restart wipes it.
// The boards, though, stay in the channel looking fully interactive. Clicking one after a
// restart is handled -- every component handler checks for a missing lobby -- but a button
// that only ever answers "that game is no longer running" reads like a broken bot.
//
// So the *messages* are tracked: channel id, message id and kind, and nothing else. On
// startup every tracked board is retired (buttons stripped, a short note added) and its row
// dropped. Boards are untracked the moment they lose their buttons in normal play, so the
// table only ever holds boards that are genuinely live.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { rememberBoard, forgetBoard, allBoards } = require('../db/activeBoards');

const ENDED_NOTE = {
  lobby: '⚠️ The bot restarted, so this lobby is no longer active. Use `/lobby create` to start a new one.',
  turn: '⚠️ The bot restarted, so this game ended here. Use `/lobby create` to start a new one.',
  vote: '⚠️ The bot restarted, so this vote was abandoned. Use `/lobby create` to start a new one.',
  gameover: '⚠️ The bot restarted, so **Rematch** is no longer available. Use `/lobby create` to start a new one.',
  confirm: '⚠️ The bot restarted before the game began -- this character is no longer in play.',
};

const FALLBACK_NOTE = ENDED_NOTE.turn;
const MAX_CONTENT = 2000;

/**
 * Records a board as live. Safe to call with a message the bot failed to send (null), and
 * with anything lacking ids -- tracking is a nicety, never a precondition for play.
 */
function trackBoard(kind, message) {
  if (!message?.id || !message?.channelId) return;
  try {
    rememberBoard(message.channelId, message.id, kind);
  } catch (err) {
    console.warn('[boards] Could not track a board message:', err.message);
  }
}

/** Call once a board has been re-rendered without its buttons -- there's nothing left to sweep. */
function untrackBoard(message) {
  if (!message?.id || !message?.channelId) return;
  try {
    forgetBoard(message.channelId, message.id);
  } catch (err) {
    console.warn('[boards] Could not untrack a board message:', err.message);
  }
}

// The Leaderboard button reads only from SQLite, so it survives a restart perfectly well --
// the reveal keeps it and loses just the Rematch button, which needs the lobby that's gone.
function leaderboardRow(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`over:leaderboard:${channelId}`)
      .setLabel('Leaderboard')
      .setEmoji('🏆')
      .setStyle(ButtonStyle.Secondary)
  );
}

// Only content and components are set, so the embeds already on the message are left as they
// are -- the final state of a turn or a reveal is still worth reading back.
function endedPayload(message, kind, channelId) {
  const note = ENDED_NOTE[kind] ?? FALLBACK_NOTE;
  const existing = typeof message.content === 'string' ? message.content : '';
  const combined = existing ? `${existing}\n\n${note}` : note;
  return {
    content: combined.length <= MAX_CONTENT ? combined : note,
    components: kind === 'gameover' ? [leaderboardRow(channelId)] : [],
  };
}

/**
 * Retires every tracked board. Run on startup (the boards belong to a process that no longer
 * exists) and again on clean shutdown, where it retires them immediately instead of leaving
 * them live until the next boot. The rows survive a force-kill, which is exactly why the
 * startup pass is the one that matters.
 */
async function sweepBoards(client) {
  const rows = allBoards();
  let retired = 0;
  for (const row of rows) {
    try {
      const channel = await client.channels.fetch(row.channelId);
      const message = await channel.messages.fetch(row.messageId);
      await message.edit(endedPayload(message, row.kind, row.channelId));
      retired++;
    } catch {
      // Deleted message, deleted channel, revoked access -- there's no board left to retire
      // either way, so the row goes regardless.
    }
    forgetBoard(row.channelId, row.messageId);
  }
  return { found: rows.length, retired };
}

module.exports = { trackBoard, untrackBoard, sweepBoards };
