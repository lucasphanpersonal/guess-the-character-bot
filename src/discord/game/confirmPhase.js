// The confirm phase: the buttons on the DM each player gets when characters are dealt.
//
// Good to go / Unlock / Reroll / Never deal this show all arrive here, because they are one
// decision made in four ways -- am I happy for this person to be wearing this? Keeping them
// together is what stops the reroll paths and the opening DM drifting apart, which they had
// already done once.
//
// Rendering lives in characterDM.js; this file is only the decisions.

const { MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const Game = require('../../core/game/Game');
const GameManager = require('../../core/game/GameManager');
const {
  getRandomCharacterExcluding,
  recordReroll,
  setListsEnabled,
  getListsByIds,
  setCharacterImage,
  REROLL_DEMOTE_THRESHOLD,
} = require('../../compendium/characterLists');
const { buildUnlockRow, checkMessagePayload, checkStatePayload, fanOutReference } = require('./characterDM');
const { requireManageGuild } = require('../util/permissions');

// Required lazily, inside the handler below, rather than at the top of the file: engine.js
// pulls in characterDM.js and this module pulls in engine.js, and a lazy require is what
// keeps that from being a load-time cycle. It is the only thing this file needs from engine.
const maybeBeginPlay = (...a) => require('./engine').maybeBeginPlay(...a);

async function handleConfirmationButton(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[0];
  const channelId = parts[1];
  const gameInstanceId = parts[2];
  
  const lobby = GameManager.getLobby(channelId);
  const game = lobby?.game;
  if (!lobby || !game || lobby.status !== 'CONFIRMING' || !game.confirmState) {
    return interaction.reply({ content: 'This confirmation has expired.', flags: MessageFlags.Ephemeral });
  }

  // Validate gameInstanceId to prevent stale controls from old games (if present)
  if (gameInstanceId && gameInstanceId !== game.gameInstanceId) {
    return interaction.reply({ content: 'This confirmation has expired.', flags: MessageFlags.Ephemeral });
  }

  const playerId = interaction.user.id;
  const state = game.confirmState[playerId];
  if (!state) {
    return interaction.reply({ content: "This isn't your confirmation to respond to.", flags: MessageFlags.Ephemeral });
  }

  if (action === 'confirm') {
    if (state.confirmed) return interaction.deferUpdate();
    state.confirmed = true;
    const waitingOn = game.turnOrder.filter((id) => !game.confirmState[id].confirmed).length;
    await interaction.update({
      content: waitingOn
        ? `✅ Locked in! Waiting on **${waitingOn}** more.\n_Changed your mind? You can unlock until everyone is in._`
        : '✅ Locked in! Starting...',
      embeds: interaction.message.embeds,
      // Deliberately still a live message: until the last player is in, confirming is a
      // decision you can take back. Kept tracked too, so a restart retires the button --
      // which is also why lockConfirmations, not this, is where the tracking ends.
      components: [buildUnlockRow(channelId, gameInstanceId)],
    });
    return maybeBeginPlay(interaction.client, lobby);
  }

  // Undo a confirmation. Only reachable while the lobby is still CONFIRMING -- the guard at
  // the top of this function refuses everything once play has begun, and lockConfirmations
  // strips the button at that moment anyway, so this is a race-loser's path more than a
  // route people will find.
  if (action === 'unconfirm') {
    if (!state.confirmed) return interaction.deferUpdate();
    state.confirmed = false;
    return interaction.update(checkMessagePayload(game, playerId, channelId));
  }

  // "Never deal this show again": drop the list from the server's selection, then reroll,
  // because whoever pressed it does not want this character either. One button doing both
  // is the point -- the alternative is rerolling now and remembering to curate later,
  // which nobody does.
  if (action === 'droplist') {
    if (!(await requireManageGuild(interaction, lobby.guildId))) return;
    if (!game.rerollAllowed) {
      return interaction.reply({
        content: "The audience picked this character — it can't be rerolled.",
        flags: MessageFlags.Ephemeral,
      });
    }
    const unlimited = state.rerollsLeft === -1;
    if (!unlimited && state.rerollsLeft <= 0) {
      return interaction.reply({ content: "You're out of rerolls.", flags: MessageFlags.Ephemeral });
    }

    // The character this player checks -- at two players that is the other one, exactly as
    // before; from three up it is specifically theirs to rule on.
    const otherPlayerId = game.checkTargetOf(playerId);
    const rejected = game.headByPlayer[otherPlayerId];
    const [list] = rejected.listId ? getListsByIds([rejected.listId], lobby.guildId) : [];
    if (!list) {
      return interaction.reply({
        content: "Couldn't tell which list this character came from, so there's nothing to drop.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Drawn from the lobby's own lists minus this one, so the replacement can't come from
    // the show that was just rejected.
    const remaining = lobby.listIds.filter((id) => id !== list.id);
    // Every head in play is excluded, not just the roller's own -- two players wearing the
    // same character would make the game unplayable for both.
    const excludeNames = new Set([
      ...game.turnOrder.map((id) => game.headByPlayer[id].name),
      ...state.rejectedNames,
    ]);
    const replacement = remaining.length
      ? getRandomCharacterExcluding(remaining, excludeNames, lobby.difficulty)
      : null;
    if (!replacement) {
      return interaction.reply({
        content:
          `Dropping **${list.name}** would leave nothing else to deal from in this lobby, so ` +
          'nothing was changed. Reroll instead, or add more lists with `/list select`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    setListsEnabled(lobby.guildId, [list.id], false);
    recordReroll(rejected.id, playerId);
    state.rejectedNames.add(rejected.name);
    if (!unlimited) state.rerollsLeft -= 1;
    game.headByPlayer[otherPlayerId] = Game.head(lobby, replacement);
    // The lobby's own pool is left alone mid-game: pulling the list out from under a game
    // in progress would change what the other player can be dealt on their next reroll for
    // no benefit. The server-wide switch-off is what was asked for, and it takes effect
    // from the next lobby.

    // Rebuilt from the same helper as the opening DM, after the swap, so the new character
    // arrives labelled with whose it is exactly as the first one was.
    await interaction.update(checkMessagePayload(game, playerId, channelId));
    // Everyone else is holding a card that just changed under them.
    await fanOutReference(game, otherPlayerId);
    return interaction.followUp({
      content:
        `🚫 **${list.name}** is out of the pool for future games. ` +
        'Undo any time with `/list toggle`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'reroll') {
    if (!game.rerollAllowed) {
      return interaction.reply({
        content: "The audience picked this character — it can't be rerolled.",
        flags: MessageFlags.Ephemeral,
      });
    }
    const unlimited = state.rerollsLeft === -1;
    if (!unlimited && state.rerollsLeft <= 0) {
      return interaction.reply({ content: "You're out of rerolls.", flags: MessageFlags.Ephemeral });
    }
    // Acknowledge before the SQLite-backed draw so Discord never expires a slow interaction.
    await interaction.deferUpdate();
    const otherPlayerId = game.checkTargetOf(playerId);
    const currentName = game.headByPlayer[otherPlayerId].name;
    const excludeNames = new Set([
      ...game.turnOrder.map((id) => game.headByPlayer[id].name),
      ...state.rejectedNames,
    ]);
    const replacement = getRandomCharacterExcluding(lobby.listIds, excludeNames, lobby.difficulty);
    if (!replacement) {
      return interaction.followUp({
        content: 'No other characters available in this list to reroll to.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Recorded before the swap, while we still know what was rejected. Enough different
    // people rejecting the same character retires it from random draws for good.
    const rejected = game.headByPlayer[otherPlayerId];
    const rejectedBy = recordReroll(rejected.id, playerId);

    state.rejectedNames.add(currentName);
    if (!unlimited) state.rerollsLeft -= 1;
    game.headByPlayer[otherPlayerId] = Game.head(lobby, replacement);

    // Rebuilt from the same helper as the opening DM, after the swap, so the new character
    // arrives labelled with whose it is exactly as the first one was.
    await interaction.editReply(checkMessagePayload(game, playerId, channelId));
    // Everyone else is holding a card that just changed under them.
    await fanOutReference(game, otherPlayerId);

    // Told only at the moment it takes effect, so the feature explains itself once rather
    // than needing documentation nobody reads.
    if (rejectedBy >= REROLL_DEMOTE_THRESHOLD) {
      return interaction.followUp({
        content:
          `🚮 **${rejected.name}** has now been rerolled by ${rejectedBy} different people, ` +
          'so the bot will stop dealing them.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return undefined;
  }
}

// Shared by the image button and its modal submission: finds the game this control belongs
// to and the character the clicking player is the designated checker for. Unlike
// handleConfirmationButton's guard, this deliberately does NOT require lobby.status ===
// 'CONFIRMING' -- a bad image is just as likely to be spotted mid-game as in the few seconds
// before confirming, and the button stays on the DM for exactly that reason.
function resolveCheckerCharacter(interaction) {
  const [, channelId, gameInstanceId] = interaction.customId.split(':');
  const lobby = GameManager.getLobby(channelId);
  const game = lobby?.game;
  const playerId = interaction.user.id;
  if (!lobby || !game || !game.confirmState?.[playerId] || (gameInstanceId && gameInstanceId !== game.gameInstanceId)) {
    return { error: 'This confirmation has expired.' };
  }
  const character = game.headByPlayer[game.checkTargetOf(playerId)];
  // Hand-picked characters from /lobby set-characters (see Game.head) have no list behind
  // them, so there's no row to save an image to.
  if (character.listId == null) {
    return { error: "This character wasn't drawn from a list, so there's nowhere to save an image for it." };
  }
  return { lobby, game, channelId, gameInstanceId, playerId, character };
}

function buildImageModal(channelId, gameInstanceId, character) {
  const modal = new ModalBuilder().setCustomId(`image-submit:${channelId}:${gameInstanceId}`).setTitle('Character image');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('url')
        .setLabel(`Image URL for ${character.name}`.slice(0, 45))
        .setStyle(TextInputStyle.Short)
        .setValue(character.imageUrl ?? '')
        .setPlaceholder('https://...')
        .setMaxLength(500)
        .setRequired(true)
    )
  );
  return modal;
}

async function handleImageButton(interaction) {
  const resolved = resolveCheckerCharacter(interaction);
  if (resolved.error) return interaction.reply({ content: resolved.error, flags: MessageFlags.Ephemeral });
  // showModal has to be the FIRST response to the interaction -- it can't follow a defer.
  return interaction.showModal(buildImageModal(resolved.channelId, resolved.gameInstanceId, resolved.character));
}

async function handleImageModalSubmit(interaction) {
  const resolved = resolveCheckerCharacter(interaction);
  if (resolved.error) return interaction.reply({ content: resolved.error, flags: MessageFlags.Ephemeral });
  const { lobby, game, channelId, playerId, character } = resolved;

  const url = interaction.fields.getTextInputValue('url').trim();
  if (!/^https?:\/\//i.test(url)) {
    return interaction.reply({
      content: 'Image must be a URL starting with http:// or https://. Nothing was changed.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const ownerId = game.checkTargetOf(playerId);
  setCharacterImage(character.listId, character.name, url);
  character.imageUrl = url; // keep the in-memory head in sync with the row just written

  await interaction.update(checkStatePayload(game, playerId, channelId, lobby.status !== 'CONFIRMING'));
  // Everyone else holding this character as a reference card is looking at the old image.
  await fanOutReference(game, ownerId);
  return interaction.followUp({ content: `🖼️ Saved the image for **${character.name}**.`, flags: MessageFlags.Ephemeral });
}

module.exports = { handleConfirmationButton, handleImageButton, handleImageModalSubmit };
