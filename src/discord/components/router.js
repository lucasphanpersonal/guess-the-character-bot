// Routes anything carrying a customId -- buttons, select menus and modal submissions -- to
// a handler based on the first segment, which is namespaced as `<namespace>:<...>`.
//
// Keeping this in one place means adding a new interactive control is a one-line
// registration rather than another branch in the interactionCreate handler.

const { MessageFlags } = require('discord.js');
const confirmPhase = require('../game/confirmPhase');
const lobbyButtons = require('./lobbyButtons');
const turnControls = require('./turnControls');
const voteControls = require('./voteControls');
const gameOverControls = require('./gameOverControls');
const listBrowser = require('./listBrowser');
const listFilter = require('./listFilter');

const HANDLERS = {
  // Character confirm/reroll buttons, sent in DMs when a game starts.
  confirm: (interaction) => confirmPhase.handleConfirmationButton(interaction),
  // Taking a confirmation back, while everyone is still deciding.
  unconfirm: (interaction) => confirmPhase.handleConfirmationButton(interaction),
  reroll: (interaction) => confirmPhase.handleConfirmationButton(interaction),
  // "Never deal this show again", alongside Reroll on the confirmation DM.
  droplist: (interaction) => confirmPhase.handleConfirmationButton(interaction),
  // Add/replace image button on the check DM, and the modal it opens.
  image: (interaction) => confirmPhase.handleImageButton(interaction),
  'image-submit': (interaction) => confirmPhase.handleImageModalSubmit(interaction),
  // Lobby board buttons.
  lobby: (interaction) => lobbyButtons.handle(interaction),
  // Turn board buttons, and the ✅ / Give up confirmations they raise.
  turn: (interaction) => turnControls.handle(interaction),
  // Confirming that you really do want to leave a game already under way.
  forfeit: (interaction) => turnControls.handleForfeit(interaction),
  // Audience vote board, ballot select menus, and host close button.
  vote: (interaction) => voteControls.handle(interaction),
  // End-of-game reveal buttons.
  over: (interaction) => gameOverControls.handle(interaction),
  // `/list show` pagination (Prev / Next / Back).
  browse: (interaction) => listBrowser.handle(interaction),
  // `/list select` checkboxes for the server's playable list selection.
  filter: (interaction) => listFilter.handle(interaction),
};

async function handleComponentInteraction(interaction) {
  const namespace = interaction.customId.split(':')[0];
  const handler = HANDLERS[namespace];
  if (!handler) {
    // Most likely a control left over from an older version of the bot.
    return interaction.reply({
      content: 'That control is no longer available.',
      flags: MessageFlags.Ephemeral,
    });
  }
  return handler(interaction);
}

module.exports = { handleComponentInteraction, HANDLERS };
