// `/character <name>` -- look one up and see them.
//
// The database holds 46,000 characters and until now the only ways to see one were to be
// dealt it mid-game or to page through `/list show`. This is the direct question: what does
// this character look like, what are they from, and would this server ever deal them.
//
// Top-level rather than a `/list` subcommand because it is not list management -- it answers
// a question about a character, and `/list` is where you go to change what gets played.
//
// SPOILER-SAFE BY CONSTRUCTION, and worth stating since almost everything else in this bot
// is not. Nobody knows their own character, so seeing an arbitrary one reveals nothing about
// their own head -- there is no way to use this to work out what you are wearing. It is
// ephemeral by default anyway, because a game channel deletes and reposts its turn board
// constantly and a public lookup would be noise between turns.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const {
  searchCharactersInGuild,
  getCharacterById,
  getCharacterSource,
  countRerollers,
  REROLL_DEMOTE_THRESHOLD,
} = require('../db/characterLists');

// Discord caps an autocomplete label at 100 characters.
const LABEL_MAX = 100;

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function describe(guildId, character) {
  const source = getCharacterSource(guildId, character.name, character.list_id ?? null);
  const rerolls = countRerollers(character.id);

  const embed = new EmbedBuilder()
    .setTitle(character.name)
    .setColor(character.image_url ? 0x5865f2 : 0x4f545c);

  if (source) embed.setDescription(`*from ${source}*`);
  if (character.image_url) embed.setImage(character.image_url);

  const facts = [`📋 ${character.listName}${character.category ? ` · ${character.category}` : ''}`];
  // Whether this server would ever deal them is the fact most likely to prompt an action --
  // `/list toggle` is right there if the answer is no and you wanted otherwise.
  facts.push(character.enabled ? '✅ in the playable pool' : '⬜ not in the playable pool');
  // Fame is only ever comparable inside one list (AniList favourites vs Wikipedia
  // sitelinks), so it is shown as a raw number rather than dressed up as a ranking.
  if (character.fame != null) facts.push(`⭐ fame ${character.fame.toLocaleString()}`);
  if (rerolls > 0) {
    facts.push(
      rerolls >= REROLL_DEMOTE_THRESHOLD
        ? `🚮 rerolled by ${rerolls} people — no longer dealt`
        : `🔁 rerolled by ${rerolls}`
    );
  }
  if (!character.image_url) facts.push('🖼️ no artwork — they reveal as text');

  embed.addFields({ name: '​', value: facts.join('\n') });
  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('character')
    .setDescription('Look up a character and see their artwork')
    .addStringOption((opt) =>
      opt.setName('name').setDescription('Character name').setRequired(true).setAutocomplete(true)
    )
    .addBooleanOption((opt) =>
      opt.setName('share').setDescription('Post it in the channel for everyone (default: only you)')
    ),

  async execute(interaction) {
    const raw = interaction.options.getString('name').trim();
    const share = interaction.options.getBoolean('share') ?? false;

    // Autocomplete hands back a row id, which resolves to exactly one character. A name typed
    // freehand cannot -- there are three Dittos -- so it falls back to searching, and the
    // best match is used rather than refusing. Refusing on a near-miss is what makes
    // /lobby set-characters frustrating, and this command has nothing at stake in guessing.
    let character = /^\d+$/.test(raw) ? getCharacterById(interaction.guildId, Number(raw)) : null;
    if (!character) {
      [character] = searchCharactersInGuild(interaction.guildId, raw, 1);
    }

    if (!character) {
      return interaction.reply({
        content: `Nothing here called **${truncate(raw, 80)}**. Pick from the suggestions as you type — they only ever offer names that exist.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      embeds: [describe(interaction.guildId, character)],
      ...(share ? {} : { flags: MessageFlags.Ephemeral }),
    });
  },

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    // An empty box would otherwise LIKE '%%' its way through all 46,000 rows to show an
    // arbitrary 25. Nothing is a better answer than an arbitrary something.
    if (!focused.trim()) return interaction.respond([]);

    const matches = searchCharactersInGuild(interaction.guildId, focused.trim(), 25);
    return interaction.respond(
      matches.map((c) => ({
        // The list is part of the label because the name alone is often ambiguous, and
        // picking blind between three identical "Ditto" rows is not a choice.
        name: truncate(`${c.name} — ${c.listName}`, LABEL_MAX),
        // The id, so the pick resolves to this exact row rather than to whatever shares
        // its name.
        value: String(c.id),
      }))
    );
  },
};
