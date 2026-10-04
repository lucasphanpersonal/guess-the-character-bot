// The tilt rules: given an accelerometer reading and the clock, decide what the player just did.
//
// Pure on purpose. No DOM, no sockets, no audio, no timers -- app.js owns every effect and calls
// step() to find out which ones to fire. This is the only real game logic on the client, it is
// the logic that can irreversibly publish the character you are wearing, and until it was split
// out it was the one part of the app with no tests: every number here was tuned against a bug
// somebody hit at a party, which is exactly the kind of thing that needs holding in place.
//
// Loads as a plain <script> before app.js (which reads the `TiltRules` global) and as a CommonJS
// module under the test runner.

const TiltRules = (() => {
  // ABSOLUTE thresholds, not relative to a captured baseline.
  //
  // This used to snapshot a "neutral" z at the start of each turn. That is fragile in exactly the
  // way that matters: if the phone wasn't actually on a forehead at that instant (still flat on
  // the table, still being raised), the baseline was garbage -- and since a flat phone reads ~9.8
  // while an upright one reads ~0, every later sample sat a full 9.8 past the threshold and the
  // gesture fired immediately and repeatedly. A player who mis-oriented their phone could burn
  // their whole turn, or blow through several turns, without touching anything.
  //
  // Held upright against a forehead, gravity's screen-normal component is ~0 regardless of how
  // the phone is rotated in its own plane, so absolute values need no calibration and cannot be
  // poisoned by a bad starting position.
  const NEUTRAL_MAX = 3.5; // |z| below this = upright, i.e. plausibly on a forehead

  // Asymmetric on purpose. Tilting UP is the irreversible move -- it ends the turn and publishes
  // the character the player is still wearing, and no undo reaches that -- while tilting down
  // only passes, which costs nothing. It is also the direction ordinary play produces by
  // accident: nodding along, or lifting the phone to reset it on the forehead. So "got it" asks
  // for a firmer tilt held slightly longer, and "pass" keeps the original, lighter touch. Same
  // asymmetry the Discord side applies to its confirm-on-correct guard.
  const TILT_TH_UP = 6.5;    // ~41 degrees off upright (was 5.5, ~34: too easy to trip)
  const TILT_TH_DOWN = 5.5;  // unchanged
  const HOLD_UP_MS = 600;    // was 450
  const HOLD_DOWN_MS = 450;  // unchanged

  // After a gesture fires, ignore the next moment entirely: the hand that just tilted is on its
  // way back and would otherwise read as the opposite gesture.
  const REFIRE_MS = 1200;

  // Tilting DOWN normally passes. When you're the last player still guessing there is nobody to
  // pass to -- so instead of the gesture doing nothing, it gives up and ends the game. That needs
  // a much longer hold than a pass, because tilting down is also the natural motion of taking the
  // phone OFF your forehead: an instant give-up would fire on anyone lowering their phone to look
  // at it, and a give-up is irreversible and public.
  const GIVEUP_HOLD_MS = 1400;  // deliberate, but achievable while holding a phone steady
  const GIVEUP_GAP_MS = 300;    // brief dips below the threshold don't restart the hold
  const GIVEUP_TICK_MS = 450;   // audible progress while it counts, so the room hears it too

  const G = 9.81;

  const isUpright = (z) => z != null && Math.abs(z) < NEUTRAL_MAX;

  // `z` everywhere in this file is gravity along the screen's normal in m/s^2, NEGATIVE when the
  // screen faces the ceiling: ~-9.8 face up on a table, ~0 upright on a forehead, ~+9.8 face down.
  //
  // That is a convention this file fixes, not something any one sensor promises. The obvious
  // source -- devicemotion's accelerationIncludingGravity.z -- does not agree on its sign across
  // browsers: iPhone Safari reads face-up as negative, Chrome on Android as positive, and other
  // Android browsers have not been reliably either. Read raw, it swapped "got it" and "pass" for
  // some Android players and not others, which looked like flakiness rather than a convention. A
  // manual flip existed, on a diagnostics screen nobody at a party ever opened. app.js now prefers
  // zFromAngles below, and learns the raw fallback's sign per phone instead of assuming it.

  // The same quantity from deviceorientation's angles, whose meaning the two platforms agree on.
  // With the spec's Z-X'-Y'' rotation, the vertical component of the screen normal is
  // cos(beta)·cos(gamma): 1 face up, -1 face down, 0 upright -- in portrait AND landscape, which
  // is what the old beta-only reading got wrong (beta barely moves on a phone held sideways).
  function zFromAngles(beta, gamma) {
    if (beta == null || gamma == null) return null;
    const rad = Math.PI / 180;
    return -G * Math.cos(beta * rad) * Math.cos(gamma * rad);
  }

  // Current tilt as a gesture: 'gotit', 'pass', or null. Absolute, so it needs no calibration.
  function gestureFor(z) {
    if (z == null) return null;
    // One signed measure of "upness", so the two thresholds can differ without the sign handling
    // getting tangled.
    const upness = -z;
    if (upness > TILT_TH_UP) return 'gotit';
    if (-upness > TILT_TH_DOWN) return 'pass';
    return null;
  }

  /** A fresh tracker. `armed` starts FALSE: see step(). */
  const newState = () => ({
    armed: false, dir: null, since: 0, lastFire: 0,
    giveUpStart: 0, giveUpLastSeen: 0, giveUpTicked: 0,
  });

  function resetGiveUp(state) {
    state.giveUpStart = 0;
    state.giveUpTicked = 0;
  }

  /** Between turns, and whenever it stops being this player's turn. */
  function reset(state) {
    state.dir = null;
    resetGiveUp(state);
  }

  const nothing = (giveUpFraction = 0) => ({ action: null, giveUpFraction, giveUpTick: false });

  /**
   * Advance the tracker by one reading and report what the caller should do.
   *
   * @param {object} state              mutated in place; make one with newState()
   * @param {object} reading
   * @param {number|null} reading.z     screen-normal gravity (negative = facing the ceiling), or
   *                                    null if the sensor has said nothing
   * @param {number} reading.now        Date.now(), passed in so tests own the clock
   * @param {boolean} reading.canGiveUp down means give up rather than pass (nobody left to pass to)
   * @returns {{action: null|'gotit'|'pass'|'giveup', giveUpFraction: number, giveUpTick: boolean}}
   */
  function step(state, { z, now, canGiveUp }) {
    // Arming requires actually seeing the phone upright. Until then no gesture can fire, however
    // the phone happens to be lying -- that is the whole safety property, and it is what stops a
    // turn that starts with the phone flat on a table from firing a gesture instantly.
    if (!state.armed) {
      if (isUpright(z)) state.armed = true;
      else {
        state.dir = null;
        state.giveUpTicked = 0;
        return nothing(0);
      }
    }

    const g = gestureFor(z);
    let giveUpTick = false;
    let fraction = 0;

    // The give-up hold, tracked SEPARATELY from the strict gesture path below.
    //
    // It used to ride on the same `since` timestamp, which resets the instant the gesture reads
    // as anything else -- and holding a phone past a threshold for well over a second produces
    // plenty of momentary dips below it. Every dip restarted the clock, so the hold could never
    // complete, and tilting down as the last player appeared to do nothing at all. This tolerates
    // gaps of up to GIVEUP_GAP_MS and reports progress so the hold is visibly counting rather
    // than relying on audio that iOS may have suspended.
    if (canGiveUp) {
      if (g === 'pass') {
        if (!state.giveUpStart) state.giveUpStart = now;
        state.giveUpLastSeen = now;
      } else if (state.giveUpStart && now - state.giveUpLastSeen > GIVEUP_GAP_MS) {
        resetGiveUp(state); // genuinely let go -> abort
      }
      if (state.giveUpStart) {
        const heldDown = now - state.giveUpStart;
        const ticks = Math.floor(heldDown / GIVEUP_TICK_MS);
        if (ticks > state.giveUpTicked) { state.giveUpTicked = ticks; giveUpTick = true; }
        fraction = Math.min(1, heldDown / GIVEUP_HOLD_MS);
        if (heldDown >= GIVEUP_HOLD_MS) {
          resetGiveUp(state);
          state.armed = false;
          state.lastFire = now;
          return { action: 'giveup', giveUpFraction: 0, giveUpTick };
        }
        // The hold owns the gesture while it is counting, so a long press down cannot also be
        // read as a pass on its way through.
        if (g === 'pass') return { action: null, giveUpFraction: fraction, giveUpTick };
      }
    } else if (state.giveUpStart) {
      resetGiveUp(state);
    }

    if (!g) { state.dir = null; return nothing(fraction); }          // near upright: ready again
    if (g !== state.dir) { state.dir = g; state.since = now; return nothing(fraction); }
    // `state.lastFire &&` because nothing has fired yet at zero. Comparing it raw only looked
    // right because Date.now() is enormous; on any other clock -- a test's, say -- a fresh
    // tracker sat inside its own cooldown and refused the first gesture of the game.
    if (state.lastFire && now - state.lastFire < REFIRE_MS) return nothing(fraction);

    const held = now - state.since;
    if (held > (g === 'gotit' ? HOLD_UP_MS : HOLD_DOWN_MS)) {
      state.armed = false;
      state.lastFire = now;
      // Disarmed either way: whether or not the caller acts on a 'pass' (it won't if there is
      // nobody to pass to), the phone has to come back upright before anything can fire again.
      return { action: g, giveUpFraction: fraction, giveUpTick };
    }
    return nothing(fraction);
  }

  return {
    NEUTRAL_MAX, TILT_TH_UP, TILT_TH_DOWN, HOLD_UP_MS, HOLD_DOWN_MS,
    REFIRE_MS, GIVEUP_HOLD_MS, GIVEUP_GAP_MS, GIVEUP_TICK_MS,
    isUpright, gestureFor, zFromAngles, newState, step, reset,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TiltRules;
