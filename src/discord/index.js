require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const engine = require('./game/engine');
const voice = require('./game/voice');
const GameManager = require('../core/game/GameManager');
const db = require('../core/db/connection');
const { handleComponentInteraction } = require('./components/router');
const { clearVoteTimer } = require('./game/audienceVote');
const { sweepBoards } = require('./game/boards');
const { refreshLobbyBoard } = require('./game/lobbyBoard');
const { cancelConfirmations } = require('./game/characterDM');
const timerWatchdog = require('./game/timerWatchdog');

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

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}. Loaded ${client.commands.size} commands.`);

  // Whatever games were running belong to a process that no longer exists, so retire their
  // boards before anyone can click a button on one. This is the pass that matters: the
  // shutdown handler below only runs on a clean exit, and a force-kill or crash skips it.
  const { found, retired } = await sweepBoards(client).catch((err) => {
    console.error('Error retiring boards left over from the last run:', err.message);
    return { found: 0, retired: 0 };
  });
  if (found) console.log(`Retired ${retired}/${found} board(s) left over from the last run.`);

  timerWatchdog.start(client);

  // Finished lobbies linger in memory (each holding a full Game object) so /rematch can read
  // their settings; without this they'd only ever be freed by a new /lobby create or
  // /lobby end in that channel. Sweep them on their TTL so a long-running bot across many
  // channels doesn't grow without bound. unref() so this never keeps the process alive.
  staleLobbyInterval = setInterval(() => {
    let abandoned = [];
    try {
      abandoned = GameManager.evictStaleLobbies();
    } catch (err) {
      console.error('[evictStaleLobbies]', err);
    }
    // A lobby that never got going is dropped after a day; its board and any confirm DMs should
    // stop looking live. Best-effort: the startup sweep catches anything missed.
    for (const lobby of abandoned) {
      lobby.status = 'CANCELLED';
      refreshLobbyBoard(lobby).catch(() => {});
      if (lobby.game?.confirmState) {
        cancelConfirmations(lobby.game, 'This lobby sat unstarted for a day, so it was closed.').catch(() => {});
      }
    }
  }, STALE_LOBBY_SWEEP_MS);
  staleLobbyInterval.unref?.();
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

// In-memory game state is intentionally not persisted, but the boards it posted, pending
// turn timers, live voice connections and the SQLite WAL all need an orderly teardown --
// otherwise buttons are left hanging in the channel, the bot can hang on exit holding a
// voice socket, and the WAL grows unbounded because it's never checkpointed.
const BOARD_SWEEP_TIMEOUT_MS = 5000;
const STALE_LOBBY_SWEEP_MS = 60 * 60 * 1000; // hourly
let staleLobbyInterval = null;
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down...`);
  timerWatchdog.stop();
  if (staleLobbyInterval) clearInterval(staleLobbyInterval);

  // Best-effort: retire the live boards now rather than leaving them clickable until the
  // next startup sweep. Bounded, because a slow Discord API shouldn't hold up the exit --
  // anything left untouched still has its row, so the next boot cleans it up.
  await Promise.race([
    sweepBoards(client).catch((err) => console.error('Error retiring boards:', err.message)),
    new Promise((resolve) => setTimeout(resolve, BOARD_SWEEP_TIMEOUT_MS)),
  ]);

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
