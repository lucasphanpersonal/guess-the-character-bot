// Stage 2: dealing characters and the confirm/reroll flow, for the web frontend.
//
// This mirrors the Discord confirm phase (src/discord/game/confirmPhase.js) but with the I/O
// pulled out: it builds a real core `Game`, and all the rules below run against Game's pure
// helpers (checkTargetOf, headByPlayer). Content access (dealing, rerolling, recording a
// rejection) is injected as `content`, so this module is unit-testable with fakes and has no
// socket.io or direct DB dependency -- the same discipline as rooms.js.
//
// The rules kept verbatim from the Discord side, because they are player-count logic, not
// Discord logic:
//   - Each player CHECKS exactly one character: the next player's, round the rotation
//     (Game.checkTargetOf). That one player, and only that one, may reroll it.
//   - A reroll excludes every character already in play (nobody should wear a duplicate) plus
//     the names this checker has personally rejected, and feeds the reroll-demotion counter.
//   - "Good to go" is per player and means "I've seen everyone else's and I'm happy with mine".
//     Play begins once every player has pressed it; a player may unlock until the last one is in.

const Game = require('../core/game/Game');
const { FIELDS: LOBBY_FIELDS } = require('../core/game/lobbySettings');

/**
 * Clamp a client-supplied turn length to the same bounds the Discord bot enforces, so the two
 * frontends can't disagree about what's legal. Returns undefined for missing/garbage input, so
 * the caller falls through to createSetup's own default rather than coercing to a number here --
 * there is exactly one place turnSeconds defaults.
 */
function clampTurnSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const { min, max } = LOBBY_FIELDS.turnSeconds;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Rerolls are always unlimited (-1) in the web app too -- a reroll budget only added friction
// to a party game. The budget machinery (rerollsLeft, the -1 sentinel) is kept so a finite
// limit remains representable, but nothing sets one. See src/core/game/lobbySettings.js.
const DEFAULT_MAX_REROLLS = -1;

/**
 * Build a core Game for a web room and attach the confirm state.
 *
 * @param {object} args
 * @param {string[]} args.order        playerIds in seating order (becomes the turn order)
 * @param {string} args.guildId        content scope, for source lookups (Game.head)
 * @param {number[]} args.listIds      the pool the characters were drawn from
 * @param {string} args.difficulty
 * @param {object[]} args.characters   one dealt character row per player, in `order`
 * @param {number} [args.turnSeconds]
 * @param {number} [args.maxRerolls]   -1 for unlimited
 */
function createSetup({ order, guildId, listIds, difficulty, characters, turnSeconds = 60, maxRerolls = DEFAULT_MAX_REROLLS, preferImages = false }) {
  // A lobby-shaped object is all Game needs: its players (turn order) and the fields Game.head
  // reads for the source label. No Discord lobby, no board, no settings surface.
  const pseudoLobby = { guildId, listIds, difficulty, preferImages, players: [...order] };
  const game = new Game({ lobby: pseudoLobby, characters, turnSeconds });
  game.rerollAllowed = true;
  game.confirmState = Object.fromEntries(
    order.map((id) => [id, { confirmed: false, rerollsLeft: maxRerolls, rejectedNames: new Set() }])
  );
  return game;
}

// The safe, sendable shape of a character -- never includes anything that would identify the
// viewer's OWN character to them.
function publicCharacter(head) {
  return { name: head.name, imageUrl: head.imageUrl ?? null, source: head.source ?? null };
}

/**
 * The personalized setup view for one viewer. Critically, it NEVER contains the viewer's own
 * character: they see the one they check (with reroll controls) and the rest as reference,
 * which between them is every character but their own -- exactly the Discord DM split.
 *
 * @param {Game} game
 * @param {string} viewerId
 * @param {Record<string,string>} names  playerId -> nickname
 */
function buildView(game, viewerId, names) {
  const nameOf = (id) => names[id] ?? 'Player';
  const state = game.confirmState[viewerId];
  const targetId = game.checkTargetOf(viewerId);

  const reference = game.turnOrder
    .filter((id) => id !== viewerId && id !== targetId)
    .map((id) => ({ ownerId: id, ownerName: nameOf(id), character: publicCharacter(game.headByPlayer[id]) }));

  const waitingOn = game.turnOrder.filter((id) => !game.confirmState[id].confirmed).length;

  return {
    checking: {
      ownerId: targetId,
      ownerName: nameOf(targetId),
      character: publicCharacter(game.headByPlayer[targetId]),
    },
    reference,
    confirmed: state.confirmed,
    rerollsLeft: state.rerollsLeft,
    rerollAllowed: game.rerollAllowed,
    waitingOn,
    allReady: waitingOn === 0,
  };
}

/**
 * Reroll the character this viewer checks (the next player's). Mirrors confirmPhase.js.
 *
 * @returns {{ok:boolean, error?:string, demotedName?:string, rejectedBy?:number}}
 */
function applyReroll(game, viewerId, { content, listIds, difficulty, preferImages = false }) {
  const state = game.confirmState[viewerId];
  if (!state) return { ok: false, error: 'Not in this game.' };
  if (!game.rerollAllowed) return { ok: false, error: "This character can't be rerolled." };
  const unlimited = state.rerollsLeft === -1;
  if (!unlimited && state.rerollsLeft <= 0) return { ok: false, error: "You're out of rerolls." };

  const targetId = game.checkTargetOf(viewerId);
  const current = game.headByPlayer[targetId];
  // Exclude every head in play (no duplicates) plus this checker's own past rejections.
  const excludeNames = new Set([
    ...game.turnOrder.map((id) => game.headByPlayer[id].name),
    ...state.rejectedNames,
  ]);
  const replacement = content.rerollOne(listIds, excludeNames, difficulty, { preferImages });
  if (!replacement) return { ok: false, error: 'No other characters left to reroll to.' };

  const rejectedBy = content.recordReject(current.id, viewerId);
  state.rejectedNames.add(current.name);
  if (!unlimited) state.rerollsLeft -= 1;
  game.headByPlayer[targetId] = Game.head(game.lobby, replacement);

  return { ok: true, rejectedBy, demotedName: rejectedBy >= content.demoteThreshold ? current.name : undefined };
}

/** Mark a player good to go. @returns {{ok, allReady}} */
function applyConfirm(game, viewerId) {
  const state = game.confirmState[viewerId];
  if (!state) return { ok: false, error: 'Not in this game.' };
  state.confirmed = true;
  const allReady = game.turnOrder.every((id) => game.confirmState[id].confirmed);
  return { ok: true, allReady };
}

/** Undo a confirmation (only meaningful before everyone is in). */
function applyUnlock(game, viewerId) {
  const state = game.confirmState[viewerId];
  if (!state) return { ok: false, error: 'Not in this game.' };
  state.confirmed = false;
  return { ok: true };
}

module.exports = {
  createSetup,
  buildView,
  applyReroll,
  applyConfirm,
  applyUnlock,
  publicCharacter,
  clampTurnSeconds,
  DEFAULT_MAX_REROLLS,
};
