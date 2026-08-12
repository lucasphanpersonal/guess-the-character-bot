// The knobs a lobby carries (turn length, rerolls, audience-vote tuning).
//
// Each one can be set twice: as a `/lobby create` option, and again from the ⚙️ Settings
// button on the lobby board while the lobby is still WAITING. Both paths share the bounds
// and the pool check below, so the modal can never leave a lobby in a state the slash
// command would have rejected.

const { countDistinctCharacters } = require('../db/characterLists');

const DEFAULTS = { turnSeconds: 90, voteOptions: 5, voteSeconds: 90 };

// `min`/`max` mirror the slash command's setMinValue/setMaxValue exactly.
//
// Rerolls are deliberately NOT here: they are always unlimited, in both the Discord bot and the
// web app. A reroll budget only ever added friction to a party game -- nobody benefits from
// being told "you're out of rerolls" mid-setup -- so there is no knob to set a finite one.
const FIELDS = {
  turnSeconds: { label: 'Seconds per turn', min: 15, max: 600 },
  voteOptions: { label: 'Candidates offered per player', min: 2, max: 25 },
  voteSeconds: { label: 'Seconds voting stays open', min: 15, max: 300 },
};

// Which settings are worth showing for a given mode -- the same split the board's Settings
// field makes.
const FIELDS_FOR_MODE = {
  classic: ['turnSeconds'],
  'audience-vote': ['turnSeconds', 'voteOptions', 'voteSeconds'],
};

const fieldsForMode = (mode) => FIELDS_FOR_MODE[mode] ?? FIELDS_FOR_MODE.classic;

const rangeText = (field) =>
  field.max === undefined ? `${field.min} or higher` : `between ${field.min} and ${field.max}`;

// A blank field means "leave this one alone" rather than an error, so the host can clear a
// value they didn't mean to touch.
function parseField(key, raw) {
  const field = FIELDS[key];
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: undefined };
  if (!/^-?\d+$/.test(text)) {
    return { ok: false, error: `**${field.label}** -- "${text}" isn't a whole number.` };
  }
  const value = Number(text);
  if (value < field.min || (field.max !== undefined && value > field.max)) {
    return { ok: false, error: `**${field.label}** -- must be ${rangeText(field)}, got ${value}.` };
  }
  return { ok: true, value };
}

// All-or-nothing: one bad field rejects the whole submission, so a host never ends up with
// half the change they asked for and no clear picture of which half.
function parseSettings(raw) {
  const values = {};
  const errors = [];
  for (const [key, text] of Object.entries(raw)) {
    if (!FIELDS[key]) continue;
    const result = parseField(key, text);
    if (!result.ok) errors.push(result.error);
    else if (result.value !== undefined) values[key] = result.value;
  }
  return { ok: errors.length === 0, values, errors };
}

// Each player needs their own disjoint candidate set, so the pool has to cover all of them.
// Returns an explanation, or null when the pool is big enough.
function votePoolError(listIds, voteOptions, playerCount, difficulty = 'everything') {
  const available = countDistinctCharacters(listIds, difficulty);
  const needed = voteOptions * playerCount;
  if (available >= needed) return null;
  return (
    `Audience vote with ${voteOptions} options per player needs ${needed} distinct ` +
    `characters (${voteOptions} × ${playerCount} players), but this selection only has ${available}. Pick more lists, or offer fewer candidates per player.`
  );
}

// How a value should appear when it is prefilled back into the modal.
const displayValue = (key, value) => String(value);

module.exports = {
  DEFAULTS,
  FIELDS,
  fieldsForMode,
  parseField,
  parseSettings,
  votePoolError,
  displayValue,
};
