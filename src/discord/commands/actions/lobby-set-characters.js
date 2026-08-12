const { MessageFlags } = require('discord.js');
const GameManager = require('../../../core/game/GameManager');
const {
  getCharacterByNameInLists,
  freeformCharacter,
  searchCharactersInLists,
} = require('../../../core/db/characterLists');

const MAX_SLOTS = 5;

module.exports = {
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby || lobby.status !== 'WAITING') {
      return interaction.reply({ content: 'No waiting lobby to assign characters for.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.user.id !== lobby.hostId) {
      return interaction.reply({ content: 'Only the host who created the lobby can assign characters.', flags: MessageFlags.Ephemeral });
    }

    // Unlike the board's modal, this command has no way to show what is already assigned, so
    // it is a targeted edit rather than a full re-declaration: only the slots you actually
    // filled in this call are touched, and everything else about the lobby's existing
    // assignedCharacters is left exactly as it was. Naming a player with no character is how
    // you clear just that one player back to random -- the modal's "leave the box blank" done
    // one player at a time instead of all five at once.
    const slots = [];
    for (let i = 1; i <= MAX_SLOTS; i++) {
      const player = interaction.options.getUser(`player${i}`);
      const characterRaw = interaction.options.getString(`character${i}`);
      const character = characterRaw?.trim() || null;
      if (!player && !character) continue;
      slots.push({ i, player, character });
    }

    if (!slots.length) {
      return interaction.reply({
        content: 'Nothing to do -- pick at least one player (with or without a character for them).',
        flags: MessageFlags.Ephemeral,
      });
    }

    const orphanCharacter = slots.find((s) => s.character && !s.player);
    if (orphanCharacter) {
      return interaction.reply({
        content: `character${orphanCharacter.i} was given without a matching player${orphanCharacter.i}. Nothing was changed.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const seenPlayers = new Map();
    for (const { i, player } of slots) {
      if (seenPlayers.has(player.id)) {
        return interaction.reply({
          content: `<@${player.id}> was picked for both player${seenPlayers.get(player.id)} and player${i}. Nothing was changed.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      seenPlayers.set(player.id, i);
    }
    const notJoined = slots.find((s) => !lobby.players.includes(s.player.id));
    if (notJoined) {
      return interaction.reply({
        content:
          `<@${notJoined.player.id}> hasn't joined this lobby. Players who have: ` +
          `${lobby.players.map((id) => `<@${id}>`).join(', ') || '(none yet)'}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const resolved = {}; // playerId -> character row, for slots that named one
    const cleared = []; // playerId, for slots naming a player with no character
    for (const { player, character } of slots) {
      if (!character) {
        cleared.push(player.id);
        continue;
      }
      // A name that isn't in any of this lobby's lists is taken literally rather than
      // refused -- an inside joke, a real person not in the database, whatever the host
      // typed is what gets worn. Autocomplete is there if they wanted the real thing and
      // mistyped it; this is for when they didn't.
      resolved[player.id] = getCharacterByNameInLists(lobby.listIds, character) || freeformCharacter(character);
    }

    // Checked against the assignment as it will exist AFTER this call, not just what was
    // typed just now -- naming Alex as Luffy when Sam already has Luffy from an earlier call
    // is exactly as unplayable as naming them both Luffy in the same command.
    const merged = { ...lobby.assignedCharacters };
    for (const id of cleared) delete merged[id];
    Object.assign(merged, resolved);
    const names = Object.values(merged).map((c) => c.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      return interaction.reply({ content: 'Two players would end up with the same character. Nothing was changed.', flags: MessageFlags.Ephemeral });
    }

    lobby.assignedCharacters = merged;

    // Ephemeral and deliberately vague about who has what -- if this were visible to the
    // players in the channel, or spelled out person-by-person, it'd spoil their own hidden
    // character even though the host typed it in the shared channel.
    const changed = [
      ...Object.keys(resolved).map((id) => `<@${id}> gets a hand-picked character`),
      ...cleared.map((id) => `<@${id}> is back to random`),
    ];
    return interaction.reply({
      content: `✅ ${changed.join(', ')}. Only you can see this. Run \`/lobby start\` when ready.`,
      flags: MessageFlags.Ephemeral,
    });
  },
  async autocomplete(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby) return interaction.respond([]);
    const focused = interaction.options.getFocused();
    const matches = searchCharactersInLists(lobby.listIds, focused);
    return interaction.respond(matches.map((name) => ({ name, value: name })));
  },
};
