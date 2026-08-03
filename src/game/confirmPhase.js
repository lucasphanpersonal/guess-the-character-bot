// The confirm phase: the buttons on the DM each player gets when characters are dealt.
//
// Good to go / Unlock / Reroll / Never deal this show all arrive here, because they are one
// decision made in four ways -- am I happy for this person to be wearing this? Keeping them
// together is what stops the reroll paths and the opening DM drifting apart, which they had
// already done once.
//
// Rendering lives in characterDM.js; this file is only the decisions.

const { MessageFlags } = require('discord.js');
const Game = require('./Game');
const GameManager = require('./GameManager');
const {
  getRandomCharacterExcluding,
  recordReroll,
  setListsEnabled,
  getListsByIds,
  REROLL_DEMOTE_THRESHOLD,
} = require('../db/characterLists');
const { buildUnlockRow, checkMessagePayload, fanOutReference } = require('./characterDM');

// Required lazily, inside the handler below, rather than at the top of the file: engine.js
// pulls in characterDM.js and this module pulls in engine.js, and a lazy require is what
// keeps that from being a load-time cycle. It is the only thing this file needs from engine.
const maybeBeginPlay = (...a) => require('./engine').maybeBeginPlay(...a);

async function handleConfirmationButton(interaction) {
  const [action, channelId] = interaction.customId.split(':');
  const lobby = GameManager.getLobby(channelId);
  const game = lobby?.game;
  if (!lobby || !game || lobby.status !== 'CONFIRMING' || !game.confirmState) {
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
      components: [buildUnlockRow(channelId)],
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
    const [list] = rejected.listId ? getListsByIds([rejected.listId]) : [];
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

    setListsEnabled([list.id], false);
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
    const otherPlayerId = game.checkTargetOf(playerId);
    const currentName = game.headByPlayer[otherPlayerId].name;
    const excludeNames = new Set([
      ...game.turnOrder.map((id) => game.headByPlayer[id].name),
      ...state.rejectedNames,
    ]);
    const replacement = getRandomCharacterExcluding(lobby.listIds, excludeNames, lobby.difficulty);
    if (!replacement) {
      return interaction.reply({ content: 'No other characters available in this list to reroll to.', flags: MessageFlags.Ephemeral });
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
    await interaction.update(checkMessagePayload(game, playerId, channelId));
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

module.exports = { handleConfirmationButton };
