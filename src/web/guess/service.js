// The setup service for Guess the Character on the web: deal a room (or, picking for each other,
// leave every seat empty), then drive the confirm/reroll/pick screen. Shared by both ways of playing -- phones (../party) and computers
// (../desk) deal, check and reroll by exactly the same rules, and a second copy is how two games
// end up disagreeing about one.
//
// Content comes from ../content.js; the rules from ./gameSetup.js, which is pure and tested.

const gameSetup = require('./gameSetup');
const web = require('../content');
const { freshSeating } = require('../../core/game/seating');

const { content } = web;

const setup = {
  options: () => web.poolOptions(),
  listsInCategory: (category, room) => web.listsInCategory(category, room),
  toggleList: (listId, room) => web.toggleList(listId, room),
  setLists: (listIds, playing, room) => web.setListsPlaying(listIds, playing, room),
  keepOff: (listIds, room) => web.keepListsOff(listIds, room),

  // preferImages is OFF unless the host asks for it: restricting the draw to characters that
  // happen to have artwork silently shrinks the pool and biases it toward the better-documented
  // franchises, which is a real change to what the game deals. It is the host's call, not a default.
  // `hostPicks` is the mode where the host chooses everyone's character and sits the game out;
  // `picks` is their choice per player (see gameSetup.dealWithPicks). The pool still matters in
  // that mode, for anyone the host left on random.
  // `eachPicks` is the mode where nothing is dealt and every player picks the character of the
  // player they check (see gameSetup.applyPick). The pool is still where "Random" draws from.
  start(room, { poolType = 'random', category = null, categories = null, difficulty = web.DEFAULT_DIFFICULTY, turnSeconds, preferImages = false, hostPicks = false, eachPicks = false, picks = {} } = {}) {
    if (hostPicks && eachPicks) return { ok: false, error: 'Choose one way of picking characters.' };
    const { listIds, label } = web.resolvePool({ poolType, category, categories, excluded: room.excludedListIds });
    // Seated afresh every game, unlike the last one in this room (core/game/seating.js): who goes
    // first, and who checks -- or picks for -- whom. Everything below deals in this order.
    let order = freshSeating(room.order, room.lastOrder);
    let characters;
    if (eachPicks) {
      // Empty seats, filled on the check screen. Nothing to count against the pool: a typed name
      // needs no pool at all, and "Random" says so itself if the pool runs dry.
      characters = order.map(() => null);
    } else if (hostPicks) {
      order = order.filter((id) => id !== room.hostPlayerId);
      // Two, not one: every player checks the NEXT player's character, and a lone guesser's
      // "next player" is themselves -- the check screen would show them their own card.
      if (order.length < 2) return { ok: false, error: 'Picking for everyone needs at least 2 players besides you.' };
      const names = Object.fromEntries([...room.players].map(([id, seat]) => [id, seat.nickname]));
      const dealt = gameSetup.dealWithPicks({ order, picks, names, content, listIds, difficulty, preferImages: !!preferImages });
      if (!dealt.ok) return dealt;
      characters = dealt.characters;
    } else {
      if (!listIds.length) return { ok: false, error: 'That selection has no playable lists.' };
      const n = order.length;
      const available = content.countDistinct(listIds, difficulty);
      if (available < n) {
        return { ok: false, error: `${label} has only ${available} characters at this difficulty; need ${n}.` };
      }
      characters = content.randomCharacters(listIds, n, [], difficulty, { preferImages: !!preferImages });
      if (characters.length < n) return { ok: false, error: 'Could not deal enough distinct characters.' };
    }

    const clampedTurnSeconds = gameSetup.clampTurnSeconds(turnSeconds);
    room.game = gameSetup.createSetup({
      order,
      guildId: web.WEB_SCOPE,
      listIds,
      difficulty,
      characters,
      preferImages: !!preferImages,
      rerollAllowed: !hostPicks,
      checkerPicks: !!eachPicks,
      ...(clampedTurnSeconds !== undefined ? { turnSeconds: clampedTurnSeconds } : {}),
    });
    room.lastOrder = order;
    const shownLabel = hostPicks ? 'Picked by the host' : eachPicks ? 'Picked for each other' : label;
    room.poolLabel = shownLabel;
    // Remembered so "Rematch (same settings)" can re-deal without the host reconfiguring. The
    // picks themselves are deliberately NOT kept: re-dealing the same hand-picked characters to
    // people who have just watched each other's all game would be no game at all.
    // Pick-for-each-other keeps nothing to replay either, but needs nothing: a rematch deals empty
    // seats again and everyone picks afresh, so it rematches like a dealt game.
    room.lastSetup = { poolType, category, categories, difficulty, turnSeconds: room.game.turnSeconds, preferImages: !!preferImages, hostPicks: !!hostPicks, eachPicks: !!eachPicks };
    return { ok: true, label: shownLabel };
  },

  view: (game, viewerId, names) => gameSetup.buildView(game, viewerId, names),
  hostView: (game, names) => gameSetup.buildHostSetupView(game, names),
  reroll: (game, viewerId) =>
    gameSetup.applyReroll(game, viewerId, {
      content,
      listIds: game.lobby.listIds,
      difficulty: game.lobby.difficulty,
      preferImages: game.lobby.preferImages,
    }),
  pick: (game, viewerId, pick) => gameSetup.applyPick(game, viewerId, pick, { content }),
  undo: (game, viewerId) => gameSetup.applyUndo(game, viewerId),
  confirm: (game, viewerId) => gameSetup.applyConfirm(game, viewerId),
  unlock: (game, viewerId) => gameSetup.applyUnlock(game, viewerId),
};

module.exports = { setup };
