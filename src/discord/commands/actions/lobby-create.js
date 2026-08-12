const { MessageFlags } = require('discord.js');
const { countDistinctCharacters, DEFAULT_DIFFICULTY } = require('../../../core/db/characterLists');
const { resolvePool, poolSuggestions, poolAnnouncement } = require('../../game/lobbyPool');
const { DEFAULTS, votePoolError } = require('../../../core/game/lobbySettings');
const Lobby = require('../../../core/game/Lobby');
const GameManager = require('../../../core/game/GameManager');
const { buildLobbyBoardPayload, attachLobbyBoard } = require('../../game/lobbyBoard');

module.exports = {
  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'This command must be used in a server.', flags: MessageFlags.Ephemeral });
    }
    const existing = GameManager.getLobby(interaction.channelId);
    if (existing && existing.status !== 'FINISHED') {
      return interaction.reply({
        content: 'There is already an active lobby or game in this channel. Use `/lobby end` to cancel it first.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const pool = resolvePool(interaction.guildId, interaction.options.getString('from'));
    if (!pool.ok) {
      return interaction.reply({ content: pool.error, flags: MessageFlags.Ephemeral });
    }
    const resolved = pool.lists;

    const listIds = resolved.map((l) => l.id);
    const difficulty = interaction.options.getString('difficulty') ?? DEFAULT_DIFFICULTY;
    // Counted at the chosen difficulty: the deal draws from that pool, so the "enough
    // characters?" guard has to look at the same one.
    const available = countDistinctCharacters(listIds, difficulty);
    if (available < 2) {
      return interaction.reply({
        content: `${resolved.map((l) => `**${l.name}**`).join(' + ')} combined need at least 2 distinct characters before they can be used.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const turnSeconds = interaction.options.getInteger('turn-seconds') ?? DEFAULTS.turnSeconds;
    const audienceVote = interaction.options.getBoolean('audience-vote') ?? false;
    const voteOptions = interaction.options.getInteger('vote-options') ?? DEFAULTS.voteOptions;
    const voteSeconds = interaction.options.getInteger('vote-seconds') ?? DEFAULTS.voteSeconds;

    // At creation time, check with minimum players (2) to prevent creating an unplayable lobby
    const MIN_PLAYERS = 2;
    const poolError = audienceVote && votePoolError(listIds, voteOptions, MIN_PLAYERS, difficulty);
    if (poolError) {
      return interaction.reply({ content: poolError, flags: MessageFlags.Ephemeral });
    }

    const lobby = new Lobby({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      hostId: interaction.user.id,
      listIds,
      listNames: resolved.map((l) => l.name),
      turnSeconds,
      mode: audienceVote ? 'audience-vote' : 'classic',
      voteOptions,
      voteSeconds,
      difficulty,
    });
    GameManager.createLobby(interaction.channelId, lobby);

    // The reply IS the lobby board -- keep a handle on it so button clicks and slash
    // commands can both re-render it in place.
    const response = await interaction.reply({
      content: poolAnnouncement(pool, difficulty),
      ...buildLobbyBoardPayload(lobby),
      withResponse: true,
    });
    await attachLobbyBoard(lobby, response, interaction);
    return undefined;
  },
  async autocomplete(interaction) {
    return interaction.respond(poolSuggestions(interaction.guildId, interaction.options.getFocused()));
  },
};
