// Web client -- stages 1-2 (rooms + setup/confirm/reroll). Vanilla JS, no build step.
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

const socket = io({ auth: { playerId } });

function show(screen) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === screen);
}
const amHost = () => lastState && lastState.hostPlayerId === playerId;

// --- lobby rendering ----------------------------------------------------------------------
function renderLobby(state) {
  $('lobbyCode').textContent = state.code;
  $('shareUrl').textContent = `${location.origin}/?room=${state.code}`;
  $('playerCount').textContent = `Players (${state.players.length}/8)`;
  const roster = $('roster');
  roster.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    li.className = 'seat';
    const dot = document.createElement('span');
    dot.className = 'dot' + (p.connected ? '' : ' off');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.nickname + (p.playerId === playerId ? '' : '');
    if (p.playerId === playerId) { const y = document.createElement('span'); y.className = 'you'; y.textContent = ' (you)'; name.appendChild(y); }
    li.append(dot, name);
    if (p.isHost) { const c = document.createElement('span'); c.className = 'crown'; c.textContent = '👑'; li.appendChild(c); }
    roster.appendChild(li);
  }
  const host = amHost();
  const enough = state.players.length >= 2;
  $('setupBtn').style.display = host ? '' : 'none';
  $('setupBtn').disabled = !enough;
  $('lobbyHint').textContent = host
    ? (enough ? '' : 'Need at least 2 players to start.')
    : 'Waiting for the host to start the game…';
}

// --- config (host) ------------------------------------------------------------------------
function openConfig() {
  socket.emit('setup:options', {}, (opts) => {
    options = opts;
    renderConfig(opts);
    show('config');
  });
}
function renderConfig(opts) {
  const pool = $('poolChoices');
  pool.innerHTML = '';
  const poolOpts = [
    { v: 'random', label: '🎲 Surprise me', sub: 'a random category' },
    { v: 'everything', label: '🌍 Everything', sub: 'all enabled lists' },
    { v: 'category', label: '🗂️ Pick a category', sub: '' },
  ];
  for (const o of poolOpts) {
    const l = document.createElement('label');
    l.className = 'choice';
    l.innerHTML = `<input type="radio" name="pool" value="${o.v}" ${o.v === 'random' ? 'checked' : ''}>
      <span><div>${o.label}</div>${o.sub ? `<div class="sub">${o.sub}</div>` : ''}</span>`;
    pool.appendChild(l);
  }
  const sel = $('categorySelect');
  sel.innerHTML = '';
  for (const c of opts.categories) {
    const o = document.createElement('option');
    o.value = c.category;
    o.textContent = `${c.category} (${c.enabled} lists)`;
    sel.appendChild(o);
  }
  pool.addEventListener('change', () => {
    const v = pool.querySelector('input[name=pool]:checked')?.value;
    sel.style.display = v === 'category' ? '' : 'none';
  });

  const diff = $('diffChoices');
  diff.innerHTML = '';
  for (const d of opts.difficulties) {
    const l = document.createElement('label');
    l.className = 'choice';
    l.innerHTML = `<input type="radio" name="diff" value="${d.key}" ${d.key === opts.defaultDifficulty ? 'checked' : ''}>
      <span><div>${d.label}</div><div class="sub">${d.blurb}</div></span>`;
    diff.appendChild(l);
  }
}
function deal() {
  const poolType = $('poolChoices').querySelector('input[name=pool]:checked')?.value || 'random';
  const category = poolType === 'category' ? $('categorySelect').value : null;
  const difficulty = $('diffChoices').querySelector('input[name=diff]:checked')?.value;
  $('configErr').textContent = 'Dealing…';
  socket.emit('setup:start', { poolType, category, difficulty }, (res) => {
    $('configErr').textContent = res?.ok ? '' : (res?.error || 'Could not start.');
    // On success the server broadcasts status + setup:state, which switches the screen.
  });
}

// --- setup / confirm ----------------------------------------------------------------------
function charCardHtml(ch) {
  const img = ch.imageUrl
    ? `<img src="${ch.imageUrl}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'(no image)'}))">`
    : `<div class="noimg">No image — reveal by name</div>`;
  return `<div class="charname">${escapeHtml(ch.name)}</div>${ch.source ? `<div class="charsrc">${escapeHtml(ch.source)}</div>` : ''}${img}`;
}
function renderSetup(view) {
  $('checkOwner').textContent = `${view.checking.ownerName}'s character`;
  $('checkCard').innerHTML = charCardHtml(view.checking.character);
  $('rerollLeft').textContent = view.rerollsLeft < 0 ? '∞' : view.rerollsLeft;
  $('rerollBtn').style.display = view.rerollAllowed ? '' : 'none';
  $('rerollBtn').disabled = view.confirmed || (view.rerollsLeft === 0);

  const ref = $('refList');
  ref.innerHTML = '';
  for (const r of view.reference) {
    const li = document.createElement('li');
    li.className = 'seat';
    li.innerHTML = `<span class="name">${escapeHtml(r.character.name)}</span>` +
      (r.character.source ? `<span class="you"> — ${escapeHtml(r.character.source)}</span>` : '');
    ref.appendChild(li);
  }

  $('goodBtn').style.display = view.confirmed ? 'none' : '';
  $('unlockBtn').style.display = view.confirmed ? '' : 'none';
  $('waitingNote').textContent = view.confirmed
    ? (view.allReady ? 'Everyone is in!' : `Locked in — waiting on ${view.waitingOn} more.`)
    : '';
  show('setup');
}

// --- playing ------------------------------------------------------------------------------
let countdown = null;          // local 1s ticker
let lastPlayView = null;

const STATUS_ICON = { finished: '✅', guessing: '🎯', waiting: '⏳', gave_up: '🏳️' };

function renderStandings(el, rows) {
  el.innerHTML = '';
  for (const s of rows) {
    const li = document.createElement('li');
    li.className = 'seat';
    const tail = s.status === 'finished' ? ` — turn ${s.turns}`
      : s.status === 'guessing' ? ` — turn ${s.turns} (guessing)`
      : s.status === 'gave_up' ? ' — gave up' : ' — waiting';
    li.innerHTML = `<span>${STATUS_ICON[s.status] || '•'}</span><span class="name">${escapeHtml(s.name)}</span><span class="you">${tail}</span>`;
    el.appendChild(li);
  }
}

function bannerText(view, remaining) {
  const t = remaining == null ? '' : ` · ⏱ ${remaining}s`;
  return view.isMyTurn
    ? `🫵 <b>Your turn</b> — turn ${view.current.turnNumber}${t}`
    : `🎯 <b>${escapeHtml(view.current.name)}</b> is guessing — turn ${view.current.turnNumber}${t}`;
}

function renderPlaying(view) {
  lastPlayView = view;
  // You've got yours: drop out of forehead mode into a "you got it" screen with your reveal.
  if (view.me?.finished) { hideForehead(); return renderFinished(view); }
  // With a motion sensor we play the real thing: full-screen forehead card + tilt to answer.
  // Without one (e.g. plain HTTP, no permission), fall back to the tap model below.
  if (motionEnabled) return renderForehead(view);
  hideForehead();
  renderMotionPrompt($('motionBanner'));
  const area = $('playArea');
  if (view.isMyTurn) {
    area.innerHTML = (view.outOfContentionNote ? `<p class="hint center">${escapeHtml(view.outOfContentionNote)}</p>` : '')
      + '<div id="turnBtns"></div>';
    const btns = area.querySelector('#turnBtns');
    if (view.buttons.gotIt) addBtn(btns, '✅ Got it!', 'good', () => socket.emit('game:gotit', {}, () => {}));
    if (view.buttons.pass) addBtn(btns, '⏭️ Pass', 'ghost', () => socket.emit('game:pass', {}, () => {}));
    if (view.buttons.giveUp) addBtn(btns, '🏳️ Give up', 'ghost', () => { if (confirm('Give up? Your character is revealed and you drop out.')) socket.emit('game:giveup', {}, () => {}); });
  } else if (view.wearing) {
    area.innerHTML = `<div class="hint center">They're wearing — help them by answering questions</div>${charCardHtml(view.wearing)}`;
  } else {
    area.innerHTML = `<p class="hint center">Waiting for the next turn…</p>`;
  }
  renderStandings($('standings'), view.standings);
  startTurnTicker(view);
  show('playing');
}

// The turn clock ticks locally each second and is re-synced on every server state push (so it
// never trusts cross-device wall clocks). Paints whichever turn line is visible -- the forehead
// banner in motion mode, or the card banner in the tap fallback.
let turnTicker = null;
function startTurnTicker(view) {
  clearInterval(turnTicker);
  let remaining = view.turnRemaining;
  const paint = () => {
    if (motionEnabled && $('forehead').classList.contains('active')) {
      $('foreheadTurn').innerHTML = view.isMyTurn
        ? `🫵 YOUR TURN${remaining != null ? ` · ⏱ ${remaining}s` : ''} — tilt up if you got it`
        : `🎯 ${escapeHtml(view.current.name)}'s turn${remaining != null ? ` · ${remaining}s` : ''}`;
    } else {
      $('turnBanner').innerHTML = bannerText(view, remaining);
    }
  };
  paint();
  if (remaining == null) return;
  turnTicker = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    paint();
    if (remaining === 0) clearInterval(turnTicker);
  }, 1000);
}

// The screen a player sees once they've got their character: their reveal, turn count, and the
// live standings while everyone else plays on.
function renderFinished(view) {
  clearInterval(turnTicker);
  renderMotionPrompt($('motionBanner'));
  const ch = view.me.character;
  $('turnBanner').innerHTML = `✅ <b>You got it in ${view.me.turns} turn${view.me.turns === 1 ? '' : 's'}!</b>`;
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
}

function renderOver(result) {
  clearInterval(countdown);
  clearInterval(turnTicker);
  hideForehead();
  const names = result.winners.map((w) => w.name);
  $('overEmoji').textContent = result.winners.length > 1 ? '🤝' : (result.winners.length ? '🏆' : '🛑');
  $('overResult').innerHTML = result.winners.length > 1
    ? `It's a tie — ${names.map(escapeHtml).join(' & ')} both got it in ${result.bestTurnCount} turns!`
    : result.winners.length
      ? `${escapeHtml(names[0])} wins — got it in ${result.bestTurnCount} turns!`
      : 'Nobody got their character.';
  const ul = $('finalStandings');
  ul.innerHTML = '';
  const finishers = result.standings.filter((s) => s.turns !== null);
  for (const s of result.standings) {
    const li = document.createElement('li');
    li.className = 'seat';
    let place;
    if (s.turns === null) place = s.outcome === 'gave_up' ? 'gave up' : 'did not finish';
    else {
      const rank = finishers.filter((o) => o.turns < s.turns).length + 1;
      place = `#${rank} — ${s.turns} turn${s.turns === 1 ? '' : 's'}`;
    }
    li.innerHTML = `<span class="name">${escapeHtml(s.name)}</span><span class="you"> ${place}</span>`;
    ul.appendChild(li);
  }
  $('againBtn').style.display = amHost() ? '' : 'none';
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
let motionNote = '';
let audioCtx = null;
const hasMotion = 'DeviceMotionEvent' in window;
const hasOrient = 'DeviceOrientationEvent' in window;
const motionSupported = hasMotion || hasOrient;

// Live sensor readings. `z` is gravity along the axis perpendicular to the screen (m/s^2):
// ~0 when the phone is held vertically on a forehead, swinging toward ±9.8 as you tilt it to
// face the ceiling or the floor. That axis is what "tilt up/down" changes no matter whether
// the phone is portrait or landscape -- which is why the old beta-based version never fired
// when the phone was held horizontally.
const sensor = { x: 0, y: 0, z: 0, beta: null, gamma: null, have: false };
let tiltFlip = store.get('gtc_tilt_flip') === '1';
const TILT_TH = 4.5;      // m/s^2 from neutral (~27 degrees)
const TILT_HOLD_MS = 450; // hold past the threshold this long before firing in-game
const tilt = { baseline: null, armed: true, dir: null, since: 0, lastFire: 0 };

function ensureAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch {}
}
function beep(freq = 880, ms = 180) {
  if (!audioCtx) return;
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.start(t); o.stop(t + ms / 1000);
  } catch {}
}

async function enableMotion() {
  if (!motionSupported) { motionNote = 'This device has no motion sensors.'; return; }
  ensureAudio();
  try {
    if (typeof DeviceMotionEvent?.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') { motionNote = 'Motion blocked — tap buttons still work.'; if (lastPlayView) renderPlaying(lastPlayView); return; }
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

function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (g && g.z != null) { sensor.x = g.x ?? sensor.x; sensor.y = g.y ?? sensor.y; sensor.z = g.z; sensor.have = true; }
  handleGameTilt();
  updateForeheadRotation();
  updateTiltTest();
}

// iOS won't let a web page unlock orientation, so we rotate the forehead card ourselves. The
// in-screen-plane gravity (x axis) tells us which way the phone is rolled; we snap to whichever
// landscape keeps the card upright for the room, with a dead zone so it doesn't flip-flop near
// vertical. If it comes out upside-down for a given hold, the sign of ROLL_SIGN is the one knob.
let fhRot = 90;
const ROLL_SIGN = 1;
function updateForeheadRotation() {
  const el = document.getElementById('foreheadRot');
  if (!el || !$('forehead').classList.contains('active') || !sensor.have) return;
  const gx = sensor.x * ROLL_SIGN;
  let target = fhRot;
  if (gx > 2.5) target = 90;
  else if (gx < -2.5) target = 270;
  if (target !== fhRot) { fhRot = target; el.style.setProperty('--fh-rot', `${fhRot}deg`); }
}
function onOrient(e) { sensor.beta = e.beta; sensor.gamma = e.gamma; updateTiltTest(); }

// Current tilt as a gesture relative to a captured neutral: 'gotit', 'pass', or null. `tiltFlip`
// swaps the two for phones that report the opposite sign (the tilt-test screen toggles it).
function currentGesture(baseline) {
  if (baseline == null || !sensor.have) return null;
  const delta = sensor.z - baseline;
  let up = delta < -TILT_TH;  // screen tipped toward the ceiling = tilt up = Got it
  let down = delta > TILT_TH; // screen tipped toward the floor = tilt down = Pass
  if (tiltFlip) { const t = up; up = down; down = t; }
  return up ? 'gotit' : down ? 'pass' : null;
}

function handleGameTilt() {
  const v = lastPlayView;
  if (!motionEnabled || !v || v.phase !== 'playing' || !v.isMyTurn) { tilt.dir = null; return; }
  if (tilt.baseline == null) tilt.baseline = sensor.z;
  const g = currentGesture(tilt.baseline);
  const now = Date.now();
  if (!g) { tilt.armed = true; tilt.dir = null; return; }        // near neutral -> re-arm
  if (g !== tilt.dir) { tilt.dir = g; tilt.since = now; return; }
  if (tilt.armed && now - tilt.since > TILT_HOLD_MS && now - tilt.lastFire > 1200) {
    tilt.armed = false; tilt.lastFire = now;
    navigator.vibrate?.(60); beep(g === 'gotit' ? 1050 : 480, 130);
    if (g === 'gotit') socket.emit('game:gotit', {}, () => {});
    else if (v.buttons?.pass) socket.emit('game:pass', {}, () => {});
  }
}

let foreheadMyTurn = false;
function renderForehead(view) {
  const el = $('forehead');
  el.classList.add('active');
  el.classList.toggle('mine', view.isMyTurn);
  const ch = view.myCharacter;
  const img = $('foreheadImg'), noimg = $('foreheadNoImg');
  if (ch && ch.imageUrl) {
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
  updateForeheadRotation();
  updateForeheadDebug();
  // My turn just started: reset the tilt baseline, buzz, and chime so I know without looking.
  if (view.isMyTurn && !foreheadMyTurn) {
    tilt.baseline = null; tilt.armed = true;
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
    ? `z ${sensor.z.toFixed(1)} Δ ${tilt.baseline != null ? (sensor.z - tilt.baseline).toFixed(1) : '—'}`
    : '';
}

function hideForehead() { $('forehead').classList.remove('active'); foreheadMyTurn = false; }

function renderMotionPrompt(container) {
  container.innerHTML = '';
  if (!motionSupported || motionEnabled) { if (motionNote) container.innerHTML = `<p class="hint center">${escapeHtml(motionNote)}</p>`; return; }
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<p class="hint center">On a phone? Enable tilt to hold it on your forehead like Heads Up.</p>`;
  const b = document.createElement('button');
  b.className = 'enable-motion';
  b.textContent = '📱 Enable tilt controls';
  b.addEventListener('click', enableMotion);
  card.appendChild(b);
  if (motionNote) { const p = document.createElement('p'); p.className = 'hint center'; p.textContent = motionNote; card.appendChild(p); }
  container.appendChild(card);
}

function startCountdown(seconds) {
  hideForehead();
  clearInterval(countdown);
  let n = Math.max(0, seconds);
  $('countNum').textContent = n || '0';
  const cnum = $('countNum');
  if (motionSupported && !motionEnabled && !document.getElementById('countEnable')) {
    const b = document.createElement('button');
    b.id = 'countEnable';
    b.className = 'enable-motion';
    b.style.marginTop = '14px';
    b.textContent = '📱 Enable tilt controls';
    b.addEventListener('click', enableMotion);
    cnum.parentElement.appendChild(b);
  }
  navigator.vibrate?.(80);
  show('countdown');
  countdown = setInterval(() => {
    n -= 1;
    if (n <= 0) { clearInterval(countdown); $('countNum').textContent = '0'; return; }
    $('countNum').textContent = n;
    navigator.vibrate?.(40);
  }, 1000);
}

// --- tilt test / calibration --------------------------------------------------------------
let ttBaseline = null;
function openTiltTest() { ttBaseline = null; $('ttEnable').style.display = motionEnabled ? 'none' : ''; updateTiltTest(); show('tilttest'); }
function updateTiltTest() {
  updateForeheadDebug();
  if (!$('tilttest').classList.contains('active')) return;
  if (ttBaseline == null && sensor.have) ttBaseline = sensor.z;
  const g = currentGesture(ttBaseline);
  const res = $('ttResult');
  res.textContent = g === 'gotit' ? '⬆  UP = Got it' : g === 'pass' ? '⬇  DOWN = Pass' : (sensor.have ? '•  neutral' : 'enable motion');
  res.style.color = g === 'gotit' ? 'var(--ok)' : g === 'pass' ? 'var(--warn)' : 'var(--fg)';
  const f = (x) => (x == null ? '—' : x.toFixed(0));
  $('ttVals').textContent = sensor.have
    ? `z ${sensor.z.toFixed(1)}  Δ ${(ttBaseline != null ? sensor.z - ttBaseline : 0).toFixed(1)}  ·  β ${f(sensor.beta)} γ ${f(sensor.gamma)}  ·  flip ${tiltFlip ? 'ON' : 'off'}`
    : (motionNote || 'waiting for sensor…');
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
  socket.emit('room:join', { code, nickname: nick }, (res) => {
    if (!res?.ok) return ($('landingErr').textContent = res?.error || 'Could not join.');
    lastState = res.state; enterRoom(res.state); routeByStatus(res.state);
  });
}
function leaveRoom() {
  socket.emit('room:leave', {}, () => {});
  currentRoom = null; lastState = null; store.del('gtc_lastRoom'); hideForehead(); show('landing');
}

// --- routing --------------------------------------------------------------------------------
function routeByStatus(state) {
  if (!state) return;
  if (state.status === 'lobby') { renderLobby(state); show('lobby'); }
  // 'setup' -> setup:state handler; 'playing' -> game:state handler; 'finished' -> game:over.
  // Those carry the per-player payloads, so status alone doesn't switch to them here.
}

// --- socket lifecycle -----------------------------------------------------------------------
socket.on('room:state', (state) => {
  if (!currentRoom || state.code !== currentRoom.code) return;
  lastState = state;
  // Don't yank the host off the config screen just because a roster broadcast arrived.
  const onConfig = $('config').classList.contains('active');
  if (state.status === 'lobby') { renderLobby(state); if (!onConfig) show('lobby'); }
  else routeByStatus(state);
});

socket.on('setup:state', (view) => renderSetup(view));

socket.on('game:countdown', ({ seconds }) => startCountdown(seconds));
socket.on('game:state', (view) => renderPlaying(view));
socket.on('game:reveal', (r) => {
  const html = r.kind === 'got'
    ? `✅ <b>${escapeHtml(r.name)}</b> got it in <b>${r.turns}</b> turn${r.turns === 1 ? '' : 's'}! — they were <b>${escapeHtml(r.character.name)}</b>`
    : r.kind === 'gaveup'
      ? `🏳️ <b>${escapeHtml(r.name)}</b> gave up — they were <b>${escapeHtml(r.character.name)}</b>`
      : `🚪 <b>${escapeHtml(r.name)}</b> left — they were <b>${escapeHtml(r.character.name)}</b>`;
  logReveal(html);
});
socket.on('game:timeout', (t) => logReveal(`⏱ <b>${escapeHtml(t.name)}</b> ran out of time — turn passes.`));
socket.on('game:over', (result) => renderOver(result));

socket.on('setup:aborted', ({ reason }) => {
  if ($('setup').classList.contains('active') || $('config').classList.contains('active')) {
    $('lobbyHint').textContent = `Setup stopped — ${reason}.`;
  }
});

socket.on('connect', () => {
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
$('overLeaveBtn').addEventListener('click', leaveRoom);
$('againBtn').addEventListener('click', () => socket.emit('game:again', {}, () => {}));
$('setupBtn').addEventListener('click', openConfig);
$('cfgBackBtn').addEventListener('click', () => show('lobby'));
$('dealBtn').addEventListener('click', deal);
$('rerollBtn').addEventListener('click', () => socket.emit('setup:reroll', {}, (res) => {
  if (res?.demotedName) $('rerollNote').textContent = `🚮 ${res.demotedName} has been rerolled by enough people to retire.`;
  else if (!res?.ok) $('rerollNote').textContent = res?.error || '';
  else $('rerollNote').textContent = '';
}));
// "Good to go" is a user gesture, so use it to also turn motion on -- by reveal time the phone
// is already listening, no separate step needed. Best-effort; the tap fallback covers refusal.
$('goodBtn').addEventListener('click', () => { if (motionSupported && !motionEnabled) enableMotion(); socket.emit('setup:confirm', {}, () => {}); });
$('unlockBtn').addEventListener('click', () => socket.emit('setup:unlock', {}, () => {}));
// Tilt calibration screen
$('tiltTestBtn').addEventListener('click', openTiltTest);
$('ttEnable').addEventListener('click', () => { enableMotion().then(() => { ttBaseline = null; updateTiltTest(); }); });
$('ttFlip').addEventListener('click', () => { tiltFlip = !tiltFlip; store.set('gtc_tilt_flip', tiltFlip ? '1' : '0'); updateTiltTest(); });
$('ttBack').addEventListener('click', () => show('landing'));
$('codeInput').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase()));
if (nickname) $('nickInput').value = nickname;

const deepRoom = new URLSearchParams(location.search).get('room');
const resumeRoom = (deepRoom || store.get('gtc_lastRoom') || '').toUpperCase();
if (deepRoom) $('codeInput').value = deepRoom.toUpperCase();
if (resumeRoom && nickname) currentRoom = { code: resumeRoom };
else if (resumeRoom) $('codeInput').value = resumeRoom;
