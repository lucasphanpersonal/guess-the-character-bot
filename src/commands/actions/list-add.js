const { MessageFlags } = require('discord.js');
const { getListByName, addCharacter, searchListNames } = require('../../db/characterLists');

module.exports = {
  async execute(interaction) {
    const listName = interaction.options.getString('list').trim();
    const characterName = interaction.options.getString('character').trim();
    const imageUrl = interaction.options.getString('image')?.trim() || null;
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
      return interaction.reply({ content: 'Image must be a URL starting with http:// or https://.', flags: MessageFlags.Ephemeral });
    }
    const list = getListByName(interaction.guildId, listName);
    if (!list) {
      return interaction.reply({
        content: `No list named **${listName}** found. Create it with \`/list create\`.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    try {
      addCharacter(list.id, characterName, interaction.user.id, imageUrl);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return interaction.reply({ content: `**${characterName}** is already in **${listName}**.`, flags: MessageFlags.Ephemeral });
      }
      throw err;
    }
    return interaction.reply(`✅ Added **${characterName}** to **${listName}**.`);
  },
};
