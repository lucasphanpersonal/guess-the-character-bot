const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
  getListByName,
  setCharacterImage,
  searchListNames,
  searchCharactersInLists,
} = require('../../db/characterLists');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('list-set-image')
    .setDescription('Attach or update the image shown when a character is revealed')
    .addStringOption((opt) => opt.setName('list').setDescription('List name').setRequired(true).setAutocomplete(true))
    .addStringOption((opt) =>
      opt.setName('character').setDescription('Character name').setRequired(true).setAutocomplete(true)
    )
    .addStringOption((opt) => opt.setName('image').setDescription('Image URL').setRequired(true)),
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'list') {
      const matches = searchListNames(interaction.guildId, focused.value);
      return interaction.respond(matches.map((name) => ({ name, value: name })));
    }
    const listName = interaction.options.getString('list');
    const list = listName ? getListByName(interaction.guildId, listName) : null;
    if (!list) return interaction.respond([]);
    const matches = searchCharactersInLists([list.id], focused.value);
    return interaction.respond(matches.map((name) => ({ name, value: name })));
  },
  async execute(interaction) {
    const listName = interaction.options.getString('list').trim();
    const characterName = interaction.options.getString('character').trim();
    const imageUrl = interaction.options.getString('image').trim();
    if (!/^https?:\/\//i.test(imageUrl)) {
      return interaction.reply({ content: 'Image must be a URL starting with http:// or https://.', flags: MessageFlags.Ephemeral });
    }
    const list = getListByName(interaction.guildId, listName);
    if (!list) {
      return interaction.reply({ content: `No list named **${listName}**.`, flags: MessageFlags.Ephemeral });
    }
    const updated = setCharacterImage(list.id, characterName, imageUrl);
    return interaction.reply({
      content: updated ? `✅ Updated image for **${characterName}**.` : `**${characterName}** isn't in **${listName}**.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
