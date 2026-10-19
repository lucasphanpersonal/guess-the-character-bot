// The phones' easter eggs: a rare, harmless surprise on an idle screen. Loaded after app.js (see
// its header for the order and why it matters); scheduleEgg() is started by boot.js.

// --- easter eggs ----------------------------------------------------------------------------
//
// Rare, small, and never during play. The point is that someone waiting in a lobby catches one
// out of the corner of their eye and isn't quite sure it happened -- so these fire minutes
// apart, not seconds, and each is one element doing one thing.
//
// Everything here is decoration that must never touch game state: an egg picks from what is
// currently on screen, adds a class, and takes it off again when the animation ends.
const EGG_MIN_MS = 50000;
const EGG_MAX_MS = 140000;
const RARE_EGG_CHANCE = 0.12;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Plays a one-shot class and cleans up after itself. The timeout is a backstop: animationend
// never fires if the element is removed or re-rendered mid-animation, and a stuck class would
// freeze that element at whatever angle the keyframe left it.
function playOnce(el, cls, maxMs = 2000) {
  if (!el || el.classList.contains(cls)) return;
  el.classList.add(cls);
  const done = () => el.classList.remove(cls);
  el.addEventListener('animationend', done, { once: true });
  setTimeout(done, maxMs);
}

// Only what the user can actually see: an egg fired into a hidden screen is a wasted egg.
const visible = (el) => el && el.offsetParent !== null;
const inActiveScreen = (sel) => [...(document.querySelector('.screen.active')?.querySelectorAll(sel) ?? [])].filter(visible);

const EGGS = [
  // A letter of the title kicks up, and its neighbours follow.
  () => {
    const letters = [...document.querySelectorAll('h1 .wob')];
    if (!letters.length) return false;
    letters.forEach((l, i) => setTimeout(() => playOnce(l, 'egg-wave'), i * 55));
    return true;
  },
  // A button gives a little hop, as if it wants pressing.
  () => {
    const btn = pick(inActiveScreen('button'));
    if (!btn) return false;
    playOnce(btn, 'egg-hop');
    return true;
  },
  // A card rocks on its corner and settles back to its own angle.
  () => {
    const card = pick(inActiveScreen('.card:not(.flat)'));
    if (!card) return false;
    playOnce(card, 'egg-nudge', 2500);
    return true;
  },
  // One character of the room code turns a cartwheel. Lobby only -- it is the only screen with
  // a room code on it.
  () => {
    const chars = [...document.querySelectorAll('#lobby .roomcode .ch')].filter(visible);
    if (!chars.length) return false;
    playOnce(pick(chars), 'egg-spin', 2000);
    return true;
  },
];

// The rare one: the whole title barrel-rolls, letter by letter. Roughly one egg in eight, so a
// long lobby might see it and a short one never will.
function rareEgg() {
  const letters = [...document.querySelectorAll('h1 .wob')];
  if (!letters.length) return false;
  letters.forEach((l, i) => setTimeout(() => playOnce(l, 'egg-roll', 2000), i * 70));
  return true;
}

// Idle means idle: not mid-game, not on a forehead, and not on a tab nobody is looking at.
function eggsAllowed() {
  return !reducedMotion() &&
    !document.hidden &&
    !document.body.classList.contains('at-play') &&
    !$('forehead').classList.contains('active');
}

function scheduleEgg() {
  const delay = EGG_MIN_MS + Math.random() * (EGG_MAX_MS - EGG_MIN_MS);
  setTimeout(() => {
    if (eggsAllowed()) (Math.random() < RARE_EGG_CHANCE ? rareEgg() : pick(EGGS)());
    scheduleEgg();
  }, delay);
}

