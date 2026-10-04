const { MessageFlags } = require('discord.js');
const { getListByName, removeCharacter } = require('../../../compendium/characterLists');
const { requireManageGuild } = require('../../util/permissions');

module.exports = {
  async execute(interaction) {
    if (!(await requireManageGuild(interaction))) return;
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
