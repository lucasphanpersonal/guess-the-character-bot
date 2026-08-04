// `/lobby <action>` -- everything you can do to a lobby, in one place.
//
// These were seven top-level commands (create-lobby, join-lobby, leave-lobby, start-game,
// end-game, status, spectate) scattered from `c` to `s` in a picker that sorts
// alphabetically. Typing `/l` returned nine results, seven of them list management nobody
// wants mid-game, and finding "how do I stop this" meant already knowing it was called
// end-game rather than game-end or cancel.
//
// Grouping puts the answer to "what can I do to this lobby?" behind one word. `/guess` and
// `/pass` deliberately stay top-level: they're typed mid-turn under a clock, where an extra
// menu costs more than the tidiness is worth.

const { SlashCommandBuilder } = require('discord.js');

const create = require('./actions/lobby-create');
const join = require('./actions/lobby-join');
const leave = require('./actions/lobby-leave');
const start = require('./actions/lobby-start');
const end = require('./actions/lobby-end');
const status = require('./actions/lobby-status');
const spectate = require('./actions/lobby-spectate');
const setCharacters = require('./actions/lobby-set-characters');

const ACTIONS = { create, join, leave, start, end, status, spectate, 'set-characters': setCharacters };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lobby')
    .setDescription('Create and manage a Guess the Character lobby')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Open a lobby in this channel')
        .addStringOption((opt) =>
          opt
            .setName('from')
            .setDescription('What to draw from: a category, everything, or list names (defaults to a random category)')
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('difficulty')
            .setDescription('How deep into each cast to draw (default normal)')
            .addChoices(
              { name: 'Easy -- best-known quarter of each cast', value: 'easy' },
              { name: 'Normal -- skips the deepest cuts', value: 'normal' },
              { name: 'Everything -- every character, however obscure', value: 'everything' }
            )
        )
        .addIntegerOption((opt) =>
          opt.setName('turn-seconds').setDescription('Seconds per turn (default 90)').setMinValue(15).setMaxValue(600)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('max-rerolls')
            .setDescription('Rerolls per player before confirming a character (default 2, -1 for unlimited)')
            .setMinValue(-1)
        )
        .addBooleanOption((opt) =>
          opt
            .setName('audience-vote')
            .setDescription("Let the audience vote on each player's character instead of the bot picking")
        )
        .addIntegerOption((opt) =>
          opt
            .setName('vote-options')
            .setDescription('Audience vote: candidates offered per player (default 5)')
            .setMinValue(2)
            .setMaxValue(25)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('vote-seconds')
            .setDescription('Audience vote: how long voting stays open (default 90)')
            .setMinValue(15)
            .setMaxValue(300)
        )
    )
    .addSubcommand((sub) => sub.setName('join').setDescription('Join the waiting lobby as a player'))
    .addSubcommand((sub) =>
      sub.setName('leave').setDescription('Leave the lobby — or forfeit, if the game is already under way')
    )
    .addSubcommand((sub) => sub.setName('start').setDescription('Start the game once at least 2 players have joined'))
    .addSubcommand((sub) =>
      sub.setName('end').setDescription('Cancel the lobby or game in this channel (host or admin only)')
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('Show whose turn it is and how long is left'))
    .addSubcommand((sub) =>
      sub
        .setName('spectate')
        // Says "toggle" because it is one -- running it again stops you spectating, which
        // the old name and description both hid.
        .setDescription("Toggle spectating: get every player's character DMed to you")
    )
    .addSubcommand((sub) => {
      sub
        .setName('set-characters')
        .setDescription('Host only: hand-pick players’ hidden characters -- with autocomplete, unlike the board button');
      // player1/character1 and player2/character2 stay required, matching how this command
      // has always worked. player3-5 are optional on top of that: a slash command can't
      // express "N pairs", so this is as many pairs as fit under Discord's 25-option cap
      // while also matching MAX_ASSIGNABLE_PLAYERS, the modal's own ceiling.
      //
      // Leaving a later pair's character blank (while still naming the player) deals that
      // player at random -- same rule as the board's modal, so the two paths behave alike.
      for (let i = 1; i <= 5; i++) {
        const required = i <= 2;
        sub.addUserOption((opt) =>
          opt.setName(`player${i}`).setDescription(`Player ${i}${required ? '' : ' (optional)'}`).setRequired(required)
        );
        sub.addStringOption((opt) =>
          opt
            .setName(`character${i}`)
            .setDescription(`player${i}'s hidden character${required ? '' : ' (blank = deal at random)'}`)
            .setRequired(false)
            .setAutocomplete(true)
        );
      }
      return sub;
    }),

  async execute(interaction) {
    return ACTIONS[interaction.options.getSubcommand()].execute(interaction);
  },

  async autocomplete(interaction) {
    const action = ACTIONS[interaction.options.getSubcommand()];
    if (!action?.autocomplete) return interaction.respond([]);
    return action.autocomplete(interaction);
  },
};
