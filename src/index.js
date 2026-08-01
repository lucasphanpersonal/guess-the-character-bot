require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const engine = require('./game/engine');
const voice = require('./game/voice');
const GameManager = require('./game/GameManager');
const db = require('./db/connection');
const { handleComponentInteraction } = require('./components/router');
const { clearVoteTimer } = require('./game/audienceVote');

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
client.commands = new Collection();

function loadCommands(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      loadCommands(full);
    } else if (entry.name.endsWith('.js')) {
      const command = require(full);
      if (command?.data && command?.execute) {
        client.commands.set(command.data.name, command);
      }
    }
  }
}
loadCommands(path.join(__dirname, 'commands'));

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}. Loaded ${client.commands.size} commands.`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(err);
      const payload = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction);
    } catch (err) {
      console.error(err);
    }
    return;
  }

  if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    try {
      await handleComponentInteraction(interaction);
    } catch (err) {
      console.error(err);
      const payload = { content: 'Something went wrong handling that.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
});

// In-memory game state is intentionally not persisted, but pending turn timers, live voice
// connections and the SQLite WAL all need an orderly teardown -- otherwise the bot can hang
// on exit holding a voice socket, and the WAL grows unbounded because it's never
// checkpointed.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down...`);

  for (const lobby of GameManager.allLobbies()) {
    try {
      clearVoteTimer(lobby.vote);
      if (lobby.game) {
        engine.clearTimers(lobby.game);
        voice.leaveVoiceForGame(lobby.game);
      }
    } catch (err) {
      console.error('Error cleaning up a game:', err.message);
    }
  }
  GameManager.clear();

  try {
    await client.destroy();
  } catch (err) {
    console.error('Error closing the Discord client:', err.message);
  }

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (err) {
    console.error('Error closing the database:', err.message);
  }

  console.log('Shutdown complete.');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  });
}

process.on('unhandledRejection', (err) => console.error('Unhandled promise rejection:', err));

client.login(process.env.DISCORD_TOKEN);
