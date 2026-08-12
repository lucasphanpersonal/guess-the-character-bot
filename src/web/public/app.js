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
  currentRoom = null; lastState = null; store.del('gtc_lastRoom'); show('landing');
}

// --- routing --------------------------------------------------------------------------------
function routeByStatus(state) {
  if (!state) return;
  if (state.status === 'lobby') { renderLobby(state); show('lobby'); }
  else if (state.status === 'ready') show('ready');
  // 'setup' is shown by the setup:state handler (it carries the per-player payload).
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
$('readyLeaveBtn').addEventListener('click', leaveRoom);
$('setupBtn').addEventListener('click', openConfig);
$('cfgBackBtn').addEventListener('click', () => show('lobby'));
$('dealBtn').addEventListener('click', deal);
$('rerollBtn').addEventListener('click', () => socket.emit('setup:reroll', {}, (res) => {
  if (res?.demotedName) $('rerollNote').textContent = `🚮 ${res.demotedName} has been rerolled by enough people to retire.`;
  else if (!res?.ok) $('rerollNote').textContent = res?.error || '';
  else $('rerollNote').textContent = '';
}));
$('goodBtn').addEventListener('click', () => socket.emit('setup:confirm', {}, () => {}));
$('unlockBtn').addEventListener('click', () => socket.emit('setup:unlock', {}, () => {}));
$('codeInput').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase()));
if (nickname) $('nickInput').value = nickname;

const deepRoom = new URLSearchParams(location.search).get('room');
const resumeRoom = (deepRoom || store.get('gtc_lastRoom') || '').toUpperCase();
if (deepRoom) $('codeInput').value = deepRoom.toUpperCase();
if (resumeRoom && nickname) currentRoom = { code: resumeRoom };
else if (resumeRoom) $('codeInput').value = resumeRoom;
