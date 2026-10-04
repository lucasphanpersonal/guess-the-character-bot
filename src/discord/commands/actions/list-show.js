const { MessageFlags } = require('discord.js');
const { listCategoriesWithCounts, searchListNames } = require('../../../compendium/characterLists');
const { buildBrowsePayload, payloadForList, payloadForCategory } = require('../../components/listBrowser');

module.exports = {
  async execute(interaction) {
    const listName = interaction.options.getString('list');
    const categoryName = interaction.options.getString('category');

    // Every view is paginated and rendered by the shared browser, so the reply and the
    // buttons that follow it look the same.
    const payload = listName
      ? payloadForList(interaction.guildId, listName)
      : categoryName
        ? payloadForCategory(interaction.guildId, categoryName)
        : buildBrowsePayload(interaction.guildId, 'cat', 0, 0);

    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  },
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'list') {
      const matches = searchListNames(interaction.guildId, focused.value);
      return interaction.respond(matches.map((name) => ({ name, value: name })));
    }
    if (focused.name === 'category') {
      const query = focused.value.toLowerCase();
      const categories = listCategoriesWithCounts(interaction.guildId)
        .map((c) => c.category)
        .filter((c) => c.toLowerCase().includes(query))
        .slice(0, 25);
      return interaction.respond(categories.map((name) => ({ name, value: name })));
    }
  },
};
