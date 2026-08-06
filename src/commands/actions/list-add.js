const { MessageFlags } = require('discord.js');
const { getListByName, addCharacter, searchListNames, searchCharactersInLists } = require('../../db/characterLists');
const { requireManageGuild } = require('../../util/permissions');

module.exports = {
  async execute(interaction) {
    if (!(await requireManageGuild(interaction))) return;
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
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'list') {
      const matches = searchListNames(interaction.guildId, focused.value, 25);
      return interaction.respond(matches.map((name) => ({ name, value: name })));
    }
    if (focused.name === 'character') {
      const listName = interaction.options.getString('list');
      if (!listName) return interaction.respond([]);
      const matches = searchCharactersInLists(interaction.guildId, focused.value, [listName]);
      return interaction.respond(matches.map((name) => ({ name, value: name })));
    }
  }
};
