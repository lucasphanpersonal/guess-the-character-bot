require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes, InteractionContextType } = require('discord.js');

// Everything except /help operates on server state (lobbies, lists, stats) and is
// meaningless in a DM, so it's marked guild-only centrally here rather than repeating
// .setContexts(...) in every command file. Only matters for global registration -- guild
// -scoped commands are already unavailable in DMs.
const DM_CAPABLE_COMMANDS = new Set(['help']);

function collectCommands(dir) {
  let commands = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      commands = commands.concat(collectCommands(full));
    } else if (entry.name.endsWith('.js')) {
      const command = require(full);
      if (!command?.data) continue;
      const json = command.data.toJSON();
      if (!DM_CAPABLE_COMMANDS.has(json.name)) {
        json.contexts = [InteractionContextType.Guild];
      }
      commands.push(json);
    }
  }
  return commands;
}

const commands = collectCommands(path.join(__dirname, 'commands'));
const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
      : Routes.applicationCommands(process.env.CLIENT_ID);
    const data = await rest.put(route, { body: commands });
    console.log(
      `Registered ${data.length} slash commands${process.env.GUILD_ID ? ` to guild ${process.env.GUILD_ID}` : ' globally'}.`
    );
  } catch (err) {
    console.error(err);
  }
})();
