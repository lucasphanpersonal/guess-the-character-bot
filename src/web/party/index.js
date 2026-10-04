// Party mode: the phone game. Phones on foreheads in one room, tilt to answer.
//
// One of the web games mounted by ../server.js, which owns everything they share (the HTTP
// server, images, browsing, the QR, rooms). This file is what makes it THIS game: the setup
// service the socket protocol drives (dealing, confirm/reroll, host picks) and the protocol
// itself (./socket.js). It is served at the site root because it was the only game when the
// links and QR codes in people's hands were made, and the client is unversioned.
//
// The rules live in pure, unit-tested modules -- ./gameSetup.js (dealing and the confirm screen)
// and ./turnLoop.js (turns and the forehead display) -- so nothing here needs a network to test.

const path = require('path');
const { attachSockets } = require('./socket');
const gameSetup = require('./gameSetup');
const web = require('../content');

const { content } = web;

const setup = {
  options: () => web.poolOptions(),
  listsInCategory: (category, room) => web.listsInCategory(category, room),
  toggleList: (listId, room) => web.toggleList(listId, room),

  // preferImages is OFF unless the host asks for it: restricting the draw to characters that
  // happen to have artwork silently shrinks the pool and biases it toward the better-documented
  // franchises, which is a real change to what the game deals. It is the host's call, not a default.
  // `hostPicks` is the mode where the host chooses everyone's character and sits the game out;
  // `picks` is their choice per player (see gameSetup.dealWithPicks). The pool still matters in
  // that mode, for anyone the host left on random.
  start(room, { poolType = 'random', category = null, difficulty = web.DEFAULT_DIFFICULTY, turnSeconds, preferImages = false, hostPicks = false, picks = {} } = {}) {
    const { listIds, label } = web.resolvePool({ poolType, category, excluded: room.excludedListIds });
    let order = [...room.order];
    let characters;
    if (hostPicks) {
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
      ...(clampedTurnSeconds !== undefined ? { turnSeconds: clampedTurnSeconds } : {}),
    });
    const shownLabel = hostPicks ? 'Picked by the host' : label;
    room.poolLabel = shownLabel;
    // Remembered so "Rematch (same settings)" can re-deal without the host reconfiguring. The
    // picks themselves are deliberately NOT kept: re-dealing the same hand-picked characters to
    // people who have just watched each other's all game would be no game at all.
    room.lastSetup = { poolType, category, difficulty, turnSeconds: room.game.turnSeconds, preferImages: !!preferImages, hostPicks: !!hostPicks };
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
  undo: (game, viewerId) => gameSetup.applyUndo(game, viewerId),
  confirm: (game, viewerId) => gameSetup.applyConfirm(game, viewerId),
  unlock: (game, viewerId) => gameSetup.applyUnlock(game, viewerId),
};

module.exports = {
  // The client, served by ../server.js.
  publicDir: path.join(__dirname, 'public'),
  // Party mode owns the DEFAULT socket.io namespace, for the same reason it owns the site root:
  // the clients already out there connect to it. Later games take a namespace of their own.
  attach: (io, { registry }) => attachSockets(io, { registry, setup }),
};
