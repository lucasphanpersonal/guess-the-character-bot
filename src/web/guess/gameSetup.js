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
//
// Host-picks mode (web only) changes who decides, not the rules above: the host chooses the
// characters (dealWithPicks) and sits the game out -- they are not in the turn order, so they
// neither check nor wear anything. Rerolls are off, since a reroll would undo the host's choice
// (the same call the Discord side makes for its audience vote). Players still check and lock in:
// that screen is also where tilt gets turned on. The host gets buildHostSetupView instead.
//
// Pick-for-each-other mode (web only) keeps every rule above and changes only how a seat is
// first filled: nothing is dealt, and each player chooses the character of the player they check
// (applyPick) -- searched, typed, or a random one from the pool through the ordinary reroll.
// A seat starts empty (null) and "Good to go" is refused until the checker has filled it, so play
// can never begin with an empty seat. Everyone still plays; nobody sits out.

const Game = require('../../core/game/Game');
const { FIELDS: LOBBY_FIELDS } = require('../../core/game/lobbySettings');
const { identityKeys } = require('../../compendium/answers');
// The sendable shape of a character. Who may RECEIVE which one is this file's business -- never
// anyone their own -- and that is decided below, not in the shape.
const { publicCharacter } = require('../publicCharacter');

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
 * @param {boolean} [args.rerollAllowed] false when the host picked: a reroll would undo their choice
 * @param {boolean} [args.checkerPicks] pick-for-each-other: `characters` may hold nulls, filled by applyPick
 */
function createSetup({ order, guildId, listIds, difficulty, characters, turnSeconds = 60, maxRerolls = DEFAULT_MAX_REROLLS, preferImages = false, rerollAllowed = true, checkerPicks = false }) {
  // A lobby-shaped object is all Game needs: its players (turn order) and the fields Game.head
  // reads for the source label. No Discord lobby, no board, no settings surface.
  const pseudoLobby = { guildId, listIds, difficulty, preferImages, players: [...order] };
  const game = new Game({ lobby: pseudoLobby, characters, turnSeconds });
  game.rerollAllowed = rerollAllowed;
  game.checkerPicks = checkerPicks;
  game.confirmState = Object.fromEntries(
    // `history` is the stack of characters this checker has rolled away from, newest last, so a
    // reroll can be taken back. Kept per checker rather than per character because it is the
    // checker's decision being undone.
    order.map((id) => [id, { confirmed: false, rerollsLeft: maxRerolls, rejectedNames: new Set(), history: [] }])
  );
  return game;
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
  // A seat nobody has picked for yet (pick-for-each-other) is shown as null, never as a placeholder
  // name a client could mistake for a character.
  const shown = (id) => (game.headByPlayer[id] ? publicCharacter(game.headByPlayer[id]) : null);
  const state = game.confirmState[viewerId];
  const targetId = game.checkTargetOf(viewerId);

  const reference = game.turnOrder
    .filter((id) => id !== viewerId && id !== targetId)
    .map((id) => ({ ownerId: id, ownerName: nameOf(id), character: shown(id) }));

  // Named, not just counted. "Waiting on 1 more" tells a room of eight people nothing they can
  // act on; a name tells them whose phone to go and look at.
  const waiting = game.turnOrder.filter((id) => !game.confirmState[id].confirmed);
  const waitingOn = waiting.length;

  return {
    checking: {
      ownerId: targetId,
      ownerName: nameOf(targetId),
      character: shown(targetId),
    },
    reference,
    confirmed: state.confirmed,
    rerollsLeft: state.rerollsLeft,
    rerollAllowed: game.rerollAllowed,
    checkerPicks: !!game.checkerPicks,
    // Said by the server so the client never has to work out that an empty seat blocks "Good to go".
    canConfirm: !!game.headByPlayer[targetId],
    canUndo: (state.history?.length ?? 0) > 0,
    waitingOn,
    waitingPlayers: waiting.map((id) => ({ playerId: id, name: nameOf(id) })),
    allReady: waitingOn === 0,
  };
}

const TYPED_NAME_MAX = 60;

/**
 * The deal for host-picks mode: the host's choice wherever they made one, random for the rest.
 *
 * `picks` arrives from a client, so none of it is trusted. A pick for somebody who isn't being
 * dealt in -- the host themselves, a player who has since left -- is refused rather than quietly
 * dropped, because dropping it would deal the room something other than what the host saw on
 * their screen. An id must resolve to a character in this scope; a typed name is trimmed and
 * capped. An empty pick means "random", so the host can decide for two people and let chance
 * have the rest.
 *
 * Duplicates are judged with identityKeys, the same keys the guess-checker and the pool dedupe
 * use, so "Spider-Man" and a typed "spiderman" -- or "Tails" and Miles "Tails" Prower -- are one
 * character here too. The random fill excludes the picks by those same keys, or it could deal the
 * pool's spelling of a character the host already handed out.
 *
 * @param {object} args
 * @param {string[]} args.order     playerIds being dealt in, in seat order (the host is not one)
 * @param {Record<string, {id?: number, name?: string}>} args.picks
 * @param {Record<string, string>} args.names  playerId -> nickname, for errors a room can act on
 * @param {object} args.content     { characterById, freeform, randomCharacters }
 * @returns {{ok: true, characters: object[]} | {ok: false, error: string}} characters in `order`
 */
function dealWithPicks({ order, picks = {}, names = {}, content, listIds, difficulty, preferImages = false }) {
  const nameOf = (id) => names[id] ?? 'a player';
  const chosen = {};
  for (const [playerId, pick] of Object.entries(picks ?? {})) {
    if (!order.includes(playerId)) return { ok: false, error: "A pick was for someone who isn't being dealt in. Re-open the picker and try again." };
    if (pick?.id != null) {
      const id = Number(pick.id);
      const row = Number.isInteger(id) ? content.characterById(id) : null;
      if (!row) return { ok: false, error: `The character picked for ${nameOf(playerId)} isn't in the library any more.` };
      chosen[playerId] = row;
      continue;
    }
    const typed = String(pick?.name ?? '').trim().slice(0, TYPED_NAME_MAX);
    if (typed) chosen[playerId] = content.freeform(typed);
  }

  const holder = new Map();
  for (const [playerId, c] of Object.entries(chosen)) {
    const keys = identityKeys(c.name);
    const clash = keys.find((k) => holder.has(k));
    if (clash) return { ok: false, error: `${nameOf(holder.get(clash))} and ${nameOf(playerId)} would both be ${c.name}.` };
    for (const k of keys) holder.set(k, playerId);
  }

  const unpicked = order.filter((id) => !chosen[id]);
  let fill = [];
  if (unpicked.length) {
    if (!listIds.length) return { ok: false, error: 'Pick a character for everyone, or choose a pool with playable lists for the rest.' };
    fill = content.randomCharacters(listIds, unpicked.length, Object.values(chosen).map((c) => c.name), difficulty, { preferImages });
    if (fill.length < unpicked.length) {
      return {
        ok: false,
        error: `${unpicked.length} player${unpicked.length === 1 ? '' : 's'} left on random, and that pool only has ${fill.length} character${fill.length === 1 ? '' : 's'} left to deal. Pick more, or widen the pool.`,
      };
    }
  }
  let next = 0;
  return { ok: true, characters: order.map((id) => chosen[id] ?? fill[next++]) };
}

/**
 * What the host sees while players check their characters and lock in, in host-picks mode.
 *
 * It holds EVERY character in play -- the host chose them, so there is nothing to hide from them
 * -- which is exactly why it must never reach a player. socket.js sends it to the host alone,
 * and only while they are sitting the game out.
 */
function buildHostSetupView(game, names) {
  const nameOf = (id) => names[id] ?? 'Player';
  const players = game.turnOrder.map((id) => ({
    playerId: id,
    name: nameOf(id),
    character: publicCharacter(game.headByPlayer[id]),
    confirmed: game.confirmState[id].confirmed,
  }));
  const waitingOn = players.filter((p) => !p.confirmed).length;
  return { phase: 'setup', players, waitingOn, allReady: waitingOn === 0 };
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

  if (state.confirmed) return { ok: false, error: 'Unlock first to change this.' };

  const targetId = game.checkTargetOf(viewerId);
  const current = game.headByPlayer[targetId];
  // Exclude every head in play (no duplicates) plus this checker's own past rejections. The
  // viewer's own head is excluded too, which is safe here and only here: the draw is random, so
  // it says nothing about who they are -- unlike a refused pick (see applyPick).
  const excludeNames = new Set([
    ...game.turnOrder.map((id) => game.headByPlayer[id]?.name).filter(Boolean),
    ...state.rejectedNames,
  ]);
  const replacement = content.rerollOne(listIds, excludeNames, difficulty, { preferImages });
  if (!replacement) return { ok: false, error: current ? 'No other characters left to reroll to.' : 'The pool has no characters left to pick from.' };

  // An empty seat (pick-for-each-other) is filled, not rerolled: nothing was turned down, so
  // nothing is recorded against the pool and there is nothing for Undo to put back.
  if (!current) {
    game.headByPlayer[targetId] = Game.head(game.lobby, replacement);
    return { ok: true };
  }
  // Only a dealt character is a judgement on the pool. One the checker chose themselves and then
  // replaced is just them changing their mind -- it does not count toward demoting it.
  const rejectedBy = current.picked ? 0 : content.recordReject(current.id, viewerId);
  state.rejectedNames.add(current.name);
  state.history.push(current); // so applyUndo can put it back
  if (!unlimited) state.rerollsLeft -= 1;
  game.headByPlayer[targetId] = Game.head(game.lobby, replacement);

  return { ok: true, rejectedBy, demotedName: rejectedBy >= content.demoteThreshold ? current.name : undefined };
}

/**
 * Pick-for-each-other: the checker chooses the character of the player they check -- a library
 * character by id, or any name typed in. Replaces whatever was there; Undo puts it back.
 *
 * `pick` arrives from a client, so it is validated exactly as dealWithPicks validates the host's.
 *
 * Duplicates are judged with identityKeys against every seat the checker can SEE -- everyone's
 * but their own. Their own seat is deliberately left out: they see every other character in play,
 * so "someone already has that" for a name they cannot see would tell them who they are. The
 * price is that a checker can, without knowing it, give their target the same character they are
 * wearing themselves. A duplicate is a nuisance; telling someone their own answer ends the game
 * for them.
 *
 * @param {{id?: number, name?: string}} pick
 * @param {{content: {characterById, freeform}}} deps
 */
function applyPick(game, viewerId, pick, { content }) {
  const state = game.confirmState[viewerId];
  if (!state) return { ok: false, error: 'Not in this game.' };
  if (!game.checkerPicks) return { ok: false, error: 'Characters are dealt in this game, not picked.' };
  if (state.confirmed) return { ok: false, error: 'Unlock first to change this.' };

  let row;
  if (pick?.id != null) {
    const id = Number(pick.id);
    row = Number.isInteger(id) ? content.characterById(id) : null;
    if (!row) return { ok: false, error: "That character isn't in the library any more." };
  } else {
    const typed = String(pick?.name ?? '').trim().slice(0, TYPED_NAME_MAX);
    if (!typed) return { ok: false, error: 'Search for a character, or type a name.' };
    row = content.freeform(typed);
  }

  const targetId = game.checkTargetOf(viewerId);
  const keys = new Set(identityKeys(row.name));
  for (const id of game.turnOrder) {
    if (id === viewerId || id === targetId) continue; // their own: see above. The target's: being replaced.
    const other = game.headByPlayer[id];
    if (other && identityKeys(other.name).some((k) => keys.has(k))) {
      return { ok: false, error: `${other.name} is already in play. Pick someone else.` };
    }
  }

  const current = game.headByPlayer[targetId];
  if (current) state.history.push(current);
  // `picked` marks it as a person's choice rather than the pool's, so replacing it later is not
  // recorded as the pool dealing something unfair (see applyReroll).
  game.headByPlayer[targetId] = { ...Game.head(game.lobby, row), picked: true };
  return { ok: true, name: row.name };
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
  // A pick pushes history too but spent no reroll, so only a reroll's budget comes back. With
  // rerolls unlimited (the only setting today) this is moot; it keeps a finite budget honest.
  if (state.rerollsLeft !== -1 && !game.checkerPicks) state.rerollsLeft += 1;
  // Already a Game.head shape, so it goes straight back -- re-deriving it would need the row.
  game.headByPlayer[targetId] = previous;
  return { ok: true, restored: previous.name };
}

/** Mark a player good to go. @returns {{ok, allReady}} */
function applyConfirm(game, viewerId) {
  const state = game.confirmState[viewerId];
  if (!state) return { ok: false, error: 'Not in this game.' };
  const targetId = game.checkTargetOf(viewerId);
  // The one gate that keeps an empty seat out of play (pick-for-each-other): every seat is some
  // checker's target, so "everyone confirmed" implies "every seat filled".
  if (!game.headByPlayer[targetId]) return { ok: false, error: 'Pick a character for them first.' };
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
  buildHostSetupView,
  dealWithPicks,
  applyReroll,
  applyPick,
  applyUndo,
  applyConfirm,
  applyUnlock,
  clampTurnSeconds,
  DEFAULT_MAX_REROLLS,
};
