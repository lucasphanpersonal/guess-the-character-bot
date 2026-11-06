// Every sound on the phones: the cues, the turn bed under the current player's turn, the sound
// check, and the mute preference that tone() honours so nothing can dodge it. Loaded after app.js,
// which declares the shared audioCtx.

function ensureAudio() {
  try {
    // A party is exactly where phones are on silent. On iOS, Web Audio is routed to the ringer
    // channel by default, so the hardware mute switch kills every cue -- and the wearer, whose
    // phone is on their forehead, has no other channel at all. Declaring a playback session
    // moves audio to the media channel, which the mute switch does not touch (Safari 16.4+).
    // Where it is unsupported the cues are simply inaudible on a muted phone, which is why the
    // turn clock is drawn on screen as well.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {}
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    // iOS starts the context suspended and keeps re-suspending it; without this the cue beeps
    // are silently dropped, which is what made the give-up hold feel like it wasn't counting.
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch {}
}

// Every sound in the game goes through here, so this is also where "off" is honoured. The
// preference is per phone and sticky: the turn bed runs for a full minute at a time, and anyone
// it bothers needs a way out that isn't leaving the game.
let muted = store.get('gtc_muted') === '1';

// One tone. `gain` matters: a clock tick that is as loud as the turn-start chime stops being a
// background texture and becomes maddening over a 60-second turn.
//
// `at` places the note on the AudioContext clock instead of "now", which is what lets the turn
// bed be scheduled a bar ahead; `out` routes it through a gain node that can fade the whole bed
// out at once.
//
// A pulse wave unless the caller names a voice: the sound of a chip of the era. A pulse has far more
// energy than a sine at the same level, so an unnamed voice is scaled down to keep the balance every
// gain here was set for. The time-up alarm names 'square' on purpose, to be as loud as it was.
const PULSE_LEVEL = 0.4;
// Every note not routed to the bed goes out through this one node, so muting can cut what is
// already sounding: a cue's notes are all scheduled up front, and a fanfare runs over a second
// after the switch was pressed. setMuted() disconnects it, and the next cue makes a fresh one.
let cueGain = null;
function cueOut() {
  if (!cueGain) { cueGain = audioCtx.createGain(); cueGain.connect(audioCtx.destination); }
  return cueGain;
}
function tone(freq = 880, ms = 180, { gain = 0.5, type, at = null, out = null } = {}) {
  if (!audioCtx || muted) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type ?? 'square'; o.frequency.value = freq; o.connect(g); g.connect(out || cueOut());
    if (!type) gain *= PULSE_LEVEL;
    const t = at ?? audioCtx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.start(t); o.stop(t + ms / 1000);
  } catch {}
}
const beep = (freq = 880, ms = 180) => tone(freq, ms);

// --- one-shot cues --------------------------------------------------------------------------
// Placed on the audio clock, like the bed, so a cue's notes keep their spacing in a tab whose
// timers are throttled. Unlike the older beeps, these play only on a RUNNING context: the clock
// stands still while iOS holds it suspended, so a lobby filling up meanwhile would stack every
// join on one instant and sound them as a single chord when it resumed. Missed is better.
const live = () => !!audioCtx && audioCtx.state === 'running';

// The tunes the computers play too (GTC.TUNES, common.js), louder: a phone speaker across a room,
// against the computers' cues at a desk, often into headphones.
const TUNE_SCALE = 1.8;
// How long a tune sounds, from its first note to its last.
function tuneLength(name) {
  return Math.max(...GTC.TUNES[name].map(([, ms, , , at]) => at + ms / 1000));
}
function playTune(name, delay = 0) {
  const t0 = audioCtx.currentTime + delay;
  for (const [f, ms, gain, type, at] of GTC.TUNES[name]) tone(f, ms, { gain: gain * TUNE_SCALE, type, at: t0 + at });
}

// The grace countdown, one blip per second while the number is above zero. It is spent raising
// the phone to a forehead, so the wearer counts it by ear -- the number is out of sight. There is
// no "go" on zero: the first player's turn chime and bed land at that same moment, and the phones
// have no queue to keep two phrases apart. The phone buzzes on the same beats (startCountdown).
function countBlip(n) {
  if (live() && n > 0) tone(523, 90, { gain: 0.4 });
}

// Somebody joined the lobby. A whole party joins in the same minute, often with the phones side
// by side, so it is quieter than any game cue.
function joinBlip() {
  if (live()) playTune('join');
}

// A correct guess on the guesser's own phone: the level-up fanfare (GTC.TUNES.levelUp). Everyone
// else's got-it stays the single chime it was.
// Until when the level-up is still sounding on the audio clock, so the game-over fanfare can wait for
// it (see fanfare).
let levelUpEndsAt = 0;
function levelUpFanfare() {
  if (!live()) return;
  playTune('levelUp');
  levelUpEndsAt = audioCtx.currentTime + tuneLength('levelUp');
}

// Menu selects: the same blip the computers play on a button or a choice (shared/sound.js). Which
// clicks count, and the throttle, are GTC.select (common.js). Off the cue clock, so it never holds
// a turn cue back. The first tap also starts audio on iOS.
document.addEventListener('click', (e) => {
  if (muted || !GTC.select.from(e.target)) return;
  ensureAudio();
  if (!live() || !GTC.select.due()) return;
  for (const [f, ms, gain, type, at] of GTC.TUNES.select) tone(f, ms, { gain: gain * TUNE_SCALE, type, at: audioCtx.currentTime + at });
}, true);

// The end of the game, a step up on top for a winner's phone. The last finisher's reveal sound comes a
// moment before game:over: a 160ms chime, or the level-up fanfare, which runs most of a second. The
// phones have no queue, so the game-over fanfare waits for whichever is still sounding; anything
// shorter than the chime's gap starts on the gap.
const AFTER_REVEAL_S = 0.2;
function fanfare(won) {
  if (!live()) return;
  const delay = Math.max(AFTER_REVEAL_S, levelUpEndsAt - audioCtx.currentTime);
  playTune('over', delay);
  if (won) playTune('overWon', delay);
}

// --- the turn bed ---------------------------------------------------------------------------
//
// A quiet two-chord vamp under the current player's turn, doing two jobs at once. The wearer
// cannot see their own screen, so the clock has to reach them as sound; and the ROOM needs to
// know whose turn it is -- which this answers by accident of physics, because only the current
// player's phone plays it and that phone is strapped to the head everyone should be looking at.
//
// Pitched to sit UNDER a room talking, not over it. A party talks through a full minute of this
// per turn, several turns a game, so the bar is "something you notice stopping" rather than
// something anybody has to raise their voice against. The last ten seconds take the same vamp
// faster and a little louder, which is the moment it is allowed to be noticed.
//
// Scheduled a bar ahead on the AudioContext clock rather than fired from setInterval: a vamp
// built out of timer callbacks wobbles audibly, and a hidden tab throttles timers to whole
// seconds. The audio clock does not drift, so the timer only has to be roughly on time.
const BED_CHORDS = [
  [110.00, 220.00, 261.63, 329.63], // A minor
  [87.31, 174.61, 220.00, 261.63],  // F major
];
// [step, note within the chord, length in steps, gain]. Four events per bar: a low pulse on the
// downbeat that rings on under the rest, then three lighter notes over the top of it.
const BED_PATTERN = [
  [0, 0, 3, 0.085],
  [2, 1, 1, 0.045],
  [4, 2, 1, 0.045],
  [6, 3, 1, 0.050],
];
const BED_STEPS = 8;
const BED_STEP_MS = 250;      // 2s bars
const BED_STEP_MS_CRIT = 150; // the last ten seconds: same vamp, taken faster

let bedGain = null;    // one node for the whole bed, so it can be faded out in a single move
let bedTimer = null;
let bedNextBarAt = 0;
let bedBar = 0;
let bedCrit = false;

function scheduleBedBar() {
  if (!audioCtx || !bedGain) return;
  const stepS = (bedCrit ? BED_STEP_MS_CRIT : BED_STEP_MS) / 1000;
  const chord = BED_CHORDS[bedBar % BED_CHORDS.length];
  for (const [step, note, len, gain] of BED_PATTERN) {
    tone(chord[note], len * stepS * 1000, {
      gain: bedCrit ? gain * 1.35 : gain,
      type: note === 0 ? 'triangle' : undefined, // triangle bass, pulse over it, as a chip would
      at: bedNextBarAt + step * stepS,
      out: bedGain,
    });
  }
  bedNextBarAt += BED_STEPS * stepS;
  bedBar += 1;
  // Wake shortly before the bar just scheduled runs out. Firing late is harmless: the next bar's
  // notes are placed from bedNextBarAt on the audio clock, not from whenever this happens to run.
  bedTimer = setTimeout(scheduleBedBar, Math.max(50, (bedNextBarAt - audioCtx.currentTime - 0.2) * 1000));
}

function startBed(crit) {
  // Before the already-running check, or muting mid-turn would leave the bed it was muting
  // playing to the end of the turn -- the one moment somebody reaching for the switch cares about.
  if (muted) return stopBed();
  bedCrit = crit;
  if (bedGain) return; // already running; the line above is how it speeds up mid-turn
  ensureAudio();
  if (!audioCtx) return;
  bedGain = audioCtx.createGain();
  bedGain.gain.value = 1;
  bedGain.connect(audioCtx.destination);
  bedNextBarAt = audioCtx.currentTime + 0.06;
  bedBar = 0;
  scheduleBedBar();
}

function stopBed() {
  if (bedTimer !== null) { clearTimeout(bedTimer); bedTimer = null; }
  const g = bedGain;
  bedGain = null;
  if (!g || !audioCtx) return;
  // Faded, not cut: a bar is always already scheduled, and killing the node outright clips those
  // notes into a click at exactly the moment a reveal chime is trying to land.
  try {
    const t = audioCtx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0.0001, t + 0.18);
    setTimeout(() => { try { g.disconnect(); } catch {} }, 500);
  } catch {
    try { g.disconnect(); } catch {}
  }
}

// The bed belongs to one live turn on one phone: the player's own, running, not paused, not
// over. Called every second from the ticker, so it also picks up the change into the last ten.
function updateBed(view, remaining) {
  const live = view.isMyTurn && !frozen(view) && remaining != null && remaining > 0;
  if (live) startBed(remaining <= CRIT_SECONDS);
  else stopBed();
}

// The setup screen's sound check. Plays the real thing -- the turn-start chime, then two bars of
// the actual bed -- because "does your phone make noise" is not the question. The question is
// whether this player, on this phone, at this volume, in this room, will hear their own clock.
function playSoundCheck() {
  if (muted) {
    $('soundCheckNote').textContent = 'Game sounds are off on this phone. Turn them back on to test.';
    return;
  }
  ensureAudio();
  beep(880, 200);
  setTimeout(() => beep(1250, 220), 150);
  setTimeout(() => startBed(false), 520);
  setTimeout(stopBed, 4800); // ~2 bars
  // Read the state a beat later: iOS hands back a suspended context and resumes it a tick after
  // the gesture, so asking immediately reports a failure that isn't one.
  setTimeout(() => {
    $('soundCheckNote').textContent = audioCtx && audioCtx.state === 'running'
      ? 'Playing now — that is what your turn sounds like. Heard nothing? Check the silent switch and the volume.'
      : "This phone wouldn't start audio, so you'll be playing by the clock bar on screen instead.";
  }, 300);
}

// Reflects the stored preference rather than a toggle's own memory, so it is still right after a
// reload -- which, on this app, happens more than you would think.
function renderSoundCheck() {
  $('muteBtn').textContent = muted ? 'Turn Game Sounds Back On' : 'Turn Game Sounds Off';
  $('soundCheckBtn').disabled = muted;
  const corner = $('soundToggle');
  corner.setAttribute('aria-checked', String(!muted));
  corner.title = muted ? 'Sound Off' : 'Sound On';
}

// The one way sound changes on the phones, from the setup screen's button or the corner switch.
function setMuted(next) {
  muted = next;
  store.set('gtc_muted', muted ? '1' : '0');
  if (muted) {
    stopBed();
    if (cueGain) { try { cueGain.disconnect(); } catch {} cueGain = null; }
  }
  renderSoundCheck();
}

