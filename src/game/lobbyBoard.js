// The lobby "board": a single message posted by /create-lobby that shows live lobby state
// and carries the Join / Leave / Spectate / Start buttons. Button clicks re-render this same
// message in place (via interaction.update), so the channel doesn't fill up with one message
// per action.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { countDistinctCharacters, getListLabelForIds } = require('../db/characterLists');

const MAX_PLAYERS = 2;

function buildButtons(lobby) {
  const full = lobby.players.length >= MAX_PLAYERS;
  const ready = lobby.players.length === MAX_PLAYERS;
  const id = (action) => `lobby:${action}:${lobby.channelId}`;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(id('join'))
      .setLabel(full ? 'Lobby full' : 'Join')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(full),
    new ButtonBuilder()
      .setCustomId(id('leave'))
      .setLabel('Leave')
      .setEmoji('🚪')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(lobby.players.length === 0),
    new ButtonBuilder()
      .setCustomId(id('spectate'))
      .setLabel('Spectate')
      .setEmoji('👁')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(id('start'))
      .setLabel(ready ? 'Start game' : `Start game (${lobby.players.length}/${MAX_PLAYERS})`)
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success)
      // The disabled state carries the rule, so nobody has to discover it via an error.
      .setDisabled(!ready)
  );
}

// Phases after WAITING keep the board honest but drop the buttons -- the turn messages take
// over from there.
const STATUS_NOTE = {
  VOTING: '🗳️ Audience vote in progress -- the crowd is picking both characters.',
  CONFIRMING: '🔍 Dealing characters -- both players need to confirm in their DMs.',
  IN_PROGRESS: '🎮 Game in progress.',
  FINISHED: '🏁 Game finished. `/rematch` to run it back, or `/create-lobby` for a new one.',
};

function buildLobbyBoardPayload(lobby) {
  const playerLines = lobby.players.length
    ? lobby.players.map((id, i) => `\`${i + 1}.\` <@${id}>`).join('\n')
    : '_nobody yet -- hit **Join** below_';

  const embed = new EmbedBuilder()
    .setTitle('🎮 Guess the Character')
    // Mentions only render in descriptions/fields, never in a footer, so the host goes here.
    .setDescription(`🗂️ **${getListLabelForIds(lobby.listIds)}**\nHosted by <@${lobby.hostId}>`)
    .addFields(
      { name: `Players (${lobby.players.length}/${MAX_PLAYERS})`, value: playerLines },
      {
        name: 'Settings',
        value: [
          `${countDistinctCharacters(lobby.listIds)} characters`,
          `${lobby.turnSeconds}s turns`,
          lobby.mode === 'audience-vote'
            ? `🗳️ audience vote (${lobby.voteOptions} options, ${lobby.voteSeconds}s)`
            : `${lobby.maxRerolls === -1 ? 'unlimited' : lobby.maxRerolls} reroll${lobby.maxRerolls === 1 ? '' : 's'}`,
        ].join(' · '),
        inline: true,
      },
      {
        name: 'Spectators',
        value: lobby.spectators.size ? `${lobby.spectators.size} watching` : 'none yet',
        inline: true,
      }
    );

  const note = STATUS_NOTE[lobby.status];
  if (note) {
    embed.addFields({ name: '​', value: note });
    return { embeds: [embed], components: [] };
  }

  return { embeds: [embed], components: [buildButtons(lobby)] };
}

// Edits the board in place. Used when something OTHER than a board button changed the lobby
// (a slash command, or the game starting) -- button handlers use interaction.update instead,
// which is atomic with acknowledging the click.
async function refreshLobbyBoard(lobby) {
  if (!lobby.boardMessage) return;
  try {
    await lobby.boardMessage.edit(buildLobbyBoardPayload(lobby));
  } catch (err) {
    console.warn('[lobbyBoard] Could not refresh the lobby board:', err.message);
  }
}

module.exports = { buildLobbyBoardPayload, refreshLobbyBoard, MAX_PLAYERS };
