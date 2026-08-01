// Handlers for the lobby board's buttons (customId `lobby:<action>:<channelId>`).
//
// Because the buttons live ON the board message, `interaction.update(payload)` both
// acknowledges the click and re-renders the board in a single API call.

const { MessageFlags } = require('discord.js');
const GameManager = require('../game/GameManager');
const engine = require('../game/engine');
const { buildLobbyBoardPayload } = require('../game/lobbyBoard');

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

async function handle(interaction) {
  const [, action, channelId] = interaction.customId.split(':');
  const lobby = GameManager.getLobby(channelId);

  if (!lobby) {
    return interaction.reply(ephemeral('This lobby is no longer active. Start a new one with `/create-lobby`.'));
  }
  // Every board button only makes sense while the lobby is still open.
  if (lobby.status !== 'WAITING') {
    return interaction.reply(ephemeral("That lobby has already started -- these buttons aren't active any more."));
  }

  const userId = interaction.user.id;

  if (action === 'join') {
    const result = lobby.addPlayer(userId);
    if (!result.ok) {
      return interaction.reply(
        ephemeral(
          result.reason === 'already-joined'
            ? "You're already in this lobby."
            : 'The lobby already has 2 players -- hit **Spectate** to follow along instead.'
        )
      );
    }
    // Joining as a player means you're no longer a spectator.
    lobby.spectators.delete(userId);
    return interaction.update(buildLobbyBoardPayload(lobby));
  }

  if (action === 'leave') {
    if (!lobby.removePlayer(userId)) {
      return interaction.reply(ephemeral("You're not in the lobby."));
    }
    return interaction.update(buildLobbyBoardPayload(lobby));
  }

  if (action === 'spectate') {
    if (lobby.players.includes(userId)) {
      return interaction.reply(ephemeral("You're a player in this game, not a spectator!"));
    }
    if (lobby.spectators.has(userId)) {
      lobby.spectators.delete(userId);
      await interaction.update(buildLobbyBoardPayload(lobby));
      return interaction.followUp(ephemeral("You're no longer spectating."));
    }
    lobby.spectators.add(userId);
    await interaction.update(buildLobbyBoardPayload(lobby));
    return interaction.followUp(
      ephemeral("👁 You're spectating -- you'll get a DM with both characters once the game starts.")
    );
  }

  if (action === 'start') {
    if (userId !== lobby.hostId) {
      return interaction.reply(ephemeral(`Only the host (<@${lobby.hostId}>) can start the game.`));
    }
    // The button is disabled below 2 players, but someone can still leave between render
    // and click, so re-check before committing.
    if (lobby.players.length !== 2) {
      return interaction.reply(ephemeral(`Need exactly 2 players -- currently ${lobby.players.length}/2.`));
    }

    // Starting sends DMs and posts messages, which can easily exceed Discord's 3s
    // acknowledgement window -- so acknowledge FIRST, then do the slow work.
    await interaction.deferUpdate();
    const result = await engine.startGameFromLobby(interaction.client, lobby).catch((err) => {
      console.error(err);
      return { ok: false, error: 'Something went wrong starting the game.' };
    });
    // startGameFromLobby refreshes the board itself, so there's nothing to update here.
    if (!result.ok) {
      return interaction.followUp(ephemeral(result.error));
    }
    return undefined;
  }

  return interaction.reply(ephemeral('Unknown lobby action.'));
}

module.exports = { handle };
