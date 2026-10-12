// Draw the Character's end of game: every drawing kept, and the accolades read from them.
//
// Pure, like ./game.js: it is handed what a turn left behind and the clock, never a socket. A
// drawing is kept as its turn ends -- its strokes, simplified, who drew what, who got it and how
// fast -- because by the end of the game the strokes are gone (each turn starts a clean canvas)
// and the end screen is the only place anyone sees them together.
//
// Simplified because the whole gallery goes to every player at once, at the end: a dozen drawings
// at up to 30,000 points each is megabytes. Ramer-Douglas-Peucker keeps a line's shape and drops
// the points along it that change nothing visible; the tolerance only grows (coarser) for a
// drawing that is still over the budget.

const MAX_POINTS = 3000; // per drawing, once simplified
const CLUTCH_MS = 5000; // a right guess with this little time left
const MIN_CLOSE_CALLS = 3;
const MIN_ABSTRACT_STROKES = 3; // a drawing nobody got, but that was really drawn
const MAX_ACCOLADES = 4;
const MAX_PER_PLAYER = 2; // the night's best player still leaves room for everyone else

// Perpendicular distance from p to the segment a-b.
function distance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Ramer-Douglas-Peucker, with a stack rather than recursion: one long stroke can be thousands of
// points, and recursion that deep is a crash waiting for the right doodle.
function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    let worst = -1;
    let at = -1;
    for (let i = from + 1; i < to; i++) {
      const d = distance(points[i], points[from], points[to]);
      if (d > worst) [worst, at] = [d, i];
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([from, at], [at, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const pointCount = (strokes) => strokes.reduce((n, s) => n + s.points.length, 0);

/**
 * The strokes as they are kept: colour, size and points, simplified to under `maxPoints`. Points
 * are in canvas fractions (0..1), so the tolerance is too: 0.0015 is under two pixels of a
 * full-size canvas.
 */
function simplifyStrokes(strokes, maxPoints = MAX_POINTS) {
  let tolerance = 0.0015;
  let out;
  for (;;) {
    out = strokes.map((s) => ({ color: s.color, size: s.size, points: simplifyLine(s.points, tolerance) }));
    if (pointCount(out) <= maxPoints || tolerance > 0.05) break;
    tolerance *= 2;
  }
  // Still over: a scribble with no straight run anywhere. Keep what fits, in the order drawn --
  // the stroke that crosses the line cut short rather than dropped, or one giant scribble would
  // leave nothing at all.
  let left = maxPoints;
  const kept = [];
  for (const s of out) {
    if (left <= 0) break;
    kept.push(s.points.length <= left ? s : { ...s, points: s.points.slice(0, left) });
    left -= s.points.length;
  }
  return kept;
}

/**
 * One finished drawing, as the gallery keeps it.
 * @param {object} turn  { drawerId, character, strokes, guessed: [[playerId, ms]] in order,
 *   gaveUp: [ids], guessers: how many could have guessed, reason, drawSeconds }
 */
function record(turn) {
  return {
    drawerId: turn.drawerId,
    character: turn.character,
    strokes: simplifyStrokes(turn.strokes ?? []),
    guessed: (turn.guessed ?? []).map(([playerId, ms]) => ({ playerId, ms })),
    gaveUp: [...(turn.gaveUp ?? [])],
    guessers: turn.guessers ?? 0,
    reason: turn.reason,
    drawSeconds: turn.drawSeconds,
  };
}

const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))}s`;

/**
 * Every accolade the game earned, best first, then cut to MAX_ACCOLADES with no player holding
 * more than MAX_PER_PLAYER. Each is only offered when it says something true: no "Speed Demon"
 * in a game nobody guessed anything, no "So Close" for one near miss.
 *
 * @param {object[]} drawings   record()s, in the order drawn
 * @param {Map} closeCalls      playerId -> close guesses this game
 * @param {(id) => string} nameOf
 * @returns {{ title, playerId, name, detail, drawing: number|null }[]}
 */
function accolades(drawings, closeCalls, nameOf) {
  const found = [];
  const award = (title, playerId, detail, drawing = null) => found.push({ title, playerId, name: nameOf(playerId), detail, drawing });
  const title = (d) => d.character?.name ?? 'it';

  // The drawing the most of the room got (as a share of who could), the first guess breaking ties.
  const got = drawings.map((d, i) => ({ d, i })).filter(({ d }) => d.guessed.length && d.guessers);
  got.sort((a, b) => b.d.guessed.length / b.d.guessers - a.d.guessed.length / a.d.guessers || a.d.guessed[0].ms - b.d.guessed[0].ms);
  if (got.length) {
    const { d, i } = got[0];
    award('Most Recognisable', d.drawerId, d.guessed.length === d.guessers ? `Everyone got ${title(d)}` : `${d.guessed.length} of ${d.guessers} got ${title(d)}`, i);
  }

  const guesses = drawings.flatMap((d, i) => d.guessed.map((x) => ({ ...x, d, i })));
  if (guesses.length) {
    const fastest = guesses.reduce((a, b) => (b.ms < a.ms ? b : a));
    award('Speed Demon', fastest.playerId, `Got ${title(fastest.d)} in ${seconds(fastest.ms)}`, fastest.i);
  }

  // Most drawings got -- by one player alone, and at least two of them.
  const tally = new Map();
  for (const x of guesses) tally.set(x.playerId, (tally.get(x.playerId) ?? 0) + 1);
  const ranked = [...tally].sort((a, b) => b[1] - a[1]);
  if (ranked.length && ranked[0][1] >= 2 && (ranked.length === 1 || ranked[1][1] < ranked[0][1])) {
    const [playerId, n] = ranked[0];
    const chances = drawings.filter((d) => d.drawerId !== playerId).length;
    award('Mind Reader', playerId, n === chances ? 'Got every drawing' : `Got ${n} of ${chances} drawings`);
  }

  // The latest right guess, if it came with only seconds to spare.
  const late = guesses
    .map((x) => ({ ...x, left: x.d.drawSeconds * 1000 - x.ms }))
    .filter((x) => x.left > 0 && x.left <= CLUTCH_MS)
    .sort((a, b) => a.left - b.left)[0];
  if (late) award('Clutch', late.playerId, `Got ${title(late.d)} with ${seconds(late.left)} left`, late.i);

  const nearest = [...closeCalls].filter(([, n]) => n >= MIN_CLOSE_CALLS).sort((a, b) => b[1] - a[1])[0];
  if (nearest) award('So Close', nearest[0], `${nearest[1]} close calls`);

  // The most-drawn picture nobody got.
  const missed = drawings
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => !d.guessed.length && d.strokes.length >= MIN_ABSTRACT_STROKES)
    .sort((a, b) => pointCount(b.d.strokes) - pointCount(a.d.strokes))[0];
  if (missed) award('Abstract Artist', missed.d.drawerId, `Nobody got ${title(missed.d)}`, missed.i);

  const per = new Map();
  const out = [];
  for (const a of found) {
    if (out.length >= MAX_ACCOLADES) break;
    if ((per.get(a.playerId) ?? 0) >= MAX_PER_PLAYER) continue;
    per.set(a.playerId, (per.get(a.playerId) ?? 0) + 1);
    out.push(a);
  }
  return out;
}

/** The gallery as the end screen gets it: names, not ids, and nothing a client could not show. */
function galleryFor(drawings, nameOf) {
  return drawings.map((d) => ({
    drawer: nameOf(d.drawerId),
    character: d.character,
    strokes: d.strokes,
    got: d.guessed.map((x) => ({ name: nameOf(x.playerId), seconds: Math.max(1, Math.round(x.ms / 1000)) })),
    guessers: d.guessers,
  }));
}

module.exports = { record, accolades, galleryFor, simplifyStrokes, simplifyLine, MAX_POINTS, CLUTCH_MS };
