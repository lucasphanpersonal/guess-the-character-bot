// Paginated browsing for `/list show` (customId `browse:<view>:<key>:<page>`).
//
// A single Discord message caps at 2000 characters, and the seed data runs to well over a
// thousand lists, so the un-paginated version simply truncated: "...and 1,247 more". That
// is fine for a small server and useless for a seeded one. Three views, each with Prev /
// Next and a way back out:
//
//   categories                 every category, with how many lists it holds
//   lists   <categoryIndex>    the list names in one category
//   chars   <listId>           the characters in one list
//
// The key is an index or a row id rather than a name because customId is limited to 100
// characters and list names are arbitrary user text -- "Yes Minister / Yes, Prime Minister"
// would both blow the budget and collide with the `:` separator.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const {
  listCategoriesWithCounts,
  listNamesInCategory,
  getListByName,
  getCharacters,
  getListsByIds,
} = require('../../core/db/characterLists');

const CATEGORIES_PER_PAGE = 12;
const LISTS_PER_PAGE = 20;
const CHARACTERS_PER_PAGE = 60;

// Leaves room for the header line and the "page x of y" footer inside Discord's 2000.
const BODY_BUDGET = 1700;

function paginate(items, page, perPage) {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(Math.max(page, 0), pages - 1);
  return { slice: items.slice(current * perPage, (current + 1) * perPage), page: current, pages };
}

// Character pages are sized by count, but a page of unusually long names can still overrun
// the message limit, so the text is trimmed to the budget as a backstop.
function fit(text) {
  if (text.length <= BODY_BUDGET) return text;
  return `${text.slice(0, BODY_BUDGET - 1)}…`;
}

function navRow(view, key, page, pages, { back = null } = {}) {
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`browse:${view}:${key}:${page - 1}`)
      .setLabel('Prev')
      .setEmoji('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`browse:${view}:${key}:${page + 1}`)
      .setLabel('Next')
      .setEmoji('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages - 1)
  );
  if (back) {
    row.addComponents(
      new ButtonBuilder().setCustomId(back.customId).setLabel(back.label).setEmoji('↩').setStyle(ButtonStyle.Primary)
    );
  }
  return row;
}

function categoriesView(guildId, page) {
  const categories = listCategoriesWithCounts(guildId);
  if (!categories.length) {
    return { content: 'No character lists yet. Create one with `/list create`.', components: [] };
  }
  const { slice, page: current, pages } = paginate(categories, page, CATEGORIES_PER_PAGE);
  const total = categories.reduce((sum, c) => sum + c.count, 0);

  const body = slice
    .map((c) => `**${c.category}** -- ${c.count} list${c.count === 1 ? '' : 's'}`)
    .join('\n');

  return {
    content: fit(
      `🗂️ **Categories** (${categories.length}, ${total} lists total)\n\n${body}`
    ) + `\n\n-# Page ${current + 1} of ${pages} · \`/list show category:<name>\` to open one`,
    components: [navRow('cat', 0, current, pages)],
  };
}

function listsView(guildId, categoryIndex, page) {
  const categories = listCategoriesWithCounts(guildId);
  const category = categories[categoryIndex];
  if (!category) return { content: 'That category no longer exists.', components: [] };

  const names = listNamesInCategory(guildId, category.category);
  const { slice, page: current, pages } = paginate(names, page, LISTS_PER_PAGE);

  return {
    content: fit(
      `🗂️ **${category.category}** -- ${names.length} list${names.length === 1 ? '' : 's'}\n\n` +
        slice.map((n) => `• ${n}`).join('\n')
    ) + `\n\n-# Page ${current + 1} of ${pages} · \`/list show list:<name>\` to open one`,
    components: [
      navRow('lists', categoryIndex, current, pages, {
        back: { customId: 'browse:cat:0:0', label: 'Categories' },
      }),
    ],
  };
}

function charactersView(listId, page) {
  const [list] = getListsByIds([listId]);
  if (!list) return { content: 'That list no longer exists.', components: [] };

  const characters = getCharacters(list.id).map((c) => c.name);
  if (!characters.length) {
    return { content: `**${list.name}** has no characters yet.`, components: [] };
  }
  const { slice, page: current, pages } = paginate(characters, page, CHARACTERS_PER_PAGE);

  // The category index lets the Back button return to where the list was found.
  const categoryIndex = listCategoriesWithCounts(list.guild_id).findIndex(
    (c) => c.category === (list.category || 'Uncategorized')
  );

  return {
    content: fit(
      `**${list.name}**${list.category && list.category !== list.name ? ` (${list.category})` : ''}` +
        ` -- ${characters.length} character${characters.length === 1 ? '' : 's'}\n\n${slice.join(', ')}`
    ) + `\n\n-# Page ${current + 1} of ${pages}`,
    components: [
      navRow('chars', list.id, current, pages, {
        back: categoryIndex >= 0 ? { customId: `browse:lists:${categoryIndex}:0`, label: 'Back' } : null,
      }),
    ],
  };
}

// Entry point shared by the slash command and the buttons, so both render identically.
function buildBrowsePayload(guildId, view, key, page) {
  if (view === 'lists') return listsView(guildId, Number(key), page);
  if (view === 'chars') return charactersView(Number(key), page);
  return categoriesView(guildId, page);
}

function payloadForList(guildId, listName) {
  const list = getListByName(guildId, listName);
  if (!list) return { content: `No list named **${listName}**.`, components: [] };
  return charactersView(list.id, 0);
}

function payloadForCategory(guildId, categoryName) {
  const index = listCategoriesWithCounts(guildId).findIndex(
    (c) => c.category.toLowerCase() === categoryName.toLowerCase()
  );
  if (index < 0) return { content: `No lists in category **${categoryName}**.`, components: [] };
  return listsView(guildId, index, 0);
}

async function handle(interaction) {
  const [, view, key, page] = interaction.customId.split(':');
  const payload = buildBrowsePayload(interaction.guildId, view, key, Number(page) || 0);
  // The browse message is ephemeral, so editing it in place is private to whoever clicked.
  return interaction.update({ ...payload, flags: MessageFlags.Ephemeral });
}

module.exports = {
  handle,
  buildBrowsePayload,
  payloadForList,
  payloadForCategory,
  paginate,
  CATEGORIES_PER_PAGE,
  LISTS_PER_PAGE,
  CHARACTERS_PER_PAGE,
};
