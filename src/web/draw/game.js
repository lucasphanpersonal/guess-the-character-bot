// Draw the Character: one player draws a character, everyone else types guesses at it.
//
// Pure, like the other games' rules: no socket.io, no DB, no timers -- the socket layer
// (./socket.js) owns time and passes `now` in, so every rule here is testable with a fake clock.
//
// A game is ROUNDS rounds; in each, every player draws once, in seat order. A turn is:
//
//   choosing  the drawer picks one of three characters, with no clock -- choosing well is half the
//             fun, and a drawer who walks away is the host's to remove -- or asks for three new
//             ones, as often as they like (CHOICE_REROLLS)
//   drawing   they draw it; everyone else types guesses. The hints come on a clock, so the
//             first half is about the drawing: the kind of work ("Anime") at a quarter of the
//             time -- from the start when the room plays one category, since everyone knows it
//             then -- the blanks (how many words, how many letters) at half time, letters of the
//             name from 60%, faster as the clock runs down, and the work itself ("Naruto", any
//             word of it that names the character blanked) for the last quarter. Ends when every
//             guesser has it, or time is up.
//   reveal    the answer and the turn's points, for REVEAL_SECONDS
//
// Guesses are judged by the compendium's checker (src/compendium/answers.js), and a character's
// known name counts on its own -- "Sasuke" for Sasuke Uchiha, "Luffy" for Monkey D. Luffy -- when
// no one else in the character's own show has that word, or everyone who does is at least ten
// times less famous: "Uzumaki" is Naruto, while "Uchiha", shared by Itachi and Sasuke, stays
// close. Full names only was the rule at first, so that "Combat" could not win the
// round for "Combat Carl" -- people guessing at a drawing type what they SEE -- but it marked
// "close" the name everyone actually calls most characters by. Unique in the show, not in the
// whole pool: across 25,000 characters somebody else is always called Fred, which says nothing
// about whether "Fred" picks out this one. Before the clock starts, the drawer is shown what will
// count (acceptedNames) and may add names of their own (alsoAccept). A close guess is told
// privately to whoever typed it ("you're close"); of everyone else, only the drawer sees it.
// Once you have it -- and for the drawer, always -- what you type goes only to the others who
// know, because it may well contain the answer.

const { judgeGuess, maskNameWords, identityKeys } = require('../../compendium/answers');
const { normalizeLoose } = require('../../compendium/text');
const { publicCharacter } = require('../publicCharacter');
const gallery = require('./gallery');

// WEB_DRAW_REVEAL_SECONDS shortens it for the socket check, the way WEB_GRACE_SECONDS does the phones' countdown.
const REVEAL_SECONDS = Number(process.env.WEB_DRAW_REVEAL_SECONDS ?? 6);
const CHOICES = 3;
// New choices per turn: -1 is unlimited, which is where it starts. Three faces nobody can draw is
// the commonest reason a turn goes nowhere, and the cost of another look is only the drawer's own
// time. A finite number stays representable (rerollsLeft counts down) for when a limit is wanted.
const CHOICE_REROLLS = -1;
// The hint clock, as fractions of the drawing time. It was everything early -- the blanks and the
// kind of work from the first second, the title and the first letter at half time -- and a room
// could often name the character before the drawing said anything. So the first half is the
// drawing's: the kind of work at a quarter, the blanks at half, letters from 60% (a beat after
// the blanks, not on top of them), the title for the last quarter.
const CATEGORY_AT = 0.25;
const MASK_AT = 0.5;
// The first letter at HINT_FIRST, then the rest spread evenly to HINT_LAST, so hints speed up as
// the clock runs down -- the end of a turn is when a stuck room most needs them. The letters a
// name can give away: a third of them (one for three to five letters), none for two ("Ed" with a
// letter showing is not a hint, it is the answer).
const HINT_FIRST = 0.6;
const HINT_LAST = 0.95;
const letterBudget = (letterCount) => (letterCount >= 3 ? Math.floor(letterCount / 3) : 0);
/** When each letter falls due, as fractions of the drawing time. */
function hintFractions(letterCount) {
  const n = letterBudget(letterCount);
  if (n <= 1) return n ? [HINT_FIRST] : [];
  return Array.from({ length: n }, (_, i) => HINT_FIRST + ((HINT_LAST - HINT_FIRST) * i) / (n - 1));
}
// The work the character is from: the strongest of the hints, so the last quarter.
const WORK_AT = 0.75;
// Other names the drawer accepts for their character, typed while choosing: the English name of a
// character the library has in Japanese ("Serena" for Usagi), a nickname the room uses. A few and
// short. One letter is a name too: the library has "Lawliet L", and the room calls him L. It lets
// nothing else through, because a drawer's name counts only as a whole name: against "L", only "L".
const ALSO_MAX = 3;
const ALSO_LEN = 40;
/**
 * The spellings the blanks may take: the name, its two words the other way round ("Rock Lee" for
 * the library's "Lee Rock") when `swap`, or a name the drawer accepts ("Endeavor"). The drawer
 * picks one, so the blanks match the name the room uses -- and only from these, so they can never
 * spell something that would not count as right. `swap` is for romanised names: Anime and Manga
 * lists keep the family name first, where "Walsh Cindy" for anyone else would only be noise.
 */
function spellingsFor(name, also = [], { swap = true } = {}) {
  const words = String(name).trim().split(/\s+/);
  const out = [String(name)];
  if (swap && words.length === 2) out.push(`${words[1]} ${words[0]}`);
  for (const n of also) if (!out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  return out;
}

function cleanAlsoAccept(text) {
  const names = String(text ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim().slice(0, ALSO_LEN))
    .filter((s) => normalizeLoose(s).length >= 1);
  return [...new Set(names)].slice(0, ALSO_MAX);
}
const CHAT_KEPT = 60;
const ROMANISED = new Set(['Anime', 'Manga']);
const TEXT_MAX = 80;
// Points for a correct guess fall from GUESS_MAX to GUESS_MIN over the turn: speed is the skill.
// The drawer earns DRAWER_PER_GUESS for each person who gets it -- a drawing nobody can read
// scores nothing. Note what that does NOT do: writing the name in letters is the most readable
// drawing of all, so this scoring rewards it; nothing here stops it but the table's own rule.
const GUESS_MAX = 400;
const GUESS_MIN = 100;
const DRAWER_PER_GUESS = 60;

/**
 * @param {(character) => object} [args.castOf]  the names a character must be told apart from --
 *   their own show's cast, as answers.poolIndex. What lets one word of a name count. Injected, so
 *   these rules need no database; without it, nothing short of a full name is ever correct.
 * @param {boolean} [args.allowSearch]  the host let drawers search for any character (addSearched)
 * @param {(key: string) => boolean} [args.knownName]  whether a guess is exactly some character's
 *   name, anywhere in the library (content.knownName): a typo that IS somebody's name is a guess at
 *   them, not a slip. Injected like castOf; without it only the show's own cast is checked.
 */
function createDrawGame({ order, rounds = 3, drawSeconds = 80, castOf = null, categoryKnown = false, allowSearch = false, knownName = null }) {
  return {
    castOf,
    knownName,
    allowSearch,
    // The room plays one category, so the kind of work is no hint: shown from the start.
    categoryKnown,
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
    guessMs: new Map(), // playerId -> how far into the drawing they got it (for the gallery)
    gaveUp: new Set(), // guessers who gave up on this drawing (see giveUp)
    scores: new Map(order.map((id) => [id, 0])),
    revealed: [], // indexes into the character's name
    categoryShown: false,
    maskShown: false,
    workShown: false,
    strokes: [],
    chat: [],
    seq: 0,
    used: [], // names drawn this game, never offered twice
    lastTurn: null,
    gone: new Set(),
    // For the end screen (./gallery.js): every finished drawing, and each player's near misses.
    drawings: [],
    closeCalls: new Map(),
    votes: new Map(), // the end screen's favourite: voter -> drawing index
  };
}

const drawerOf = (g) => g.order[g.drawerIndex];
const activeOf = (g) => g.order.filter((id) => !g.gone.has(id));
const guessersOf = (g) => activeOf(g).filter((id) => id !== drawerOf(g));
/**
 * Whether a player already knows the answer this turn: the drawer, anyone who guessed it, and
 * anyone who gave up on it (who is shown it -- see giveUp).
 */
const knows = (g, id) => id === drawerOf(g) || g.guessed.has(id) || g.gaveUp.has(id);
const allGuessed = (g) => {
  const guessers = guessersOf(g);
  return guessers.length > 0 && guessers.every((id) => g.guessed.has(id));
};
/** Nobody is still guessing: every guesser got it or gave up. The turn has nothing left to wait for. */
const allDone = (g) => {
  const guessers = guessersOf(g);
  return guessers.length > 0 && guessers.every((id) => g.guessed.has(id) || g.gaveUp.has(id));
};
/** Why a turn with nobody left guessing ended: everyone got it, or some gave up. */
const doneReason = (g) => (allGuessed(g) ? 'all' : 'given-up');

/** How guesses at this character are judged -- one place, so the drawer is told the same rules. */
const judging = (g, character) => ({
  singleWords: true,
  others: g.castOf?.(character) ?? [],
  // Anime and Manga names are romanised from Japanese: "Tanjiro" is "Tanjirou" there.
  romanised: ROMANISED.has(character.origin?.category),
  // A slip of the keyboard counts ("Hermoine Granger"): close here is only a hint, so a guesser who
  // plainly knew it scored nothing for a typo. answers.js says how small, and never another name in
  // the show ("Maria" for Mario stays close where both are in it) or in the library at all.
  acceptTypos: true,
  knownName: g.knownName,
});

/**
 * What a guesser can type and be right, as the drawer should be told before choosing whether to
 * add another name: the name itself, then each word of it that counts alone -- asked of the judge
 * itself, word by word, so the list cannot promise what say() would refuse. "Todoroki Enji" says
 * only "Enji": nobody calls him Endeavor unless the drawer adds it.
 */
function acceptedNames(g, character) {
  const opts = judging(g, character);
  const out = [character.name];
  for (const raw of String(character.name).split(/\s+/)) {
    const word = raw.replace(/^["'(]+|["'),.]+$/g, '');
    if (!word || out.some((o) => o.toLowerCase() === word.toLowerCase())) continue;
    if (judgeGuess(word, character.name, opts).verdict === 'correct') out.push(word);
  }
  return out;
}

/** Start the current drawer's turn with these characters to choose from. */
function offerChoices(g, choices, now) {
  g.phase = 'choosing';
  g.choices = choices.slice(0, CHOICES);
  g.offered = g.choices.map((c) => c.name);
  g.rerollsLeft = CHOICE_REROLLS;
  g.character = null;
  g.deadline = null; // choosing has no clock
  g.startedAt = null;
  g.guessed = new Map();
  g.guessMs = new Map();
  g.gaveUp = new Set();
  g.reactors = new Map(); // playerId -> reactions to this drawing (Crowd Pleaser)
  g.alsoAccept = [];
  g.shownAs = null;
  g.revealed = [];
  g.categoryShown = false;
  g.maskShown = false;
  g.workShown = false;
  g.strokes = [];
  g.chat = [];
}

// --- the host's pause ---------------------------------------------------------------------------

const PAUSED = { ok: false, error: 'The game is paused.' };
/**
 * The host stops the clock. Nothing falls due and nothing is played until they continue: no
 * guess, no stroke, no pick. Kept as when it began, so Continue can move the turn's start and
 * deadline on by however long it lasted -- the hints and the points are both measured from those,
 * so the turn carries on exactly where it stopped.
 */
function pause(g, now) {
  if (g.phase === 'over' || g.pausedAt != null) return { ok: false };
  g.pausedAt = now;
  g.hostPaused = true;
  return { ok: true };
}
function resume(g, now) {
  if (g.pausedAt == null) return { ok: false };
  const away = Math.max(0, now - g.pausedAt);
  if (g.startedAt != null) g.startedAt += away;
  if (g.deadline != null) g.deadline += away;
  g.pausedAt = null;
  g.hostPaused = false;
  return { ok: true };
}
const isPaused = (g) => g.pausedAt != null;

/**
 * `alsoAccept`: other names the drawer will accept for this character (cleanAlsoAccept).
 * `shownAs`: which spelling the blanks take (spellingsFor); anything else is the name itself.
 */
function choose(g, playerId, index, now, alsoAccept = '', shownAs = null) {
  if (isPaused(g)) return PAUSED;
  if (g.phase !== 'choosing') return { ok: false, error: 'Nothing to choose right now.' };
  if (playerId !== drawerOf(g)) return { ok: false, error: "It's not your turn to draw." };
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= g.choices.length) return { ok: false, error: 'Pick one of the three.' };
  g.character = g.choices[i];
  g.alsoAccept = cleanAlsoAccept(alsoAccept);
  const wanted = String(shownAs ?? '').trim();
  const swap = ROMANISED.has(g.character.origin?.category);
  g.shownAs = spellingsFor(g.character.name, g.alsoAccept, { swap }).find((s) => s === wanted) ?? g.character.name;
  g.choices = [];
  g.used.push(g.character.name);
  g.phase = 'drawing';
  g.startedAt = now;
  g.deadline = now + g.drawSeconds * 1000;
  return { ok: true };
}

/**
 * The drawer, in a room whose host allowed it, draws someone they searched for instead of one of
 * the three. It joins the choices rather than having a path of its own, so picking it IS picking a
 * choice: the same dialog (what will count, the spellings) and the same `choose`, which already
 * checks the turn, the drawer and the index. One searched choice at a time; another search
 * replaces it, and New Choices drops it with the rest.
 *
 * Refused if it was drawn already this game -- by identityKeys, the keys the guess-checker judges
 * with, so "Spiderman" is not a second go at "Spider-Man". Already one of the three: that one.
 *
 * @param {object} character  a head the caller resolved itself (never a client's own description)
 * @returns {{ok: false, error: string} | {ok: true, index: number}} the choice to open
 */
function addSearched(g, playerId, character) {
  if (isPaused(g)) return PAUSED;
  if (!g.allowSearch) return { ok: false, error: "Searching isn't on in this room." };
  if (g.phase !== 'choosing') return { ok: false, error: 'Nothing to choose right now.' };
  if (playerId !== drawerOf(g)) return { ok: false, error: "It's not your turn to draw." };
  if (!character?.name) return { ok: false, error: 'No such character.' };
  const keys = new Set(identityKeys(character.name));
  const same = (name) => identityKeys(name).some((k) => keys.has(k));
  if (g.used.some(same)) return { ok: false, error: `${character.name} has already been drawn this game.` };
  const dealt = g.choices.filter((c) => !c.searched);
  g.choices = dealt;
  const already = dealt.findIndex((c) => same(c.name));
  if (already >= 0) return { ok: true, index: already };
  g.choices = [...dealt, { ...character, searched: true }];
  return { ok: true, index: g.choices.length - 1 };
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
  if (isPaused(g)) return PAUSED;
  if (g.phase !== 'choosing') return { ok: false, error: 'Nothing to choose right now.' };
  if (playerId !== drawerOf(g)) return { ok: false, error: "It's not your turn to draw." };
  if (g.rerollsLeft === 0) return { ok: false, error: 'No new choices left this turn.' };
  if (!choices?.length) return { ok: false, error: 'There are no other characters left to offer.' };
  g.choices = choices.slice(0, CHOICES);
  g.offered.push(...g.choices.map((c) => c.name));
  if (g.rerollsLeft > 0) g.rerollsLeft -= 1;
  g.deadline = null; // choosing has no clock
  return { ok: true };
}

const pointsAt = (g, now) => {
  const left = Math.max(0, g.deadline - now) / (g.drawSeconds * 1000);
  return Math.round(GUESS_MIN + (GUESS_MAX - GUESS_MIN) * left);
};

// `kind`: 'said' (talk), 'guess' (a miss), 'close', 'correct' -- so a line can say which it was.
function post(g, playerId, text, insider, kind = 'said') {
  g.chat.push({ id: ++g.seq, playerId, text, insider, kind });
  if (g.chat.length > CHAT_KEPT) g.chat.splice(0, g.chat.length - CHAT_KEPT);
}

/**
 * Anything typed into the chat. From someone still guessing it is a guess; from someone who
 * already knows, it is a message for the others who know.
 *
 * @returns {{ok: false, error} | {ok: true, verdict: 'correct'|'close'|'wrong'|'said', points?, allDone?, doneReason?}}
 */
function say(g, playerId, text, now) {
  if (g.phase !== 'drawing' && g.phase !== 'choosing' && g.phase !== 'reveal') return { ok: false, error: 'The game is over.' };
  if (!g.order.includes(playerId) || g.gone.has(playerId)) return { ok: false, error: "You're not in this game." };
  if (isPaused(g)) return PAUSED;
  const clean = String(text ?? '').trim().slice(0, TEXT_MAX);
  if (!clean) return { ok: false, error: 'Type something first.' };

  if (g.phase !== 'drawing' || knows(g, playerId)) {
    // Between drawings nobody is guessing, so it is just chat; while drawing, only insiders see
    // an insider's words.
    post(g, playerId, clean, g.phase === 'drawing');
    return { ok: true, verdict: 'said' };
  }

  const opts = judging(g, g.character);
  const { romanised } = opts;
  let { verdict } = judgeGuess(clean, g.character.name, opts);
  // A name the drawer said they would accept counts as the name -- as a whole name (any order,
  // case, accents, or a small typo), not word by word: they typed exactly what they meant.
  if (verdict !== 'correct' && (g.alsoAccept ?? []).some((name) => judgeGuess(clean, name, { romanised, acceptTypos: true, knownName: g.knownName }).verdict === 'correct')) {
    verdict = 'correct';
  }
  if (verdict === 'correct') {
    const points = pointsAt(g, now);
    g.guessed.set(playerId, points);
    g.guessMs.set(playerId, now - g.startedAt);
    g.scores.set(playerId, (g.scores.get(playerId) ?? 0) + points);
    const drawer = drawerOf(g);
    g.scores.set(drawer, (g.scores.get(drawer) ?? 0) + DRAWER_PER_GUESS);
    // The guess itself, for those who know: the drawer sees every guess, the right ones included.
    post(g, playerId, clean, true, 'correct');
    return { ok: true, verdict, points, allDone: allDone(g), doneReason: doneReason(g) };
  }
  // A close guess goes only to those who know -- the drawer above all, who wants to see every
  // guess -- never to anyone still guessing: "Sasuek" would be a hint to them.
  if (verdict === 'close') {
    g.closeCalls.set(playerId, (g.closeCalls.get(playerId) ?? 0) + 1);
    post(g, playerId, clean, true, 'close');
    return { ok: true, verdict };
  }
  post(g, playerId, clean, false, 'guess');
  return { ok: true, verdict };
}

/**
 * A guesser gives up on this drawing. They stop guessing, score nothing for it, and are shown the
 * answer -- so from here they are one of those who know, and their words go only to the others
 * who know. Without it a stuck guesser could only sit out the clock, and so could everyone
 * waiting on them: once every guesser has got it or given up, the turn ends early.
 *
 * @returns {{ok: false, error} | {ok: true, allDone: boolean, doneReason: string}}
 */
/**
 * A guesser reacted to the drawing (the socket has already checked who and when). Counted per
 * person, so the end screen can tell a room's delight from one player holding the button down.
 */
function noteReaction(g, playerId) {
  if (!g.reactors) g.reactors = new Map();
  g.reactors.set(playerId, (g.reactors.get(playerId) ?? 0) + 1);
}

function giveUp(g, playerId) {
  if (isPaused(g)) return PAUSED;
  if (g.phase !== 'drawing') return { ok: false, error: 'There is no drawing to give up on.' };
  if (!g.order.includes(playerId) || g.gone.has(playerId)) return { ok: false, error: "You're not in this game." };
  if (playerId === drawerOf(g)) return { ok: false, error: "You're drawing it -- you know who it is." };
  if (g.guessed.has(playerId)) return { ok: false, error: 'You already got it.' };
  if (g.gaveUp.has(playerId)) return { ok: false, error: 'You already gave up on this one.' };
  g.gaveUp.add(playerId);
  return { ok: true, allDone: allDone(g), doneReason: doneReason(g) };
}

// --- hints -----------------------------------------------------------------------------------

const isLetter = (ch) => /[\p{L}\p{N}]/u.test(ch);
/** The name as the blanks spell it: the drawer's pick (spellingsFor), the name itself by default. */
const spelling = (g) => g.shownAs ?? g.character.name;

/** When the hints fall due, in ms timestamps -- each one a moment the room must be sent a view. */
const lettersOf = (name) => [...name].map((ch, i) => (isLetter(ch) ? i : -1)).filter((i) => i >= 0);
const hintTimes = (g) =>
  g.startedAt == null || !g.character
    ? []
    : [...new Set([...hintFractions(lettersOf(spelling(g)).length), CATEGORY_AT, MASK_AT, WORK_AT])].map(
        (f) => g.startedAt + f * g.drawSeconds * 1000
      );

/**
 * Reveal whatever hints are due. `pick` chooses among the candidate indexes (random in play, fixed
 * in tests). Returns whether anything changed.
 */
function revealDueHints(g, now, pick = (xs) => xs[Math.floor(Math.random() * xs.length)]) {
  if (g.phase !== 'drawing' || !g.character || isPaused(g)) return false;
  const letters = lettersOf(spelling(g));
  const at = (f) => g.startedAt + f * g.drawSeconds * 1000;
  let changed = false;
  if (!g.categoryShown && now >= at(CATEGORY_AT)) {
    g.categoryShown = true;
    changed = true;
  }
  if (!g.maskShown && now >= at(MASK_AT)) {
    g.maskShown = true;
    changed = true;
  }
  if (!g.workShown && g.character.origin?.work && now >= at(WORK_AT)) {
    g.workShown = true;
    changed = true;
  }
  const due = hintFractions(letters.length).filter((f) => at(f) <= now).length;
  while (g.revealed.length < due) {
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
  return [...spelling(g)].map((ch, i) => (isLetter(ch) && !g.revealed.includes(i) ? '_' : ch)).join('');
}

/** The clock's reading (seconds left) at which a hint falls due -- what the page says it waits for. */
const secondsLeftAt = (g, f) => Math.round(g.drawSeconds * (1 - f));

/**
 * Where the character is from, as far as the clock allows: `category` once due (or from the start
 * when the room plays one category), `work` once due (masked -- "Super _____ Bros." -- because a
 * title can spell the answer), and for each one still to come the clock reading it arrives at
 * (`categoryAt`, `workAt`), so the page can say so. The same for everyone, the drawer included:
 * they see what the guessers are working with.
 */
function clueFor(g) {
  const origin = g.character?.origin;
  if (!origin) return null;
  // Blanked of the name AND of the spelling the blanks use: "Endeavor" in a title would be as
  // much the answer as "Enji".
  const work = origin.work ? maskNameWords(maskNameWords(origin.work, g.character.name), spelling(g)) : null;
  const category = origin.category ?? null;
  const categoryNow = g.categoryKnown || g.categoryShown;
  return {
    category: categoryNow ? category : null,
    categoryAt: !categoryNow && category ? secondsLeftAt(g, CATEGORY_AT) : null,
    work: g.workShown ? work : null,
    workAt: !g.workShown && work ? secondsLeftAt(g, WORK_AT) : null,
  };
}

// --- turn ends and advances ------------------------------------------------------------------

function endTurn(g, now, reason) {
  if (g.phase !== 'drawing' && g.phase !== 'choosing') return { ok: false };
  const drawer = drawerOf(g);
  // Kept for the end screen while the strokes still exist: the next turn starts a clean canvas.
  // Only a turn that was drawn -- one that ended while choosing has no picture.
  if (g.phase === 'drawing' && g.character) {
    g.drawings.push(
      gallery.record({
        drawerId: drawer,
        // As the room saw it: the spelling the blanks took, the library's name kept beside it.
        character: { ...publicCharacter(g.character), name: spelling(g), ...(spelling(g) !== g.character.name ? { realName: g.character.name } : {}) },
        strokes: g.strokes,
        guessed: [...g.guessMs],
        gaveUp: g.gaveUp,
        reactors: g.reactors,
        guessers: guessersOf(g).length,
        reason,
        drawSeconds: g.drawSeconds,
      })
    );
  }
  g.lastTurn = {
    drawerId: drawer,
    character: g.character ?? g.choices[0] ?? null,
    reason, // 'all' | 'given-up' | 'time' | 'drawer-left'
    guessed: [...g.guessed].map(([playerId, points]) => ({ playerId, points })),
    gaveUp: [...g.gaveUp],
    alsoAccepted: [...(g.alsoAccept ?? [])],
    shownAs: g.character && g.shownAs && g.shownAs !== g.character.name ? g.shownAs : null,
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
  if (g.phase === 'drawing' && allDone(g)) {
    endTurn(g, now, doneReason(g));
    return { ok: true, endTurn: true };
  }
  return { ok: true, endTurn: false };
}

/** Everything the end screen shows: the standings, every drawing, the accolades and the votes. */
function overFor(g, names) {
  const nameOf = (id) => names[id] ?? 'Player';
  return {
    standings: standings(g, names),
    gallery: gallery.galleryFor(g.drawings, nameOf),
    accolades: gallery.accolades(g.drawings, g.closeCalls, nameOf),
    votes: votesOf(g),
  };
}

/**
 * The end screen's vote for the best drawing: one each, changeable (the same one again takes it
 * back), never for your own. Counted openly but cast in secret -- only the tally is published, so
 * nobody's vote is anyone else's business.
 */
function vote(g, playerId, index) {
  if (g.phase !== 'over') return { ok: false, error: 'Voting opens when the game ends.' };
  if (!g.order.includes(playerId) || g.gone.has(playerId)) return { ok: false, error: "You're not in this game." };
  const i = Number(index);
  const d = g.drawings[i];
  if (!Number.isInteger(i) || !d) return { ok: false, error: 'There is no such drawing.' };
  if (d.drawerId === playerId) return { ok: false, error: "You can't vote for your own drawing." };
  if (g.votes.get(playerId) === i) g.votes.delete(playerId);
  else g.votes.set(playerId, i);
  return { ok: true, mine: g.votes.get(playerId) ?? null };
}
/** How many votes each drawing has, in gallery order. */
const votesOf = (g) => g.drawings.map((_, i) => [...g.votes.values()].filter((v) => v === i).length);

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
    // Read off the moment it stopped while paused, so the clock shows still rather than running out.
    secondsLeft: g.deadline ? Math.max(0, Math.round((g.deadline - (g.pausedAt ?? now)) / 1000)) : null,
    paused: isPaused(g),
    drawSeconds: g.drawSeconds,
    // Each with what will count for it (acceptedNames): what the drawer is shown on picking one.
    // And, for a romanised name, its words the other way round: a spelling the drawer may pick.
    choices:
      isDrawer && g.phase === 'choosing'
        ? g.choices.map((c) => ({
            ...publicCharacter(c),
            accepts: acceptedNames(g, c),
            swapped: spellingsFor(c.name, [], { swap: ROMANISED.has(c.origin?.category) })[1] ?? null,
            // Found by search (addSearched): opened straight into the dialog, not shown as a fourth card.
            searched: !!c.searched,
          }))
        : null,
    canSearch: isDrawer && g.phase === 'choosing' && !!g.allowSearch,
    // -1 unlimited. Only the drawer has anything to reroll.
    rerollsLeft: isDrawer && g.phase === 'choosing' ? g.rerollsLeft : null,
    character: answerShown && g.character ? publicCharacter(g.character) : null,
    // The spelling the blanks take -- to those who may see the answer, and to nobody else: for a
    // guesser it would be the answer by another name.
    shownAs: answerShown && g.character ? spelling(g) : null,
    // The blanks only from half time: how many words and letters is a big hint on its own.
    mask: g.phase === 'drawing' && g.maskShown ? maskOf(g) : null,
    maskAt: g.phase === 'drawing' && !g.maskShown ? secondsLeftAt(g, MASK_AT) : null,
    clue: g.phase === 'drawing' ? clueFor(g) : null,
    guessedIt: g.guessed.has(viewerId),
    gaveUpIt: g.gaveUp.has(viewerId),
    // Only the drawer, who typed them. To anyone else they would be the answer by another name.
    alsoAccept: isDrawer && g.phase === 'drawing' ? g.alsoAccept ?? [] : null,
    players: g.order.map((id) => ({
      playerId: id,
      name: nameOf(id),
      score: g.scores.get(id) ?? 0,
      guessed: g.guessed.has(id),
      gaveUp: g.gaveUp.has(id),
      drawing: id === drawer && (g.phase === 'drawing' || g.phase === 'choosing'),
      left: g.gone.has(id),
    })),
    // Insider lines only for insiders, while drawing. Once the answer is out they are harmless.
    chat: g.chat
      .filter((m) => !m.insider || insider || g.phase !== 'drawing')
      .slice(-40)
      // `mine`: so a phone floats only the OTHERS' guesses over the picture -- you know what you typed.
      .map((m) => ({ id: m.id, name: nameOf(m.playerId), text: m.text, insider: m.insider, kind: m.kind ?? 'said', mine: m.playerId === viewerId })),
    lastTurn:
      g.phase === 'reveal' && g.lastTurn
        ? {
            drawer: nameOf(g.lastTurn.drawerId),
            character: g.lastTurn.character ? publicCharacter(g.lastTurn.character) : null,
            reason: g.lastTurn.reason,
            guessed: g.lastTurn.guessed.map((x) => ({ name: nameOf(x.playerId), points: x.points })),
            gaveUp: (g.lastTurn.gaveUp ?? []).map(nameOf),
            alsoAccepted: g.lastTurn.alsoAccepted ?? [],
            shownAs: g.lastTurn.shownAs ?? null,
            drawerPoints: g.lastTurn.drawerPoints,
          }
        : null,
  };
}

module.exports = {
  createDrawGame,
  noteReaction,
  pause,
  resume,
  isPaused,
  offerChoices,
  choose,
  rerollChoices,
  rerollExclusions,
  addSearched,
  say,
  revealDueHints,
  hintTimes,
  maskOf,
  clueFor,
  endTurn,
  advance,
  removePlayer,
  standings,
  overFor,
  vote,
  votesOf,
  viewFor,
  drawerOf,
  allGuessed,
  allDone,
  giveUp,
  cleanAlsoAccept,
  spellingsFor,
  knows,
  REVEAL_SECONDS,
  CHOICES,
  CHOICE_REROLLS,
  TEXT_MAX,
};
