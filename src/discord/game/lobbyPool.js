// Resolving `/lobby create from:` -- what a lobby draws from.
//
// This used to be four separate options (list / category / everything / random) that were
// mutually exclusive, which Discord cannot express. So the command advertised no required
// options, then rejected both giving none and giving two. The option surface allowed states
// the command refused, and the modes nobody scrolled far enough to see were undiscoverable.
//
// One autocompleted option fixes all three: exclusivity becomes structural, every mode shows
// up in the same picker, and free text still means list names.
//
// Sentinel values carry the mode. A `::` prefix cannot collide with a real list name in any
// realistic library, and free text falls through to list-name resolution.

const {
  getListByName,
  getEnabledLists,
  getEnabledListsByCategory,
  getRandomCategory,
  listCategoriesWithEnabledCounts,
  searchListNames,
  countDistinctCharacters,
} = require('../../core/db/characterLists');

const RANDOM = '::random';
const EVERYTHING = '::everything';
const CATEGORY_PREFIX = '::cat:';

// Bare `/lobby create` should start a game rather than explain itself, so an absent option
// means roulette rather than an error.
const DEFAULT_FROM = RANDOM;

/**
 * Autocomplete choices for the `from` option.
 *
 * The modes come first when the field is empty, because they're the ones that were
 * previously invisible. Typing filters everything; typing a comma switches to continuing a
 * multi-list selection, where the modes no longer make sense.
 */
function poolSuggestions(guildId, typed) {
  const raw = typed ?? '';

  // Comma means "and also" -- from here on only list names can follow.
  if (raw.includes(',')) {
    const parts = raw.split(',');
    const partial = parts[parts.length - 1].trim();
    const already = parts.slice(0, -1).map((p) => p.trim()).filter(Boolean);
    return searchListNames(guildId, partial)
      .filter((name) => !already.includes(name))
      .slice(0, 25)
      .map((name) => {
        const value = [...already, name].join(', ');
        const label = `📋 ${value}`;
        return {
          name: label.length > 100 ? `${label.slice(0, 99)}…` : label,
          value: value.length > 100 ? value.slice(0, 100) : value,
        };
      });
  }

  const query = raw.trim().toLowerCase();
  const counts = listCategoriesWithEnabledCounts(guildId);
  const totalEnabled = counts.reduce((sum, c) => sum + c.enabled, 0);
  const choices = [];

  if (!query || 'random'.includes(query) || 'roulette'.includes(query)) {
    choices.push({ name: '🎲 Random category — let the bot roll', value: RANDOM });
  }
  if (!query || 'everything'.includes(query) || 'all'.includes(query)) {
    choices.push({
      name: `🌍 Everything — every enabled list (${totalEnabled})`,
      value: EVERYTHING,
    });
  }
  for (const c of counts) {
    if (!c.enabled) continue;
    if (query && !c.category.toLowerCase().includes(query)) continue;
    choices.push({
      name: `🗂️ ${c.category} — ${c.enabled} lists`.slice(0, 100),
      value: `${CATEGORY_PREFIX}${c.category}`.slice(0, 100),
    });
  }
  for (const name of searchListNames(guildId, raw.trim())) {
    if (choices.length >= 25) break;
    choices.push({ name: `📋 ${name}`.slice(0, 100), value: name.slice(0, 100) });
  }
  return choices.slice(0, 25);
}

// A pooled draw with nothing switched on is the one dead end curation can create, so this
// distinguishes "you own no lists" from "you own plenty and enabled none".
function nothingEnabled(guildId) {
  const counts = listCategoriesWithEnabledCounts(guildId);
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  if (!total) return 'No character lists exist yet -- create one with `/list create`.';
  return (
    `None of this server's ${total} lists are enabled yet, so there's nothing to draw from. ` +
    'Run `/list select` to pick which ones you play with -- it sorts best-known first, so ' +
    '**Enable page** on page 1 of a category is usually all it takes. You can still name a ' +
    'list outright in `from:` in the meantime.'
  );
}

/**
 * @returns {{ok: true, lists: object[], mode: string, category?: string}}
 *        | {{ok: false, error: string}}
 */
function resolvePool(guildId, from) {
  const value = (from ?? DEFAULT_FROM).trim();

  if (value === RANDOM) {
    const category = getRandomCategory(guildId);
    if (!category) return { ok: false, error: nothingEnabled(guildId) };
    return { ok: true, lists: getEnabledListsByCategory(guildId, category), mode: 'random', category };
  }

  if (value === EVERYTHING) {
    const lists = getEnabledLists(guildId);
    if (!lists.length) return { ok: false, error: nothingEnabled(guildId) };
    return { ok: true, lists, mode: 'everything' };
  }

  if (value.startsWith(CATEGORY_PREFIX)) {
    const category = value.slice(CATEGORY_PREFIX.length);
    const lists = getEnabledListsByCategory(guildId, category);
    if (lists.length) return { ok: true, lists, mode: 'category', category };

    const counts = listCategoriesWithEnabledCounts(guildId);
    const match = counts.find((c) => c.category.toLowerCase() === category.toLowerCase());
    // "Nothing enabled in it" and "no such category" are different problems with different
    // fixes, and telling them apart is the whole point of the message.
    if (match) {
      return {
        ok: false,
        error:
          `**${category}** has ${match.count} lists but none of them are enabled. ` +
          'Turn some on with `/list select`, or name one outright in `from:`.',
      };
    }
    const available = counts.filter((c) => c.enabled > 0).map((c) => `**${c.category}**`).join(', ');
    return { ok: false, error: `No lists in category **${category}**.${available ? ` Try: ${available}` : ''}` };
  }

  // Free text: one or more list names. Named lists deliberately bypass the enabled
  // selection -- asking for one by name is already a deliberate choice.
  const names = [...new Set(value.split(',').map((n) => n.trim()).filter(Boolean))];
  if (!names.length) return { ok: false, error: nothingEnabled(guildId) };

  const lists = [];
  const missing = [];
  for (const name of names) {
    const list = getListByName(guildId, name);
    if (list) lists.push(list);
    else missing.push(name);
  }
  if (missing.length) {
    return {
      ok: false,
      error:
        `No list(s) named ${missing.map((n) => `**${n}**`).join(', ')} found. ` +
        'Start typing in `from:` for suggestions, or run `/list show` to browse categories.',
    };
  }
  return { ok: true, lists, mode: 'lists' };
}

// The line posted above the lobby board, naming what was drawn from. Null when the selection
// speaks for itself (a list or two, already named on the board).
function poolAnnouncement(result, difficulty) {
  const count = countDistinctCharacters(result.lists.map((l) => l.id), difficulty);
  if (result.mode === 'random') return `🎲 Random category rolled: **${result.category}**!`;
  if (result.mode === 'category') {
    return `🗂️ Drawing from every enabled list in **${result.category}** (${result.lists.length} lists).`;
  }
  if (result.mode === 'everything') {
    return `🌍 Drawing from **every enabled list** -- ${result.lists.length} lists, ${count} characters.`;
  }
  return undefined;
}

module.exports = {
  RANDOM,
  EVERYTHING,
  CATEGORY_PREFIX,
  DEFAULT_FROM,
  poolSuggestions,
  resolvePool,
  poolAnnouncement,
  nothingEnabled,
};
