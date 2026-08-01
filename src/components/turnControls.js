// Handlers for the turn board's Guess / Pass controls.
//
// customIds:
//   turn:guess:<channelId>   button  -> opens the guess modal
//   turn:submit:<channelId>  modal   -> the submitted guess
//   turn:pass:<channelId>    button  -> ends the turn

const {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const GameManager = require('../game/GameManager');
const engine = require('../game/engine');

const GUESS_INPUT_ID = 'guess';
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

function buildGuessModal(channelId) {
  return new ModalBuilder()
    .setCustomId(`turn:submit:${channelId}`)
    .setTitle('Guess the character')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(GUESS_INPUT_ID)
          .setLabel('Who do you think you are?')
          .setPlaceholder('Typos are fine, and a first or last name alone works')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
      )
    );
}

async function handle(interaction) {
  const [, action, channelId] = interaction.customId.split(':');
  const lobby = GameManager.getLobby(channelId);
  const game = lobby?.game;

  if (!lobby || !game || lobby.status !== 'IN_PROGRESS' || game.finished) {
    return interaction.reply(ephemeral('That game is no longer running.'));
  }
  // Everyone can see the board, so every control has to check who actually clicked it.
  if (interaction.user.id !== game.currentPlayerId) {
    return interaction.reply(ephemeral(`It's <@${game.currentPlayerId}>'s turn, not yours.`));
  }

  if (action === 'guess') {
    // showModal has to be the FIRST response to the interaction -- it can't follow a defer.
    return interaction.showModal(buildGuessModal(channelId));
  }

  if (action === 'submit') {
    const guessText = interaction.fields.getTextInputValue(GUESS_INPUT_ID);
    // Resolving a guess can end the turn and post the next board, which may exceed the 3s
    // window -- acknowledge first. The modal came from a button, so deferUpdate is valid.
    if (interaction.isFromMessage()) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const result = await engine
      .submitGuess(interaction.client, lobby, interaction.user.id, guessText)
      .catch((err) => {
        console.error(err);
        return { ok: false, error: 'Something went wrong submitting that guess.' };
      });

    if (!result.ok) return interaction.followUp(ephemeral(result.error));
    // The board already shows the guess and its ✅/❌, so keep the private note minimal.
    return interaction.followUp(ephemeral(result.correct ? '✅ Correct!' : '❌ Not quite.'));
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

module.exports = { handle, buildGuessModal };
