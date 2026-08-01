const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
  getListByName,
  countDistinctCharacters,
  searchListNames,
  getRandomCategory,
  getListsByCategory,
} = require('../db/characterLists');
const Lobby = require('../game/Lobby');
const GameManager = require('../game/GameManager');
const { buildLobbyBoardPayload, attachLobbyBoard } = require('../game/lobbyBoard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('create-lobby')
    .setDescription('Create a Guess the Character lobby in this channel')
    .addStringOption((opt) =>
      opt
        .setName('list')
        .setDescription('Character list(s) to use -- comma-separated to combine several')
        .setAutocomplete(true)
    )
    .addBooleanOption((opt) =>
      opt.setName('random').setDescription('Skip picking a list -- let the bot roll a random category instead')
    )
    .addIntegerOption((opt) =>
      opt.setName('turn-seconds').setDescription('Seconds per turn (default 90)').setMinValue(15).setMaxValue(600)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('max-rerolls')
        .setDescription('Rerolls allowed per player before confirming a character (default 2, -1 = unlimited)')
        .setMinValue(-1)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('audience-vote')
        .setDescription('Let the audience vote on each player\'s character instead of the bot picking')
    )
    .addIntegerOption((opt) =>
      opt
        .setName('vote-options')
        .setDescription('Audience vote: candidates offered per player (default 5)')
        .setMinValue(2)
        .setMaxValue(25)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('vote-seconds')
        .setDescription('Audience vote: how long voting stays open (default 60)')
        .setMinValue(15)
        .setMaxValue(300)
    ),
  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'This command must be used in a server.', flags: MessageFlags.Ephemeral });
    }
    const existing = GameManager.getLobby(interaction.channelId);
    if (existing && existing.status !== 'FINISHED') {
      return interaction.reply({
        content: 'There is already an active lobby or game in this channel. Use `/end-game` to cancel it first.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const random = interaction.options.getBoolean('random');
    const listOption = interaction.options.getString('list');
    if (!random && !listOption) {
      return interaction.reply({
        content: 'Provide a `list` to use, or set `random:true` to have the bot roll a random category.',
        flags: MessageFlags.Ephemeral,
      });
    }

    let resolved;
    let rolledCategory = null;
    if (random) {
      const category = getRandomCategory(interaction.guildId);
      if (!category) {
        return interaction.reply({ content: 'No character lists exist yet -- create one with `/list-create`.', flags: MessageFlags.Ephemeral });
      }
      resolved = getListsByCategory(interaction.guildId, category);
      rolledCategory = category;
    } else {
      const requestedNames = [...new Set(
        listOption
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
      )];

      resolved = [];
      const missing = [];
      for (const name of requestedNames) {
        const list = getListByName(interaction.guildId, name);
        if (list) resolved.push(list);
        else missing.push(name);
      }
      if (missing.length) {
        return interaction.reply({
          content:
            `No list(s) named ${missing.map((n) => `**${n}**`).join(', ')} found. ` +
            'Start typing in the `list` option for autocomplete suggestions, or run `/list-show` to browse categories.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    const listIds = resolved.map((l) => l.id);
    const available = countDistinctCharacters(listIds);
    if (available < 2) {
      return interaction.reply({
        content: `${resolved.map((l) => `**${l.name}**`).join(' + ')} combined need at least 2 distinct characters before they can be used.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const turnSeconds = interaction.options.getInteger('turn-seconds') ?? 90;
    const maxRerolls = interaction.options.getInteger('max-rerolls') ?? 2;
    const audienceVote = interaction.options.getBoolean('audience-vote') ?? false;
    const voteOptions = interaction.options.getInteger('vote-options') ?? 5;
    const voteSeconds = interaction.options.getInteger('vote-seconds') ?? 60;

    // Each player needs their own disjoint candidate set, so the pool has to cover both.
    if (audienceVote && available < voteOptions * 2) {
      return interaction.reply({
        content:
          `Audience vote with ${voteOptions} options per player needs ${voteOptions * 2} distinct ` +
          `characters, but this selection only has ${available}. Pick more lists or lower \`vote-options\`.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const lobby = new Lobby({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      hostId: interaction.user.id,
      listIds,
      listNames: resolved.map((l) => l.name),
      turnSeconds,
      maxRerolls,
      mode: audienceVote ? 'audience-vote' : 'classic',
      voteOptions,
      voteSeconds,
    });
    GameManager.createLobby(interaction.channelId, lobby);

    // The reply IS the lobby board -- keep a handle on it so button clicks and slash
    // commands can both re-render it in place.
    const response = await interaction.reply({
      content: rolledCategory ? `🎲 Random category rolled: **${rolledCategory}**!` : undefined,
      ...buildLobbyBoardPayload(lobby),
      withResponse: true,
    });
    await attachLobbyBoard(lobby, response, interaction);
    return undefined;
  },
  async autocomplete(interaction) {
    const raw = interaction.options.getFocused();
    const parts = raw.split(',');
    const currentPartial = parts[parts.length - 1].trim();
    const alreadyTyped = parts
      .slice(0, -1)
      .map((p) => p.trim())
      .filter(Boolean);

    const matches = searchListNames(interaction.guildId, currentPartial).filter((name) => !alreadyTyped.includes(name));
    const choices = matches.slice(0, 25).map((name) => {
      const value = [...alreadyTyped, name].join(', ');
      const display = value.length > 100 ? `${value.slice(0, 97)}...` : value;
      return { name: display, value: value.length > 100 ? value.slice(0, 100) : value };
    });
    return interaction.respond(choices);
  },
};
