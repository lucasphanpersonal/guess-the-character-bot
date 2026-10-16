// The computer games' sound (/desk/, /draw/). Loaded after common.js; exposes one global,
// GTCSound. The phones have their own (src/web/party/public/app.js) because their problem is
// different: the wearer cannot see the screen, so sound carries the clock and a bed runs under
// the whole turn. Here everyone can see the screen, so there is no bed and no ticking -- only
// short one-shot cues for the moments worth looking up for. Often that is a player in another
// tab, on a call, waiting for their turn. The one exception is Draw's pen on paper (scribble),
// which sounds only while a pen is actually moving.
//
// Sound sits under the room, not over it. These play on computers that are usually also carrying
// a voice call, often into headphones, several of them in one room, so every cue is soft sine or
// triangle at a low gain. Only the game itself is loud, never the beeps. And the cues are
// spread across machines on purpose: a miss is heard only by the person who guessed (misses are
// free and come by the dozen), and only a ruler hears the call to rule.
//
// Every sound goes through tone(), so "off" is honoured in one place and nothing can dodge it.
// The preference is the phones' own key (gtc_muted): one per browser, sticky, on by default.
(function () {
  const { store } = GTC;
  let ctx = null;
  let master = null;
  let muted = store.get('gtc_muted') === '1';

  // Browsers only start audio after a gesture on the page. So the context is made on the first
  // click or key, not at load: made earlier, it would sit suspended and log a warning. It is
  // resumed on every gesture too, because a browser can suspend it again.
  //
  // Resolves once audio can actually play. tone() refuses a suspended context rather than queue
  // on it: notes scheduled on a stopped clock all sound at once when it starts, a burst of stale
  // cues on somebody's first click.
  function wake() {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') return ctx.resume().catch(() => {});
    } catch { /* no Web Audio: every cue is silent, the game is not */ }
    return Promise.resolve();
  }
  document.addEventListener('pointerdown', wake, { capture: true, passive: true });
  document.addEventListener('keydown', wake, { capture: true, passive: true });

  // One output for every cue, so muting can cut what is already sounding: a three-note cue is
  // scheduled all at once, and checking `muted` per note would not stop the notes already queued.
  function out() {
    if (!master) {
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    return master;
  }

  // One note. `at` is seconds from now, so a cue's notes are placed on the audio clock together
  // rather than by timers, which a background tab slows down -- the tab most likely to need a
  // "your turn" cue.
  let cueStart = 0; // where on the audio clock the cue being played begins (see play)
  let quietAt = 0;  // when the last note scheduled so far ends
  function tone(freq, ms, { gain = 0.25, type = 'sine', at = 0 } = {}) {
    if (muted || !ctx || ctx.state !== 'running') return;
    try {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq; o.connect(g); g.connect(out());
      const t = Math.max(ctx.currentTime, cueStart) + at;
      quietAt = Math.max(quietAt, t + ms / 1000);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.start(t); o.stop(t + ms / 1000 + 0.02);
    } catch { /* fine */ }
  }

  // The vocabulary both games share, so the same moment sounds the same in either. Each is
  // distinct by SHAPE, not just pitch: rising for yours, falling for a miss, level for "held",
  // repeated for "look up".
  const CUES = {
    // Your turn: a soft rising pair. The one cue meant to reach someone looking elsewhere.
    turn() { tone(523, 160, { gain: 0.3 }); tone(784, 260, { gain: 0.3, at: 0.13 }); },
    // Somebody got it: a bright rising triad.
    got() { [523, 659, 784].forEach((f, i) => tone(f, i === 2 ? 320 : 150, { gain: 0.26, type: 'triangle', at: i * 0.1 })); },
    // You got it: the same triad with the octave on top, so yours is recognisably yours.
    gotMine() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i === 3 ? 380 : 140, { gain: 0.28, type: 'triangle', at: i * 0.09 })); },
    // A miss: one low falling step, short. Heard often, so it is the quietest thing here.
    miss() { tone(330, 120, { gain: 0.16 }); tone(262, 180, { gain: 0.16, at: 0.1 }); },
    // Close -- held for a ruling: two level notes, a question rather than an answer.
    close() { tone(587, 130, { gain: 0.2 }); tone(587, 180, { gain: 0.2, at: 0.17 }); },
    // Your call is wanted (a ruling): a quick double knock, higher, with a deadline behind it.
    ask() { tone(880, 90, { gain: 0.22 }); tone(880, 90, { gain: 0.22, at: 0.14 }); tone(1175, 160, { gain: 0.2, at: 0.28 }); },
    // Time nearly up: two soft knocks. Once, not a tick per second -- the bar turns colour too.
    hurry() { tone(698, 100, { gain: 0.2 }); tone(698, 100, { gain: 0.2, at: 0.16 }); },
    // The reveal: a falling-then-resolving phrase, the turn closing.
    reveal() { [784, 659, 523, 784].forEach((f, i) => tone(f, i === 3 ? 360 : 140, { gain: 0.22, type: 'triangle', at: i * 0.12 })); },
  };
  // Cues queue rather than overlap. Two arrive together often -- the last right guess and the
  // reveal it causes come in the same moment -- and two phrases on top of each other are a mush in
  // which neither means anything. The wait is capped, so a backlog never makes a cue late enough
  // to be about something that has already passed.
  const GAP_S = 0.08;
  const MAX_WAIT_S = 1.2;
  function play(name) {
    const cue = CUES[name];
    if (!cue || muted || !ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    cueStart = Math.min(Math.max(now, quietAt + GAP_S), now + MAX_WAIT_S);
    try { cue(); } finally { cueStart = 0; }
  }

  // --- the pen on paper (Draw) -----------------------------------------------------------------
  // The one sound here that is not a cue: noise, band-passed to a pencil's scratch, heard only
  // while a pen is moving and as loud as it is fast -- a slow line a whisper, scribbling a rasp.
  // It stops the moment the pen does, so it is never a bed. It is quieter than the quietest cue
  // (a miss), because it plays on every screen in the room for as long as someone draws.
  // Thin brushes sound higher than fat ones: a pencil, not a marker.
  //
  // One looping noise source while anyone draws, wound down after a moment's stillness. The level
  // is set on the audio clock, not by timers, so a background tab's slow timers cannot leave it
  // stuck on: every call schedules its own fade.
  const SCRIBBLE_PEAK = 0.09;
  const SCRIBBLE_HOLD_S = 0.07; // how long one movement is heard before it fades
  const SCRIBBLE_IDLE_MS = 1500; // stillness before the source itself stops
  let pencil = null; // { src, filter, gain, idle }
  function noiseBuffer() {
    const len = ctx.sampleRate; // a second of noise, looped
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Grainy rather than smooth: paper has a tooth, so the noise comes in uneven clumps.
    let grain = 1;
    for (let i = 0; i < len; i++) {
      if (i % 220 === 0) grain = 0.35 + Math.random() * 0.65;
      d[i] = (Math.random() * 2 - 1) * grain;
    }
    return buf;
  }
  function stopScribble() {
    if (!pencil) return;
    clearTimeout(pencil.idle);
    try { pencil.src.stop(); pencil.gain.disconnect(); } catch { /* fine */ }
    pencil = null;
  }
  /**
   * The pen moved. `speed`: canvas widths per second. `size`: the brush (3 thin .. 36 fat).
   */
  function scribble(speed, size = 8) {
    if (muted || !ctx || ctx.state !== 'running' || !(speed > 0)) return;
    try {
      if (!pencil) {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer();
        src.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 0.9;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(filter); filter.connect(gain); gain.connect(out());
        src.start();
        pencil = { src, filter, gain, idle: null };
      }
      const now = ctx.currentTime;
      const pace = Math.min(1, speed / 2);
      const level = SCRIBBLE_PEAK * Math.sqrt(pace);
      const pitch = (4200 - Math.min(36, Math.max(3, size)) * 70) * (0.8 + 0.4 * pace);
      pencil.filter.frequency.setTargetAtTime(pitch, now, 0.03);
      const g = pencil.gain.gain;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(level, now, 0.015);
      g.setTargetAtTime(0, now + SCRIBBLE_HOLD_S, 0.03);
      clearTimeout(pencil.idle);
      pencil.idle = setTimeout(stopScribble, SCRIBBLE_IDLE_MS);
    } catch { /* fine */ }
  }

  /**
   * A Sound On / Sound Off switch. The button is in each page's markup; this wires and paints it.
   * Turning it on plays a cue straight away: the point of the control is hearing what you chose,
   * and the click is the gesture that lets audio start.
   */
  function mountToggle(btn) {
    if (!btn) return;
    const paint = () => {
      btn.setAttribute('aria-checked', String(!muted));
      btn.querySelector('.label').textContent = muted ? 'Sound Off' : 'Sound On';
    };
    btn.addEventListener('click', () => {
      muted = !muted;
      store.set('gtc_muted', muted ? '1' : '0');
      if (muted && master) {
        // Cut whatever is sounding, and start a fresh output next time.
        stopScribble();
        try { master.disconnect(); } catch { /* fine */ }
        master = null;
      }
      paint();
      if (!muted) wake().then(() => play('turn'));
    });
    paint();
  }

  window.GTCSound = { tone, play, scribble, mountToggle, isMuted: () => muted, CUES: Object.keys(CUES) };
})();
