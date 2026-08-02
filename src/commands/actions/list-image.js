const { MessageFlags } = require('discord.js');
const {
  getListByName,
  setCharacterImage,
  searchListNames,
  searchCharactersInLists,
} = require('../../db/characterLists');

module.exports = {
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
