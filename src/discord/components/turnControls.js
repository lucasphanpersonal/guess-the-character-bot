// Handlers for the turn board's controls.
//
// customIds:
//   turn:right:<channelId>                            button -> judge starts to rule "correct"
//   turn:yes:<channelId>:<playerId>:<turnNumber>      button -> and confirms it (ephemeral)
//   turn:wrong:<channelId>                            button -> the judge rules it wrong
//   turn:pass:<channelId>                             button -> the guesser hands the turn on
//   turn:giveup:<channelId>                           button -> the guesser starts to bow out
//   turn:giveupyes:<channelId>:<playerId>:<turnNumber> button -> and confirms it (ephemeral)
//   turn:spectate:<channelId>                         button -> a NON-player asks to see them all
//
// There is no "submit a guess" control here on purpose. Guesses are said out loud and ruled
// on by the player who can see the answer; a second way to settle the same question would
// mean two authorities on it.

const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const GameManager = require('../../core/game/GameManager');
const engine = require('../game/engine');

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

const JUDGE_ACTIONS = new Set(['right', 'wrong', 'yes']);

// ✅ and ❌ sit next to each other, and only one of them is reversible. Pressing ❌ by
// mistake costs nothing -- the turn carries on. Pressing ✅ by mistake ends the turn, marks
// that player finished, and publishes the character they are wearing, which no undo can take
// back: they have now seen their own answer and the game is spoiled for them.
//
// So the harmless button stays a single press and the irreversible one asks first. The cost
// is one extra tap at most once per player per game, since ✅ lands exactly once for each of
// them; the thing it prevents costs the whole game.
function confirmRow(channelId, playerId, turnNumber, gameInstanceId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`turn:yes:${channelId}:${playerId}:${turnNumber}:${gameInstanceId}`)
      .setLabel('Yes, they got it')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
  );
}

// Giving up is the guesser's own irreversible act -- it drops them from the rotation, reveals
// their character, and when they are the last one guessing it ends the whole game -- so it asks
// first, exactly as the judge's ✅ does and as `/lobby leave` does. Carries the player and turn
// it was raised on, so a confirmation left sitting until the turn moved on answers "too late"
// instead of surrendering whoever is up now.
function giveUpConfirmRow(channelId, playerId, turnNumber, gameInstanceId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`turn:giveupyes:${channelId}:${playerId}:${turnNumber}:${gameInstanceId}`)
      .setLabel('Yes, give up')
      .setEmoji('🏳️')
      .setStyle(ButtonStyle.Danger)
  );
}

async function handle(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const channelId = parts[2];
  const lobby = GameManager.getLobby(channelId);
  const game = lobby?.game;

  if (!lobby || !game || lobby.status !== 'IN_PROGRESS' || game.finished) {
    return interaction.reply(ephemeral('That game is no longer running.'));
  }

  // Validate gameInstanceId to prevent stale controls from old games
  const expectedGameInstanceId = game.gameInstanceId;
  let providedGameInstanceId;
  let targetId;
  let targetTurn;

  if (action === 'yes' || action === 'giveupyes') {
    // turn:yes:channelId:playerId:turnNumber:gameInstanceId (giveupyes is the same shape)
    targetId = parts[3];
    targetTurn = parts[4];
    providedGameInstanceId = parts[5];
  } else {
    // turn:right:channelId:gameInstanceId, etc.
    providedGameInstanceId = parts[3];
  }

  if (providedGameInstanceId && providedGameInstanceId !== expectedGameInstanceId) {
    return interaction.reply(ephemeral('That control is no longer available.'));
  }

  // The board carries two players' controls, so the ownership check depends on the button.
  // Judging belongs to whoever ISN'T guessing -- they're the one who can see the answer.
  if (JUDGE_ACTIONS.has(action)) {
    // Checked before who-may-judge, because a confirmation left sitting until the turn moved
    // on is stale whoever is up now -- and if the turn passed to the judge themselves, the
    // ownership check below would otherwise answer with a confusing "you're guessing this
    // turn". Only the judge can see this message, so there is no separate check that they
    // are the one who opened it.
    if (action === 'yes' && (targetId !== game.currentPlayerId || targetTurn !== String(game.turnsFor(targetId)))) {
      return interaction.update({
        content: '⌛ Too late — that turn has already moved on, so nothing was recorded.',
        components: [],
      });
    }

    const judges = game.judges;
    // Named while there is one of them; past that a list of mentions is noise, and "everyone
    // else" is the actual rule.
    const whoJudges = judges.length === 1 ? `<@${judges[0]}>` : 'everyone else at the table';
    if (interaction.user.id === game.currentPlayerId) {
      return interaction.reply(
        ephemeral(`You're guessing this turn — ${whoJudges} rules on it. Say your guesses out loud.`)
      );
    }
    if (!game.turnOrder.includes(interaction.user.id)) {
      return interaction.reply(ephemeral(`Only the players in this game can judge — ${whoJudges} this turn.`));
    }

    if (action === 'right') {
      const who = game.currentPlayerId;
      return interaction.reply({
        content:
          `Did <@${who}> get it? Their character goes public and they leave the rotation — ` +
          "there's no taking it back.",
        components: [confirmRow(channelId, who, game.turnsFor(who), game.gameInstanceId)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === 'yes') {
      await interaction.update({ content: '✅ Recorded — they got it.', components: [] });
    } else {
      await interaction.deferUpdate();
    }

    const result = await engine
      .submitJudgement(interaction.client, lobby, interaction.user.id, action === 'yes')
      .catch((err) => {
        console.error(err);
        return { ok: false, error: 'Something went wrong recording that.' };
      });
    if (!result.ok) return interaction.followUp(ephemeral(result.error));
    return undefined;
  }

  // Checked before the whose-turn-is-it guard below, because this is the one control on the
  // board that belongs to people who are NOT playing.
  if (action === 'spectate') {
    if (game.turnOrder.includes(interaction.user.id)) {
      return interaction.reply(ephemeral("You're a player in this game — you already know everyone else's."));
    }
    lobby.spectators.add(interaction.user.id);
    const sent = await engine.sendSpectatorDM(interaction.client, lobby, interaction.user.id);
    return interaction.reply(
      ephemeral(
        sent
          ? `👁 Sent you all ${game.turnOrder.length} characters via DM. Press again any time to re-send.`
          : "You're spectating, but I couldn't DM you — check that you allow DMs from server members."
      )
    );
  }

  // The give-up confirmation button (raised by `giveup` below). Handled before the whose-turn
  // check so a confirmation left sitting until the turn moved on gets a clean "too late" rather
  // than the confusing "it's <someone else>'s turn". It is ephemeral to the player who raised
  // it, so only they can reach it, and the turn/player check is the staleness guard.
  if (action === 'giveupyes') {
    if (targetId !== game.currentPlayerId || targetTurn !== String(game.turnsFor(targetId))) {
      return interaction.update({
        content: '⌛ Too late — that turn has already moved on, so nothing was recorded.',
        components: [],
      });
    }
    await interaction.update({ content: '🏳️ You gave up.', components: [] });
    const result = await engine
      .submitGiveUp(interaction.client, lobby, interaction.user.id)
      .catch((err) => {
        console.error(err);
        return { ok: false, error: 'Something went wrong giving up.' };
      });
    if (!result.ok) return interaction.followUp(ephemeral(result.error));
    return undefined;
  }

  // Everyone can see the board, so every control has to check who actually clicked it.
  if (interaction.user.id !== game.currentPlayerId) {
    return interaction.reply(ephemeral(`It's <@${game.currentPlayerId}>'s turn, not yours.`));
  }

  // Pass hands the turn on and can never remove anyone -- a single press, no confirmation.
  if (action === 'pass') {
    await interaction.deferUpdate();
    const result = await engine.submitPass(interaction.client, lobby, interaction.user.id).catch((err) => {
      console.error(err);
      return { ok: false, error: 'Something went wrong passing the turn.' };
    });
    if (!result.ok) return interaction.followUp(ephemeral(result.error));
    return undefined;
  }

  // Give up is irreversible -- it drops you from the rotation, reveals your character, and when
  // you're the last one guessing it ends the game -- so, like ✅ and `/lobby leave`, it asks
  // first rather than surrendering on a single tap. The confirmation's button does the deed.
  if (action === 'giveup') {
    const alone = game.activePlayers.length === 1;
    const turnNumber = game.turnsFor(game.currentPlayerId);
    return interaction.reply({
      content: alone
        ? "Give up? You're the last one still guessing, so this ends the game — and there's no taking it back."
        : 'Give up? You leave the rotation and your character is revealed — no way back in. Everyone else plays on.',
      components: [giveUpConfirmRow(channelId, game.currentPlayerId, turnNumber, game.gameInstanceId)],
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply(ephemeral('Unknown turn action.'));
}

/**
 * The confirmation raised by `/lobby leave` during a game.
 *
 * Separate from `handle` because it arrives from a slash command's ephemeral reply rather
 * than from the turn board, and it is the only control here that a player uses to remove
 * themselves rather than to rule on somebody else.
 */
async function handleForfeit(interaction) {
  const [, channelId] = interaction.customId.split(':');
  const lobby = GameManager.getLobby(channelId);
  const result = await engine
    .submitForfeit(interaction.client, lobby, interaction.user.id)
    .catch((err) => {
      console.error(err);
      return { ok: false, error: 'Something went wrong leaving the game.' };
    });
  return interaction.update({
    content: result.ok ? '🏳️ You have left the game.' : result.error,
    components: [],
  });
}

module.exports = { handle, handleForfeit };
