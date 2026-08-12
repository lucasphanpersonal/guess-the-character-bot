const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} = require('@discordjs/voice');
const path = require('path');
const fs = require('fs');

const SOUNDS_DIR = path.join(__dirname, '..', '..', '..', 'data', 'sounds');
const CHIME_PATH = path.join(SOUNDS_DIR, 'chime.wav');
const CORRECT_PATH = path.join(SOUNDS_DIR, 'correct.wav');
const WRONG_PATH = path.join(SOUNDS_DIR, 'wrong.wav');
const WIN_PATH = path.join(SOUNDS_DIR, 'win.wav');
const WIN_SOUND_DURATION_MS = 750; // roughly how long win.wav takes to play out

// Warn once at startup rather than failing silently per-play mid-game.
const missingSounds = [CHIME_PATH, CORRECT_PATH, WRONG_PATH, WIN_PATH].filter((p) => !fs.existsSync(p));
if (missingSounds.length) {
  console.warn(
    `[voice] Missing sound file(s): ${missingSounds.map((p) => path.basename(p)).join(', ')}. ` +
      'Run `npm run generate:sounds`. Games still work, just without audio.'
  );
}

/**
 * Which game currently holds the bot's voice connection in each guild.
 *
 * A bot has exactly ONE voice connection per server -- `getVoiceConnection(guildId)` takes a
 * guild and nothing else, because there is nothing else to take. Two games running in two
 * channels therefore cannot both have sound, and the failure was not a quiet one:
 *
 *   - joining for the second game MOVED the bot out of the first game's channel;
 *   - a connection carries one subscription, so the second game's player displaced the
 *     first's, and the surviving sounds played into the wrong room;
 *   - and whichever game finished first called destroy() on the shared connection, cutting
 *     off a game that was still being played.
 *
 * So voice is claimed, and the claim is honoured. The first game to want it gets it; a second
 * concurrent game plays text-only and is told why. Nothing is silently taken from anyone.
 */
const voiceOwnerByGuild = new Map();

const guildOf = (game) => game?.lobby?.guildId ?? null;

/** The game holding voice in this guild, if it is still worth honouring. */
function voiceHolder(guildId) {
  const owner = voiceOwnerByGuild.get(guildId);
  // A finished game's claim expires with it, so the next game can have the channel.
  if (owner && owner.finished) {
    voiceOwnerByGuild.delete(guildId);
    return null;
  }
  return owner ?? null;
}

/** @returns true if `game` may use voice -- either it already holds it, or nobody does. */
function claimVoice(game) {
  const guildId = guildOf(game);
  if (!guildId) return false;
  const holder = voiceHolder(guildId);
  if (holder && holder !== game) return false;
  voiceOwnerByGuild.set(guildId, game);
  return true;
}

function releaseVoice(game) {
  const guildId = guildOf(game);
  if (guildId && voiceOwnerByGuild.get(guildId) === game) voiceOwnerByGuild.delete(guildId);
}

// The voice channel holding the most players, provided at least two of them are in it.
//
// At two players that is exactly the old rule -- both in the same channel or nothing -- but
// it no longer breaks the moment a third joins. Requiring ALL players would mean one person
// on a phone silences the sounds for everybody else, and taking the first player's channel
// would ignore five people sitting together because player one happened to be elsewhere.
async function findSharedVoiceChannel(guild, playerIds) {
  const members = await Promise.all(playerIds.map((id) => guild.members.fetch(id).catch(() => null)));
  const byChannel = new Map();
  for (const member of members) {
    const channel = member?.voice?.channel;
    if (!channel) continue;
    const entry = byChannel.get(channel.id) ?? { channel, count: 0 };
    entry.count++;
    byChannel.set(channel.id, entry);
  }
  let best = null;
  for (const entry of byChannel.values()) {
    if (entry.count >= 2 && (!best || entry.count > best.count)) best = entry;
  }
  return best?.channel ?? null;
}

// Called once, from maybeBeginPlay. Silently no-ops if the players aren't in a shared
// voice channel, or if joining/connecting fails for any reason -- the text countdown
// remains the sole fallback in every case.
async function joinVoiceForGame(client, lobby) {
  const game = lobby.game;
  // Checked before anything is fetched: joining would move the bot out of the other game's
  // channel, and the other game is already being played.
  const holder = voiceHolder(lobby.guildId);
  if (holder && holder !== game) {
    return { joined: false, takenBy: holder.lobby?.channelId ?? null };
  }
  try {
    const guild = await client.guilds.fetch(lobby.guildId);
    const channel = await findSharedVoiceChannel(guild, game.turnOrder);
    if (!channel) return { joined: false };

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Discord is reconnecting us (e.g. a brief blip) -- let it proceed.
      } catch {
        connection.destroy();
        if (game.voiceConnection === connection) {
          game.voiceConnection = null;
          game.audioPlayer = null;
        }
      }
    });
    connection.on('error', (err) => console.warn('[voice] connection error:', err.message));

    const player = createAudioPlayer();
    player.on('error', (err) => console.warn('[voice] player error:', err.message));
    connection.subscribe(player);

    game.voiceConnection = connection;
    game.audioPlayer = player;
    claimVoice(game);
    return { joined: true };
  } catch (err) {
    console.warn('[voice] Skipping voice join (continuing text-only):', err.message);
    return { joined: false };
  }
}

// Shared by all the named play*Sound helpers below. No-op if there's no live connection.
function playSound(game, filePath, label) {
  if (!game.voiceConnection || !game.audioPlayer) return;
  try {
    if (game.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
      game.audioPlayer.stop(); // cuts off an overlapping sound at a tight timing gap
    }
    game.audioPlayer.play(createAudioResource(filePath));
  } catch (err) {
    console.warn(`[voice] Failed to play ${label} sound:`, err.message);
  }
}

// Called once per countdown checkpoint.
function playChime(game) {
  playSound(game, CHIME_PATH, 'countdown chime');
}

// Called on a correct/wrong guess, and once when the game is won.
function playCorrectSound(game) {
  playSound(game, CORRECT_PATH, 'correct-guess');
}
function playWrongSound(game) {
  playSound(game, WRONG_PATH, 'wrong-guess');
}
function playWinSound(game) {
  playSound(game, WIN_PATH, 'win');
}

// Called from finalizeGame and end-game.js -- NOT from clearTimers, which fires every
// turn. Idempotent/safe even if voice was never joined.
function leaveVoiceForGame(game) {
  if (!game) return;
  releaseVoice(game);
  try {
    game.audioPlayer?.stop();
    // Destroyed only by the game that opened it. The connection is shared per guild, so a
    // game tearing down one it never claimed would cut off whoever is actually using it.
    if (game.voiceConnection) game.voiceConnection.destroy();
  } catch (err) {
    console.warn('[voice] Error leaving voice channel:', err.message);
  } finally {
    game.voiceConnection = null;
    game.audioPlayer = null;
  }
}

module.exports = {
  joinVoiceForGame,
  voiceHolder,
  claimVoice,
  releaseVoice,
  playChime,
  playCorrectSound,
  playWrongSound,
  playWinSound,
  leaveVoiceForGame,
  WIN_SOUND_DURATION_MS,
};
