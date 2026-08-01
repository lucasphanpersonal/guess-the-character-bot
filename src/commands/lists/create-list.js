const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { createList, getListByName } = require('../../db/characterLists');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('list-create')
    .setDescription('Create a new character list for Guess the Character')
    .addStringOption((opt) => opt.setName('name').setDescription('Name of the list').setRequired(true))
    .addStringOption((opt) =>
      opt.setName('category').setDescription('Category/media type, e.g. "Anime", "Video Games"').setRequired(true)
    ),
  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'This command must be used in a server.', flags: MessageFlags.Ephemeral });
    }
    const name = interaction.options.getString('name').trim();
    const category = interaction.options.getString('category').trim();
    if (getListByName(interaction.guildId, name)) {
      return interaction.reply({ content: `A list named **${name}** already exists.`, flags: MessageFlags.Ephemeral });
    }
    createList(interaction.guildId, name, interaction.user.id, category);
    return interaction.reply(
      `✅ Created character list **${name}**. Add characters with \`/list-add-character list:${name} character:<name>\`.`
    );
  },
};
