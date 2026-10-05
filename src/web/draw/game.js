// Draw the Character: one player draws a character, everyone else types guesses at it.
//
// Pure, like the other games' rules: no socket.io, no DB, no timers -- the socket layer
// (./socket.js) owns time and passes `now` in, so every rule here is testable with a fake clock.
//
// A game is ROUNDS rounds; in each, every player draws once, in seat order. A turn is:
//
//   choosing  the drawer picks one of three characters (CHOOSE_SECONDS, then the first is taken),
//             or asks for three new ones -- as often as they like (CHOICE_REROLLS), each a fresh clock
//   drawing   they draw it; everyone else types guesses. Everyone sees the kind of work it is
//             from ("Anime") from the start, and the work itself ("Naruto") from half time,
//             with any word of it that names the character blanked. Letters of the name are
//             revealed as hints part-way through. Ends when every guesser has it, or time is up.
//   reveal    the answer and the turn's points, for REVEAL_SECONDS
//
// Guesses are judged by the compendium's checker (src/compendium/answers.js) with single words
// OFF: people guessing at a drawing type what they SEE, and "Combat" must not win the round for
// "Combat Carl". A close guess is told privately to whoever typed it ("you're close") and shown
// to nobody else. Once you have it -- and for the drawer, always -- what you type goes only to
// the others who know, because it may well contain the answer.

const { judgeGuess, maskNameWords } = require('../../compendium/answers');
const { publicCharacter } = require('../publicCharacter');

const CHOOSE_SECONDS = 15;
// WEB_DRAW_REVEAL_SECONDS shortens it for the socket check, the way WEB_GRACE_SECONDS does the phones' countdown.
const REVEAL_SECONDS = Number(process.env.WEB_DRAW_REVEAL_SECONDS ?? 6);
const CHOICES = 3;
// New choices per turn: -1 is unlimited, which is where it starts. Three faces nobody can draw is
// the commonest reason a turn goes nowhere, and the cost of another look is only the drawer's own
// time. A finite number stays representable (rerollsLeft counts down) for when a limit is wanted.
const CHOICE_REROLLS = -1;
// Hints: a letter at half time, another at three quarters -- never more than a third of the name.
const HINT_AT = [0.5, 0.75];
// The work the character is from, at half time. The kind of work is shown from the start.
const WORK_AT = 0.5;
const CHAT_KEPT = 60;
const TEXT_MAX = 80;
// Points for a correct guess fall from GUESS_MAX to GUESS_MIN over the turn: speed is the skill.
// The drawer earns DRAWER_PER_GUESS for each person who gets it -- a drawing nobody can read
// scores nothing, which is the incentive to draw the character rather than spell it.
const GUESS_MAX = 400;
const GUESS_MIN = 100;
const DRAWER_PER_GUESS = 60;

function createDrawGame({ order, rounds = 3, drawSeconds = 80 }) {
  return {
    order: [...order],
    rounds,
    drawSeconds,
    round: 1,
    drawerIndex: 0,
    phase: 'choosing',
    choices: [],
    offered: [], // every name offered this turn, so new choices are new
    rerollsLeft: CHOICE_REROLLS,
    character: null,
    deadline: null,
    startedAt: null,
    guessed: new Map(), // playerId -> points this turn, in the order they got it
    scores: new Map(order.map((id) => [id, 0])),
    revealed: [], // indexes into the character's name
    workShown: false,
    strokes: [],
    chat: [],
    seq: 0,
    used: [], // names drawn this game, never offered twice
    lastTurn: null,
    gone: new Set(),
  };
}

const drawerOf = (g) => g.order[g.drawerIndex];
const activeOf = (g) => g.order.filter((id) => !g.gone.has(id));
const guessersOf = (g) => activeOf(g).filter((id) => id !== drawerOf(g));
/** Whether a player already knows the answer this turn: the drawer, and anyone who guessed it. */
const knows = (g, id) => id === drawerOf(g) || g.guessed.has(id);
const allGuessed = (g) => {
  const guessers = guessersOf(g);
  return guessers.length > 0 && guessers.every((id) => g.guessed.has(id));
};

/** Start the current drawer's turn with these characters to choose from. */
function offerChoices(g, choices, now) {
  g.phase = 'choosing';
  g.choices = choices.slice(0, CHOICES);
  g.offered = g.choices.map((c) => c.name);
  g.rerollsLeft = CHOICE_REROLLS;
  g.character = null;
  g.deadline = now + CHOOSE_SECONDS * 1000;
  g.startedAt = null;
  g.guessed = new Map();
  g.revealed = [];
  g.workShown = false;
  g.strokes = [];
  g.chat = [];
}

function choose(g, playerId, index, now) {
  if (g.phase !== 'choosing') return { ok: false, error: 'Nothing to choose right now.' };
  if (playerId !== drawerOf(g)) return { ok: false, error: "It's not your turn to draw." };
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= g.choices.length) return { ok: false, error: 'Pick one of the three.' };
  g.character = g.choices[i];
  g.choices = [];
  g.used.push(g.character.name);
  g.phase = 'drawing';
  g.startedAt = now;
  g.deadline = now + g.drawSeconds * 1000;
  return { ok: true };
}

/**
 * What new choices must avoid: everything drawn this game, and everything already offered this
 * turn -- otherwise "new choices" could hand back the very faces the drawer just turned down.
 */
const rerollExclusions = (g) => [...new Set([...g.used, ...g.offered])];

/**
 * The drawer turns down all three and gets new ones. `choices` are dealt by the caller with
 * rerollExclusions(g); fewer than three is fine (a small pool), none is refused. The choosing clock
 * starts again, because it measured time to decide among the old three.
 */
function rerollChoices(g, playerId, choices, now) {
  if (g.phase !== 'choosing') return { ok: false, error: 'Nothing to choose right now.' };
  if (playerId !== drawerOf(g)) return { ok: false, error: "It's not your turn to draw." };
  if (g.rerollsLeft === 0) return { ok: false, error: 'No new choices left this turn.' };
  if (!choices?.length) return { ok: false, error: 'There are no other characters left to offer.' };
  g.choices = choices.slice(0, CHOICES);
  g.offered.push(...g.choices.map((c) => c.name));
  if (g.rerollsLeft > 0) g.rerollsLeft -= 1;
  g.deadline = now + CHOOSE_SECONDS * 1000;
  return { ok: true };
}

/** The drawer let the clock run out: the first choice it is. */
const autoChoose = (g, now) => choose(g, drawerOf(g), 0, now);

const pointsAt = (g, now) => {
  const left = Math.max(0, g.deadline - now) / (g.drawSeconds * 1000);
  return Math.round(GUESS_MIN + (GUESS_MAX - GUESS_MIN) * left);
};

function post(g, playerId, text, insider) {
  g.chat.push({ id: ++g.seq, playerId, text, insider });
  if (g.chat.length > CHAT_KEPT) g.chat.splice(0, g.chat.length - CHAT_KEPT);
}

/**
 * Anything typed into the chat. From someone still guessing it is a guess; from someone who
 * already knows, it is a message for the others who know.
 *
 * @returns {{ok: false, error} | {ok: true, verdict: 'correct'|'close'|'wrong'|'said', points?, allGuessed?}}
 */
function say(g, playerId, text, now) {
  if (g.phase !== 'drawing' && g.phase !== 'choosing' && g.phase !== 'reveal') return { ok: false, error: 'The game is over.' };
  if (!g.order.includes(playerId) || g.gone.has(playerId)) return { ok: false, error: "You're not in this game." };
  const clean = String(text ?? '').trim().slice(0, TEXT_MAX);
  if (!clean) return { ok: false, error: 'Type something first.' };

  if (g.phase !== 'drawing' || knows(g, playerId)) {
    // Between drawings nobody is guessing, so it is just chat; while drawing, only insiders see
    // an insider's words.
    post(g, playerId, clean, g.phase === 'drawing');
    return { ok: true, verdict: 'said' };
  }

  const { verdict } = judgeGuess(clean, g.character.name, { singleWords: false });
  if (verdict === 'correct') {
    const points = pointsAt(g, now);
    g.guessed.set(playerId, points);
    g.scores.set(playerId, (g.scores.get(playerId) ?? 0) + points);
    const drawer = drawerOf(g);
    g.scores.set(drawer, (g.scores.get(drawer) ?? 0) + DRAWER_PER_GUESS);
    return { ok: true, verdict, points, allGuessed: allGuessed(g) };
  }
  // A close guess is for its author's eyes only: shown to the room, "Sasuek" would be a hint to
  // everyone else.
  if (verdict === 'close') return { ok: true, verdict };
  post(g, playerId, clean, false);
  return { ok: true, verdict };
}

// --- hints -----------------------------------------------------------------------------------

const isLetter = (ch) => /[\p{L}\p{N}]/u.test(ch);

/** When the hints fall due, in ms timestamps -- the letters and the work. */
const hintTimes = (g) =>
  g.startedAt == null ? [] : [...new Set([...HINT_AT, WORK_AT])].map((f) => g.startedAt + f * g.drawSeconds * 1000);

/**
 * Reveal whatever hints are due. `pick` chooses among the candidate indexes (random in play, fixed
 * in tests). Returns whether anything changed.
 */
function revealDueHints(g, now, pick = (xs) => xs[Math.floor(Math.random() * xs.length)]) {
  if (g.phase !== 'drawing' || !g.character) return false;
  const name = [...g.character.name];
  const letters = name.map((ch, i) => (isLetter(ch) ? i : -1)).filter((i) => i >= 0);
  const cap = Math.floor(letters.length / 3);
  const at = (f) => g.startedAt + f * g.drawSeconds * 1000;
  let changed = false;
  if (!g.workShown && g.character.origin?.work && now >= at(WORK_AT)) {
    g.workShown = true;
    changed = true;
  }
  const due = HINT_AT.filter((f) => at(f) <= now).length;
  while (g.revealed.length < Math.min(due, cap)) {
    const left = letters.filter((i) => !g.revealed.includes(i));
    if (!left.length) break;
    g.revealed.push(pick(left));
    changed = true;
  }
  return changed;
}

/**
 * The name as a guesser sees it: letters blanked unless revealed, everything else shown -- the
 * spaces, the hyphen in "Spider-Man", the apostrophe in "Kai'Sa" are part of the shape.
 */
function maskOf(g) {
  if (!g.character) return null;
  return [...g.character.name].map((ch, i) => (isLetter(ch) && !g.revealed.includes(i) ? '_' : ch)).join('');
}

/**
 * Where the character is from, as far as the clock allows: `category` throughout, `work` once
 * it is due (masked -- "Super _____ Bros." -- because a title can spell the answer), and
 * `workLater` while there is one still to come, so the page can say it is on its way. The same
 * for everyone, the drawer included: they see what the guessers are working with.
 */
function clueFor(g) {
  const origin = g.character?.origin;
  if (!origin) return null;
  const work = origin.work ? maskNameWords(origin.work, g.character.name) : null;
  return { category: origin.category ?? null, work: g.workShown ? work : null, workLater: !g.workShown && !!work };
}

// --- turn ends and advances ------------------------------------------------------------------

function endTurn(g, now, reason) {
  if (g.phase !== 'drawing' && g.phase !== 'choosing') return { ok: false };
  const drawer = drawerOf(g);
  g.lastTurn = {
    drawerId: drawer,
    character: g.character ?? g.choices[0] ?? null,
    reason, // 'all' | 'time' | 'drawer-left'
    guessed: [...g.guessed].map(([playerId, points]) => ({ playerId, points })),
    drawerPoints: g.guessed.size * DRAWER_PER_GUESS,
  };
  g.phase = 'reveal';
  g.deadline = now + REVEAL_SECONDS * 1000;
  return { ok: true };
}

/**
 * Move on from the reveal to the next drawer -- skipping anyone who left -- or to the next round,
 * or to the end. Returns { over } ; when not over, the caller deals the next drawer's choices.
 */
function advance(g) {
  if (activeOf(g).length < 2) {
    g.phase = 'over';
    return { over: true };
  }
  for (;;) {
    g.drawerIndex++;
    if (g.drawerIndex >= g.order.length) {
      g.drawerIndex = 0;
      g.round++;
      if (g.round > g.rounds) {
        g.phase = 'over';
        return { over: true };
      }
    }
    if (!g.gone.has(drawerOf(g))) return { over: false };
  }
}

/**
 * A player leaves for good. Their score stays on the board. If they were drawing, the turn ends;
 * if they were the last one guessing, it ends because everyone left has it.
 */
function removePlayer(g, playerId, now) {
  if (!g.order.includes(playerId) || g.gone.has(playerId)) return { ok: false };
  const wasDrawer = playerId === drawerOf(g);
  g.gone.add(playerId);
  if (g.phase === 'over' || g.phase === 'reveal') return { ok: true, endTurn: false };
  if (activeOf(g).length < 2) {
    endTurn(g, now, 'drawer-left');
    return { ok: true, endTurn: true };
  }
  if (wasDrawer) {
    endTurn(g, now, 'drawer-left');
    return { ok: true, endTurn: true };
  }
  if (g.phase === 'drawing' && allGuessed(g)) {
    endTurn(g, now, 'all');
    return { ok: true, endTurn: true };
  }
  return { ok: true, endTurn: false };
}

/** Final (or running) standings: by score, ties sharing a place. */
function standings(g, names) {
  const rows = g.order
    .map((id) => ({ playerId: id, name: names[id] ?? 'Player', score: g.scores.get(id) ?? 0, left: g.gone.has(id) }))
    .sort((a, b) => b.score - a.score);
  let place = 0;
  let last = null;
  rows.forEach((r, i) => {
    if (r.score !== last) place = i + 1;
    last = r.score;
    r.place = place;
  });
  return rows;
}

// --- what one player sees --------------------------------------------------------------------

/**
 * One player's view. The rule it keeps: the answer reaches only those who know it -- the drawer,
 * and anyone who has guessed it -- until the reveal. Not in `character`, not in `choices`, not in
 * a chat line from someone who knows. test/draw.test.js searches whole payloads for it.
 */
function viewFor(g, viewerId, names, now = Date.now()) {
  const nameOf = (id) => names[id] ?? 'Player';
  const drawer = drawerOf(g);
  const isDrawer = viewerId === drawer;
  const insider = g.phase === 'drawing' && knows(g, viewerId);
  const answerShown = g.phase === 'reveal' || g.phase === 'over' || (g.phase === 'drawing' && knows(g, viewerId));
  return {
    phase: g.phase,
    round: Math.min(g.round, g.rounds),
    rounds: g.rounds,
    drawer: { playerId: drawer, name: nameOf(drawer) },
    isDrawer,
    secondsLeft: g.deadline ? Math.max(0, Math.round((g.deadline - now) / 1000)) : null,
    drawSeconds: g.drawSeconds,
    choices: isDrawer && g.phase === 'choosing' ? g.choices.map(publicCharacter) : null,
    // -1 unlimited. Only the drawer has anything to reroll.
    rerollsLeft: isDrawer && g.phase === 'choosing' ? g.rerollsLeft : null,
    character: answerShown && g.character ? publicCharacter(g.character) : null,
    mask: g.phase === 'drawing' ? maskOf(g) : null,
    clue: g.phase === 'drawing' ? clueFor(g) : null,
    guessedIt: g.guessed.has(viewerId),
    players: g.order.map((id) => ({
      playerId: id,
      name: nameOf(id),
      score: g.scores.get(id) ?? 0,
      guessed: g.guessed.has(id),
      drawing: id === drawer && (g.phase === 'drawing' || g.phase === 'choosing'),
      left: g.gone.has(id),
    })),
    // Insider lines only for insiders, while drawing. Once the answer is out they are harmless.
    chat: g.chat
      .filter((m) => !m.insider || insider || g.phase !== 'drawing')
      .slice(-40)
      .map((m) => ({ id: m.id, name: nameOf(m.playerId), text: m.text, insider: m.insider })),
    lastTurn:
      g.phase === 'reveal' && g.lastTurn
        ? {
            drawer: nameOf(g.lastTurn.drawerId),
            character: g.lastTurn.character ? publicCharacter(g.lastTurn.character) : null,
            reason: g.lastTurn.reason,
            guessed: g.lastTurn.guessed.map((x) => ({ name: nameOf(x.playerId), points: x.points })),
            drawerPoints: g.lastTurn.drawerPoints,
          }
        : null,
  };
}

module.exports = {
  createDrawGame,
  offerChoices,
  choose,
  rerollChoices,
  rerollExclusions,
  autoChoose,
  say,
  revealDueHints,
  hintTimes,
  maskOf,
  clueFor,
  endTurn,
  advance,
  removePlayer,
  standings,
  viewFor,
  drawerOf,
  allGuessed,
  knows,
  CHOOSE_SECONDS,
  REVEAL_SECONDS,
  CHOICES,
  CHOICE_REROLLS,
  TEXT_MAX,
};
