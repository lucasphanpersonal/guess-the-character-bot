const { MessageFlags } = require('discord.js');
const { createList, getListByName } = require('../../db/characterLists');

module.exports = {
  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'This command must be used in a server.', flags: MessageFlags.Ephemeral });
    }
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
};
