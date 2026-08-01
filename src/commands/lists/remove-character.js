const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getListByName, removeCharacter, searchListNames, searchCharactersInLists } = require('../../db/characterLists');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('list-remove-character')
    .setDescription('Remove a character from a list')
    .addStringOption((opt) => opt.setName('list').setDescription('List name').setRequired(true).setAutocomplete(true))
    .addStringOption((opt) =>
      opt.setName('character').setDescription('Character name').setRequired(true).setAutocomplete(true)
    ),
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'list') {
      const matches = searchListNames(interaction.guildId, focused.value);
      return interaction.respond(matches.map((name) => ({ name, value: name })));
    }
    // Suggest characters from whichever list has been picked so far (if any).
    const listName = interaction.options.getString('list');
    const list = listName ? getListByName(interaction.guildId, listName) : null;
    if (!list) return interaction.respond([]);
    const matches = searchCharactersInLists([list.id], focused.value);
    return interaction.respond(matches.map((name) => ({ name, value: name })));
  },
  async execute(interaction) {
    const listName = interaction.options.getString('list').trim();
    const characterName = interaction.options.getString('character').trim();
    const list = getListByName(interaction.guildId, listName);
    if (!list) {
      return interaction.reply({ content: `No list named **${listName}**.`, flags: MessageFlags.Ephemeral });
    }
    const removed = removeCharacter(list.id, characterName);
    return interaction.reply({
      content: removed ? `Removed **${characterName}** from **${listName}**.` : `**${characterName}** wasn't in **${listName}**.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
