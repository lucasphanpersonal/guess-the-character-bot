const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
  getListByName,
  getCharacters,
  listCategoriesWithCounts,
  listNamesInCategory,
  searchListNames,
} = require('../../db/characterLists');

// Discord caps message content at 2000 chars -- some lists/categories have thousands of
// entries, which would otherwise blow past that and the reply would just fail. Show as many
// items as fit, then note how many more there are.
function truncateJoin(items, prefix) {
  const budget = 1900 - prefix.length;
  let shown = 0;
  let text = '';
  for (const item of items) {
    const piece = shown === 0 ? item : `, ${item}`;
    if (text.length + piece.length > budget) break;
    text += piece;
    shown++;
  }
  const suffix = shown < items.length ? ` ...and ${items.length - shown} more` : '';
  return `${prefix}${text}${suffix}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('list-show')
    .setDescription("Browse categories, list names within one, or one list's characters")
    .addStringOption((opt) => opt.setName('list').setDescription("Show this list's characters").setAutocomplete(true))
    .addStringOption((opt) =>
      opt.setName('category').setDescription('Show list names in this category').setAutocomplete(true)
    ),
  async execute(interaction) {
    const listName = interaction.options.getString('list');
    const categoryName = interaction.options.getString('category');

    if (listName) {
      const list = getListByName(interaction.guildId, listName);
      if (!list) {
        return interaction.reply({ content: `No list named **${listName}**.`, flags: MessageFlags.Ephemeral });
      }
      const chars = getCharacters(list.id);
      if (!chars.length) {
        return interaction.reply({ content: `**${list.name}** has no characters yet.`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({
        content: truncateJoin(chars.map((c) => c.name), `**${list.name}** (${chars.length}): `),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (categoryName) {
      const names = listNamesInCategory(interaction.guildId, categoryName);
      if (!names.length) {
        return interaction.reply({ content: `No lists in category **${categoryName}**.`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({
        content: truncateJoin(names, `**${categoryName}** (${names.length} lists): `),
        flags: MessageFlags.Ephemeral,
      });
    }

    const categories = listCategoriesWithCounts(interaction.guildId);
    if (!categories.length) {
      return interaction.reply({ content: 'No character lists yet. Create one with `/list-create`.', flags: MessageFlags.Ephemeral });
    }
    const content =
      categories.map((c) => `**${c.category}**: ${c.count} list${c.count === 1 ? '' : 's'}`).join('\n') +
      '\n\nUse `/list-show category:<name>` for list names in a category, or `/list-show list:<name>` for a ' +
      "list's characters -- both have autocomplete.";
    return interaction.reply({ content, flags: MessageFlags.Ephemeral });
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
