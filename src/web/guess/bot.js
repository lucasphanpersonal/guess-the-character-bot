// A test bot's brain for Who Am I?, both ways of playing (../bots.js runs it).
//
// It hears what a player's browser hears and answers with what a browser would send:
//   check screen  fill an empty seat at random (pick-for-each-other), then Good to Go
//   phones        on its turn, a pause, then "got it" (a tilt up) or a pass (a tilt down)
//   computers     on its turn, a wrong guess or two, then its own name -- now and then with a typo,
//                 so a person gets to rule on a close guess -- or a pass; and it rules on others'
//                 close guesses, slowly enough that a person usually gets there first
//
// It knows its own character by reading the room (bot.room()), which no player can: that is what
// lets it be right some of the time, as a person would be, instead of never.

// Wrong guesses: well-known enough to read as a guess, and if one happens to be right, it is right.
const WRONG = ['Mario', 'Pikachu', 'Batman', 'Sherlock Holmes', 'Elsa', 'Goku', 'Shrek', 'Homer Simpson', 'Darth Vader', 'Sonic', 'Link', 'Spider-Man', 'Wonder Woman', 'Kirby'];

// Two letters swapped in the middle: the kind of slip the checker calls close, not wrong.
function typo(name) {
  const chars = [...name];
  const at = chars.findIndex((c, i) => i >= 2 && /\p{L}/u.test(c) && /\p{L}/u.test(chars[i + 1] ?? ''));
  if (at < 0) return name;
  [chars[at], chars[at + 1]] = [chars[at + 1], chars[at]];
  return chars.join('');
}

function attach(bot, { rand, pick }) {
  const s = bot.socket;
  const desk = bot.kind === 'desk';
  const myName = () => bot.room()?.game?.headByPlayer?.[bot.id]?.name ?? null;

  // --- the check screen ------------------------------------------------------------------------
  s.on('setup:state', (v) => {
    bot.state.setup = v;
    if (v.confirmed) return;
    bot.once('setup', rand(1200, 3500), () => {
      const now = bot.state.setup;
      if (!now || now.confirmed) return;
      // An empty seat to fill first: the check screen's Pick at Random is a reroll of nothing.
      if (!now.canConfirm && now.checkerPicks) return bot.emit('setup:reroll');
      if (now.canConfirm) bot.emit('setup:confirm');
    });
  });
  // A new deal (rematch, or the host cancelled and dealt again) starts the check screen afresh.
  s.on('setup:aborted', () => bot.cancelAll());

  // --- play --------------------------------------------------------------------------------------
  s.on('game:state', (v) => {
    bot.state.game = v;
    if (desk) ruleIfAsked(v);
    const stopped = v.paused || v.hostPaused || v.phase !== 'playing';
    if (!v.isMyTurn || stopped) {
      // Not ours, or the clock is stopped: whatever was planned waits for a fresh state.
      bot.cancelAll('turn');
      bot.state.turnKey = null;
      return;
    }
    const key = `${v.current.playerId}:${v.current.turnNumber}`;
    if (bot.state.turnKey === key) {
      // Still our turn with nothing planned: a close guess was ruled a miss (or lapsed). Have
      // another go rather than sit out the clock. If the turn was about to end on what was just
      // sent, the plan finds it is no longer ours when it comes due, and does nothing.
      if (desk && !v.ruling && !bot.pending('turn')) planLast(key, 4000);
      return;
    }
    bot.state.turnKey = key;
    bot.cancelAll('turn');
    // Inside the time there is, with some to spare: a bot that always timed out would test nothing.
    const budget = Math.max(3000, ((v.turnRemaining ?? v.turnSeconds ?? 60) * 1000) * 0.7);
    if (desk) planGuesses(key, budget);
    else planTilt(key, budget);
  });

  const stillMine = (key) => {
    const v = bot.state.game;
    return v && v.isMyTurn && !v.paused && !v.hostPaused && `${v.current.playerId}:${v.current.turnNumber}` === key;
  };
  // Passing is the way not to know. Last one guessing has no pass (turnRules.guesserControls), and
  // waiting out the clock every turn would only make the person watching wait too -- so a bot left
  // on its own always comes up with its name.
  const canPass = () => !!bot.state.game?.buttons?.pass;

  // Phones: one tilt, after a pause that looks like somebody asking questions.
  function planTilt(key, budget) {
    bot.once('turn:tilt', Math.min(budget, rand(4000, 12000)), () => {
      if (!stillMine(key)) return;
      if (!canPass() || Math.random() < 0.55) bot.emit('game:gotit');
      else bot.emit('game:pass');
    });
  }

  // Computers: a few typed guesses, spaced out, the last of them the answer about half the time.
  function planGuesses(key, budget) {
    const wrongs = Math.floor(rand(0, 3));
    const gap = Math.min(6000, budget / (wrongs + 2));
    for (let i = 0; i < wrongs; i++) {
      bot.once(`turn:wrong${i}`, gap * (i + 1) * rand(0.8, 1.2), () => {
        if (stillMine(key)) bot.emit('game:guess', { text: pick(WRONG) });
      });
    }
    planLast(key, gap * (wrongs + 1));
  }

  // The turn's last word: the name (now and then with a slip), or a pass.
  function planLast(key, ms) {
    bot.once('turn:last', ms * rand(0.9, 1.1), () => {
      if (!stillMine(key)) return;
      const name = myName();
      if (canPass() && (!name || Math.random() < 0.45)) return bot.emit('game:pass');
      if (!name) return bot.emit('game:giveup');
      bot.emit('game:guess', { text: canPass() && Math.random() < 0.25 ? typo(name) : name });
    });
  }

  // Someone else's close guess: a ruling, after long enough that the person at the screen usually
  // makes it first. Mostly yes -- a close guess usually is the name.
  function ruleIfAsked(v) {
    const r = v.ruling;
    if (!r || r.waiting || !r.canRule) return;
    bot.once(`rule:${r.id}`, rand(6000, 10000), () => {
      if (bot.state.game?.ruling?.id !== r.id) return;
      bot.emit('game:rule', { id: r.id, accept: Math.random() < 0.75 });
    });
  }
}

module.exports = { attach, typo, WRONG };
