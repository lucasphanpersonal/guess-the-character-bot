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
const { buildLobbyBoardPayload, MIN_PLAYERS, MAX_ASSIGNABLE_PLAYERS } = require('../game/lobbyBoard');
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
// One input per player. A modal holds five, which is why the board button disables itself
// past MAX_ASSIGNABLE_PLAYERS rather than opening something that cannot be built.
function buildCharactersModal(lobby) {
  const modal = new ModalBuilder()
    .setCustomId(`lobby:save-characters:${lobby.channelId}`)
    .setTitle('Hand-pick the characters');

  lobby.players.forEach((playerId, i) => {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`player${i + 1}`)
          .setLabel(`Character for player ${i + 1}`)
          .setStyle(TextInputStyle.Short)
          .setValue(lobby.assignedCharacters[playerId]?.name ?? '')
          .setMaxLength(100)
          // Leaving every box blank clears the assignment back to a random deal.
          .setRequired(false)
      )
    );
  });
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
    if (lobby.players.length < MIN_PLAYERS) {
      return interaction.reply(ephemeral(`Need at least ${MIN_PLAYERS} players joined first -- currently ${lobby.players.length}.`));
    }
    if (lobby.players.length > MAX_ASSIGNABLE_PLAYERS) {
      return interaction.reply(
        ephemeral(
          `Hand-picking tops out at ${MAX_ASSIGNABLE_PLAYERS} players -- a modal holds five boxes and this ` +
            `needs one each, and there are ${lobby.players.length}. They'll be dealt at random.`
        )
      );
    }

    if (action === 'characters') {
      return interaction.showModal(buildCharactersModal(lobby));
    }

    const typed = Object.fromEntries(
      lobby.players.map((id, i) => [id, interaction.fields.getTextInputValue(`player${i + 1}`).trim()])
    );

    // Leaving every box blank is how you go back to a random deal.
    if (lobby.players.every((id) => !typed[id])) {
      lobby.assignedCharacters = {};
      await interaction.update(buildLobbyBoardPayload(lobby));
      return interaction.followUp(ephemeral('🎲 Cleared -- characters will be dealt at random.'));
    }

    // A blank box means "deal this player at random" -- it is only a problem when EVERY box
    // is blank, and that case already returned above. Left in the loop below, a blank typed
    // value would be looked up as a character literally named "", fail, and get reported back
    // as "(blank)" alongside anything genuinely misspelled.
    const resolved = {};
    const missing = [];
    for (const playerId of lobby.players) {
      if (!typed[playerId]) continue;
      const found = getCharacterByNameInLists(lobby.listIds, typed[playerId]);
      if (found) resolved[playerId] = found;
      else missing.push(typed[playerId]);
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
    // One character can only sit on one head, so duplicates would make the game unplayable
    // for everyone wearing the repeat. Checked only among what was actually typed -- the
    // players left blank are dealt at random later and can't collide with anything yet.
    const typedNames = Object.values(resolved).map((c) => c.name.toLowerCase());
    if (new Set(typedNames).size !== typedNames.length) {
      return interaction.reply(ephemeral('Every hand-picked player needs a different character. Nothing was changed.'));
    }

    lobby.assignedCharacters = resolved;
    // The board only ever says THAT characters are set, never which -- the players are
    // reading it, and their own character is the one thing they must not see.
    await interaction.update(buildLobbyBoardPayload(lobby));
    return interaction.followUp(
      ephemeral(
        '✅ Set. Only you can see this: ' +
          lobby.players
            .map((id) => `<@${id}> gets **${resolved[id] ? resolved[id].name : 'a random character'}**`)
            .join(', ') +
          '.'
      )
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
    // Already-joined is the only way this fails now: there is no lobby size limit.
    const result = lobby.addPlayer(userId);
    if (!result.ok) {
      return interaction.reply(ephemeral("You're already in this lobby."));
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
    if (lobby.players.length < MIN_PLAYERS) {
      return interaction.reply(ephemeral(`Need at least ${MIN_PLAYERS} players -- currently ${lobby.players.length}.`));
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
