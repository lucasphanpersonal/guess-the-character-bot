const { PermissionFlagsBits, MessageFlags } = require('discord.js');

async function hasManageGuildPermission(interaction, guildId = interaction.guildId) {
  if (interaction.memberPermissions) {
    return interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild);
  }
  if (!guildId) return false;

  const guild = await interaction.client.guilds.fetch(guildId);
  const member = await guild.members.fetch(interaction.user.id);
  return member?.permissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function requireManageGuild(interaction, guildId) {
  if (await hasManageGuildPermission(interaction, guildId)) return true;
  await interaction.reply({
    content: 'You need the Manage Server permission to change this server\'s character lists.',
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

module.exports = { hasManageGuildPermission, requireManageGuild };
