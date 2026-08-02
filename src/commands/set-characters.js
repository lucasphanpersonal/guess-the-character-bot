const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const GameManager = require('../game/GameManager');
const {
  getCharacterByNameInLists,
  searchCharactersInLists,
  getListLabelForIds,
} = require('../db/characterLists');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-characters')
    .setDescription("Host only: assign each player's own hidden character instead of leaving it random")
    .addUserOption((opt) => opt.setName('player1').setDescription('First player').setRequired(true))
    .addStringOption((opt) =>
      opt.setName('character1').setDescription("player1's hidden character").setRequired(true).setAutocomplete(true)
    )
    .addUserOption((opt) => opt.setName('player2').setDescription('Second player').setRequired(true))
    .addStringOption((opt) =>
      opt.setName('character2').setDescription("player2's hidden character").setRequired(true).setAutocomplete(true)
    ),
  async execute(interaction) {
    const lobby = GameManager.getLobby(interaction.channelId);
    if (!lobby || lobby.status !== 'WAITING') {
      return interaction.reply({ content: 'No waiting lobby to assign characters for.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.user.id !== lobby.hostId) {
      return interaction.reply({ content: 'Only the host who created the lobby can assign characters.', flags: MessageFlags.Ephemeral });
    }
    if (lobby.players.length !== 2) {
      return interaction.reply({ content: `Need exactly 2 players joined first -- currently ${lobby.players.length}/2.`, flags: MessageFlags.Ephemeral });
    }

    const player1 = interaction.options.getUser('player1');
    const player2 = interaction.options.getUser('player2');
    if (player1.id === player2.id) {
      return interaction.reply({ content: 'player1 and player2 must be two different people.', flags: MessageFlags.Ephemeral });
    }
    const selected = new Set([player1.id, player2.id]);
    const joined = new Set(lobby.players);
    if (selected.size !== joined.size || ![...selected].every((id) => joined.has(id))) {
      return interaction.reply({
        content: `player1 and player2 must be exactly the two people who joined: ${lobby.players.map((id) => `<@${id}>`).join(' and ')}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const character1Name = interaction.options.getString('character1').trim();
    const character2Name = interaction.options.getString('character2').trim();
    const character1 = getCharacterByNameInLists(lobby.listIds, character1Name);
    const character2 = getCharacterByNameInLists(lobby.listIds, character2Name);
    if (!character1 || !character2) {
      const missing = [!character1 && character1Name, !character2 && character2Name].filter(Boolean);
      return interaction.reply({
        // The summarising label, not lobby.listNames -- a category lobby holds hundreds of
        // list names and spelling them out overflows Discord's 2,000-character limit.
        content: `Couldn't find ${missing.map((n) => `**${n}**`).join(' or ')} in this lobby's list(s) (${getListLabelForIds(lobby.listIds)}). Use the autocomplete suggestions.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (character1.name.toLowerCase() === character2.name.toLowerCase()) {
      return interaction.reply({ content: 'player1 and player2 need different characters.', flags: MessageFlags.Ephemeral });
    }

    lobby.assignedCharacters = { [player1.id]: character1, [player2.id]: character2 };

    // Ephemeral and deliberately vague in wording -- if this were visible to the players in
    // the channel, or spelled out who-gets-what, it'd spoil their own hidden character.
    return interaction.reply({
      content: `✅ Characters assigned for <@${player1.id}> and <@${player2.id}>. Run \`/start-game\` when ready -- only you can see this confirmation.`,
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
