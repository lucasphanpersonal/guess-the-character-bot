// Handlers for the lobby board's buttons (customId `lobby:<action>:<channelId>`) and for
// the settings modal they open (`lobby:save-settings:<channelId>`).
//
// Because the buttons live ON the board message, `interaction.update(payload)` both
// acknowledges the click and re-renders the board in a single API call.

const {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const GameManager = require('../game/GameManager');
const engine = require('../game/engine');
const { buildLobbyBoardPayload } = require('../game/lobbyBoard');
const {
  FIELDS,
  fieldsForMode,
  parseSettings,
  votePoolError,
  displayValue,
} = require('../game/lobbySettings');
const {
  DIFFICULTIES,
  countDistinctCharacters,
  getCharacterByNameInLists,
  getListLabelForIds,
} = require('../db/characterLists');

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// Prefilled with the values in force, so the modal reads as an edit form rather than a
// blank one -- the host can see what they're changing from without closing it again.
function buildSettingsModal(lobby) {
  const modal = new ModalBuilder()
    .setCustomId(`lobby:save-settings:${lobby.channelId}`)
    .setTitle('Lobby settings');

  for (const key of fieldsForMode(lobby.mode)) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(key)
          .setLabel(FIELDS[key].label)
          .setStyle(TextInputStyle.Short)
          .setValue(displayValue(key, lobby[key]))
          .setMaxLength(12)
          // Optional, so clearing a field leaves that setting alone instead of blocking
          // the whole submission on a box the host didn't want to touch.
          .setRequired(false)
      )
    );
  }
  return modal;
}

// Two boxes, one per player, prefilled with whatever is already assigned. No autocomplete
// -- modals have none -- so `/lobby set-characters` stays for anyone who wants help finding
// a name in a 12,000-character pool.
function buildCharactersModal(lobby) {
  const [p1, p2] = lobby.players;
  const modal = new ModalBuilder()
    .setCustomId(`lobby:save-characters:${lobby.channelId}`)
    .setTitle('Hand-pick both characters');

  for (const [key, playerId] of [['player1', p1], ['player2', p2]]) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(key)
          .setLabel(`Character for player ${key.slice(-1)}`)
          .setStyle(TextInputStyle.Short)
          .setValue(lobby.assignedCharacters[playerId]?.name ?? '')
          .setMaxLength(100)
          // Blank in both boxes clears the assignment back to a random deal.
          .setRequired(false)
      )
    );
  }
  return modal;
}

async function handle(interaction) {
  const [, action, channelId] = interaction.customId.split(':');
  const lobby = GameManager.getLobby(channelId);

  if (!lobby) {
    return interaction.reply(ephemeral('This lobby is no longer active. Start a new one with `/lobby create`.'));
  }
  // Every board button only makes sense while the lobby is still open.
  if (lobby.status !== 'WAITING') {
    return interaction.reply(ephemeral("That lobby has already started -- these buttons aren't active any more."));
  }

  const userId = interaction.user.id;
  const notHost =
    userId !== lobby.hostId ? `Only the host (<@${lobby.hostId}>) can change the lobby settings.` : null;

  if (action === 'settings') {
    if (notHost) return interaction.reply(ephemeral(notHost));
    // showModal has to be the FIRST response to the interaction -- it can't follow a defer.
    return interaction.showModal(buildSettingsModal(lobby));
  }

  if (action === 'save-settings') {
    if (notHost) return interaction.reply(ephemeral(notHost));

    const submitted = Object.fromEntries(
      fieldsForMode(lobby.mode).map((key) => [key, interaction.fields.getTextInputValue(key)])
    );
    const { ok, values, errors } = parseSettings(submitted);
    if (!ok) {
      return interaction.reply(ephemeral(`Nothing changed:\n${errors.map((e) => `• ${e}`).join('\n')}`));
    }

    if (lobby.mode === 'audience-vote') {
      const poolError = votePoolError(lobby.listIds, values.voteOptions ?? lobby.voteOptions, lobby.difficulty);
      if (poolError) return interaction.reply(ephemeral(`Nothing changed: ${poolError}`));
    }

    Object.assign(lobby, values);
    return interaction.update(buildLobbyBoardPayload(lobby));
  }

  if (action === 'characters' || action === 'save-characters') {
    if (notHost) return interaction.reply(ephemeral(notHost));
    if (lobby.players.length !== 2) {
      return interaction.reply(ephemeral(`Need both players joined first -- currently ${lobby.players.length}/2.`));
    }

    if (action === 'characters') {
      return interaction.showModal(buildCharactersModal(lobby));
    }

    const [p1, p2] = lobby.players;
    const typed = {
      [p1]: interaction.fields.getTextInputValue('player1').trim(),
      [p2]: interaction.fields.getTextInputValue('player2').trim(),
    };

    // Clearing both is how you go back to a random deal.
    if (!typed[p1] && !typed[p2]) {
      lobby.assignedCharacters = {};
      await interaction.update(buildLobbyBoardPayload(lobby));
      return interaction.followUp(ephemeral('🎲 Cleared -- both characters will be dealt at random.'));
    }

    const resolved = {};
    const missing = [];
    for (const playerId of [p1, p2]) {
      const found = getCharacterByNameInLists(lobby.listIds, typed[playerId]);
      if (found) resolved[playerId] = found;
      else missing.push(typed[playerId] || '(blank)');
    }
    if (missing.length) {
      return interaction.reply(
        ephemeral(
          `Couldn't find ${missing.map((n) => `**${n}**`).join(' or ')} in this lobby's lists ` +
            `(${getListLabelForIds(lobby.listIds)}). Nothing was changed -- ` +
            '`/lobby set-characters` has autocomplete if you want help spelling them.'
        )
      );
    }
    if (resolved[p1].name.toLowerCase() === resolved[p2].name.toLowerCase()) {
      return interaction.reply(ephemeral('Both players need different characters. Nothing was changed.'));
    }

    lobby.assignedCharacters = resolved;
    // The board only ever says THAT characters are set, never which -- the players are
    // reading it, and their own character is the one thing they must not see.
    await interaction.update(buildLobbyBoardPayload(lobby));
    return interaction.followUp(
      ephemeral(`✅ Set. Only you can see this: <@${p1}> gets **${resolved[p1].name}**, <@${p2}> gets **${resolved[p2].name}**.`)
    );
  }

  if (action === 'difficulty') {
    if (notHost) return interaction.reply(ephemeral(notHost));

    // Cycles rather than opening a picker: three states fit in a label, and a click that
    // shows its result immediately beats a menu that has to be dismissed.
    const order = Object.keys(DIFFICULTIES);
    const next = order[(order.indexOf(lobby.difficulty) + 1) % order.length];
    lobby.difficulty = next;

    const pool = countDistinctCharacters(lobby.listIds, next);
    if (pool < 2) {
      // Easy on a tiny selection can starve the pool; say so rather than failing at Start.
      lobby.difficulty = order[order.indexOf(next) === 0 ? order.length - 1 : order.indexOf(next) - 1];
      return interaction.reply(
        ephemeral(
          `**${DIFFICULTIES[next].label}** would leave only ${pool} character(s) to draw from -- ` +
            'enable more lists with `/list select` first.'
        )
      );
    }

    await interaction.update(buildLobbyBoardPayload(lobby));
    return interaction.followUp(
      ephemeral(`🎚️ **${DIFFICULTIES[next].label}** -- ${DIFFICULTIES[next].blurb}. ${pool} characters in the pool.`)
    );
  }

  if (action === 'mode') {
    if (notHost) return interaction.reply(ephemeral(notHost));

    if (lobby.mode === 'audience-vote') {
      lobby.mode = 'classic';
      return interaction.update(buildLobbyBoardPayload(lobby));
    }

    // Same guard /lobby create applies, re-run here because the pool is fixed but the
    // vote settings are not.
    const poolError = votePoolError(lobby.listIds, lobby.voteOptions, lobby.difficulty);
    if (poolError) return interaction.reply(ephemeral(poolError));

    lobby.mode = 'audience-vote';
    // startGameFromLobby hands off to the vote before it ever looks at assignedCharacters,
    // so a host who already ran /lobby set-characters needs telling their picks are now moot.
    const overridesSetCharacters = Object.keys(lobby.assignedCharacters).length > 0;
    await interaction.update(buildLobbyBoardPayload(lobby));
    if (overridesSetCharacters) {
      return interaction.followUp(
        ephemeral(
          '🗳️ Audience vote is on -- the crowd now picks both characters, so your ' +
            '`/lobby set-characters` picks are ignored. Turn it back off to use them.'
        )
      );
    }
    return undefined;
  }

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

module.exports = { handle, buildSettingsModal, buildCharactersModal };
