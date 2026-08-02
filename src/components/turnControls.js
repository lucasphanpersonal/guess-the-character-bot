// Handlers for the turn board's controls.
//
// customIds:
//   turn:right:<channelId>   button  -> the judge rules the spoken guess correct
//   turn:wrong:<channelId>   button  -> the judge rules it wrong
//   turn:pass:<channelId>    button  -> the guesser ends their turn
//
// There is no "submit a guess" control here on purpose. Guesses are said out loud and ruled
// on by the player who can see the answer; a second way to settle the same question would
// mean two authorities on it. `/guess` still exists for anyone who prefers to type.

const { MessageFlags } = require('discord.js');
const GameManager = require('../game/GameManager');
const engine = require('../game/engine');

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

async function handle(interaction) {
  const [, action, channelId] = interaction.customId.split(':');
  const lobby = GameManager.getLobby(channelId);
  const game = lobby?.game;

  if (!lobby || !game || lobby.status !== 'IN_PROGRESS' || game.finished) {
    return interaction.reply(ephemeral('That game is no longer running.'));
  }

  // The board carries two players' controls, so the ownership check depends on the button.
  // Judging belongs to whoever ISN'T guessing -- they're the one who can see the answer.
  if (action === 'right' || action === 'wrong') {
    if (interaction.user.id === game.currentPlayerId) {
      return interaction.reply(
        ephemeral(`You're guessing this turn — <@${game.judgeId}> rules on it. Say your guesses out loud.`)
      );
    }
    if (!game.turnOrder.includes(interaction.user.id)) {
      return interaction.reply(ephemeral(`Only <@${game.judgeId}> can judge this turn.`));
    }

    await interaction.deferUpdate();
    const result = await engine
      .submitJudgement(interaction.client, lobby, interaction.user.id, action === 'right')
      .catch((err) => {
        console.error(err);
        return { ok: false, error: 'Something went wrong recording that.' };
      });
    if (!result.ok) return interaction.followUp(ephemeral(result.error));
    return undefined;
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
