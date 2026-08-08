const { MessageFlags } = require('discord.js');
const { createList, getListByName, listCategoriesWithCounts } = require('../../db/characterLists');
const { requireManageGuild } = require('../../util/permissions');

module.exports = {
  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'This command must be used in a server.', flags: MessageFlags.Ephemeral });
    }
    if (!(await requireManageGuild(interaction))) return;
    const name = interaction.options.getString('name').trim();
    const category = interaction.options.getString('category').trim();
    if (getListByName(interaction.guildId, name)) {
      return interaction.reply({ content: `A list named **${name}** already exists.`, flags: MessageFlags.Ephemeral });
    }
    // Enabled on creation: typing a list out by hand is a deliberate choice, unlike the
    // thousands the seed scripts add, so it should be playable without a trip to
    // /list select.
    createList(interaction.guildId, name, interaction.user.id, category, { enabled: true });
    return interaction.reply(
      `✅ Created character list **${name}**, enabled for pooled draws. ` +
        `Add characters with \`/list add list:${name} character:<name>\`.`
    );
  },
  // Suggests categories already in use, so "Anime" and "Anim" don't end up as two different
  // categories by typo -- but nothing stops typing a genuinely new one, same as everywhere
  // else in this bot an autocompleted string isn't a fixed set of choices.
  async autocomplete(interaction) {
    const query = interaction.options.getFocused().toLowerCase();
    const categories = listCategoriesWithCounts(interaction.guildId)
      .map((c) => c.category)
      .filter((c) => c.toLowerCase().includes(query))
      .slice(0, 25);
    return interaction.respond(categories.map((name) => ({ name, value: name })));
  },
};
