// Handlers for the turn board's controls.
//
// customIds:
//   turn:right:<channelId>                        button -> judge starts to rule "correct"
//   turn:yes:<channelId>:<playerId>:<turnNumber>  button -> and confirms it (ephemeral)
//   turn:wrong:<channelId>                        button -> the judge rules it wrong
//   turn:pass:<channelId>                         button -> the guesser ends their turn
//   turn:spectate:<channelId>                     button -> a NON-player asks to see them all
//
// There is no "submit a guess" control here on purpose. Guesses are said out loud and ruled
// on by the player who can see the answer; a second way to settle the same question would
// mean two authorities on it.

const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const GameManager = require('../game/GameManager');
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
function confirmRow(channelId, playerId, turnNumber) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`turn:yes:${channelId}:${playerId}:${turnNumber}`)
      .setLabel('Yes, they got it')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
  );
}

async function handle(interaction) {
  const [, action, channelId, targetId, targetTurn] = interaction.customId.split(':');
  const lobby = GameManager.getLobby(channelId);
  const game = lobby?.game;

  if (!lobby || !game || lobby.status !== 'IN_PROGRESS' || game.finished) {
    return interaction.reply(ephemeral('That game is no longer running.'));
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
        components: [confirmRow(channelId, who, game.turnsFor(who))],
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

  // Everyone can see the board, so every control has to check who actually clicked it.
  if (interaction.user.id !== game.currentPlayerId) {
    return interaction.reply(ephemeral(`It's <@${game.currentPlayerId}>'s turn, not yours.`));
  }

  if (action === 'pass') {
    await interaction.deferUpdate();
    const result = await engine.submitPass(interaction.client, lobby, interaction.user.id).catch((err) => {
      console.error(err);
      return { ok: false, error: 'Something went wrong passing the turn.' };
    });
    if (!result.ok) return interaction.followUp(ephemeral(result.error));
    return undefined;
  }

  return interaction.reply(ephemeral('Unknown turn action.'));
}

module.exports = { handle };
