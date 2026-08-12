// The lobby "board": a single message posted by /lobby create that shows live lobby state
// and carries the Join / Leave / Spectate / Start buttons. Button clicks re-render this same
// message in place (via interaction.update), so the channel doesn't fill up with one message
// per action.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { countDistinctCharacters, getListLabelForIds, difficultyOf } = require('../../core/db/characterLists');
const { trackBoard, untrackBoard } = require('./boards');
const { MAX_PLAYERS } = require('../../core/game/Lobby');

// The fewest that makes a game.
const MIN_PLAYERS = 2;

// One text input per player, against Discord's five-per-modal limit.
const MAX_ASSIGNABLE_PLAYERS = 5;

function buildButtons(lobby) {
  const ready = lobby.players.length >= MIN_PLAYERS;
  const id = (action) => `lobby:${action}:${lobby.channelId}`;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(id('join'))
      .setLabel(`Join (${lobby.players.length}/${MAX_PLAYERS})`)
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(lobby.players.length >= MAX_PLAYERS),
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
      .setLabel(
        ready
          ? `Start game (${lobby.players.length}/${MAX_PLAYERS})`
          : `Start game (${lobby.players.length}/${MIN_PLAYERS} min)`
      )
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success)
      // The disabled state carries the rule, so nobody has to discover it via an error.
      .setDisabled(!ready)
  );
}

// Host-only controls, on their own row so they don't crowd the join/start flow everyone
// else uses. They stay enabled for non-hosts rather than greyed out: a disabled button
// gives no reason, and "only the host can do that" is the thing worth saying.
function buildSettingsRow(lobby) {
  const id = (action) => `lobby:${action}:${lobby.channelId}`;
  const voting = lobby.mode === 'audience-vote';

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(id('settings'))
      .setLabel('Settings')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(id('mode'))
      // The label states the current mode, not the action -- the board is read far more
      // often than the button is pressed.
      .setLabel(voting ? 'Audience vote: on' : 'Audience vote: off')
      .setEmoji('🗳️')
      .setStyle(voting ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(id('difficulty'))
      .setLabel(`Difficulty: ${difficultyOf(lobby.difficulty).label}`)
      .setEmoji('🎚️')
      .setStyle(ButtonStyle.Secondary),
    // Hand-picking the characters was the last lobby setting still living only in a slash
    // command, long after every other one moved onto the board.
    new ButtonBuilder()
      .setCustomId(id('characters'))
      .setLabel(Object.keys(lobby.assignedCharacters).length ? 'Characters: set' : 'Set characters')
      .setEmoji('🎭')
      .setStyle(
        Object.keys(lobby.assignedCharacters).length ? ButtonStyle.Primary : ButtonStyle.Secondary
      )
      // Needs everyone joined before it can ask who gets what, and can't ask at all past five
      // -- a modal holds five text inputs, and this needs one per player.
      .setDisabled(lobby.players.length < MIN_PLAYERS || lobby.players.length > MAX_ASSIGNABLE_PLAYERS)
  );
}

// Phases after WAITING keep the board honest but drop the buttons -- the turn messages take
// over from there.
const STATUS_NOTE = {
  VOTING: '🗳️ Audience vote in progress -- the crowd is picking both characters.',
  CONFIRMING: '🔍 Dealing characters -- every player needs to confirm in their DMs.',
  IN_PROGRESS: '🎮 Game in progress.',
  FINISHED: '🏁 Game finished. `/rematch` to run it back, or `/lobby create` for a new one.',
  // A cancelled lobby is deleted outright, so there is nothing left for /rematch to replay
  // -- pointing at it (as FINISHED does) would just send people to an error.
  CANCELLED: '🛑 Lobby cancelled. Use `/lobby create` to start a new one.',
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
          // Counted at the lobby's difficulty, so the number is what will actually be dealt.
          `${countDistinctCharacters(lobby.listIds, lobby.difficulty)} characters`,
          `🎚️ ${difficultyOf(lobby.difficulty).label}`,
          `${lobby.turnSeconds}s turns`,
          lobby.mode === 'audience-vote'
            ? `🗳️ audience vote (${lobby.voteOptions} options, ${lobby.voteSeconds}s)`
            : 'unlimited rerolls',
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

  return { embeds: [embed], components: [buildButtons(lobby), buildSettingsRow(lobby)] };
}

// Edits the board in place. Used when something OTHER than a board button changed the lobby
// (a slash command, or the game starting) -- button handlers use interaction.update instead,
// which is atomic with acknowledging the click.
async function refreshLobbyBoard(lobby) {
  if (!lobby.boardMessage) return;
  const payload = buildLobbyBoardPayload(lobby);
  try {
    await lobby.boardMessage.edit(payload);
    // Past WAITING the board has no buttons left, so a restart has nothing to retire. A failed
    // game start can restore WAITING after that, so restoring controls must make the board live
    // in restart tracking again.
    if (!payload.components.length) untrackBoard(lobby.boardMessage);
    else trackBoard('lobby', lobby.boardMessage);
  } catch (err) {
    console.warn('[lobbyBoard] Could not refresh the lobby board:', err.message);
  }
}

// All three places that post a board (/lobby create, /rematch, the reveal's Rematch button)
// do it as an interaction reply, so they share the handle-keeping and the restart tracking.
async function attachLobbyBoard(lobby, response, interaction) {
  lobby.boardMessage = response?.resource?.message ?? (await interaction.fetchReply().catch(() => null));
  trackBoard('lobby', lobby.boardMessage);
  return lobby.boardMessage;
}

module.exports = {
  buildLobbyBoardPayload,
  refreshLobbyBoard,
  attachLobbyBoard,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_ASSIGNABLE_PLAYERS,
};
