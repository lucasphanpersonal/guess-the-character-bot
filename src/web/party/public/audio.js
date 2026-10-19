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
function tone(freq = 880, ms = 180, { gain = 0.5, type = 'sine', at = null, out = null } = {}) {
  if (!audioCtx || muted) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq; o.connect(g); g.connect(out || audioCtx.destination);
    const t = at ?? audioCtx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.start(t); o.stop(t + ms / 1000);
  } catch {}
}
const beep = (freq = 880, ms = 180) => tone(freq, ms);

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
      type: note === 0 ? 'triangle' : 'sine',
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
}

