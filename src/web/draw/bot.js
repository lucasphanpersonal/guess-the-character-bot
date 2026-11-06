// A test bot's brain for Doodle Dash, both ways of playing (../bots.js runs it).
//
// It hears what a player's browser hears and answers with what a browser would send:
//   classic    picks one of the three when it is the drawer, then doodles in strokes a few at a
//              time, as a hand would; as a guesser, a wrong guess or two, and the answer at a
//              moment of its own (or never), a reaction now and then, and a vote at the end
//   telephone  picks a starting character, doodles and hands in, and names what it was passed --
//              sometimes the chain's real start, sometimes a wrong guess
//
// It reads the room to know the answer (bot.room()), which no player can, so its guesses land
// some of the time. It cannot see a picture, so its drawings are a doodle -- a face and a scribble
// -- not the character: enough to test the canvas, the relay, the gallery and the accolades.

const { WRONG } = require('../guess/bot');

// Fallbacks for a room state that somehow had no tools in it; the server's own lists win.
const FALLBACK_COLOURS = ['#1b1033', '#e21b3c', '#1f8bff', '#26890c', '#ffd60a'];
const FALLBACK_SIZES = [3, 8, 18];
const PIECE = 8; // points per piece sent: a stroke arrives a little at a time, as a hand draws

const clamp = (n) => Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));

/**
 * A doodle as strokes ({color, size, points}): a face, two eyes, a smile, and a scribble or two.
 * Coordinates are the canvas's own, 0..1.
 */
function doodle({ colours = FALLBACK_COLOURS, sizes = FALLBACK_SIZES, rand = Math.random } = {}) {
  const r = (lo, hi) => lo + rand() * (hi - lo);
  const ink = colours.filter((c) => c !== '#ffffff');
  const any = () => ink[Math.floor(rand() * ink.length)] ?? '#1b1033';
  const size = (i) => sizes[Math.min(i, sizes.length - 1)];
  const cx = r(0.4, 0.6);
  const cy = r(0.4, 0.55);
  const rad = r(0.18, 0.28);
  const arc = (from, to, rr, x = cx, y = cy, steps = 28) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const a = from + ((to - from) * i) / steps;
      return [clamp(x + Math.cos(a) * rr), clamp(y + Math.sin(a) * rr)];
    });
  const strokes = [
    { color: any(), size: size(1), points: arc(0, Math.PI * 2, rad) },
    { color: any(), size: size(2), points: arc(0, Math.PI * 2, rad * 0.08, cx - rad * 0.38, cy - rad * 0.25, 8) },
    { color: any(), size: size(2), points: arc(0, Math.PI * 2, rad * 0.08, cx + rad * 0.38, cy - rad * 0.25, 8) },
    { color: any(), size: size(1), points: arc(Math.PI * 0.15, Math.PI * 0.85, rad * 0.55, cx, cy + rad * 0.05, 14) },
  ];
  const scribbles = 1 + Math.floor(rand() * 2);
  for (let s = 0; s < scribbles; s++) {
    let x = r(0.1, 0.9);
    let y = r(0.1, 0.9);
    const points = [];
    for (let i = 0; i < 20; i++) {
      x = clamp(x + r(-0.05, 0.05));
      y = clamp(y + r(-0.05, 0.05));
      points.push([x, y]);
    }
    strokes.push({ color: any(), size: size(Math.floor(rand() * sizes.length)), points });
  }
  return strokes;
}

/** A doodle cut into the pieces a page sends while drawing, each tagged with its stroke's id. */
function pieces(strokes, prefix) {
  const out = [];
  strokes.forEach((st, n) => {
    const id = `${prefix}${n}`.slice(0, 24);
    for (let i = 0; i < st.points.length; i += PIECE) {
      // Each piece after the first starts where the last ended, so the line has no gaps.
      out.push({ id, color: st.color, size: st.size, points: st.points.slice(Math.max(0, i - 1), i + PIECE) });
    }
  });
  return out;
}

function attach(bot, { rand, pick }) {
  const s = bot.socket;
  const tools = () => ({ colours: (bot.roomState?.palette ?? []).map(([c]) => c), sizes: bot.roomState?.sizes });
  const plan = (tag) => `${tag}:${Math.random().toString(36).slice(2, 8)}`;

  // Send a doodle a piece at a time over about `ms`, while `still()` holds.
  function drawOut(event, still, ms, then) {
    const t = tools();
    const all = pieces(doodle({ colours: t.colours.length ? t.colours : FALLBACK_COLOURS, sizes: t.sizes?.length ? t.sizes : FALLBACK_SIZES }), plan('b').replace(':', ''));
    const step = ms / (all.length + 1);
    all.forEach((p, i) => bot.once(`draw:${p.id}:${i}`, step * (i + 1), () => still() && bot.emit(event, p)));
    if (then) bot.once('draw:done', step * (all.length + 1) + 300, () => still() && then());
  }

  // --- classic ---------------------------------------------------------------------------------
  s.on('draw:state', (v) => {
    bot.state.view = v;
    const turnKey = `${v.round}:${v.drawer?.playerId}`;
    if (v.paused || v.phase === 'reveal' || v.phase === 'over') {
      bot.cancelAll('draw:');
      bot.cancelAll('guess');
      bot.state.turnKey = null;
      return;
    }
    if (v.phase === 'choosing' && v.isDrawer && v.choices?.length) {
      bot.once('choose', rand(1500, 4000), () => {
        const now = bot.state.view;
        if (now?.phase === 'choosing' && now.isDrawer && now.choices?.length) bot.emit('draw:choose', { index: Math.floor(Math.random() * now.choices.length) });
      });
      return;
    }
    if (v.phase !== 'drawing' || bot.state.turnKey === turnKey) return;
    bot.state.turnKey = turnKey;
    const still = () => bot.state.view?.phase === 'drawing' && `${bot.state.view.round}:${bot.state.view.drawer?.playerId}` === turnKey && !bot.state.view.paused;
    const secs = (v.secondsLeft ?? v.drawSeconds ?? 80) * 1000;
    if (v.isDrawer) return drawOut('draw:stroke', () => still() && bot.state.view.isDrawer, Math.min(20000, secs * 0.4));
    planGuessing(still, secs, v.drawSeconds * 1000);
  });

  // A guesser: wrong guesses now and then, a reaction, and the answer at a moment of its own,
  // somewhere between a fifth and nine tenths of the way in. Always, in the end: a drawing nobody
  // gets runs its whole clock, and the person testing would sit through every one of them.
  function planGuessing(still, left, whole) {
    const answerAt = whole * rand(0.2, 0.9) - (whole - left);
    const wrongs = Math.floor(rand(0, 3));
    for (let i = 0; i < wrongs; i++) {
      bot.once(`guess:wrong${i}`, rand(3000, Math.max(3500, Math.min(left, answerAt) - 500)), () => {
        if (still() && !bot.state.view.guessedIt) bot.emit('draw:say', { text: pick(WRONG) });
      });
    }
    if (Math.random() < 0.4) bot.once('guess:react', rand(2000, Math.max(2500, left * 0.6)), () => still() && bot.emit('draw:react', { kind: pick(['star', 'wow', 'huh', 'ha']) }));
    bot.once('guess:answer', Math.max(1500, Math.min(answerAt, left - 1000)), () => {
      const g = bot.room()?.game;
      const answer = g?.shownAs ?? g?.character?.name;
      if (still() && answer && !bot.state.view.guessedIt) bot.emit('draw:say', { text: answer });
    });
  }

  // The end screen: a vote for somebody else's drawing, as a person might.
  s.on('draw:over', (over) => {
    const others = (over.gallery ?? []).map((d, i) => ({ d, i })).filter(({ d }) => d.drawerId !== bot.id);
    if (!others.length) return;
    bot.once('vote', rand(3000, 7000), () => bot.emit('draw:vote', { drawing: pick(others).i }));
  });

  // --- telephone -------------------------------------------------------------------------------
  s.on('tel:state', (v) => {
    bot.state.tel = v;
    if (v.paused || !v.task) {
      if (v.paused) bot.state.telStep = null;
      bot.cancelAll('tel');
      bot.cancelAll('draw:');
      return;
    }
    if (bot.state.telStep === v.step) return;
    bot.state.telStep = v.step;
    const still = () => bot.state.tel?.task && bot.state.tel.step === v.step && !bot.state.tel.paused;
    const left = (v.secondsLeft ?? v.stepSeconds ?? 40) * 1000;
    if (v.task.kind === 'pick') {
      bot.once('tel:pick', Math.min(left * 0.5, rand(2000, 5000)), () => still() && bot.emit('tel:pick', { index: Math.floor(Math.random() * Math.max(1, v.task.choices.length)) }));
    } else if (v.task.kind === 'draw') {
      drawOut('tel:stroke', still, Math.min(12000, left * 0.4), () => bot.emit('tel:submit', {}));
    } else {
      bot.once('tel:guess', Math.min(left * 0.5, rand(4000, 9000)), () => {
        if (!still()) return;
        bot.emit('tel:submit', { text: Math.random() < 0.5 ? chainStart(v.step) ?? pick(WRONG) : pick(WRONG) });
      });
    }
  });

  // The character the chain this bot holds started from (telephone.js chainIndexFor).
  function chainStart(step) {
    const t = bot.room()?.game;
    if (!t?.chains) return null;
    const seat = t.order.indexOf(bot.id);
    if (seat < 0) return null;
    const n = t.order.length;
    return t.chains[(seat - step + n * t.steps) % n]?.entries[0]?.text ?? null;
  }
}

module.exports = { attach, doodle, pieces };
