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
const MIN_REACTIONS = 4; // Crowd Pleaser: this many reactions...
const MIN_REACTORS = 2; // ...from at least this many people, not one player holding the button
const MAX_MINIMAL_STROKES = 6; // Minimalist: got from this few strokes at most
const MIN_LABOUR_STROKES = 25; // Labour of Love: this many strokes on a drawing someone got
const MIN_RAINBOW_COLOURS = 5; // Rainbow: this many colours in one drawing
const MAX_ACCOLADES = 6;
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
    // A fill is one point and stays one: it is a place, not a line.
    out = strokes.map((s) =>
      s.kind === 'fill'
        ? { kind: 'fill', color: s.color, size: 0, points: s.points.slice(0, 1) }
        : { color: s.color, size: s.size, points: simplifyLine(s.points, tolerance) }
    );
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
 *   gaveUp: [ids], reactors: Map playerId -> reactions, guessers: how many could have guessed,
 *   reason, drawSeconds }
 */
function record(turn) {
  const reactors = [...(turn.reactors ?? new Map()).values()];
  return {
    drawerId: turn.drawerId,
    character: turn.character,
    strokes: simplifyStrokes(turn.strokes ?? []),
    guessed: (turn.guessed ?? []).map(([playerId, ms]) => ({ playerId, ms })),
    gaveUp: [...(turn.gaveUp ?? [])],
    reactions: reactors.reduce((n, k) => n + k, 0),
    reactors: reactors.length,
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
  const indexed = drawings.map((d, i) => ({ d, i }));
  const linesIn = (d) => d.strokes.filter((s) => s.kind !== 'fill').length;
  const gotByAll = (d) => d.guessers > 0 && d.guessed.length === d.guessers;

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

  // The drawing the room reacted to most -- and from more than one of them, so it is the room's
  // delight and not one player holding the button down.
  const loved = indexed
    .filter(({ d }) => (d.reactions ?? 0) >= MIN_REACTIONS && (d.reactors ?? 0) >= MIN_REACTORS)
    .sort((a, b) => b.d.reactions - a.d.reactions)[0];
  if (loved) award('Crowd Pleaser', loved.d.drawerId, `${loved.d.reactions} reactions to ${title(loved.d)}`, loved.i);

  // Everyone got every one of a player's drawings, two at least. The most drawings wins; a tie
  // names nobody, as Mind Reader's does.
  const byDrawer = new Map();
  for (const d of drawings) byDrawer.set(d.drawerId, [...(byDrawer.get(d.drawerId) ?? []), d]);
  const sweeps = [...byDrawer].filter(([, ds]) => ds.length >= 2 && ds.every(gotByAll)).sort((a, b) => b[1].length - a[1].length);
  if (sweeps.length && (sweeps.length === 1 || sweeps[1][1].length < sweeps[0][1].length)) {
    const [playerId, ds] = sweeps[0];
    award('Clean Sweep', playerId, `Everyone got all ${ds.length} of theirs`);
  }

  // The latest right guess, if it came with only seconds to spare.
  const late = guesses
    .map((x) => ({ ...x, left: x.d.drawSeconds * 1000 - x.ms }))
    .filter((x) => x.left > 0 && x.left <= CLUTCH_MS)
    .sort((a, b) => a.left - b.left)[0];
  if (late) award('Clutch', late.playerId, `Got ${title(late.d)} with ${seconds(late.left)} left`, late.i);

  // Said the most with the least: half the room or more got it, from a handful of lines.
  const minimal = indexed
    .map((x) => ({ ...x, n: linesIn(x.d) }))
    .filter(({ d, n }) => n >= 1 && n <= MAX_MINIMAL_STROKES && d.guessers > 0 && d.guessed.length * 2 >= d.guessers)
    .sort((a, b) => a.n - b.n || pointCount(a.d.strokes) - pointCount(b.d.strokes))[0];
  if (minimal) award('Minimalist', minimal.d.drawerId, `${title(minimal.d)} in ${minimal.n} stroke${minimal.n === 1 ? '' : 's'}`, minimal.i);

  const nearest = [...closeCalls].filter(([, n]) => n >= MIN_CLOSE_CALLS).sort((a, b) => b[1] - a[1])[0];
  if (nearest) award('So Close', nearest[0], `${nearest[1]} close calls`);

  // The most-drawn picture nobody got.
  const missed = drawings
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => !d.guessed.length && d.strokes.length >= MIN_ABSTRACT_STROKES)
    .sort((a, b) => pointCount(b.d.strokes) - pointCount(a.d.strokes))[0];
  if (missed) award('Abstract Artist', missed.d.drawerId, `Nobody got ${title(missed.d)}`, missed.i);

  // The most work that paid off: a great many strokes on a drawing somebody got.
  const labour = indexed
    .filter(({ d }) => d.strokes.length >= MIN_LABOUR_STROKES && d.guessed.length)
    .sort((a, b) => b.d.strokes.length - a.d.strokes.length)[0];
  if (labour) award('Labour of Love', labour.d.drawerId, `${labour.d.strokes.length} strokes on ${title(labour.d)}`, labour.i);

  // The most colours in one drawing. White is the paper: drawn or erased, it adds no colour.
  const colourful = indexed
    .map((x) => ({ ...x, n: new Set(x.d.strokes.map((st) => st.color).filter((c) => c !== '#ffffff')).size }))
    .filter(({ n }) => n >= MIN_RAINBOW_COLOURS)
    .sort((a, b) => b.n - a.n)[0];
  if (colourful) award('Rainbow', colourful.d.drawerId, `${colourful.n} colours in ${title(colourful.d)}`, colourful.i);

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
    drawerId: d.drawerId, // public: so a page knows which drawings are its own (and cannot vote for them)
    character: d.character, // { name: as the blanks spelled it, realName: the library's, when different }
    strokes: d.strokes,
    got: d.guessed.map((x) => ({ name: nameOf(x.playerId), seconds: Math.max(1, Math.round(x.ms / 1000)) })),
    guessers: d.guessers,
  }));
}

module.exports = { record, accolades, galleryFor, simplifyStrokes, simplifyLine, MAX_POINTS, CLUTCH_MS };
