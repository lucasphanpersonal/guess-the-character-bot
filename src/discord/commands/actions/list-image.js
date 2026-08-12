const { MessageFlags } = require('discord.js');
const { requireManageGuild } = require('../../util/permissions');
const {
  getListByName,
  setCharacterImage,
  searchListNames,
  searchCharactersInLists,
} = require('../../../core/db/characterLists');

module.exports = {
  async execute(interaction) {
    if (!(await requireManageGuild(interaction))) return;
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
  },
};
