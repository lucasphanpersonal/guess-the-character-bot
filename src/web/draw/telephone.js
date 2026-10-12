// Telephone: Draw the Character's other mode. Everyone works at once, each on a chain that starts
// with a character and is passed one seat along at every step:
//
//   pick   everyone picks a character to start their own chain (one of three, new ones on asking)
//   draw   everyone draws the name they were passed
//   guess  everyone names the drawing they were passed
//   ...    draw, guess, draw ... until every chain has come back round -- always ending on a guess,
//          which is the punchline
//   replay the host walks the room through each chain, one card at a time
//   over   the album: every chain, every drawing
//
// Pure, like ./game.js: the socket layer (./socket.js) owns time and passes `now` in, deals the
// characters, and keeps the strokes coming in. The rule it keeps is the same as the classic
// game's: during play a player sees ONLY the one thing they are working from -- the name or the
// drawing passed to them. test/telephone.test.js and the socket check search whole payloads.

const { judgeGuess } = require('../../compendium/answers');
const { publicCharacter } = require('../publicCharacter');
const { simplifyStrokes } = require('./gallery');

const MIN_PLAYERS = 3;
const PICK_SECONDS = 45;
const GUESS_SECONDS = 40;
const GUESS_MAX = 60;
const CHOICES = 3;

const stepKind = (step) => (step === 0 ? 'pick' : step % 2 === 1 ? 'draw' : 'guess');

/**
 * @param {object} args
 * @param {string[]} args.order        everyone playing, in seat order (at least MIN_PLAYERS)
 * @param {number} args.drawSeconds    each drawing step
 * @param {Map} args.choices           playerId -> CHOICES characters to start a chain from
 */
function createTelephone({ order, drawSeconds = 80, choices = new Map() }) {
  const n = order.length;
  return {
    mode: 'telephone',
    order: [...order],
    gone: new Set(),
    drawSeconds,
    // Every chain visits every seat once: n steps, or n - 1 when n is even, so that the last
    // step is always a guess (step 0 is the pick, odd steps draw, even steps guess).
    steps: n % 2 === 1 ? n : n - 1,
    step: 0,
    phase: 'pick',
    deadline: null,
    chains: order.map((owner) => ({ owner, entries: [], madeIt: null })),
    choices: new Map(choices),
    drafts: new Map(), // playerId -> strokes of the drawing in progress this step
    done: new Set(), // who has handed in this step
    replay: { chain: 0, shown: 1 },
    pausedAt: null,
    hostPaused: false,
  };
}

const active = (t) => t.order.filter((id) => !t.gone.has(id));
/** The chain a seat works on at a step: one seat along per step, so no chain meets a seat twice. */
const chainIndexFor = (t, playerId, step = t.step) => {
  const seat = t.order.indexOf(playerId);
  return seat < 0 ? -1 : (seat - step + t.order.length * t.steps) % t.order.length;
};
const secondsFor = (t, kind) => (kind === 'pick' ? PICK_SECONDS : kind === 'draw' ? t.drawSeconds : GUESS_SECONDS);

function startStep(t, now) {
  t.phase = stepKind(t.step);
  t.deadline = now + secondsFor(t, t.phase) * 1000;
  t.done = new Set();
  t.drafts = new Map();
}

/** Begin: the pick, on the clock. */
function begin(t, now) {
  startStep(t, now);
  return t;
}

const PAUSED = { ok: false, error: 'The game is paused.' };
const isPaused = (t) => t.pausedAt != null;
/** The host's pause: nothing is due, nothing is handed in, until Continue moves the clock on. */
function pause(t, now) {
  if (t.phase === 'over' || isPaused(t)) return { ok: false };
  t.pausedAt = now;
  t.hostPaused = true;
  return { ok: true };
}
function resume(t, now) {
  if (!isPaused(t)) return { ok: false };
  if (t.deadline != null) t.deadline += Math.max(0, now - t.pausedAt);
  t.pausedAt = null;
  t.hostPaused = false;
  return { ok: true };
}

/** New starting choices for a player who has not picked yet. `fresh` is dealt by the caller. */
function rerollChoices(t, playerId, fresh) {
  if (isPaused(t)) return PAUSED;
  if (t.phase !== 'pick' || t.done.has(playerId) || t.gone.has(playerId)) return { ok: false, error: 'Nothing to choose right now.' };
  if (!fresh?.length) return { ok: false, error: 'There are no other characters left to offer.' };
  t.choices.set(playerId, fresh.slice(0, CHOICES));
  return { ok: true };
}

/** What every name offered so far is, so new choices are new. */
const offeredNames = (t) => [...t.choices.values()].flat().map((c) => c.name);

// What a seat hands in at this step, put on the chain it is working on.
function entryFor(t, playerId, { index, text } = {}) {
  const kind = t.phase;
  if (kind === 'pick') {
    const options = t.choices.get(playerId) ?? [];
    const c = options[Number.isInteger(Number(index)) ? Number(index) : 0] ?? options[0];
    if (!c) return null;
    return { kind, by: playerId, text: c.name, character: c };
  }
  if (kind === 'draw') return { kind, by: playerId, strokes: simplifyStrokes(t.drafts.get(playerId) ?? []) };
  const clean = String(text ?? '').trim().slice(0, GUESS_MAX);
  return { kind, by: playerId, text: clean || '(no guess)', ...(clean ? {} : { blank: true }) };
}

/** Hand in this step's work: a pick ({ index }), the drawing so far, or a guess ({ text }). */
function submit(t, playerId, payload = {}, now) {
  if (isPaused(t)) return PAUSED;
  if (!['pick', 'draw', 'guess'].includes(t.phase)) return { ok: false, error: 'Nothing to hand in right now.' };
  if (!t.order.includes(playerId) || t.gone.has(playerId)) return { ok: false, error: "You're not in this game." };
  if (t.done.has(playerId)) return { ok: false, error: 'Already handed in.' };
  if (t.phase === 'pick') {
    const i = Number(payload.index);
    if (!Number.isInteger(i) || !(t.choices.get(playerId) ?? [])[i]) return { ok: false, error: 'Pick one of the three.' };
  }
  const entry = entryFor(t, playerId, payload);
  if (!entry) return { ok: false, error: 'Nothing to hand in.' };
  t.chains[chainIndexFor(t, playerId)].entries[t.step] = entry;
  t.done.add(playerId);
  if (active(t).every((id) => t.done.has(id))) advance(t, now);
  return { ok: true };
}

// The step is over (everyone in, or the clock): whoever has not handed in hands in what they have
// -- the first choice, the drawing so far, no guess -- and anyone who left is skipped. Then the
// next step, or the replay once every chain has come round.
function advance(t, now) {
  for (const id of t.order) {
    const chain = t.chains[chainIndexFor(t, id)];
    if (chain.entries[t.step]) continue;
    if (t.gone.has(id)) {
      // A pick must still start the chain: whoever left, their first choice is the character.
      chain.entries[t.step] = t.phase === 'pick' ? entryFor(t, id, { index: 0 }) : { kind: t.phase, by: id, skipped: true, ...(t.phase === 'draw' ? { strokes: [] } : { text: '(skipped)' }) };
    } else {
      chain.entries[t.step] = entryFor(t, id, { index: 0 });
    }
  }
  t.step += 1;
  if (t.step >= t.steps) return toReplay(t);
  startStep(t, now);
  return t;
}

/** The clock ran out on this step. Returns whether anything changed. */
function timeUp(t, now) {
  if (isPaused(t) || !['pick', 'draw', 'guess'].includes(t.phase) || t.deadline == null || t.deadline > now) return false;
  advance(t, now);
  return true;
}

function toReplay(t) {
  t.phase = 'replay';
  t.deadline = null;
  t.replay = { chain: 0, shown: 1 };
  // Did the name survive? The last guess against where the chain started, by the same checker the
  // classic game uses -- a first name or a dominant surname still counts.
  for (const chain of t.chains) {
    const start = chain.entries[0]?.text;
    const last = [...chain.entries].reverse().find((e) => e?.kind === 'guess' && !e.blank && !e.skipped);
    chain.madeIt = !!(start && last && judgeGuess(last.text, start, { singleWords: true }).verdict === 'correct');
  }
  return t;
}

/** Everyone left but one: no more steps, straight to the replay of what there is. */
function endEarly(t) {
  if (['replay', 'over'].includes(t.phase)) return t;
  for (const chain of t.chains) chain.entries.length = Math.min(chain.entries.length, t.step);
  t.steps = t.step;
  return toReplay(t);
}

/** The host moves the replay on: the next card of this chain, or the next chain, or the album. */
function replayNext(t) {
  if (t.phase !== 'replay') return { ok: false, error: 'Nothing to replay.' };
  const chain = t.chains[t.replay.chain];
  if (t.replay.shown < chain.entries.filter(Boolean).length) t.replay.shown += 1;
  else if (t.replay.chain < t.chains.length - 1) t.replay = { chain: t.replay.chain + 1, shown: 1 };
  else t.phase = 'over';
  return { ok: true };
}
function replayBack(t) {
  if (t.phase !== 'replay') return { ok: false, error: 'Nothing to replay.' };
  if (t.replay.shown > 1) t.replay.shown -= 1;
  else if (t.replay.chain > 0) {
    const chain = t.replay.chain - 1;
    t.replay = { chain, shown: t.chains[chain].entries.filter(Boolean).length };
  }
  return { ok: true };
}

/** Someone leaves for good: their seat is skipped from here on; the chains carry on. */
function removePlayer(t, playerId, now) {
  if (!t.order.includes(playerId) || t.gone.has(playerId)) return { ok: false };
  t.gone.add(playerId);
  if (active(t).length < 2) {
    endEarly(t);
    return { ok: true };
  }
  if (['pick', 'draw', 'guess'].includes(t.phase) && active(t).every((id) => t.done.has(id))) advance(t, now);
  return { ok: true };
}

// --- the drawing in progress ---------------------------------------------------------------------
// Kept here as it is drawn, so a drawer whose time runs out hands in what they had, and one who
// reloads gets it back. Nobody else is sent it: a drawing travels only when its step is over.

const MAX_DRAFT_POINTS = 30000;
const MAX_DRAFT_FILLS = 60;
function drawsNow(t, playerId) {
  return t.phase === 'draw' && !isPaused(t) && t.order.includes(playerId) && !t.gone.has(playerId) && !t.done.has(playerId);
}
/** A piece of a stroke, already checked by the caller (palette, size, points on the canvas). */
function addPiece(t, playerId, piece) {
  if (!drawsNow(t, playerId)) return false;
  const draft = t.drafts.get(playerId) ?? [];
  if (draft.reduce((n, s) => n + s.points.length, 0) + piece.points.length > MAX_DRAFT_POINTS) return false;
  if (piece.kind === 'fill') {
    if (draft.some((s) => s.id === piece.id) || draft.filter((s) => s.kind === 'fill').length >= MAX_DRAFT_FILLS) return false;
    draft.push({ id: piece.id, kind: 'fill', color: piece.color, size: 0, points: piece.points.slice(0, 1) });
  } else {
    let s = draft.find((x) => x.id === piece.id);
    if (s?.kind === 'fill') return false;
    if (!s) draft.push((s = { id: piece.id, color: piece.color, size: piece.size, points: [] }));
    s.points.push(...piece.points);
  }
  t.drafts.set(playerId, draft);
  return true;
}
function undo(t, playerId) {
  if (!drawsNow(t, playerId)) return false;
  t.drafts.get(playerId)?.pop();
  return true;
}
function clearDraft(t, playerId) {
  if (!drawsNow(t, playerId)) return false;
  t.drafts.set(playerId, []);
  return true;
}

// --- what one player sees ------------------------------------------------------------------------

function entryView(e, nameOf) {
  if (!e) return null;
  return {
    kind: e.kind,
    by: nameOf(e.by),
    text: e.text ?? null,
    strokes: e.strokes ?? null,
    character: e.character ? publicCharacter(e.character) : null,
    skipped: !!e.skipped,
    blank: !!e.blank,
  };
}
const chainView = (t, chain, nameOf, shown = Infinity) => ({
  owner: nameOf(chain.owner),
  entries: chain.entries.filter(Boolean).slice(0, shown).map((e) => entryView(e, nameOf)),
  length: chain.entries.filter(Boolean).length,
  // Only once the whole chain is out: knowing it made it through gives the ending away.
  madeIt: shown >= chain.entries.filter(Boolean).length ? chain.madeIt : null,
});

/**
 * One player's view. During play: their own task -- the three to pick from, the name to draw (and
 * their drawing so far), or the drawing to name -- and who is still working. Nothing of any other
 * chain. In the replay: the chain being shown, as far as it has been shown. At the end: everything.
 */
function viewFor(t, viewerId, names, now = Date.now()) {
  const nameOf = (id) => names[id] ?? 'Player';
  const playing = ['pick', 'draw', 'guess'].includes(t.phase);
  const mine = playing && t.order.includes(viewerId) && !t.gone.has(viewerId) && !t.done.has(viewerId);
  let task = null;
  if (mine) {
    const chain = t.chains[chainIndexFor(t, viewerId)];
    const from = chain.entries[t.step - 1];
    if (t.phase === 'pick') task = { kind: 'pick', choices: (t.choices.get(viewerId) ?? []).map(publicCharacter) };
    else if (t.phase === 'draw') task = { kind: 'draw', prompt: from?.text ?? '', draft: t.drafts.get(viewerId) ?? [] };
    else task = { kind: 'guess', drawing: from?.strokes ?? [], skipped: !!from?.skipped };
  }
  return {
    mode: 'telephone',
    phase: t.phase,
    step: t.step,
    steps: t.steps,
    kind: playing ? t.phase : null,
    secondsLeft: playing && t.deadline ? Math.max(0, Math.round((t.deadline - (t.pausedAt ?? now)) / 1000)) : null,
    stepSeconds: playing ? secondsFor(t, t.phase) : null,
    paused: isPaused(t),
    task,
    // Count, then name: who the room is waiting on, once you are not one of them.
    waitingOn: playing ? active(t).filter((id) => !t.done.has(id)).map(nameOf) : [],
    players: t.order.map((id) => ({ playerId: id, name: nameOf(id), done: playing && t.done.has(id), left: t.gone.has(id) })),
    replay:
      t.phase === 'replay'
        ? { chain: t.replay.chain, of: t.chains.length, ...chainView(t, t.chains[t.replay.chain], nameOf, t.replay.shown) }
        : null,
    album: t.phase === 'over' ? t.chains.map((c) => chainView(t, c, nameOf)) : null,
  };
}

module.exports = {
  createTelephone,
  begin,
  submit,
  timeUp,
  advance,
  rerollChoices,
  offeredNames,
  replayNext,
  replayBack,
  removePlayer,
  endEarly,
  pause,
  resume,
  isPaused,
  addPiece,
  undo,
  clearDraft,
  viewFor,
  chainIndexFor,
  stepKind,
  MIN_PLAYERS,
  CHOICES,
  PICK_SECONDS,
  GUESS_SECONDS,
};
