// The /list select page: which lists this server actually plays with.
//
// Discord has no checkbox component, but a string select with setMinValues(0) and
// setMaxValues(n) is one in every respect that matters -- each option shows a tick when
// selected, and the submitted value is the full set of ticks in that menu. So a page is
// three 25-option menus (75 checkboxes) plus two button rows, which is the 5-row ceiling.
//
// Sorting matters more than the widget does. With 437 anime lists nobody is going to read
// 437 names, so lists come back most-recognisable-first and "Enable page" on page 1 means
// "enable the 75 best-known" -- the bulk of a server's curation in one click.
//
// customIds:
//   filter:cat:<page>                      the category landing page
//   filter:open:<categoryIndex>:<page>     one category's checkboxes
//   filter:pick:<categoryIndex>:<page>:<n> select menu n on that page
//   filter:page:<categoryIndex>:<page>     paginate within a category
//   filter:all:<categoryIndex>:<page>      enable everything on the current page
//   filter:none:<categoryIndex>:<page>     disable everything on the current page
//   filter:clear:<categoryIndex>:<page>    disable the whole category

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const {
  listCategoriesWithEnabledCounts,
  listsForFilter,
  setListsEnabled,
} = require('../db/characterLists');

// Discord's hard limits: 25 options per select, 5 action rows per message.
const OPTIONS_PER_MENU = 25;
const MENUS_PER_PAGE = 3;
const LISTS_PER_PAGE = OPTIONS_PER_MENU * MENUS_PER_PAGE;
const CATEGORIES_PER_PAGE = 10;

const ephemeralPayload = (payload) => ({ ...payload, flags: MessageFlags.Ephemeral });

function paginate(items, page, perPage) {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(Math.max(page, 0), pages - 1);
  return { slice: items.slice(current * perPage, (current + 1) * perPage), page: current, pages };
}

// ---------------------------------------------------------------------------
// Category landing page
// ---------------------------------------------------------------------------

function categoriesView(guildId, page) {
  const categories = listCategoriesWithEnabledCounts(guildId);
  if (!categories.length) {
    return { content: 'No character lists exist yet -- create one with `/list create`.', components: [] };
  }

  const { slice, page: current, pages } = paginate(categories, page, CATEGORIES_PER_PAGE);
  const totalEnabled = categories.reduce((sum, c) => sum + c.enabled, 0);
  const total = categories.reduce((sum, c) => sum + c.count, 0);

  const body = slice
    .map((c) => {
      const state = c.enabled === 0 ? '⬜' : c.enabled === c.count ? '✅' : '🔲';
      return `${state} **${c.category}** -- ${c.enabled} of ${c.count} enabled`;
    })
    .join('\n');

  // One button per category on the page, 5 to a row, so opening one is a click rather than
  // another command.
  const rows = [];
  for (let i = 0; i < slice.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const c of slice.slice(i, i + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`filter:open:${categories.indexOf(c)}:0`)
          .setLabel(c.category.length > 20 ? `${c.category.slice(0, 19)}…` : c.category)
          .setStyle(c.enabled > 0 ? ButtonStyle.Success : ButtonStyle.Secondary)
      );
    }
    rows.push(row);
  }

  if (pages > 1) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`filter:cat:${current - 1}`)
          .setLabel('Prev')
          .setEmoji('◀')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(current <= 0),
        new ButtonBuilder()
          .setCustomId(`filter:cat:${current + 1}`)
          .setLabel('Next')
          .setEmoji('▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(current >= pages - 1)
      )
    );
  }

  return {
    content:
      `🎛️ **Which lists does this server play with?**\n` +
      `Pooled draws (\`category\`, \`everything\`, \`random\`) only ever use enabled lists. ` +
      `Naming one directly with \`list:\` always works, enabled or not.\n\n${body}\n\n` +
      `-# **${totalEnabled}** of ${total} lists enabled · page ${current + 1} of ${pages} · pick a category to edit`,
    components: rows,
  };
}

// ---------------------------------------------------------------------------
// One category's checkboxes
// ---------------------------------------------------------------------------

// Discord truncates silently past its limits, and a truncated list name is a name the host
// can't recognise -- so trim deliberately, with an ellipsis that says it happened.
const clamp = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function categoryView(guildId, categoryIndex, page) {
  const categories = listCategoriesWithEnabledCounts(guildId);
  const category = categories[categoryIndex];
  if (!category) return { content: 'That category no longer exists.', components: [] };

  const all = listsForFilter(guildId, category.category);
  const { slice, page: current, pages } = paginate(all, page, LISTS_PER_PAGE);

  const rows = [];
  // Discord shows a select's PLACEHOLDER only while nothing is selected -- once options are
  // ticked it lists them instead. After the top-N default everything on page 1 is ticked, so
  // a placeholder saying which slice a menu covers is invisible exactly when it is needed.
  // The ranges therefore go in the message body, where they always render.
  const ranges = [];
  for (let menu = 0; menu < MENUS_PER_PAGE; menu++) {
    const chunk = slice.slice(menu * OPTIONS_PER_MENU, (menu + 1) * OPTIONS_PER_MENU);
    if (!chunk.length) break;

    const first = clamp(chunk[0].name, 20);
    const last = clamp(chunk[chunk.length - 1].name, 20);
    const from = current * LISTS_PER_PAGE + menu * OPTIONS_PER_MENU + 1;
    const on = chunk.filter((l) => l.enabled === 1).length;
    ranges.push(
      `**${from}–${from + chunk.length - 1}** ${first} → ${last} · ${on}/${chunk.length} on`
    );

    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`filter:pick:${categoryIndex}:${current}:${menu}`)
          .setPlaceholder(chunk.length === 1 ? first : `${first} … ${last}`)
          // Zero is a legitimate answer: clearing a menu is how you switch its lists off.
          .setMinValues(0)
          .setMaxValues(chunk.length)
          .addOptions(
            chunk.map((list) => ({
              label: clamp(list.name, 100),
              value: String(list.id),
              description: `${list.character_count} characters`,
              default: list.enabled === 1,
            }))
          )
      )
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`filter:all:${categoryIndex}:${current}`)
        .setLabel('Enable page')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`filter:none:${categoryIndex}:${current}`)
        .setLabel('Disable page')
        .setEmoji('⬜')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`filter:clear:${categoryIndex}:${current}`)
        .setLabel('Disable all')
        .setEmoji('🧹')
        .setStyle(ButtonStyle.Danger)
    )
  );

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`filter:page:${categoryIndex}:${current - 1}`)
        .setLabel('Prev')
        .setEmoji('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current <= 0),
      new ButtonBuilder()
        .setCustomId(`filter:page:${categoryIndex}:${current + 1}`)
        .setLabel('Next')
        .setEmoji('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current >= pages - 1),
      new ButtonBuilder()
        .setCustomId('filter:cat:0')
        .setLabel('Categories')
        .setEmoji('↩')
        .setStyle(ButtonStyle.Primary)
    )
  );

  const enabledHere = all.filter((l) => l.enabled === 1).length;
  const ranked = all.some((l) => l.popularity != null);

  return {
    content:
      `🎛️ **${category.category}** -- **${enabledHere}** of ${all.length} enabled\n` +
      (ranked
        ? '-# Sorted best-known first, so **Enable page** on page 1 switches on the most recognisable.\n'
        : '-# No fame ranking for this category -- sorted by name. Run `npm run backfill:popularity` to rank it.\n') +
      `\nTick the lists you want. Clearing a menu switches all of its lists off.\n\n` +
      `${ranges.join('\n')}\n\n` +
      `-# Page ${current + 1} of ${pages} · each menu below covers one range`,
    components: rows,
  };
}

// ---------------------------------------------------------------------------
// Interaction handling
// ---------------------------------------------------------------------------

function buildFilterPayload(guildId, view, key, page) {
  if (view === 'open' || view === 'page') return categoryView(guildId, Number(key), page);
  return categoriesView(guildId, page);
}

async function handle(interaction) {
  const [, action, key, page, menu] = interaction.customId.split(':');
  const guildId = interaction.guildId;
  const categoryIndex = Number(key);
  const currentPage = Number(page) || 0;

  if (action === 'pick') {
    // The submitted values are the ticks in THIS menu only, so the menu's own 25 lists are
    // the universe being rewritten -- everything it offered and didn't return is now off.
    const categories = listCategoriesWithEnabledCounts(guildId);
    const category = categories[categoryIndex];
    if (!category) return interaction.update(ephemeralPayload(categoriesView(guildId, 0)));

    const all = listsForFilter(guildId, category.category);
    const { slice } = paginate(all, currentPage, LISTS_PER_PAGE);
    const offered = slice
      .slice(Number(menu) * OPTIONS_PER_MENU, (Number(menu) + 1) * OPTIONS_PER_MENU)
      .map((l) => l.id);

    const ticked = new Set(interaction.values.map(Number));
    setListsEnabled(offered.filter((id) => ticked.has(id)), true);
    setListsEnabled(offered.filter((id) => !ticked.has(id)), false);

    return interaction.update(ephemeralPayload(categoryView(guildId, categoryIndex, currentPage)));
  }

  if (action === 'all' || action === 'none' || action === 'clear') {
    const categories = listCategoriesWithEnabledCounts(guildId);
    const category = categories[categoryIndex];
    if (!category) return interaction.update(ephemeralPayload(categoriesView(guildId, 0)));

    const all = listsForFilter(guildId, category.category);
    const target = action === 'clear' ? all : paginate(all, currentPage, LISTS_PER_PAGE).slice;
    setListsEnabled(target.map((l) => l.id), action === 'all');

    return interaction.update(ephemeralPayload(categoryView(guildId, categoryIndex, currentPage)));
  }

  const view = action === 'open' || action === 'page' ? 'open' : 'cat';
  // `filter:cat:<page>` has the page where the others have a category key.
  const pageForView = view === 'cat' ? Number(key) || 0 : currentPage;
  return interaction.update(ephemeralPayload(buildFilterPayload(guildId, view, categoryIndex, pageForView)));
}

module.exports = {
  handle,
  categoriesView,
  categoryView,
  buildFilterPayload,
  LISTS_PER_PAGE,
  OPTIONS_PER_MENU,
  MENUS_PER_PAGE,
};
