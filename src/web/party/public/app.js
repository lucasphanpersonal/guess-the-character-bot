// Web client -- the whole party-mode frontend. Vanilla JS, no build step.
//
// Rooms, host config, confirm/reroll, the grace countdown, forehead mode + tilt, the results
// screen, and the read-only character compendium.
//
// Screen is driven by the room status the server reports (lobby -> setup -> ready), plus the
// per-player setup:state (which never contains your own character). Identity survives a
// reconnect via a persistent playerId in localStorage sent in the socket handshake.

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

let playerId = store.get('gtc_playerId');
if (!playerId) {
  playerId = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now());
  store.set('gtc_playerId', playerId);
}

let currentRoom = null;          // { code }
let lastState = null;            // last room:state
let nickname = store.get('gtc_nick') || '';
let options = null;              // setup options (categories/difficulties), fetched for host
// Why setup ended, held rather than written straight to the lobby hint: the room:state that
// follows re-renders the lobby and would wipe it. renderLobby consumes it once.
let abortNote = '';

const socket = io({ auth: { playerId } });

// Sets text one character at a time, each at its own angle and colour, so headings read as
// hand-placed rather than typed. Written with textContent per span, so the source string is
// never treated as markup.
//
// Characters are grouped into WORDS, and that grouping is load-bearing rather than tidiness:
// giving every character its own inline-block box removes ordinary word-boundary line breaking,
// because the browser may then break between any two boxes. "Guess the Character" duly wrapped
// with a lone "r" on the second line. A nowrap word wrapper puts the break opportunities back
// where they belong -- between words only.
const WOBBLE_ANGLES = [-6, 4, -3, 7, -5, 3, -7, 5];
function wobble(el, text, { colour = true } = {}) {
  if (!el) return;
  el.innerHTML = '';
  const words = String(text).split(' ');
  let i = 0;
  words.forEach((word, w) => {
    const holder = document.createElement('span');
    holder.className = 'wob-word';
    for (const ch of word) {
      const span = document.createElement('span');
      span.className = 'wob' + (colour ? ` w${i % 4}` : '');
      span.style.setProperty('--rot', `${WOBBLE_ANGLES[i % WOBBLE_ANGLES.length]}deg`);
      span.textContent = ch;
      holder.appendChild(span);
      i++;
    }
    el.appendChild(holder);
    if (w < words.length - 1) el.appendChild(document.createTextNode(' '));
  });
}

function show(screen) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === screen);
  retilt($(screen));
  // Idle whimsy stops once play starts -- phones are on foreheads, and the only thing that
  // should be moving is the game.
  document.body.classList.toggle('at-play', screen === 'playing' || screen === 'countdown');
}

// Alternates the decorative lean across the cards actually visible on a screen. Hidden cards are
// skipped so toggling one (how-to-play) doesn't flip every card below it, and this runs after
// dynamic inserts too, so the reveal log keeps the rhythm going.
function retilt(root) {
  if (!root) return;
  let i = 0;
  for (const card of root.querySelectorAll('.card:not(.flat)')) {
    if (card.style.display === 'none') continue;
    card.style.setProperty('--tilt', `${i % 2 ? 0.35 : -0.35}deg`);
    i++;
  }
}
const amHost = () => lastState && lastState.hostPlayerId === playerId;

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

// --- lobby rendering ----------------------------------------------------------------------
function renderLobby(state) {
  // Rendered per character so each can carry its own angle (see .roomcode .ch).
  const codeEl = $('lobbyCode');
  codeEl.innerHTML = '';
  const angles = ['-7deg', '5deg', '-4deg', '8deg'];
  [...state.code].forEach((c, i) => {
    const sp = document.createElement('span');
    sp.className = 'ch';
    sp.textContent = c;
    sp.style.setProperty('--rot', angles[i % angles.length]);
    codeEl.appendChild(sp);
  });
  const joinUrl = `${location.origin}/?room=${state.code}`;
  $('shareUrl').textContent = joinUrl;
  const qr = $('qrImg');
  qr.src = `/api/qr?room=${encodeURIComponent(state.code)}`;
  // 'block' (not '') -- an <img> defaults to inline, and margin:auto centering (see CSS) only
  // takes effect on a block-level box. Leaving it inline was why the QR rendered off-center.
  qr.style.display = 'block';
  $('playerCount').textContent = `Players (${state.players.length}/${state.maxPlayers ?? 8})`;
  const roster = $('roster');
  roster.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    li.className = 'seat';
    const dot = document.createElement('span');
    dot.className = 'dot' + (p.connected ? '' : ' off');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.nickname;
    if (p.playerId === playerId) { const y = document.createElement('span'); y.className = 'you'; y.textContent = ' (you)'; name.appendChild(y); }
    li.append(dot, name);
    if (p.isHost) { const c = document.createElement('span'); c.className = 'crown'; c.textContent = 'HOST'; li.appendChild(c); }
    roster.appendChild(li);
  }
  const host = amHost();
  const enough = state.players.length >= 2;
  $('setupBtn').style.display = host ? '' : 'none';
  $('setupBtn').disabled = !enough;
  $('lobbyHint').textContent =
    abortNote ||
    (host ? (enough ? '' : 'Grab one more person!') : 'Hang tight — the host is picking characters.');
  abortNote = ''; // one-shot: it explains the jump back here, then gets out of the way
}

// --- config (host) ------------------------------------------------------------------------
function openConfig({ pick } = {}) {
  if (pick !== undefined) pickMode = pick;
  if (!['deal', 'each', 'host'].includes(pickMode)) pickMode = 'deal';
  socket.emit('setup:options', {}, (opts) => {
    options = opts;
    renderConfig(opts);
    renderModeChoices();
    show('config');
  });
}

// --- host picks ------------------------------------------------------------------------------
//
// The mode where the host chooses everyone's character and sits the game out. Picks live here,
// keyed by playerId, rather than in the form: the picker is rebuilt whenever the roster changes,
// and a deal that gets called off (somebody removed for not locking in) should come back to the
// host's choices, not an empty form. They are dropped when a game ends -- by then everyone has
// seen them.
//   playerId -> { id, name, list, imageUrl }   a character from the library
//            -> { name, typed: true }           a name typed in, which has no picture
const hostPicks = new Map();
// Who picks the characters: 'deal' (at random), 'each' (every player picks for the one they
// check, on the next screen), 'host' (the host picks them all and sits out).
let pickMode = 'deal';

const othersInRoom = () => (lastState?.players ?? []).filter((p) => p.playerId !== playerId);
// Two, not one: each player checks the NEXT player's character, and a lone guesser's next
// player is themselves. The server refuses it too; this just says so before the host bothers.
const canPickForEveryone = () => othersInRoom().length >= 2;

// Who the picker was last built for. Roster broadcasts also fire whenever somebody's connection
// dot flickers, and rebuilding on those would wipe whatever the host was halfway through typing;
// only a change of people (a join, a leave, a rename) is worth that.
let pickerRosterKey = '';
const rosterKey = () => othersInRoom().map((p) => `${p.playerId}:${p.nickname}`).join('|');

function renderModeChoices() {
  pickerRosterKey = rosterKey();
  if (pickMode === 'host' && !canPickForEveryone()) pickMode = 'deal';
  const box = $('modeChoices');
  box.innerHTML = '';
  const modes = [
    { v: 'deal', label: 'Deal at random', sub: 'everyone plays, you included', shape: '▲' },
    { v: 'each', label: 'Pick for each other', sub: 'everyone chooses who the next player is', shape: '●' },
    {
      v: 'host', label: "I'll pick them", shape: '◆', disabled: !canPickForEveryone(),
      sub: canPickForEveryone() ? 'you choose, and sit this one out' : 'needs 2 players besides you',
    },
  ];
  modes.forEach((m, i) => {
    const l = document.createElement('label');
    l.className = `choice c${i}`;
    if (m.disabled) l.style.opacity = '.55';
    const checked = m.v === pickMode;
    l.innerHTML = `<input type="radio" name="mode" value="${m.v}" ${checked ? 'checked' : ''} ${m.disabled ? 'disabled' : ''}>
      <span class="shape">${m.shape}</span>
      <span><div>${escapeHtml(m.label)}</div><div class="sub">${escapeHtml(m.sub)}</div></span>`;
    box.appendChild(l);
  });
  box.onchange = () => {
    pickMode = box.querySelector('input[name=mode]:checked')?.value || 'deal';
    syncPickMode();
  };
  syncPickMode();
}

function syncPickMode() {
  const host = pickMode === 'host';
  $('pickerBox').style.display = host ? '' : 'none';
  // The pool still matters in both picking modes -- for anyone the host leaves blank, and for a
  // player who taps Random -- so it stays, and says what it is now for.
  $('poolLabel').textContent =
    host ? 'Anyone left blank is drawn from' : pickMode === 'each' ? 'Random picks come from' : 'Draw characters from';
  $('dealBtn').textContent = host ? 'Start With These Picks' : pickMode === 'each' ? 'Start Picking' : 'Deal Characters';
  if (host) renderPicker();
  retilt($('config'));
}

function renderPicker() {
  const ul = $('pickerList');
  ul.innerHTML = '';
  const others = othersInRoom();
  // A pick for somebody who has left can't be dealt, and the server refuses the whole deal
  // rather than quietly drop it -- so forget it here, where the host can see it go.
  for (const id of [...hostPicks.keys()]) if (!others.some((p) => p.playerId === id)) hostPicks.delete(id);
  for (const p of others) ul.appendChild(pickSlot(p));
}

function pickSlot(p) {
  const li = document.createElement('li');
  li.className = 'pickslot';
  const head = document.createElement('div');
  head.className = 'pickhead';
  const who = document.createElement('span');
  who.className = 'name';
  who.textContent = p.nickname;
  const current = document.createElement('span');
  current.className = 'pickcurrent';
  head.append(who, current);
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search, or type any name';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', `Character for ${p.nickname}`);
  const results = document.createElement('div');
  li.append(head, input, results);

  const paint = () => {
    const pick = hostPicks.get(p.playerId);
    current.innerHTML = '';
    current.classList.toggle('random', !pick);
    if (!pick) { current.textContent = 'Random'; return; }
    if (pick.imageUrl) {
      const img = document.createElement('img');
      img.className = 'pickthumb';
      img.alt = '';
      img.src = pick.imageUrl;
      current.appendChild(img);
    }
    const label = document.createElement('span');
    label.className = 'lbl';
    label.textContent = pick.typed ? `“${pick.name}”` : pick.name;
    label.title = pick.typed ? 'Typed in — no picture' : pick.list || '';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'pickclear';
    clear.textContent = '✕';
    clear.setAttribute('aria-label', `Back to random for ${p.nickname}`);
    clear.addEventListener('click', () => { hostPicks.delete(p.playerId); paint(); });
    current.append(label, clear);
  };
  // Search and the typed-name row are /shared/pickers.js, shared with the pick-for-each-other
  // screen and the computers.
  window.GTCPickers?.characterSearch(input, results, (pick) => {
    hostPicks.set(p.playerId, pick);
    paint();
  });
  paint();
  return li;
}
// The host's last pool picker, read by deal(). Rebuilt each time the config screen opens, so it
// starts from the server's current curation for this room.
let poolPicker = null;
const ask = (event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

function renderConfig(opts) {
  // Through the fallback: if the picker script is missing or throws, a plain dropdown stands in
  // rather than the config screen never opening at all (this runs before show('config')).
  poolPicker = window.GTC?.mountPoolPicker
    ? GTC.mountPoolPicker($('poolPicker'), { options: opts, request: ask })
    : GTCPickers.poolPicker($('poolPicker'), { options: opts, request: ask });

  const diff = $('diffChoices');
  diff.innerHTML = '';
  const shapes = ['▲', '◆', '●', '■'];
  opts.difficulties.forEach((d, i) => {
    const l = document.createElement('label');
    l.className = `choice c${i}`;
    l.innerHTML = `<input type="radio" name="diff" value="${d.key}" ${d.key === opts.defaultDifficulty ? 'checked' : ''}>
      <span class="shape">${shapes[i % 4]}</span>
      <span><div>${d.label}</div><div class="sub">${d.blurb}</div></span>`;
    diff.appendChild(l);
  });
}

function deal() {
  const difficulty = $('diffChoices').querySelector('input[name=diff]:checked')?.value;
  const turnSeconds = Number($('turnSecondsSelect').value) || 60;
  $('configErr').textContent = 'Dealing…';
  const preferImages = $('preferImagesInput').checked;
  const config = { ...poolPicker.value(), difficulty, turnSeconds, preferImages };
  if (pickMode === 'each') config.eachPicks = true;
  if (pickMode === 'host') {
    const inRoom = new Set(othersInRoom().map((p) => p.playerId));
    config.hostPicks = true;
    // Blank slots are simply absent: the server deals those at random.
    config.picks = Object.fromEntries(
      [...hostPicks].filter(([id]) => inRoom.has(id)).map(([id, pk]) => [id, pk.typed ? { name: pk.name } : { id: pk.id }])
    );
  }
  socket.emit('setup:start', config, (res) => {
    $('configErr').textContent = res?.ok ? '' : (res?.error || 'Could not start.');
    // On success the server broadcasts status + setup:state, which switches the screen.
  });
}

// --- setup / confirm ----------------------------------------------------------------------
function charCardHtml(ch) {
  const img = ch.imageUrl
    ? `<img src="${escapeHtml(ch.imageUrl)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'(no image)'}))">`
    : `<div class="noimg">No image — reveal by name</div>`;
  // Wrapped in .charcard so the fixed image box (.charcard img { height:230px }) applies wherever
  // this is inserted -- not just inside #checkCard. Without the wrapper the image rendered at
  // full natural size on the finished/tap screens and blew out the layout.
  return `<div class="charcard"><div class="charname">${escapeHtml(ch.name)}</div>${ch.source ? `<div class="charsrc">${escapeHtml(ch.source)}</div>` : ''}${img}</div>`;
}

// --- keeping the screen awake -------------------------------------------------------------
//
// Once the reveal happens nobody touches their phone -- it is on a forehead being read by the
// room -- so the auto-lock timer runs out and the screen dies mid-turn, taking that player's
// character off the table.
//
// The Screen Wake Lock API is the supported fix. Two things make it fiddly, and both are
// handled below:
//   - the browser releases the lock whenever the page is hidden (a call, a notification, an
//     app switch), and does NOT restore it on return, so it has to be re-acquired on
//     visibilitychange rather than requested once;
//   - it needs a secure context, so it works over the HTTPS tunnel or a real cert but not over
//     plain http://<LAN-ip>. There is no reliable fallback -- the old silent-video trick just
//     burns battery -- so where it is unavailable it stays unavailable, silently.
let wakeLock = null;
let wantWake = false;

async function keepAwake() {
  wantWake = true;
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    // Fires on the browser's own release (page hidden), not just ours -- clear the handle so
    // the visibilitychange path below can take a fresh one.
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    wakeLock = null; // unsupported, insecure context, or refused: play on without it
  }
}

function allowSleep() {
  wantWake = false;
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (wantWake) keepAwake();
  // The turn clock is counted down locally between server pushes, and a hidden tab's timers are
  // throttled to roughly one a second at best -- so a phone that was locked, or a tab someone
  // switched away from, comes back showing a countdown that has quietly drifted and will not be
  // corrected until the turn changes. Ask for the real remaining time on the way back in.
  if (lastPlayView) socket.emit('game:resync', {}, () => {});
});

let lastSetupView = null;
function renderSetup(view) {
  keepAwake();
  lastSetupView = view;
  // The tilt handler reads lastPlayView to decide whether a gesture means anything. Leaving a
  // finished game's view lying around made a tilt during the NEXT game's reroll stage look like
  // a live "got it" -- so every screen that is not the playing screen clears it.
  lastPlayView = null;
  // Only shown where the browser cannot hold the screen on, since then it is the player's job.
  // Said here rather than at the reveal: this is the last screen anyone is still looking at.
  $('wakeNote').textContent = 'wakeLock' in navigator ? '' : "Your phone may lock mid-game — set auto-lock to Never first.";
  $('rerollNote').textContent = ''; // a note about the last reroll must not outlive this render
  $('soundCheckNote').textContent = ''; // nor the result of the last sound test
  renderSoundCheck();
  const picking = view.checkerPicks;
  const target = escapeHtml(view.checking.ownerName);
  $('checkOwner').textContent = `${view.checking.ownerName}'s character`;
  // An empty seat holds the same box a character would, so nothing jumps when the pick lands.
  $('checkCard').innerHTML = view.checking.character
    ? charCardHtml(view.checking.character)
    : `<div class="charcard"><div class="charname" style="color:var(--muted)">Not picked yet</div><div class="charsrc"></div><div class="noimg">Search below, or pick at random</div></div>`;
  $('rerollBtn').style.display = view.rerollAllowed ? '' : 'none';
  // With rerolls off the host picked these, and "is it fair? Reroll if…" would ask the player to
  // judge something they can no longer change.
  $('checkHint').innerHTML = picking
    ? `You choose who <b>${target}</b> is. <br>Pick someone they'd know — they have to guess it.`
    : view.rerollAllowed
      ? 'Check this character — is it fair? <br>Reroll if nobody in the room would know them.'
      : "The host picked everyone's characters. <br>Have a look — you'll be giving clues about this one.";
  $('pickBox').style.display = picking && !view.confirmed ? '' : 'none';
  $('pickSearch').setAttribute('aria-label', `Character for ${view.checking.ownerName}`);
  $('rerollBtn').textContent = picking ? (view.checking.character ? 'Pick at Random Instead' : 'Pick at Random') : 'Reroll';
  $('rerollBtn').disabled = view.confirmed; // rerolls are unlimited, so only lock it once confirmed
  // Undo only appears once there is something to take back, so it never sits there dead.
  $('undoBtn').style.display = view.rerollAllowed && view.canUndo ? '' : 'none';
  $('undoBtn').textContent = picking ? 'Undo Last Change' : 'Undo Last Reroll';
  $('undoBtn').disabled = view.confirmed;

  const ref = $('refList');
  ref.innerHTML = '';
  view.reference.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = `seat tint${i % 4}`;
    li.innerHTML =
      `<span class="owner">${escapeHtml(r.ownerName)}</span>` +
      (r.character
        ? `<span style="flex:1"><span class="name">${escapeHtml(r.character.name)}</span>` +
          (r.character.source ? `<br><span class="you">${escapeHtml(r.character.source)}</span>` : '')
        : `<span style="flex:1"><span class="you">Still being picked…</span>`) +
      `</span>`;
    ref.appendChild(li);
  });

  // Tilt is the only control surface once a phone is on a forehead, so "ready" has to mean the
  // sensor is live. Until it is, this gate stands where Good to go would be.
  const needsMotion = !motionEnabled && !view.confirmed;
  $('motionGate').style.display = needsMotion ? '' : 'none';
  if (needsMotion) {
    const problem = motionProblem();
    // Good to go is hidden for every one of these, so name that here rather than inside
    // motionProblem() -- the same text is the whole mid-game fallback screen, which has no
    // Good to go button to explain the absence of.
    $('motionGateWhy').textContent = `${problem.text} Until tilt is on, "Good to go" stays hidden.`;
    // A missing sensor or an http:// link has nothing to tap -- the button would only fail.
    const canRetry = problem.fix === 'ask' || problem.fix === 'settings';
    $('motionGateBtn').style.display = canRetry ? '' : 'none';
    $('motionGateBtn').textContent = problem.fix === 'settings' ? 'I Turned It On — Try Again' : 'Turn On Tilt to Lock In';
  }

  // Only the host can call off a deal; anyone can leave.
  $('setupCancelBtn').style.display = amHost() ? '' : 'none';
  $('goodBtn').style.display = view.confirmed || needsMotion ? 'none' : '';
  // The server refuses an empty seat too; this just says so before anyone taps.
  $('goodBtn').disabled = view.canConfirm === false;
  $('unlockBtn').style.display = view.confirmed ? '' : 'none';
  $('waitingNote').textContent = view.confirmed
    ? (view.allReady ? 'Everyone is in!' : `Locked in — waiting on ${view.waitingOn} more.`)
    : view.canConfirm === false ? `Pick a character for ${view.checking.ownerName} to lock in.` : '';
  renderWaitingList(view);
  show('setup');
}

// Everyone still to lock in, named. The host also gets a way to remove them: readiness is
// mandatory now, so one player who cannot enable motion would otherwise hold the whole room
// indefinitely, and re-dealing walks into the same wall.
function renderWaitingList(view) {
  const ul = $('waitingList');
  ul.innerHTML = '';
  const waiting = (view.waitingPlayers ?? []).filter((p) => p.playerId !== playerId);
  // Only worth showing once you are waiting on someone else -- before that it is just a list of
  // people who are doing nothing wrong.
  if (!waiting.length || !(view.confirmed || amHost())) return;
  for (const p of waiting) {
    const li = document.createElement('li');
    li.className = 'seat';
    const name = document.createElement('span');
    name.className = 'name';
    name.style.flex = '1';
    name.textContent = p.name;
    li.append(name);
    if (amHost()) li.append(removeButton(p));
    ul.appendChild(li);
  }
}

// Host-only. Readiness is mandatory, so without this one stuck player holds the room forever.
function removeButton(p) {
  const b = document.createElement('button');
  b.className = 'rmbtn';
  b.textContent = 'Remove';
  b.addEventListener('click', () => {
    if (!confirm(`Remove ${p.name} from the room? Everyone goes back to the lobby and you deal again.`)) return;
    b.disabled = true;
    socket.emit('room:kick', { playerId: p.playerId }, (res) => {
      b.disabled = false;
      if (!res?.ok) alert(res?.error || 'Could not remove them.');
    });
  });
  return b;
}

// --- the host who sits out (host-picks mode) --------------------------------------------------
//
// Watch-only, by design: the host sees every character, who is locked in, whose turn it is and
// the clock, but resolves nothing -- players answer with their own tilt. Only this phone ever
// gets these views; the server sends them to the sitting-out host alone.
function renderHost(view) {
  keepAwake(); // the one phone in the room nobody is wearing, and the one someone is reading
  clearInterval(countdown);
  clearInterval(turnTicker);
  const banner = $('hostBanner');
  $('hostCancelBtn').style.display = view.phase === 'playing' ? 'none' : '';

  if (view.phase === 'setup') {
    banner.innerHTML = view.allReady
      ? '<b>Everyone is in!</b>'
      : `<b>Waiting on ${view.waitingOn}</b> to check their character and lock in`;
    renderHostList(view.players.map((p) => ({
      ...p,
      icon: p.confirmed ? '✓' : '·',
      meta: p.confirmed ? 'locked in' : 'still checking',
      removable: !p.confirmed,
    })));
  } else if (view.phase === 'countdown') {
    let n = view.seconds;
    const paint = () => { banner.innerHTML = `<b>Starting in ${n}</b> — phones up to foreheads`; };
    paint();
    countdown = setInterval(() => {
      n = Math.max(0, n - 1);
      paint();
      if (!n) clearInterval(countdown);
    }, 1000);
    // The list stays as the setup phase left it: everyone is locked in and nothing else changed.
  } else if (view.phase === 'playing') {
    let remaining = view.turnRemaining;
    const name = escapeHtml(view.current.name);
    const paint = () => {
      banner.innerHTML = view.paused
        ? `Waiting for <b>${name}</b> to reconnect…`
        : `<b>${name}</b> is guessing — turn ${view.current.turnNumber}${remaining != null ? ` · ${remaining}s` : ''}`;
    };
    paint();
    if (!view.paused && remaining != null) {
      turnTicker = setInterval(() => {
        remaining = Math.max(0, remaining - 1);
        paint();
        if (!remaining) clearInterval(turnTicker);
      }, 1000);
    }
    const plural = (n) => `${n} turn${n === 1 ? '' : 's'}`;
    renderHostList(view.players.map((p) => ({
      ...p,
      icon: STATUS_ICON[p.status] || '•',
      meta: p.status === 'finished' ? `got it in ${plural(p.turns)}${p.secondsLeft == null ? '' : `, ${p.secondsLeft}s left`}`
        : p.status === 'gave_up' ? 'gave up'
          : p.status === 'guessing' ? 'guessing now'
            : p.turns ? `${plural(p.turns)} so far` : 'waiting for a first turn',
    })));
  }
  show('hosting');
}

function renderHostList(rows) {
  const ul = $('hostList');
  ul.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = 'seat';
    const ch = r.character;
    // Three short lines rather than "name — status" on one: with a thumbnail on the left and a
    // Remove button on the right the text column is narrow, and the status wrapped mid-phrase.
    li.innerHTML =
      `<span style="font-weight:900;min-width:1.1em;text-align:center">${escapeHtml(r.icon)}</span>` +
      (ch?.imageUrl ? `<img class="pickthumb" src="${escapeHtml(ch.imageUrl)}" alt="">` : '') +
      `<span style="flex:1;min-width:0"><span class="name">${escapeHtml(r.name)}</span><br>` +
      `<span style="font-weight:700">${escapeHtml(ch?.name ?? '—')}</span><br>` +
      `<span class="you">${escapeHtml(r.meta)}</span></span>`;
    if (r.removable) li.append(removeButton(r));
    ul.appendChild(li);
  }
  retilt($('hosting'));
}

// --- playing ------------------------------------------------------------------------------
let countdown = null;          // local 1s ticker
let lastPlayView = null;

const STATUS_ICON = { finished: '✓', guessing: '▶', waiting: '·', gave_up: '✗' };

function renderStandings(el, rows) {
  el.innerHTML = '';
  for (const s of rows) {
    const li = document.createElement('li');
    li.className = 'seat';
    const tail = s.status === 'finished' ? ` — turn ${s.turns}${s.secondsLeft == null ? '' : `, ${s.secondsLeft}s left`}`
      : s.status === 'guessing' ? ` — turn ${s.turns} (guessing)`
      : s.status === 'gave_up' ? ' — gave up' : ' — waiting';
    li.innerHTML = `<span>${STATUS_ICON[s.status] || '•'}</span><span class="name">${escapeHtml(s.name)}</span><span class="you">${tail}</span>`;
    el.appendChild(li);
  }
}

function bannerText(view, remaining) {
  const t = remaining == null ? '' : ` · ${remaining}s`;
  return view.isMyTurn
    ? `<b>Your turn</b> — turn ${view.current.turnNumber}${t}`
    : `<b>${escapeHtml(view.current.name)}</b> is guessing — turn ${view.current.turnNumber}${t}`;
}

function renderPlaying(view) {
  keepAwake();
  lastPlayView = view;
  // You've got yours: drop out of forehead mode into a "you got it" screen with your reveal.
  if (view.me?.finished) { hideForehead(); return renderFinished(view); }
  // With motion we play the real thing: full-screen forehead card + tilt to answer.
  if (motionEnabled) return renderForehead(view);

  // Without it there is no honest fallback. On-screen Got it / Pass buttons LOOKED like one and
  // were not: pressing them means holding the phone where you can see it, and the phone is
  // showing your own character -- so they mean either cheating or tapping blind. They also made
  // a broken setup look like a working one, and a whole game was played around someone who
  // could not actually answer. So this screen says what is wrong and how to fix it, and offers
  // nothing else. The turn clock keeps running, so play passes them by rather than stalling.
  hideForehead();
  $('motionBanner').innerHTML = '';
  const problem = motionProblem();
  // The banner is left to startTurnTicker below -- whose turn it is and how long is left still
  // matters to someone who cannot answer, and setting it here would only be overwritten.
  $('playArea').innerHTML = `<p class="hint center">${escapeHtml(problem.text)}</p><div id="turnBtns"></div>`;
  const btns = $('playArea').querySelector('#turnBtns');
  if (problem.fix === 'ask' || problem.fix === 'settings') {
    // Same shape as the setup gate's button, naming what tilt unlocks HERE: mid-game there is
    // nothing left to lock in, there is a turn to answer.
    addBtn(btns, problem.fix === 'settings' ? 'I Turned It On — Try Again' : 'Turn On Tilt to Answer', 'alt',
      () => enableMotion().then(() => lastPlayView && renderPlaying(lastPlayView)));
  }
  renderStandings($('standings'), view.standings);
  startTurnTicker(view);
  show('playing');
}

// Turn cues.
//
// The problem these solve: the player whose turn it is has their phone on their forehead. They
// cannot see the screen, and at a party half the phones are on silent -- so a single chime at
// the start of a turn leaves everyone guessing whether a turn has begun, how long is left, or
// whether it has ended. Three channels now carry it, so losing any one of them still leaves two:
//
//   sound   a start chime, a quiet two-chord bed under the whole turn (see startBed -- it is
//           also how the room knows whose head to look at), a double knock at halfway, firmer
//           ticks over a faster bed for the last ten, and a descending alarm when time runs out
//   sight   the clock bar on the forehead card, which the ROOM is looking at even though the
//           wearer is not -- amber at halfway, red and flashing at the end
//   touch   a buzz at start, at halfway and at time-up (Android; iOS Safari has no vibrate)
//
// Only the current player's phone ticks. Six phones ticking out of sync would be a nightmare,
// and everyone else can see the bar on the wearer's forehead anyway.
const CRIT_SECONDS = 10;

function paintTurnClock(view, remaining) {
  const bar = $('foreheadTimeBar');
  const fh = $('forehead');
  const total = view.turnSeconds || 0;
  if (!bar) return;
  const live = view.isMyTurn && !view.paused && remaining != null && total > 0;
  bar.style.display = live ? 'block' : 'none';
  fh.classList.toggle('warn', live && remaining <= total / 2 && remaining > CRIT_SECONDS);
  fh.classList.toggle('crit', live && remaining <= CRIT_SECONDS);
  if (live) bar.firstElementChild.style.width = `${Math.max(0, (remaining / total) * 100)}%`;
}

function turnCue(view, remaining) {
  if (!view.isMyTurn || view.paused || remaining == null) return;
  const total = view.turnSeconds || 0;
  const half = Math.floor(total / 2);
  if (remaining === 0) {
    // Time up: unmistakable, and distinct from every other cue in the game.
    tone(440, 220, { gain: 0.55, type: 'square' });
    setTimeout(() => tone(330, 260, { gain: 0.55, type: 'square' }), 200);
    setTimeout(() => tone(220, 420, { gain: 0.55, type: 'square' }), 440);
    navigator.vibrate?.([300, 100, 300]);
  } else if (total && remaining === half) {
    tone(660, 110, { gain: 0.32 });
    setTimeout(() => tone(660, 110, { gain: 0.32 }), 150);
    navigator.vibrate?.([80, 60, 80]);
  } else if (remaining <= CRIT_SECONDS) {
    tone(900, 70, { gain: 0.3 }); // urgent, and it now lands over a bed that has sped up too
  }
  // No per-second tick above ten: the bed carries that stretch. The tick it replaces was a 22ms
  // blip at 0.07 gain -- "felt more than heard" was accurate, and across a loud room it was
  // neither.
}

// The turn clock ticks locally each second and is re-synced on every server state push (so it
// never trusts cross-device wall clocks).
let turnTicker = null;
function startTurnTicker(view) {
  clearInterval(turnTicker);
  let remaining = view.turnRemaining;
  const pausedMsg = `Waiting for ${escapeHtml(view.current.name)} to reconnect…`;
  const paint = () => {
    if (motionEnabled && $('forehead').classList.contains('active')) {
      // The last player has nobody to pass to, so down = give up (held long). Say so.
      const downHint = view.buttons?.pass ? 'tilt up = got it' : 'up = got it · hold down = give up';
      // The out-of-contention note has to be painted HERE, inside the ticker, or the next
      // second's repaint wipes it. It was rendered only by the old tap fallback, so deleting
      // that fallback silently took it away: a player who could no longer win was never told,
      // and from their side the game just quietly stopped mattering.
      const ooc = view.isMyTurn && view.outOfContentionNote
        ? `<div class="ooc">${escapeHtml(view.outOfContentionNote)}</div>` : '';
      $('foreheadTurn').innerHTML = (view.paused ? pausedMsg
        : view.isMyTurn ? `YOUR TURN${remaining != null ? ` · ${remaining}s` : ''} — ${downHint}`
        : `${escapeHtml(view.current.name)}'s turn${remaining != null ? ` · ${remaining}s` : ''}`) + ooc;
    } else {
      $('turnBanner').innerHTML = view.paused ? pausedMsg : bannerText(view, remaining);
    }
    paintTurnClock(view, remaining);
    // In paint() rather than turnCue(): this has to run on the first render of a turn as well as
    // on every later second, or the bed would not start until a second in.
    updateBed(view, remaining);
  };
  paint();
  if (view.paused || remaining == null) return; // frozen while the current player is away
  turnTicker = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    paint();
    turnCue(view, remaining);
    if (remaining === 0) clearInterval(turnTicker);
  }, 1000);
}

// The screen a player sees once they've got their character: their reveal, turn count, and the
// live standings while everyone else plays on.
function renderFinished(view) {
  clearInterval(turnTicker);
  stopBed(); // their turn is over even though the game isn't
  renderMotionPrompt($('motionBanner'));
  const ch = view.me.character;
  $('turnBanner').innerHTML = `<b>You got it in ${view.me.turns} turn${view.me.turns === 1 ? '' : 's'}!</b>`;
  $('playArea').innerHTML =
    (ch ? charCardHtml(ch) : '') +
    `<p class="hint center">That's you${ch ? ` — <b>${escapeHtml(ch.name)}</b>` : ''}. Sit tight while the others finish.</p>`;
  renderStandings($('standings'), view.standings);
  show('playing');
}

function logReveal(html) {
  const log = $('revealLog');
  const div = document.createElement('div');
  div.className = 'card';
  div.style.marginTop = '10px';
  div.innerHTML = html;
  log.prepend(div);
  while (log.children.length > 4) log.lastChild.remove();
  retilt($('playing'));
}

function renderOver(result) {
  allowSleep();
  lastPlayView = null;
  clearInterval(countdown);
  clearInterval(turnTicker);
  stopBed();
  hideForehead();
  const names = result.winners.map((w) => w.name);
  const turnsText = (n) => `${n} turn${n === 1 ? '' : 's'}`;
  const leftText = (secs) => (secs == null ? '' : ` with ${secs}s left`);
  const w0 = result.winners[0];
  wobble($('overEmoji'), result.winners.length > 1 ? 'TIE!' : result.winners.length ? 'WINNER!' : 'GAME OVER');
  // "Wins on time" when somebody matched the winner's turns and lost only on the clock -- said
  // outright, or a player who also got it in one is simply told they lost.
  $('overResult').innerHTML = result.winners.length > 1
    ? `It's a tie — ${names.map(escapeHtml).join(' & ')} both got it in ${turnsText(result.bestTurnCount)}${leftText(w0.secondsLeft)}!`
    : !result.winners.length
      ? 'Nobody got their character.'
      : result.wonOnTime
        ? `${escapeHtml(names[0])} wins on time — got it in ${turnsText(result.bestTurnCount)}${leftText(w0.secondsLeft)}!`
        : `${escapeHtml(names[0])} wins — got it in ${turnsText(result.bestTurnCount)}!`;
  const ul = $('finalStandings');
  ul.innerHTML = '';
  for (const s of result.standings) {
    const li = document.createElement('li');
    li.className = 'seat';
    // `place` comes from the server (Game.standings): turns first, then time left, with level
    // players sharing a place. Re-deriving it here from turns alone is how this screen and the
    // Discord reveal could have ranked one game two different ways.
    let place;
    if (s.turns === null) place = s.outcome === 'gave_up' ? 'gave up' : 'did not finish';
    else place = `#${s.place} — ${turnsText(s.turns)}${s.secondsLeft == null ? '' : ` · ${s.secondsLeft}s left`}`;
    const ch = s.character;
    const thumb = ch && ch.imageUrl
      ? `<img src="${escapeHtml(ch.imageUrl)}" alt="" style="width:44px;height:44px;object-fit:cover;object-position:50% 20%;border-radius:9px;flex:none">`
      : '';
    // Podium colouring for the top three finishers; everyone else is a plain row.
    const rank = s.place ?? 0;
    if (rank >= 1 && rank <= 3) li.classList.add(`rank${rank}`);
    li.style.alignItems = 'center';
    li.innerHTML = `${rank ? `<span style="font-weight:900;font-size:1.2rem;min-width:1.4em">${rank}</span>` : ''}${thumb}`
      + `<span style="flex:1"><span class="name">${escapeHtml(s.name)}</span>`
      + `<span class="you"> ${place}</span><br><span class="you">was ${ch ? escapeHtml(ch.name) : '—'}</span></span>`;
    ul.appendChild(li);
  }
  const host = amHost();
  // Repeat the code here: if someone left, the fix is to get a replacement in, and the code
  // is otherwise only on the lobby screen which nobody is looking at any more.
  $('overCode').textContent = lastState ? `Room code ${lastState.code} — anyone can still join` : '';
  $('overErr').textContent = '';
  $('rematchBtn').style.display = host ? '' : 'none';
  $('changeBtn').style.display = host ? '' : 'none';
  // A hand-picked game can't be re-dealt "with the same settings": the picks aren't kept, and
  // the same characters again would be no game. So the button takes the host back to the
  // picker instead -- and the old picks are forgotten, because by now everyone has seen them.
  lastOverHostPicked = !!result.hostPicked;
  if (result.hostPicked) hostPicks.clear();
  $('rematchBtn').textContent = result.hostPicked ? 'Pick Characters Again' : 'Rematch (Same Settings)';
  // a little win sting
  beep(880, 160); setTimeout(() => beep(1320, 260), 170);
  show('over');
}

function addBtn(parent, label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls === 'good' ? 'good' : cls;
  b.style.marginTop = '8px';
  b.innerHTML = label;
  b.addEventListener('click', onClick);
  parent.appendChild(b);
}

// --- motion / tilt / forehead mode --------------------------------------------------------
let motionEnabled = false;
let motionDenied = false;
let motionNote = '';
let audioCtx = null;
const hasMotion = 'DeviceMotionEvent' in window;
const hasOrient = 'DeviceOrientationEvent' in window;
const motionSupported = hasMotion || hasOrient;

// Live sensor readings. `z` is gravity along the axis perpendicular to the screen (m/s^2), in
// tilt.js's convention: ~0 when the phone is held vertically on a forehead, toward -9.8 as it
// tilts to face the ceiling and +9.8 toward the floor. That axis is what "tilt up/down" changes
// whether the phone is portrait or landscape.
//
// Two sources, and the order matters. deviceorientation's angles mean the same thing on every
// platform, so once they arrive they are the only source (`fromAngles`). devicemotion's raw z is
// kept as a fallback for phones that never send angles -- typically Androids without a gyroscope
// -- but its SIGN differs between browsers, which is the bug that swapped "got it" and "pass" for
// some Android players. See motionFaceUpSign for how the fallback finds out which way is up.
const sensor = { z: 0, have: false, fromAngles: false, rawZ: null, beta: null, gamma: null };

// Which sign this phone's raw devicemotion z takes when the screen faces up: +1 or -1.
//
// Learnt, not assumed: whenever somebody TAPS the screen, it is facing them and therefore the
// ceiling -- nobody taps a phone that faces the floor. Each tap with a clear reading casts a vote
// (clamped, so a few odd taps -- someone lying on a sofa holding it overhead -- can be outvoted
// later rather than locking in). Before any vote, the platform's usual convention is the guess:
// iPhone Safari reads face-up as negative, the spec and Chrome on Android as positive.
const RAW_VOTE_MIN = 3;   // |z| below this is too close to upright to say which way it faces
const RAW_VOTE_CAP = 5;
const RAW_VOTE_TRUST = 2; // net taps before the votes overrule the guess; one odd tap is not enough
let rawFaceUpVotes = 0;
const rawPlatformGuess = typeof DeviceMotionEvent?.requestPermission === 'function' ? -1 : 1;
const motionFaceUpSign = () =>
  Math.abs(rawFaceUpVotes) >= RAW_VOTE_TRUST ? Math.sign(rawFaceUpVotes) : rawPlatformGuess;
document.addEventListener('pointerdown', () => {
  if (sensor.fromAngles || sensor.rawZ == null || Math.abs(sensor.rawZ) < RAW_VOTE_MIN) return;
  rawFaceUpVotes = Math.max(-RAW_VOTE_CAP, Math.min(RAW_VOTE_CAP, rawFaceUpVotes + Math.sign(sensor.rawZ)));
}, { capture: true, passive: true });
// The thresholds, the hold times and the gesture state machine live in tilt.js, which is pure
// and unit-tested (test/tilt-rules.test.js). Every number in it was tuned against a bug somebody
// hit at a party, and it is the code that can irreversibly publish the character you are wearing.
//
// `armed` starts FALSE every turn and only becomes true once the phone has actually been seen
// upright. That is the whole safety property: a phone that never reaches a sane orientation never
// fires a gesture, instead of firing one instantly.
const tilt = TiltRules.newState();
const isUpright = () => TiltRules.isUpright(sensor.have ? sensor.z : null);

// The forehead card is WITHHELD until the phone has been seen upright at least once.
//
// Forehead mode assumes the wearer cannot see the screen -- the phone carries their OWN
// character for the room to read. That is true the moment it is on a forehead and false at
// exactly one moment: just after they tapped something. The countdown covers the start of a
// game; nothing covered coming back mid-game. Tilt is off on every fresh page load, so a
// player whose phone locked and whose tab iOS then discarded taps "Turn on tilt to answer"
// and was handed their own character while staring straight at it.
//
// Latching, not live: |z| passes NEUTRAL_MAX during the answer tilt itself, and a card that
// vanished mid-gesture would take it away from the room that is reading it.
//
// Only latches while the overlay is up, which is the whole reason this is not simply checked
// wherever the sensor is read: a phone held vertically to read the setup screen is "upright"
// too, so a latch that ran everywhere would already be set by the time it mattered. That same
// limit applies within the wait -- someone holding the phone bolt upright in front of their
// face satisfies it -- but a reading angle does not, which is the position this protects.
let foreheadHeld = false;
let foreheadHoldTimer = null;
// Safety net, not the mechanism: a sensor that never reports upright -- held at an angle, or
// events that never arrive despite permission -- must not cost the player their whole turn.
const FOREHEAD_HOLD_MS = 6000;

function revealForehead() {
  if (foreheadHeld) return;
  foreheadHeld = true;
  clearTimeout(foreheadHoldTimer);
  foreheadHoldTimer = null;
  // Through renderPlaying, not renderForehead: it owns the finished/motion routing, and a
  // reveal that arrives just as the turn ends must not paint a card over the wrong screen.
  if (lastPlayView) renderPlaying(lastPlayView);
}

function resetForeheadHold() {
  foreheadHeld = false;
  clearTimeout(foreheadHoldTimer);
  foreheadHoldTimer = null;
}

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
  const live = view.isMyTurn && !view.paused && remaining != null && remaining > 0;
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

async function enableMotion() {
  if (!motionSupported) { motionNote = 'This device has no motion sensors.'; return; }
  ensureAudio();
  try {
    if (typeof DeviceMotionEvent?.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') {
        // iOS only ever prompts once. After a refusal the fix is in Settings, not another tap.
        motionDenied = true;
        motionNote = 'Motion access was refused.';
        if (lastPlayView) renderPlaying(lastPlayView);
        return;
      }
    }
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') { try { await DeviceOrientationEvent.requestPermission(); } catch {} }
    window.addEventListener('devicemotion', onMotion);
    window.addEventListener('deviceorientation', onOrient);
    motionEnabled = true;
    motionNote = '';
    if (lastPlayView) renderPlaying(lastPlayView);
  } catch {
    motionNote = 'Could not start motion.';
  }
}

// Why tilt is not available, phrased as something the player can act on. Each of these has a
// different fix, and telling someone "motion blocked" when the real problem is that they opened
// an http:// link sends them hunting through Settings for nothing.
function motionProblem() {
  if (!window.isSecureContext) {
    return { fix: 'link', text: 'This page was opened over an insecure link, and phones only allow motion sensors on https. Ask the host to share the link again, or scan the QR code in the lobby.' };
  }
  if (!motionSupported) {
    return { fix: 'device', text: 'This device has no motion sensor. The game is played with a phone on your forehead, so join from a phone instead.' };
  }
  if (motionDenied) {
    return { fix: 'settings', text: 'Motion access was refused, and iOS will not ask a second time. Open Settings, then Safari, then Motion & Orientation Access, turn it on, and reload this page.' };
  }
  // Screen-agnostic on purpose: this text renders on the setup gate AND mid-game, so anything
  // naming a control ("Good to go") is wrong on one of them. The gate adds its own line instead.
  return { fix: 'ask', text: 'Tilting the phone is how you answer once it is on your forehead. Tap below and allow motion access.' };
}

// Turn tilt on wherever it costs the player nothing.
//
// Platforms with no permission prompt (Android, desktop) are switched on here, silently, so
// nobody is asked to tap a button for something that needed no asking.
//
// iOS is deliberately NOT primed. It prompts once per origin and never again, and this runs on
// the "Create a room" tap -- before a single word has explained why a party game wants the
// accelerometer. A reasonable person taps "Don't Allow", and since tilt became mandatory that
// now means they cannot play at all, with the only fix buried in Settings. So the ask is
// deferred to the gate on the setup screen, where the reason is on screen beside the button.
function primeMotion() {
  if (!motionSupported || motionEnabled) return;
  if (typeof DeviceMotionEvent?.requestPermission === 'function') return; // asked at the gate
  enableMotion();
}

function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.z == null) return;
  sensor.rawZ = g.z;
  if (sensor.fromAngles) return; // the angles are the source of truth once they have arrived
  // tilt.js wants face-up NEGATIVE; a phone whose raw face-up reading is positive gets negated.
  takeReading(motionFaceUpSign() > 0 ? -g.z : g.z);
}
function onOrient(e) {
  // Some Androids fire this with nulls when they have no gyroscope; leave the fallback in charge.
  if (e.beta == null || e.gamma == null) return;
  sensor.beta = e.beta; sensor.gamma = e.gamma; sensor.fromAngles = true;
  takeReading(TiltRules.zFromAngles(e.beta, e.gamma));
}
function takeReading(z) {
  sensor.z = z; sensor.have = true;
  // Before handleGameTilt: the same reading that arms a gesture is the one that reveals the
  // card, and the room should have it in front of them before an answer can fire.
  if (!foreheadHeld && $('forehead').classList.contains('active') && isUpright()) revealForehead();
  handleGameTilt();
  updateTiltTest();
}

const currentGesture = () => TiltRules.gestureFor(sensor.have ? sensor.z : null);

// Tilting down gives up only when there is nobody to pass to -- otherwise down means pass. Read
// off the buttons the server sent, so the gesture and the rules agree by construction.
const canGiveUpByTilt = (v) => !!v.buttons && !v.buttons.pass && !!v.buttons.giveUp;

// Visible feedback for the hold. The wearer may not be looking, but the room is -- and if they
// lowered the phone to give up, they are looking too. Either way it beats silent audio-only ticks.
function showGiveUpProgress(fraction) {
  const el = $('foreheadGiveUpBar');
  if (!el) return;
  if (fraction <= 0) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.firstElementChild.style.width = `${Math.round(fraction * 100)}%`;
}

// Everything below is effects: the decisions all live in TiltRules.step (public/tilt.js), which
// is pure and unit-tested. This reads the sensor, hands it over, and does what it is told.
function handleGameTilt() {
  const v = lastPlayView;
  if (!motionEnabled || !v || v.phase !== 'playing' || !v.isMyTurn) {
    TiltRules.reset(tilt);
    showGiveUpProgress(0);
    return;
  }

  const out = TiltRules.step(tilt, {
    z: sensor.have ? sensor.z : null,
    now: Date.now(),
    canGiveUp: canGiveUpByTilt(v),
  });

  if (out.giveUpTick) { beep(300, 90); navigator.vibrate?.(45); }
  showGiveUpProgress(out.giveUpFraction);

  if (out.action === 'giveup') {
    navigator.vibrate?.([200, 80, 200]); beep(220, 320);
    socket.emit('game:giveup', {}, () => {});
  } else if (out.action === 'gotit') {
    navigator.vibrate?.(60); beep(1050, 130);
    socket.emit('game:gotit', {}, () => {});
  } else if (out.action === 'pass') {
    navigator.vibrate?.(60); beep(480, 130);
    // Swallowed when there is nobody to pass to; the disarm has happened either way.
    if (v.buttons?.pass) socket.emit('game:pass', {}, () => {});
  }
}

let foreheadMyTurn = false;
function renderForehead(view) {
  const el = $('forehead');
  el.classList.add('active');
  el.classList.toggle('mine', view.isMyTurn);
  $('foreheadCount').style.display = 'none'; // countdown is over; show the character
  // The TOP guide belongs to positioning, so it stays up exactly as long as the card is withheld.
  $('foreheadTop').style.display = foreheadHeld ? 'none' : '';
  $('foreheadLeave').style.display = '';     // the only way out while the overlay covers everything
  const ch = view.myCharacter;
  const img = $('foreheadImg'), noimg = $('foreheadNoImg');
  if (!foreheadHeld) {
    // Not seen upright yet, so whoever is reading this is holding the phone in front of their
    // face -- say what to do with it instead of handing them their own character.
    if (!foreheadHoldTimer) foreheadHoldTimer = setTimeout(revealForehead, FOREHEAD_HOLD_MS);
    img.style.display = 'none'; noimg.style.display = 'block';
    noimg.textContent = 'Phone on your forehead';
    $('foreheadName').textContent = 'Hold sideways with ▲ TOP up, then on your forehead';
  } else if (ch && ch.imageUrl) {
    // Has art: full-screen image, name + source along the bottom for the room to read.
    img.src = ch.imageUrl; img.style.display = 'block'; noimg.style.display = 'none';
    img.onerror = () => { img.style.display = 'none'; noimg.style.display = 'block'; noimg.textContent = ch.name; };
    $('foreheadName').textContent = ch.source ? `${ch.name} · ${ch.source}` : ch.name;
  } else {
    // No art: the NAME is the whole card -- big and centered (not a small line at the bottom).
    img.style.display = 'none'; noimg.style.display = 'block'; noimg.textContent = ch ? ch.name : '…';
    $('foreheadName').textContent = ch && ch.source ? ch.source : '';
  }
  startTurnTicker(view); // paints the turn banner and keeps its countdown ticking
  updateForeheadDebug();
  // My turn just started: reset the tilt baseline, buzz, and chime so I know without looking.
  if (view.isMyTurn && !foreheadMyTurn) {
    // Disarmed until the phone is seen upright, so a turn that starts with the phone flat on a
    // table can't instantly fire a gesture.
    tilt.armed = false; TiltRules.reset(tilt); showGiveUpProgress(0);
    navigator.vibrate?.([140, 60, 140]);
    beep(880, 200); setTimeout(() => beep(1250, 220), 150);
  }
  foreheadMyTurn = view.isMyTurn;
  show('playing');
}

function updateForeheadDebug() {
  const el = $('foreheadDebug');
  if (!el) return;
  el.textContent = foreheadMyTurn && sensor.have
    ? `z ${sensor.z.toFixed(1)}${tilt.armed ? '' : ' · hold phone upright'}`
    : '';
}

function hideForehead() { $('forehead').classList.remove('active'); foreheadMyTurn = false; resetForeheadHold(); }

// A one-line note about the sensor itself (refused, missing, failed to start), for screens that
// have room for an aside rather than a whole explanation. The screens where tilt is actually
// REQUIRED -- the setup gate and the play screen -- use motionProblem() instead, which names the
// fix, because "motion blocked" is useless to someone whose real problem is an http:// link.
function renderMotionPrompt(container) {
  container.innerHTML = motionNote ? `<p class="hint center">${escapeHtml(motionNote)}</p>` : '';
}

function startCountdown(seconds) {
  keepAwake();
  lastPlayView = null; // the reveal has not happened yet; no gesture should resolve anything
  // Every round re-earns the reveal: the phone comes down between games. Latching here rather
  // than at play time is what keeps the gate invisible in the normal flow -- the countdown is
  // spent raising the phone, so by the time the card is due it has already been seen upright.
  resetForeheadHold();
  clearInterval(countdown);
  let n = Math.max(0, seconds);
  // With motion on, run the countdown INSIDE the landscape forehead frame so players orient the
  // phone (▲ TOP up) and see the number the right way round before their character replaces it.
  const inForehead = motionEnabled;
  if (inForehead) {
    const el = $('forehead');
    el.classList.remove('mine');
    el.classList.add('active');
    $('foreheadImg').style.display = 'none';
    $('foreheadNoImg').style.display = 'none';
    $('foreheadCount').style.display = 'flex';
    $('foreheadTop').style.display = ''; // show the TOP guide only while positioning the phone
    $('foreheadLeave').style.display = 'none'; // nothing to leave yet; play hasn't started
    $('foreheadTurn').innerHTML = 'Get ready…';
    $('foreheadName').textContent = 'Hold sideways with ▲ TOP up, then on your forehead';
    $('foreheadDebug').textContent = '';
  } else {
    hideForehead();
    show('countdown');
  }
  const paint = () => {
    const text = n <= 0 ? '0' : String(n);
    // The forehead card stays plain -- it is read across a room, not admired up close.
    if (inForehead) $('foreheadCount').textContent = text;
    else wobble($('countNum'), text);
  };
  paint();
  navigator.vibrate?.(80);
  countdown = setInterval(() => {
    n -= 1;
    paint();
    if (n <= 0) { clearInterval(countdown); return; }
    navigator.vibrate?.(40);
  }, 1000);
}

// --- tilt test / calibration --------------------------------------------------------------
function openTiltTest() { primeMotion(); $('ttEnable').style.display = motionEnabled ? 'none' : ''; updateTiltTest(); show('tilttest'); }
function updateTiltTest() {
  updateForeheadDebug();
  if (!$('tilttest').classList.contains('active')) return;
  const g = currentGesture();
  const res = $('ttResult');
  res.textContent = g === 'gotit' ? 'UP = Got it' : g === 'pass' ? 'DOWN = Pass'
    : sensor.have ? (isUpright() ? 'upright — ready' : 'hold the phone upright') : 'enable motion';
  res.style.color = g === 'gotit' ? 'var(--green)' : g === 'pass' ? 'var(--amber)' : 'var(--ink)';
  $('ttVals').textContent = sensor.have
    ? `z ${sensor.z.toFixed(1)}  ·  upright ${isUpright() ? 'yes' : 'no'}  ·  ` +
      (sensor.fromAngles ? 'from angles' : `from accelerometer, face-up ${motionFaceUpSign() > 0 ? '+' : '−'}`)
    : (motionNote || 'waiting for sensor…');
}

// --- compendium ---------------------------------------------------------------------------
//
// Read-only browsing over plain HTTP, so it never contends with the game socket and the browser
// can cache it. Three depths -- categories, lists, characters -- each ordered the way the game
// orders things, so the top of a page is the part people actually recognise.
const browseState = { view: 'categories', category: null, list: null, offset: 0, loading: false, filter: '' };
let browseLists = []; // the current category's lists, kept client-side so filtering is instant

const PAGE = 60;
async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function browseBusy(on) {
  browseState.loading = on;
  if (on) $('browseBody').innerHTML = '<p class="hint center">Loading…</p>';
}

async function openBrowse({ push = true } = {}) {
  // Mark the entry we are leaving, so backing out of the compendium lands on the app rather
  // than on whatever the tab's history happens to hold below it.
  if (push && !$('browse').classList.contains('active')) {
    try { history.replaceState({ gtcExit: true }, ''); } catch { historyWorks = false; }
  }
  browseState.view = 'categories';
  browseState.category = null;
  browseState.list = null;
  show('browse');
  $('browseFilter').style.display = 'none';
  $('browseMore').style.display = 'none';
  setCrumb(['Everything in the game']);
  if (push) pushBrowseHistory('categories');
  browseBusy(true);
  try {
    const { categories } = await getJson('/api/browse/categories');
    const body = $('browseBody');
    body.innerHTML = '';
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    categories.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = `tile c${i % 4}`;
      b.innerHTML = `${escapeHtml(c.category)}<span class="n">${c.lists} lists · ${c.playable} in play</span>`;
      b.addEventListener('click', () => openCategory(c.category));
      tiles.appendChild(b);
    });
    body.appendChild(tiles);
  } catch (err) {
    $('browseBody').innerHTML = `<p class="hint center">Could not load (${escapeHtml(err.message)}).</p>`;
  } finally {
    browseState.loading = false;
  }
}

async function openCategory(category, { push = true } = {}) {
  // Coming BACK to a category keeps what was typed; arriving at a new one starts clean. Retyping
  // a filter after every look at a list is the kind of friction that stops people browsing.
  if (browseState.category !== category) browseState.filter = '';
  browseState.view = 'lists';
  browseState.category = category;
  setCrumb(['All', category]);
  if (push) pushBrowseHistory('lists', { category });
  $('browseMore').style.display = 'none';
  browseBusy(true);
  try {
    const data = await getJson(`/api/browse/lists?category=${encodeURIComponent(category)}`);
    browseLists = data.lists;
    // A filter box rather than paging: the whole category is already here, and 437 titles is a
    // lot to thumb past when you know the name you want.
    const filter = $('browseFilter');
    filter.style.display = '';
    filter.value = browseState.filter;
    filter.placeholder = `Filter ${browseLists.length} lists…`;
    renderBrowseLists(browseState.filter);
  } catch (err) {
    $('browseBody').innerHTML = `<p class="hint center">Could not load (${escapeHtml(err.message)}).</p>`;
  } finally {
    browseState.loading = false;
  }
}

function renderBrowseLists(query) {
  const q = query.trim().toLowerCase();
  const shown = q ? browseLists.filter((l) => l.name.toLowerCase().includes(q)) : browseLists;
  const body = $('browseBody');
  body.innerHTML = '';
  if (!shown.length) {
    body.innerHTML = '<p class="hint center">Nothing matches.</p>';
    return;
  }
  // Capped rather than virtualised: a few hundred buttons is fine, thousands is not, and the
  // filter is the intended way through a long category.
  for (const l of shown.slice(0, 300)) {
    const b = document.createElement('button');
    b.className = 'rowbtn';
    b.innerHTML =
      `<span style="flex:1">${escapeHtml(l.name)}</span>` +
      (l.playable ? '' : '<span class="off-pool">NOT IN POOL</span>') +
      `<span class="n">${l.characters}</span>`;
    b.addEventListener('click', () => openList(l));
    body.appendChild(b);
  }
  if (shown.length > 300) {
    const p = document.createElement('p');
    p.className = 'hint center';
    p.textContent = `Showing 300 of ${shown.length} — keep typing to narrow it down.`;
    body.appendChild(p);
  }
}

async function openList(list, { push = true } = {}) {
  browseState.view = 'characters';
  browseState.list = list;
  browseState.offset = 0;
  $('browseFilter').style.display = 'none';
  setCrumb(['All', browseState.category, list.name]);
  if (push) pushBrowseHistory('characters', { category: browseState.category, list });
  browseBusy(true); // loadCharacterPage replaces this with the grid
  await loadCharacterPage(true);
}

async function loadCharacterPage(first) {
  const { list, offset } = browseState;
  try {
    const data = await getJson(`/api/browse/characters?listId=${list.id}&limit=${PAGE}&offset=${offset}`);
    const body = $('browseBody');
    if (first) body.innerHTML = '';
    let grid = body.querySelector('.chargrid');
    if (!grid) {
      grid = document.createElement('div');
      grid.className = 'chargrid';
      body.appendChild(grid);
    }
    for (const c of data.characters) {
      const tile = document.createElement('div');
      tile.className = 'chartile';
      // loading="lazy": a 60-tile page would otherwise fire 60 image requests at once, and each
      // miss makes the server fetch upstream. Only what scrolls into view is paid for.
      tile.innerHTML =
        (c.imageUrl
          ? `<img src="${c.imageUrl}" alt="" loading="lazy" decoding="async">`
          : '<div class="noimg">no picture</div>') +
        `<span class="cname">${escapeHtml(c.name)}</span>`;
      grid.appendChild(tile);
    }
    browseState.offset = offset + data.characters.length;
    const more = browseState.offset < data.total;
    $('browseMore').style.display = more ? '' : 'none';
    $('browseMore').textContent = `Load more (${browseState.offset} of ${data.total})`;
    setCrumb(['All', browseState.category,
      `${data.list.name} · ${data.total}${data.list.playable ? '' : ' · not in play'}`]);
  } catch (err) {
    $('browseBody').innerHTML = `<p class="hint center">Could not load (${escapeHtml(err.message)}).</p>`;
  } finally {
    browseState.loading = false;
  }
}

// A breadcrumb where every level above the current one is tappable, so going up two steps does
// not mean pressing Back twice. Taps rewind history instead of pushing, so the phone's own Back
// gesture keeps agreeing with what is on screen.
function setCrumb(parts) {
  const el = $('browseCrumb');
  el.innerHTML = '';
  parts.forEach((label, i) => {
    if (i) el.appendChild(document.createTextNode(' › '));
    const span = document.createElement('span');
    span.textContent = label;
    if (i < parts.length - 1) {
      span.className = 'up';
      span.addEventListener('click', () => (historyWorks
        ? history.go(i - (parts.length - 1))
        : (i === 0 ? openBrowse() : openCategory(browseState.category))));
    }
    el.appendChild(span);
  });
}

// The phone's own Back gesture is what people reach for first, so each depth gets a history
// entry. Guarded on the browse screen being active: a game can pull the player out of browsing
// at any moment, and a stray back-swipe must not then drag them out of the game.
let historyWorks = true;
function pushBrowseHistory(view, extra = {}) {
  try {
    history.pushState({ gtcBrowse: { view, ...extra } }, '');
  } catch {
    // Some embedded webviews refuse pushState. Note it, so Back walks the levels by hand
    // instead of calling history.back() and sailing off the page entirely.
    historyWorks = false;
  }
}

window.addEventListener('popstate', (e) => {
  if (!$('browse').classList.contains('active')) return;
  const st = e.state?.gtcExit ? null : e.state?.gtcBrowse;
  if (!st) return show(currentRoom ? 'lobby' : startScreen);
  if (st.view === 'categories') return openBrowse({ push: false });
  if (st.view === 'lists') return openCategory(st.category, { push: false });
  if (st.view === 'characters') {
    // Restore the category the entry was CREATED in. Reading it from browseState instead meant
    // a back-navigation across two categories drew the right list under the wrong parent.
    browseState.category = st.category ?? browseState.category;
    return openList(st.list, { push: false });
  }
});

function browseBack() {
  if (historyWorks) return history.back();
  if (browseState.view === 'characters') return openCategory(browseState.category);
  if (browseState.view === 'lists') return openBrowse();
  show(currentRoom ? 'lobby' : startScreen);
}

// --- helpers ------------------------------------------------------------------------------
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function readNick() { nickname = $('nickInput').value.trim(); if (nickname) store.set('gtc_nick', nickname); return nickname; }
function enterRoom(state) { currentRoom = { code: state.code }; store.set('gtc_lastRoom', state.code); }

// --- room actions -------------------------------------------------------------------------
function createRoom() {
  const nick = readNick();
  if (!nick) return ($('landingErr').textContent = 'Enter your name first.');
  $('landingErr').textContent = '';
  primeMotion(); // first gesture -> turn tilt on (no separate opt-in)
  socket.emit('room:create', { nickname: nick }, (res) => {
    if (!res?.ok) return ($('landingErr').textContent = res?.error || 'Could not create a room.');
    lastState = res.state; enterRoom(res.state); routeByStatus(res.state);
  });
}
function joinRoom() {
  const nick = readNick();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!nick) return ($('landingErr').textContent = 'Enter your name first.');
  if (code.length !== 4) return ($('landingErr').textContent = 'Room codes are 4 letters.');
  $('landingErr').textContent = '';
  primeMotion(); // first gesture -> turn tilt on (no separate opt-in)
  socket.emit('room:join', { code, nickname: nick }, (res) => {
    if (!res?.ok) return ($('landingErr').textContent = res?.error || 'Could not join.');
    lastState = res.state; enterRoom(res.state); routeByStatus(res.state);
  });
}
function leaveRoom() {
  allowSleep();
  stopBed();
  lastPlayView = null;
  socket.emit('room:leave', {}, () => {});
  currentRoom = null; lastState = null; store.del('gtc_lastRoom'); hideForehead(); show('landing');
  // A join link's ?room=CODE would otherwise put them straight back in on the next reload -- the
  // page resumes whatever room the URL names. history.state is kept: the back-button guard uses it.
  if (new URLSearchParams(location.search).has('room')) {
    try { history.replaceState(history.state, '', location.pathname); } catch { /* sandboxed: harmless */ }
  }
}

// --- routing --------------------------------------------------------------------------------
function routeByStatus(state) {
  if (!state) return;
  if (state.status === 'lobby') { lastPlayView = null; renderLobby(state); show('lobby'); }
  // 'setup' -> setup:state handler; 'playing' -> game:state handler; 'finished' -> game:over.
  // Those carry the per-player payloads, so status alone doesn't switch to them here.
}

// --- socket lifecycle -----------------------------------------------------------------------
socket.on('room:state', (state) => {
  if (!currentRoom || state.code !== currentRoom.code) return;
  lastState = state;
  // Don't yank the host off the config screen just because a roster broadcast arrived.
  const onConfig = $('config').classList.contains('active');
  if (state.status === 'lobby') {
    renderLobby(state);
    if (!onConfig) show('lobby');
    else if (rosterKey() !== pickerRosterKey) renderModeChoices(); // someone joined or left mid-pick
  } else routeByStatus(state);
});

socket.on('setup:state', (view) => renderSetup(view));

socket.on('game:countdown', ({ seconds }) => startCountdown(seconds));
socket.on('game:state', (view) => renderPlaying(view));
socket.on('host:state', (view) => renderHost(view));
socket.on('game:reveal', (r) => {
  beep(r.kind === 'got' ? 760 : 380, 160); // a chime when someone finishes / bows out
  // Seconds left are named at the moment of finishing because that is now the time to beat:
  // anyone who gets theirs in as many turns needs more on the clock to win outright.
  const left = r.secondsLeft == null ? '' : ` with <b>${r.secondsLeft}s</b> left`;
  const html = r.kind === 'got'
    ? `<b>${escapeHtml(r.name)}</b> got it in <b>${r.turns}</b> turn${r.turns === 1 ? '' : 's'}${left} — they were <b>${escapeHtml(r.character.name)}</b>`
    : r.kind === 'gaveup'
      ? `<b>${escapeHtml(r.name)}</b> gave up — they were <b>${escapeHtml(r.character.name)}</b>`
      : `<b>${escapeHtml(r.name)}</b> left — they were <b>${escapeHtml(r.character.name)}</b>`;
  logReveal(html);
});
socket.on('game:timeout', (t) => logReveal(`<b>${escapeHtml(t.name)}</b> ran out of time — turn passes.`));
socket.on('game:over', (result) => renderOver(result));

socket.on('setup:aborted', ({ reason }) => { abortNote = `Setup stopped — ${reason}.`; });

// Being removed has to be said out loud. Otherwise the screen simply stops updating and the
// player assumes the app broke.
socket.on('room:kicked', ({ reason }) => {
  allowSleep();
  lastPlayView = null; lastSetupView = null;
  currentRoom = null; lastState = null;
  store.del('gtc_lastRoom');
  hideForehead();
  show('landing');
  $('landingErr').textContent = reason || 'You were removed from the room.';
});

socket.on('connect', () => {
  // Cleared here rather than after the re-join lands: the socket being up is exactly what the
  // notice was reporting on, and leaving it to the callback meant one Wi-Fi blip left "Reconnecting…"
  // on screen for the rest of the party, long after everything had come back.
  $('connState').textContent = '';
  if (currentRoom && nickname) {
    socket.emit('room:join', { code: currentRoom.code, nickname }, (res) => {
      if (res?.ok) { lastState = res.state; enterRoom(res.state); routeByStatus(res.state); }
      else { currentRoom = null; store.del('gtc_lastRoom'); show('landing'); }
    });
  }
});
socket.on('disconnect', () => { if (currentRoom) $('connState').textContent = 'Reconnecting…'; });

// --- wire up + boot -------------------------------------------------------------------------
$('createBtn').addEventListener('click', createRoom);
$('joinBtn').addEventListener('click', joinRoom);
$('leaveBtn').addEventListener('click', leaveRoom);
$('playLeaveBtn').addEventListener('click', () => { if (confirm('Leave the game? Your character is revealed and you drop out.')) leaveRoom(); });
// The forehead overlay covers everything else at full-screen, including playLeaveBtn above --
// this is the only way out while a phone is actually in forehead mode.
$('foreheadLeave').addEventListener('click', () => { if (confirm('Leave the game? Your character is revealed and you drop out.')) leaveRoom(); });
$('overLeaveBtn').addEventListener('click', leaveRoom);
let lastOverHostPicked = false;
$('rematchBtn').addEventListener('click', () => {
  $('overErr').textContent = '';
  if (lastOverHostPicked) {
    // Back to the lobby first -- setup can only start from there -- which also shows the players
    // "the host is picking characters" while that is exactly what is happening.
    socket.emit('game:again', {}, (res) => {
      if (res?.ok) openConfig({ pick: 'host' });
      else $('overErr').textContent = res?.error || 'Could not go back to picking.';
    });
    return;
  }
  primeMotion();
  $('rematchBtn').disabled = true;
  socket.emit('game:rematch', {}, (res) => {
    $('rematchBtn').disabled = false;
    // The server always says why it refused; discarding that was what made the button look
    // broken when a player had left.
    if (!res?.ok) $('overErr').textContent = res?.error || 'Could not start a rematch.';
  });
});
$('changeBtn').addEventListener('click', () => socket.emit('game:again', {}, () => {}));
// How-to-play is open by default (most people at a party have never played) but the choice is
// remembered, so a group that already knows isn't shown it every round.
const howtoHidden = () => store.get('gtc_howto') === 'hidden';
function syncHowto() {
  const hidden = howtoHidden();
  $('howtoCard').style.display = hidden ? 'none' : '';
  $('howtoToggle').textContent = hidden ? 'How to Play' : 'Hide How to Play';
  retilt($('lobby')); // one fewer card changes the alternation below it
}
$('howtoToggle').addEventListener('click', () => {
  store.set('gtc_howto', howtoHidden() ? 'shown' : 'hidden');
  syncHowto();
});
syncHowto();
// Wrapped: openConfig takes options, and would otherwise be handed the click event as them.
$('setupBtn').addEventListener('click', () => openConfig());
$('cfgBackBtn').addEventListener('click', () => show('lobby'));
$('dealBtn').addEventListener('click', deal);
$('setupCancelBtn').addEventListener('click', () => {
  if (confirm('Cancel this deal and send everyone back to the lobby?')) socket.emit('setup:cancel', {}, () => {});
});
$('setupLeaveBtn').addEventListener('click', () => {
  if (confirm('Leave the room?')) leaveRoom();
});
$('hostCancelBtn').addEventListener('click', () => {
  if (confirm('Call off this deal and send everyone back to the lobby? Your picks are kept.')) socket.emit('setup:cancel', {}, () => {});
});
$('hostLeaveBtn').addEventListener('click', () => {
  if (confirm('Leave the room? The game carries on without you.')) leaveRoom();
});
$('undoBtn').addEventListener('click', () => socket.emit('setup:undo', {}, (res) => {
  $('rerollNote').textContent = res?.ok ? `Put ${res.restored} back.` : res?.error || '';
}));
$('rerollBtn').addEventListener('click', () => socket.emit('setup:reroll', {}, (res) => {
  if (res?.demotedName) $('rerollNote').textContent = `${res.demotedName} has been rerolled by enough people to retire.`;
  else if (!res?.ok) $('rerollNote').textContent = res?.error || '';
  else $('rerollNote').textContent = '';
}));
// No primeMotion here, though this is a user gesture and iOS wants one: the button only exists
// once the gate has already turned tilt on, so by the time anyone can press it the phone is
// listening. The gate's own button is where the permission is actually asked for.
$('goodBtn').addEventListener('click', () => socket.emit('setup:confirm', {}, (res) => {
  if (!res?.ok) $('waitingNote').textContent = res?.error || 'Could not lock in.';
}));
// Pick-for-each-other: whatever is chosen here becomes the checked player's character. The view
// that comes back from the server repaints the card; the note only carries a refusal.
// Optional-chained: if /shared/pickers.js did not load, a throw HERE, at the top level, stopped
// every handler below it -- the whole game. Without it the search box is inert; Random still works.
window.GTCPickers?.characterSearch($('pickSearch'), $('pickResults'), (pick) => {
  socket.emit('setup:pick', pick.typed ? { name: pick.name } : { id: pick.id }, (res) => {
    $('rerollNote').textContent = res?.ok ? '' : res?.error || 'Could not pick that one.';
  });
});
// The gate's own button is a user gesture, which is what iOS requires before handing over the
// sensor -- so this is the request most likely to actually succeed.
$('motionGateBtn').addEventListener('click', () => {
  motionDenied = false; // someone who has just fixed Settings deserves another go
  enableMotion().then(() => { if (lastSetupView) renderSetup(lastSetupView); });
});
$('soundCheckBtn').addEventListener('click', playSoundCheck);
$('muteBtn').addEventListener('click', () => {
  muted = !muted;
  store.set('gtc_muted', muted ? '1' : '0');
  if (muted) stopBed();
  renderSoundCheck();
  // Turning it back on auditions immediately: the whole point of the control is being able to
  // hear what you just chose.
  if (muted) $('soundCheckNote').textContent = 'Game sounds are off on this phone.';
  else playSoundCheck();
});
$('unlockBtn').addEventListener('click', () => socket.emit('setup:unlock', {}, () => {}));
$('browseBtn').addEventListener('click', openBrowse);

// The computer-version link is a real link (somewhere to go, maybe in a new tab) dressed as the
// ghost button below it. Buttons don't inherit the page font -- each browser gives them its own
// (Arial here, the system font on an iPhone) -- so the link takes whatever a real button got,
// rather than guessing it in CSS and looking pasted in on the next browser.

// The title goes home. A real link (so it opens in a new tab), but a plain navigation would put a
// player straight back in their room, which the page rejoins on load -- so in a room it asks first,
// in words that say what leaving costs, and leaves properly. Out of a room it just shows the start
// screen, which is also the way back from Browse and Test Tilt.
$('homeTitle').addEventListener('click', (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if (currentRoom) {
    const status = lastState?.status;
    const watching = document.getElementById('hosting')?.classList.contains('active');
    const cost = watching
      ? 'Leave the room? The game carries on without you.'
      : status === 'playing' || status === 'countdown'
      ? 'Leave the game? Your character is revealed and you drop out.'
      : status === 'setup' || status === 'ready'
        ? 'Leave the room? This deal is called off and everyone goes back to the lobby.'
        : 'Leave this room and go back to the start?';
    if (!confirm(cost)) return;
    leaveRoom();
  }
  // Home is the first question, Phone or Computer -- the one screen every other start hangs off.
  show('splash');
  window.scrollTo(0, 0);
});

// --- the start: Phone or Computer ---------------------------------------------------------
//
// Asked before anything else, because it decides what the rest of the start screen offers. The
// answer is remembered only as "where Back from Browse returns to" -- the question itself is asked
// on every fresh visit, so a phone borrowed for one game is never stuck being a computer.
let startScreen = 'landing';
function pickDevice(screen) {
  startScreen = screen;
  show(screen);
  window.scrollTo(0, 0);
}
$('pickPhone').addEventListener('click', () => pickDevice('landing'));
$('pickComputer').addEventListener('click', () => pickDevice('computer'));
for (const b of document.querySelectorAll('[data-splash]')) b.addEventListener('click', () => show('splash'));
// A hint, never a decision: touch-first is a good guess at "phone", and a tablet or a touchscreen
// laptop can still pick the other one.
$(matchMedia('(pointer: coarse)').matches ? 'likelyPhone' : 'likelyComputer').hidden = false;

// The computer games live on pages of their own, so the computer start hands off: create goes to
// the chosen game's page with the name, join asks the server which game the code is for.
const pcNick = () => {
  const n = $('pcNickInput').value.trim();
  if (n) store.set('gtc_nick', n);
  return n;
};
$('pcNickInput').value = store.get('gtc_nick') || '';
$('pcCreateBtn').addEventListener('click', () => {
  const name = pcNick();
  if (!name) return ($('pcErr').textContent = 'Enter your name first.');
  const game = document.querySelector('input[name=pcGame]:checked')?.value === 'draw' ? '/draw/' : '/desk/';
  location.assign(`${game}?create=1&name=${encodeURIComponent(name)}`);
});
$('pcJoinBtn').addEventListener('click', async () => {
  const name = pcNick();
  const code = $('pcCodeInput').value.trim().toUpperCase();
  if (!name) return ($('pcErr').textContent = 'Enter your name first.');
  if (code.length !== 4) return ($('pcErr').textContent = 'Room codes are 4 letters.');
  $('pcErr').textContent = '';
  let found;
  try {
    const res = await fetch(`/api/room?code=${encodeURIComponent(code)}`);
    found = await res.json();
    if (!res.ok) return ($('pcErr').textContent = found?.error || 'No room with that code.');
  } catch {
    return ($('pcErr').textContent = "Couldn't reach the server. Check your connection and try again.");
  }
  // A phone room: the forehead game cannot be played from a computer, so say whose it is.
  if (found.path === '/') return ($('pcErr').textContent = "That room is a phone game. Join it from a phone, or ask the host for a computer room.");
  location.assign(`${found.path}?room=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`);
});
$('pcCodeInput').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase()));
$('pcCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pcJoinBtn').click(); });
$('pcBrowseBtn').addEventListener('click', () => openBrowse());

// Dark mode. <head> already applied the stored choice (or the phone's own setting) before first
// paint; this is only the corner switch, which says which way it is set. The choice is per device.
const themeIsDark = () => document.documentElement.dataset.theme === 'dark';
function syncThemeToggle() {
  $('themeToggle').setAttribute('aria-checked', String(themeIsDark()));
}
$('themeToggle').addEventListener('click', () => {
  const dark = !themeIsDark();
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  store.set('gtc_theme', dark ? 'dark' : 'light');
  const spooky = document.documentElement.dataset.season === 'spooky';
  document.querySelector('meta[name=theme-color]').content = dark ? (spooky ? '#2a1307' : '#170d2b') : spooky ? '#cc4a0c' : '#46178f';
  syncThemeToggle();
});
syncThemeToggle();
$('browseBack').addEventListener('click', browseBack);
$('browseMore').addEventListener('click', () => { if (!browseState.loading) { browseState.loading = true; loadCharacterPage(false); } });
$('browseFilter').addEventListener('input', (e) => {
  browseState.filter = e.target.value;
  renderBrowseLists(e.target.value);
});
// Tilt calibration screen
$('tiltTestBtn').addEventListener('click', openTiltTest);
$('ttEnable').addEventListener('click', () => enableMotion().then(() => {
  $('ttEnable').style.display = motionEnabled ? 'none' : '';
  updateTiltTest();
}));
$('ttBack').addEventListener('click', () => show('landing'));
$('codeInput').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase()));
// Tapping a partly-filled code box should continue the code, not drop the caret mid-string.
// A deferred setSelectionRange, because the browser positions the caret after the tap resolves.
for (const ev of ['focus', 'click']) {
  $('codeInput').addEventListener(ev, (e) => {
    const end = e.target.value.length;
    setTimeout(() => e.target.setSelectionRange(end, end), 0);
  });
}
// The landing screen is active from the markup, so show() never runs for it -- tilt it here or
// the first screen anyone sees is the one screen with no lean at all.
retilt(document.querySelector('.screen.active'));
scheduleEgg();
wobble($('homeTitle'), 'Guess the Character');
for (const el of document.querySelectorAll('[data-wobble]')) wobble(el, el.textContent, { colour: false });
if (nickname) $('nickInput').value = nickname;

const deepRoom = new URLSearchParams(location.search).get('room');
const resumeRoom = (deepRoom || store.get('gtc_lastRoom') || '').toUpperCase();
if (deepRoom) $('codeInput').value = deepRoom.toUpperCase();
if (resumeRoom && nickname) currentRoom = { code: resumeRoom };
else if (resumeRoom) $('codeInput').value = resumeRoom;
// A room link or a rejoin has already answered Phone or Computer (only a phone page holds a
// phone room), so skip the question. It is also what shows while the rejoin lands.
if (resumeRoom) show('landing');
