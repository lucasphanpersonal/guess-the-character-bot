// Composing and sending the messages that show a character.
//
// Split out of engine.js because it is the part that gets rendered from several places at
// once -- the opening DM, both reroll paths, the fan-out after a reroll, the completion
// reveal, the spectator DM -- and every time a second copy of one of these payloads existed,
// the copies drifted. Three separate bugs came from exactly that: the reroll paths losing the
// audience-vote wording, the spectator DM keeping a two-player copy of the character list, and
// the final reveal repeating characters that had already been shown.
//
// So the rule this file exists to enforce: **if a message is rendered from more than one
// place, it is built here, once.**

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { trackBoard, untrackBoard } = require('./boards');

// Discord renders at most 10 embeds per message.
const MAX_EMBEDS = 10;

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// A character's name plus the work it comes from, on its own line so the name stays the
// thing your eye lands on. Omitted entirely when the source is unknown or would just
// restate the name.
function withSource(line, source) {
  return source ? `${line}\n*from ${source}*` : line;
}

// description: the text shown above the embed(s), e.g. who this character belongs to.
// characters: array of { label, name, imageUrl, source } -- one embed per character.
function characterMessage(description, characters) {
  const embeds = characters.map(({ label, name, imageUrl, source }) => {
    const embed = new EmbedBuilder().setDescription(withSource(`**${label}**: **${name}**`, source));
    if (imageUrl) embed.setImage(imageUrl);
    return embed;
  });
  return { content: description, embeds };
}

function buildConfirmRow(channelId, rerollsLeft, { allowReroll = true, canDropList = false } = {}) {
  const unlimited = rerollsLeft === -1;
  const confirmBtn = new ButtonBuilder()
    .setCustomId(`confirm:${channelId}`)
    .setLabel(allowReroll ? 'Good to go' : 'Ready')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success);
  // In audience-vote mode the crowd already decided, so the reroll button is omitted
  // entirely rather than shown disabled (which would read as a bug).
  if (!allowReroll) return new ActionRowBuilder().addComponents(confirmBtn);

  const rerollBtn = new ButtonBuilder()
    .setCustomId(`reroll:${channelId}`)
    .setLabel(unlimited ? 'Reroll' : rerollsLeft > 0 ? `Reroll (${rerollsLeft} left)` : 'No rerolls left')
    .setEmoji('🔁')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!unlimited && rerollsLeft <= 0);

  const row = new ActionRowBuilder().addComponents(confirmBtn, rerollBtn);
  // The moment somebody is staring at a character they don't recognise is the only moment
  // they will ever want to curate, so the curation lives here rather than in a command they
  // would have to remember twenty minutes later.
  if (canDropList) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`droplist:${channelId}`)
        .setLabel('Never deal this show')
        .setEmoji('🚫')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!unlimited && rerollsLeft <= 0)
    );
  }
  return row;
}

// What a locked-in player is left holding: a way back out, until everyone is in.
function buildUnlockRow(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`unconfirm:${channelId}`)
      .setLabel('Unlock')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Secondary)
  );
}

// Labelled with whose character it is, in the same shape the reference DM uses, so scrolling
// back to it answers "who was this for?" without having to remember.
function confirmCharacterEmbed(character, ownerName) {
  const embed = new EmbedBuilder().setDescription(
    withSource(`**${ownerName}'s character**: **${character.name}**`, character.source)
  );
  if (character.imageUrl) embed.setImage(character.imageUrl);
  return embed;
}

/**
 * The message a player acts on: the one character they're checking, whose it is, and the
 * controls for it.
 *
 * Rendered from three places (the opening DM and both reroll paths). Naming the owner leaks
 * nothing: everyone except the wearer already knows this character, and the wearer never
 * sees this message.
 */
function checkMessagePayload(game, checkerId, channelId) {
  const state = game.confirmState[checkerId];
  const ownerId = game.checkTargetOf(checkerId);
  const character = game.headByPlayer[ownerId];
  const owner = game.nameOf(ownerId);

  const instruction = game.rerollAllowed
    ? `👤 You're checking **${owner}**'s character — use it to answer their questions. ` +
      "If you don't think they'll recognise it, reroll it."
    : `👤 **${owner}**'s character, chosen by the audience — use it to answer their questions, ` +
      'then hit **Ready**.';

  return {
    content: `🗂️ Playing with: **${game.listLabel}**\n\n${instruction}\n_(You can't see your own.)_`,
    embeds: [confirmCharacterEmbed(character, owner)],
    components: [
      buildConfirmRow(channelId, state.rerollsLeft, {
        allowReroll: game.rerollAllowed,
        // Only offerable when we know which list the character came from, which rules out
        // hand-assigned characters from /lobby set-characters.
        canDropList: game.rerollAllowed && character.listId != null,
      }),
    ],
  };
}

// The characters a player needs to recognise but is NOT the checker for: everyone except
// themselves and their check target. Empty at two players, which is why the reference
// message only exists from three up.
function referenceHeadsFor(game, playerId) {
  const target = game.checkTargetOf(playerId);
  return game.turnOrder.filter((id) => id !== playerId && id !== target);
}

// The read-only half of the DM. No components at all -- everything here belongs to somebody
// else to check, and a control that isn't yours is just noise you have to read past.
function referencePayload(game, playerIds) {
  return characterMessage(
    '📖 **The others**, so you can answer questions about them. Nothing here is yours to check.',
    playerIds.map((id) => ({ label: `${game.nameOf(id)}'s character`, ...game.headByPlayer[id] }))
  );
}

/**
 * The DM each player gets when characters are dealt, as TWO messages.
 *
 * Discord renders components after every embed, so a single message would strand the button
 * row below N-1 character cards with nothing saying which one it acts on. Splitting puts the
 * controls back beside their subject, and confines the 10-embed ceiling to the message that
 * has no buttons.
 *
 * Returns false if the player cannot receive every card needed to judge the game.
 */
async function sendConfirmDMs(recipientUser, game, channelId) {
  const state = game.confirmState[recipientUser.id];

  try {
    const dm = await recipientUser.send(checkMessagePayload(game, recipientUser.id, channelId));
    trackBoard('confirm', dm);
    state.checkMessage = dm;
  } catch {
    return false;
  }

  // Best-effort: the check message is the one that gates the game starting, so a reference
  // message that fails to send is not worth refusing to play over.
  state.referenceMessages = [];
  const others = referenceHeadsFor(game, recipientUser.id);
  if (others.length) {
    for (const page of chunk(others, MAX_EMBEDS)) {
      try {
        state.referenceMessages.push(await recipientUser.send(referencePayload(game, page)));
      } catch {
        return false;
      }
    }
  }
  return true;
}

/**
 * Re-renders the reference message of everybody who can see `changedPlayerId`'s character,
 * after a reroll swapped it.
 *
 * Unavoidable, and the price of characters being shared rather than per-viewer: at two
 * players a reroll is private to the one person looking at it, and from three up it
 * invalidates what everyone else is holding. Confirmed players are included -- their message
 * has had its buttons stripped, but they still have to answer questions about the character
 * all game.
 */
async function fanOutReference(game, changedPlayerId) {
  await Promise.all(
    game.turnOrder.map(async (viewerId) => {
      if (viewerId === changedPlayerId) return; // never sees their own
      if (game.checkTargetOf(viewerId) === changedPlayerId) return; // it's on their check message
      const state = game.confirmState[viewerId];
      const pages = state?.referenceMessages ?? [];
      if (!pages.length) return;
      const heads = chunk(referenceHeadsFor(game, viewerId), MAX_EMBEDS);
      await Promise.all(
        pages.map((message, i) =>
          heads[i] ? message.edit(referencePayload(game, heads[i])).catch(() => {}) : null
        )
      );
    })
  );
}

/**
 * Retires the ↩️ Unlock buttons once play actually begins.
 *
 * Being able to change your mind only means anything while everyone is still deciding, so
 * the moment the game starts those buttons stop being an option and become a lie. The DM
 * itself stays -- it is the reference for the character you spend the game answering
 * questions about.
 */
async function retireConfirmations(game, contentForPlayer, { clearEmbeds = false } = {}) {
  await Promise.all(
    game.turnOrder.map(async (playerId) => {
      const message = game.confirmState[playerId]?.checkMessage;
      if (!message) return;
      try {
        const payload = {
          content: contentForPlayer(playerId),
          components: [],
        };
        // A successful start leaves the character card as a useful in-game reference. A
        // cancelled start must not leave a stale character visible before a retry.
        if (clearEmbeds) payload.embeds = [];
        await message.edit(payload);
      } catch {
        // Nothing to be done about a DM we can no longer edit.
      }
      untrackBoard(message);
    })
  );
}

async function lockConfirmations(game) {
  return retireConfirmations(
    game,
    (playerId) =>
      `✅ Locked in — the game is under way. This is **${game.nameOf(game.checkTargetOf(playerId))}'s character; ` +
      'use it to answer their questions.'
  );
}

async function cancelConfirmations(game) {
  const cancelledContent =
    '⚠️ The game did not start because a player could not receive their DMs. ' +
    'Ask the host to try again once every player enables DMs from server members.';
  await retireConfirmations(
    game,
    () => cancelledContent,
    { clearEmbeds: true }
  );
  await Promise.all(
    game.turnOrder.flatMap((playerId) =>
      (game.confirmState[playerId]?.referenceMessages ?? []).map(async (message) => {
        try {
          await message.edit({ content: cancelledContent, embeds: [], components: [] });
        } catch {
          // Nothing to be done about a DM we can no longer edit.
        }
      })
    )
  );
}

/**
 * Every player's character, to one spectator.
 *
 * The single path for it, used by the opening sweep, `/lobby spectate` and the turn board's
 * 👁 button alike -- the command used to carry its own copy, which still destructured two
 * players out of the turn order and so showed a five-player game as a two-player one.
 *
 * One embed per player against a 10-embed ceiling, so a big table needs several messages.
 */
async function sendSpectatorDM(client, lobby, userId) {
  const game = lobby.game;
  if (!game) return false;
  const pages = chunk(game.turnOrder, MAX_EMBEDS);
  try {
    const user = await client.users.fetch(userId);
    for (const [i, page] of pages.entries()) {
      const header =
        i === 0
          ? `🗂️ Playing with: **${game.listLabel}**\n🕵️ Spectator info for the game in <#${lobby.channelId}>:`
          : `…continued (${i + 1}/${pages.length})`;
      await user.send(
        characterMessage(
          header,
          page.map((id) => ({ label: `${game.nameOf(id)}'s head`, ...game.headByPlayer[id] }))
        )
      );
    }
    return true;
  } catch {
    return false; // DMs closed
  }
}

async function sendSpectatorDMs(client, lobby) {
  const game = lobby.game;
  const playing = new Set(game.turnOrder);

  const spectatorIds = new Set(lobby.spectators);
  try {
    // Every player's channel, not just the first one's -- whoever happens to be listed first
    // may be the one person playing from their phone, and that used to mean nobody sitting
    // with the rest got auto-added.
    const guild = await client.guilds.fetch(lobby.guildId);
    const members = await Promise.all(
      game.turnOrder.map((id) => guild.members.fetch(id).catch(() => null))
    );
    const channels = new Map();
    for (const member of members) {
      const channel = member?.voice?.channel;
      if (channel) channels.set(channel.id, channel);
    }
    for (const channel of channels.values()) {
      for (const [, m] of channel.members) {
        if (!playing.has(m.id)) spectatorIds.add(m.id);
      }
    }
  } catch {
    // best-effort voice detection only
  }

  for (const specId of spectatorIds) {
    await sendSpectatorDM(client, lobby, specId);
  }
}

module.exports = {
  MAX_EMBEDS,
  chunk,
  characterMessage,
  buildUnlockRow,
  checkMessagePayload,
  sendConfirmDMs,
  fanOutReference,
  lockConfirmations,
  cancelConfirmations,
  sendSpectatorDM,
  sendSpectatorDMs,
};
