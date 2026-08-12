const { MessageFlags } = require('discord.js');
const { 
  getListByName, 
  addCharacter, 
  searchListNames, 
  searchCharactersInLists, 
  setCharacterImage 
} = require('../../../core/db/characterLists');
const { requireManageGuild } = require('../../util/permissions');

module.exports = {
  async execute(interaction) {
    if (!(await requireManageGuild(interaction))) return;
    const listName = interaction.options.getString('list').trim();
    const characterName = interaction.options.getString('character').trim();
    const imageUrl = interaction.options.getString('image')?.trim() || null;
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
      return interaction.reply({ 
        content: 'Image must be a URL starting with http:// or https://.', 
        flags: MessageFlags.Ephemeral 
      });
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
      return interaction.reply(`✅ Added **${characterName}** to **${listName}**.`);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        // If an image URL was provided, update the existing character's image in-place
        if (imageUrl) {
          setCharacterImage(list.id, characterName, imageUrl);
          return interaction.reply(`✅ Updated image for **${characterName}** in **${listName}**.`);
        }
        
        // Otherwise, throw the standard duplicate error
        return interaction.reply({ 
          content: `**${characterName}** is already in **${listName}**.`, 
          flags: MessageFlags.Ephemeral 
        });
      }
      throw err;
    }
  },
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'list') {
      const matches = searchListNames(interaction.guildId, focused.value, 25);
      return interaction.respond(matches.map((name) => ({ name, value: name })));
    }
    if (focused.name === 'character') {
      const listName = interaction.options.getString('list');
      if (!listName) return interaction.respond([]);
      const list = getListByName(interaction.guildId, listName);
      const matches = list ? searchCharactersInLists([list.id], focused.value) : [];
      return interaction.respond(matches.map((name) => ({ name, value: name })));
    }
  }
};