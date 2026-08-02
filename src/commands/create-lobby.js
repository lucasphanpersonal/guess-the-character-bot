const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
  getListByName,
  countDistinctCharacters,
  searchListNames,
  getRandomCategory,
  getEnabledListsByCategory,
  getEnabledLists,
  listCategoriesWithEnabledCounts,
  DEFAULT_DIFFICULTY,
} = require('../db/characterLists');
const { DEFAULTS, votePoolError } = require('../game/lobbySettings');
const Lobby = require('../game/Lobby');
const GameManager = require('../game/GameManager');
const { buildLobbyBoardPayload, attachLobbyBoard } = require('../game/lobbyBoard');

// A pooled draw with nothing switched on is the one dead end this feature can create, so
// the message has to distinguish "you own no lists" from "you own plenty and enabled none".
function nothingEnabled(guildId) {
  const counts = listCategoriesWithEnabledCounts(guildId);
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  if (!total) return 'No character lists exist yet -- create one with `/list-create`.';
  return (
    `None of this server's ${total} lists are enabled yet, so there's nothing to draw from. ` +
    'Run `/list-filter` to pick which ones you play with -- it sorts best-known first, so ' +
    '**Enable page** on page 1 of a category is usually all it takes. You can still name a ' +
    'list directly with `list:` in the meantime.'
  );
}

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
    .addStringOption((opt) =>
      opt
        .setName('category')
        .setDescription('Use every list in a category, e.g. all of Video Games')
        .setAutocomplete(true)
    )
    .addBooleanOption((opt) =>
      opt.setName('everything').setDescription('Draw from every list in the server at once -- all categories pooled')
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
    .addStringOption((opt) =>
      opt
        .setName('difficulty')
        .setDescription('How deep into each cast to draw (default normal)')
        .addChoices(
          { name: 'Easy -- best-known quarter of each cast', value: 'easy' },
          { name: 'Normal -- skips the deepest cuts', value: 'normal' },
          { name: 'Everything -- every character, however obscure', value: 'everything' }
        )
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
        .setDescription('Audience vote: how long voting stays open (default 90)')
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
    const everything = interaction.options.getBoolean('everything');
    const listOption = interaction.options.getString('list');
    const categoryOption = interaction.options.getString('category');

    const chosen = [
      listOption && 'list',
      categoryOption && 'category',
      everything && 'everything',
      random && 'random',
    ].filter(Boolean);
    if (!chosen.length) {
      return interaction.reply({
        content:
          'Pick one: a `list`, a `category` to use every list in it, `everything:true` for every ' +
          'list in the server, or `random:true` to roll a category.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (chosen.length > 1) {
      return interaction.reply({
        content: `Use only one of \`list\`, \`category\`, \`everything\` or \`random\` -- you gave ${chosen.join(' and ')}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    let resolved;
    let rolledCategory = null;
    let pooledCategory = null;
    let pooledEverything = false;
    // Pooled draws (everything / category / random) only ever see the server's enabled
    // selection; naming lists outright, further down, deliberately ignores it.
    if (everything) {
      resolved = getEnabledLists(interaction.guildId);
      if (!resolved.length) {
        return interaction.reply({ content: nothingEnabled(interaction.guildId), flags: MessageFlags.Ephemeral });
      }
      pooledEverything = true;
    } else if (categoryOption) {
      resolved = getEnabledListsByCategory(interaction.guildId, categoryOption);
      if (!resolved.length) {
        const counts = listCategoriesWithEnabledCounts(interaction.guildId);
        const match = counts.find((c) => c.category.toLowerCase() === categoryOption.toLowerCase());
        // "Nothing enabled in it" and "no such category" are different problems with
        // different fixes, and telling them apart is the whole point of the message.
        if (match) {
          return interaction.reply({
            content:
              `**${categoryOption}** has ${match.count} lists but none of them are enabled. ` +
              'Turn some on with `/list-filter`, or name one directly with `list:`.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const available = counts.filter((c) => c.enabled > 0).map((c) => `**${c.category}**`).join(', ');
        return interaction.reply({
          content: `No lists in category **${categoryOption}**.${available ? ` Try: ${available}` : ''}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      pooledCategory = categoryOption;
    } else if (random) {
      const category = getRandomCategory(interaction.guildId);
      if (!category) {
        return interaction.reply({ content: nothingEnabled(interaction.guildId), flags: MessageFlags.Ephemeral });
      }
      resolved = getEnabledListsByCategory(interaction.guildId, category);
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
    const maxRerolls = interaction.options.getInteger('max-rerolls') ?? DEFAULTS.maxRerolls;
    const audienceVote = interaction.options.getBoolean('audience-vote') ?? false;
    const voteOptions = interaction.options.getInteger('vote-options') ?? DEFAULTS.voteOptions;
    const voteSeconds = interaction.options.getInteger('vote-seconds') ?? DEFAULTS.voteSeconds;

    const poolError = audienceVote && votePoolError(listIds, voteOptions, difficulty);
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
      maxRerolls,
      mode: audienceVote ? 'audience-vote' : 'classic',
      voteOptions,
      voteSeconds,
      difficulty,
    });
    GameManager.createLobby(interaction.channelId, lobby);

    // The reply IS the lobby board -- keep a handle on it so button clicks and slash
    // commands can both re-render it in place.
    const response = await interaction.reply({
      content: rolledCategory
        ? `🎲 Random category rolled: **${rolledCategory}**!`
        : pooledCategory
          ? `🗂️ Drawing from every list in **${pooledCategory}** (${resolved.length} lists).`
          : pooledEverything
            ? `🌍 Drawing from **every list in the server** -- ${resolved.length} lists, ${available} characters.`
            : undefined,
      ...buildLobbyBoardPayload(lobby),
      withResponse: true,
    });
    await attachLobbyBoard(lobby, response, interaction);
    return undefined;
  },
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'category') {
      const query = focused.value.toLowerCase();
      const choices = listCategoriesWithCounts(interaction.guildId)
        .filter((c) => c.category.toLowerCase().includes(query))
        .slice(0, 25)
        .map((c) => ({ name: `${c.category} (${c.count} lists)`, value: c.category }));
      return interaction.respond(choices);
    }

    const raw = focused.value;
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
