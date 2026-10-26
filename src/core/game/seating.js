// Who sits where for a new game -- every game, on every frontend.
//
// The order is more than who goes first. Everyone checks (and, picking for each other, picks for)
// the NEXT player round the rotation, so the order also decides who handles whose character. Taken
// straight from the join order, both were fixed for good: the host always went first, a rematch
// replayed the same order, and the same person picked for you all night. Scoring by turns taken
// means the seat gives nobody an edge, so it is free to change -- and changing it is most of what
// makes the next game a different game.
//
// So a game is seated at random, and of the shuffles tried, the one most UNLIKE the last game is
// kept: a different first player above all, then as few as possible of the same "checks the next
// one" pairs. With two players the pair cannot change (each checks the other), but who starts does;
// with three, the rotation simply runs the other way.
//
// GTC_FIXED_SEATING=1 keeps the order as given: the test suites assert on who goes first.

// Shuffles tried for one unlike the last. With four players only the reverse rotation repeats no
// pair, about one shuffle in eight: 30 tries missed it now and then (measured, test/seating). 200
// misses it about once in a trillion, and costs nothing even for Draw's fifty.
const TRIES = 200;

function shuffled(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * @param {string[]} players     everyone being seated
 * @param {string[]|null} [previous]  the last game's order in this room or lobby, if any
 * @param {object} [opts]
 * @param {() => number} [opts.rand]
 * @param {boolean} [opts.fixed]  keep `players` as given (GTC_FIXED_SEATING)
 * @returns {string[]} a new order of the same players
 */
function freshSeating(players, previous = null, { rand = Math.random, fixed = process.env.GTC_FIXED_SEATING === '1' } = {}) {
  if (fixed || players.length < 2) return [...players];
  // Only what is still true of this table: someone who left has no place to repeat.
  const before = (previous ?? []).filter((id) => players.includes(id));
  const nextBefore = new Map(before.map((id, i) => [id, before[(i + 1) % before.length]]));
  const unlikeness = (order) =>
    (before.length && order[0] === before[0] ? 100 : 0) +
    order.filter((id, i) => nextBefore.get(id) === order[(i + 1) % order.length]).length;

  let best = null;
  let bestScore = Infinity;
  for (let t = 0; t < TRIES && bestScore > 0; t++) {
    const order = shuffled(players, rand);
    const score = unlikeness(order);
    if (score < bestScore) {
      best = order;
      bestScore = score;
    }
  }
  return best;
}

module.exports = { freshSeating };
