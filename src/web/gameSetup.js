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
    // `history` is the stack of characters this checker has rolled away from, newest last, so a
    // reroll can be taken back. Kept per checker rather than per character because it is the
    // checker's decision being undone.
    order.map((id) => [id, { confirmed: false, rerollsLeft: maxRerolls, rejectedNames: new Set(), history: [] }])
  );
  return game;
}

// The safe, sendable shape of a character -- never includes anything that would identify the
// viewer's OWN character to them.
//
// Artwork is handed out as a local /img/<id> path rather than the upstream CDN URL, so phones
// fetch from this server and the server fetches upstream once (see imageCache.js -- Commons
// throttles by IP, and a party shares one). Characters with no database row behind them (a
// hand-picked freeform name) have no id to look up, so they keep their original URL.
function publicCharacter(head) {
  const imageUrl = head.imageUrl ? (head.id != null ? `/img/${head.id}` : head.imageUrl) : null;
  return { name: head.name, imageUrl, source: head.source ?? null };
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
    canUndo: (state.history?.length ?? 0) > 0,
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
  state.history.push(current); // so applyUndo can put it back
  if (!unlimited) state.rerollsLeft -= 1;
  game.headByPlayer[targetId] = Game.head(game.lobby, replacement);

  return { ok: true, rejectedBy, demotedName: rejectedBy >= content.demoteThreshold ? current.name : undefined };
}

/**
 * Put back the character this checker most recently rolled away from.
 *
 * A reroll is a snap judgement made against a stranger's face, and "actually the last one was
 * better" is the obvious second thought -- without this the previous character is simply gone,
 * since a fresh roll cannot be steered back to it.
 *
 * The retraction is honest rather than cosmetic: the name comes back out of `rejectedNames`, so
 * this checker is no longer recorded as having turned it down, and a finite reroll budget is
 * refunded. The reroll-demotion tally (which needs three DIFFERENT people) is deliberately left
 * alone -- it is a slow, shared signal about the pool, not part of this room's bookkeeping, and
 * reaching into it from here would let one player edit a server-wide count by tapping twice.
 */
function applyUndo(game, viewerId) {
  const state = game.confirmState[viewerId];
  if (!state) return { ok: false, error: 'Not in this game.' };
  if (!state.history?.length) return { ok: false, error: 'Nothing to undo.' };
  if (state.confirmed) return { ok: false, error: 'Unlock first to change this.' };

  const previous = state.history.pop();
  const targetId = game.checkTargetOf(viewerId);
  state.rejectedNames.delete(previous.name);
  if (state.rerollsLeft !== -1) state.rerollsLeft += 1;
  // Already a Game.head shape, so it goes straight back -- re-deriving it would need the row.
  game.headByPlayer[targetId] = previous;
  return { ok: true, restored: previous.name };
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
  applyUndo,
  applyConfirm,
  applyUnlock,
  publicCharacter,
  clampTurnSeconds,
  DEFAULT_MAX_REROLLS,
};
