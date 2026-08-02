const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { categoriesView, categoryView } = require('../components/listFilter');
const { listCategoriesWithEnabledCounts, enableTopN } = require('../db/characterLists');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('list-filter')
    .setDescription('Choose which character lists this server plays with')
    .addStringOption((opt) =>
      opt.setName('category').setDescription('Jump straight into one category').setAutocomplete(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('top')
        .setDescription('Enable the N best-known lists instead of ticking boxes (all categories, or just `category`)')
        .setMinValue(1)
        .setMaxValue(1000)
    ),
  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'This command must be used in a server.', flags: MessageFlags.Ephemeral });
    }

    const requested = interaction.options.getString('category');
    const top = interaction.options.getInteger('top');

    // The threshold path exists so the common case -- "give us the well-known ones" -- never
    // involves paging through checkboxes at all.
    if (top != null) {
      const counts = listCategoriesWithEnabledCounts(interaction.guildId);
      if (requested && !counts.some((c) => c.category.toLowerCase() === requested.toLowerCase())) {
        return interaction.reply({
          content: `No lists in category **${requested}**.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const category = requested
        ? counts.find((c) => c.category.toLowerCase() === requested.toLowerCase()).category
        : null;

      const added = enableTopN(interaction.guildId, category, top);
      const scope = category ? `**${category}**` : 'every category';
      const nowOn = listCategoriesWithEnabledCounts(interaction.guildId).reduce((sum, c) => sum + c.enabled, 0);
      return interaction.reply({
        content:
          `✅ Enabled the top ${top} in ${scope} -- ${added} newly switched on, **${nowOn}** lists enabled in total.\n` +
          '-# Only adds; nothing already enabled was turned off. Run `/list-filter` to fine-tune.',
        flags: MessageFlags.Ephemeral,
      });
    }

    let payload;
    if (requested) {
      const index = listCategoriesWithEnabledCounts(interaction.guildId).findIndex(
        (c) => c.category.toLowerCase() === requested.toLowerCase()
      );
      payload =
        index >= 0
          ? categoryView(interaction.guildId, index, 0)
          : { content: `No lists in category **${requested}**.`, components: [] };
    } else {
      payload = categoriesView(interaction.guildId, 0);
    }

    // Ephemeral: the selection it edits is server-wide, but the page itself is a control
    // panel, not an announcement -- and a shared one would go stale the moment two people
    // curated at once.
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  },
  async autocomplete(interaction) {
    const query = interaction.options.getFocused().toLowerCase();
    const choices = listCategoriesWithEnabledCounts(interaction.guildId)
      .filter((c) => c.category.toLowerCase().includes(query))
      .slice(0, 25)
      .map((c) => ({ name: `${c.category} (${c.enabled}/${c.count} enabled)`, value: c.category }));
    return interaction.respond(choices);
  },
};
