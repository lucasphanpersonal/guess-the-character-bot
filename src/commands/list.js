// `/list <action>` -- building character lists, and choosing which ones this server plays
// with.
//
// The noun-first names these replace (list-create, list-add-character, ...) already
// clustered usefully in the picker, which is the argument for the grouping rather than
// against it: one word now shows the whole family instead of seven near-identical entries.
//
// `select` was called `list-filter`, which described the wrong thing -- it does not filter a
// view, it sets persistent server state about what is playable.

const { SlashCommandBuilder } = require('discord.js');

const create = require('./actions/list-create');
const add = require('./actions/list-add');
const remove = require('./actions/list-remove');
const image = require('./actions/list-image');
const show = require('./actions/list-show');
const toggle = require('./actions/list-toggle');
const select = require('./actions/list-select');

const ACTIONS = { create, add, remove, image, show, toggle, select };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('list')
    .setDescription('Build character lists and choose which ones this server plays with')
    .addSubcommand((sub) =>
      sub
        .setName('show')
        .setDescription('Browse categories, the lists in one, or one list\'s characters')
        .addStringOption((opt) =>
          opt.setName('list').setDescription("Show this list's characters").setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt.setName('category').setDescription('Show the list names in this category').setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('select')
        .setDescription('Choose which lists this server plays with (governs category, everything and random draws)')
        .addStringOption((opt) =>
          opt.setName('category').setDescription('Jump straight into one category').setAutocomplete(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('top')
            // No backticks: Discord renders option descriptions as plain text, so markdown
            // shows up literally.
            .setDescription('Enable the N best-known lists instead of ticking boxes -- all categories, or just one')
            .setMinValue(1)
            .setMaxValue(1000)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('toggle')
        .setDescription('Switch one list in or out of the pool this server plays with')
        .addStringOption((opt) =>
          opt.setName('list').setDescription('The list to switch').setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a new character list')
        .addStringOption((opt) => opt.setName('name').setDescription('Name of the list').setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName('category')
            .setDescription('Category or media type, e.g. Anime or Video Games')
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a character to a list')
        .addStringOption((opt) =>
          opt.setName('list').setDescription('List name').setRequired(true).setAutocomplete(true)
        )
        .addStringOption((opt) => opt.setName('character').setDescription('Character name').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('image').setDescription('Image URL shown when this character is revealed')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a character from a list')
        .addStringOption((opt) =>
          opt.setName('list').setDescription('List name').setRequired(true).setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt.setName('character').setDescription('Character name').setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('image')
        .setDescription('Attach or update the image shown when a character is revealed')
        .addStringOption((opt) =>
          opt.setName('list').setDescription('List name').setRequired(true).setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt.setName('character').setDescription('Character name').setRequired(true).setAutocomplete(true)
        )
        .addStringOption((opt) => opt.setName('image').setDescription('Image URL').setRequired(true))
    ),

  async execute(interaction) {
    return ACTIONS[interaction.options.getSubcommand()].execute(interaction);
  },

  async autocomplete(interaction) {
    const action = ACTIONS[interaction.options.getSubcommand()];
    if (!action?.autocomplete) return interaction.respond([]);
    return action.autocomplete(interaction);
  },
};
