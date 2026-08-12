// Web client -- stage 1 (rooms + membership). Vanilla JS, no build step.
//
// Identity that survives a reconnect: a persistent playerId in localStorage, sent in the
// socket handshake. If we were in a room and the connection drops, socket.io reconnects the
// transport automatically and we re-emit room:join to reclaim the same seat -- the server keys
// seats by playerId, not socket id. See docs/mobile-app-plan.md#reconnection-...

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// Persistent per-device identity.
let playerId = store.get('gtc_playerId');
if (!playerId) {
  playerId = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now());
  store.set('gtc_playerId', playerId);
}

// What we believe we're in, so a transport reconnect can re-join.
let currentRoom = null; // { code }
let nickname = store.get('gtc_nick') || '';

const socket = io({ auth: { playerId } });

// --- screen switching ---------------------------------------------------------------------
function show(screen) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === screen);
}

// --- rendering ----------------------------------------------------------------------------
function renderState(state) {
  $('lobbyCode').textContent = state.code;
  const url = `${location.origin}/?room=${state.code}`;
  $('shareUrl').textContent = url;
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
    name.textContent = p.nickname;
    if (p.playerId === playerId) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = ' (you)';
      name.appendChild(you);
    }
    li.append(dot, name);
    if (p.isHost) {
      const crown = document.createElement('span');
      crown.className = 'crown';
      crown.textContent = '👑';
      crown.title = 'Host';
      li.appendChild(crown);
    }
    roster.appendChild(li);
  }
}

// --- actions ------------------------------------------------------------------------------
function readNick() {
  nickname = $('nickInput').value.trim();
  if (nickname) store.set('gtc_nick', nickname);
  return nickname;
}

function enterRoom(state) {
  currentRoom = { code: state.code };
  store.set('gtc_lastRoom', state.code);
  renderState(state);
  show('lobby');
  $('connState').textContent = '';
}

function createRoom() {
  const nick = readNick();
  if (!nick) return ($('landingErr').textContent = 'Enter your name first.');
  $('landingErr').textContent = '';
  socket.emit('room:create', { nickname: nick }, (res) => {
    if (!res?.ok) return ($('landingErr').textContent = res?.error || 'Could not create a room.');
    enterRoom(res.state);
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
    enterRoom(res.state);
  });
}

function leaveRoom() {
  socket.emit('room:leave', {}, () => {});
  currentRoom = null;
  store.del('gtc_lastRoom');
  show('landing');
}

// --- socket lifecycle ---------------------------------------------------------------------
socket.on('room:state', (state) => {
  // Only meaningful while we're actually in that room.
  if (currentRoom && state.code === currentRoom.code) renderState(state);
});

socket.on('connect', () => {
  // Transport (re)connected. If we think we're in a room, reclaim the seat -- on a first load
  // this is also how a stored session or a ?room= deep link auto-joins.
  if (currentRoom && nickname) {
    socket.emit('room:join', { code: currentRoom.code, nickname }, (res) => {
      if (res?.ok) enterRoom(res.state);
      else { currentRoom = null; store.del('gtc_lastRoom'); show('landing'); }
    });
  }
});

socket.on('disconnect', () => {
  if (currentRoom) $('connState').textContent = 'Reconnecting…';
});

// --- wire up + boot -----------------------------------------------------------------------
$('createBtn').addEventListener('click', createRoom);
$('joinBtn').addEventListener('click', joinRoom);
$('leaveBtn').addEventListener('click', leaveRoom);
$('codeInput').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase()));
if (nickname) $('nickInput').value = nickname;

// Deep link (?room=CODE, e.g. from a shared link/QR) or a stored session -> try to rejoin.
const deepRoom = new URLSearchParams(location.search).get('room');
const resumeRoom = (deepRoom || store.get('gtc_lastRoom') || '').toUpperCase();
if (deepRoom) $('codeInput').value = deepRoom.toUpperCase();
if (resumeRoom && nickname) {
  // Prime currentRoom so the 'connect' handler above reclaims the seat once the socket is up.
  currentRoom = { code: resumeRoom };
} else if (resumeRoom) {
  // We know the room but not a name yet -- prefill the code and let them enter a name.
  $('codeInput').value = resumeRoom;
}
