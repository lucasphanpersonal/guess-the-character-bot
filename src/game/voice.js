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

const SOUNDS_DIR = path.join(__dirname, '..', '..', 'data', 'sounds');
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

// Stricter than sendSpectatorDMs's voice lookup in engine.js (which only checks player
// 1's channel, on purpose, for auto-spectating) -- this requires BOTH players in the same
// channel, and is used only for the voice-join decision.
async function findSharedVoiceChannel(guild, p1Id, p2Id) {
  const [member1, member2] = await Promise.all([
    guild.members.fetch(p1Id).catch(() => null),
    guild.members.fetch(p2Id).catch(() => null),
  ]);
  const ch1 = member1?.voice?.channel;
  const ch2 = member2?.voice?.channel;
  return ch1 && ch2 && ch1.id === ch2.id ? ch1 : null;
}

// Called once, from maybeBeginPlay. Silently no-ops if the players aren't in a shared
// voice channel, or if joining/connecting fails for any reason -- the text countdown
// remains the sole fallback in every case.
async function joinVoiceForGame(client, lobby) {
  const game = lobby.game;
  try {
    const guild = await client.guilds.fetch(lobby.guildId);
    const [p1Id, p2Id] = game.turnOrder;
    const channel = await findSharedVoiceChannel(guild, p1Id, p2Id);
    if (!channel) return;

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
  } catch (err) {
    console.warn('[voice] Skipping voice join (continuing text-only):', err.message);
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
  try {
    game.audioPlayer?.stop();
    game.voiceConnection?.destroy();
  } catch (err) {
    console.warn('[voice] Error leaving voice channel:', err.message);
  } finally {
    game.voiceConnection = null;
    game.audioPlayer = null;
  }
}

module.exports = {
  joinVoiceForGame,
  playChime,
  playCorrectSound,
  playWrongSound,
  playWinSound,
  leaveVoiceForGame,
  WIN_SOUND_DURATION_MS,
};
