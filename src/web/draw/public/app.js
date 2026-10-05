// Draw the Character -- the client.
//
// Talks to the /draw socket.io namespace (src/web/draw/socket.js). The server decides everything
// -- whose turn, the answer, the clock, the score -- and this draws what it is sent. The one thing
// drawn locally first is the drawer's own pen, so it never lags their hand; every stroke still
// goes through the server, which checks it and passes it on.
//
// The picture is kept in 0..1 coordinates, so it looks the same on every screen size.

const { $, esc, store, show, toast, wobble, roomCodeHtml } = GTC;
const playerId = GTC.playerIdFor('gtc_draw_player');
const socket = io('/draw', { auth: { playerId } });
wobble($('title'), 'Draw the Character');

// The palette and sizes the server accepts (src/web/draw/socket.js); anything else is refused.
// Named, because a swatch is the one control where colour IS the content -- the names are what a
// screen reader, or anyone who can't tell two of them apart, has to go on.
const PALETTE = [
  ['#1b1033', 'Black'], ['#9a9a9a', 'Grey'], ['#e21b3c', 'Red'], ['#ffa602', 'Orange'], ['#26890c', 'Green'],
  ['#1368ce', 'Blue'], ['#7fd6ff', 'Sky blue'], ['#c13ac1', 'Purple'], ['#8b4513', 'Brown'], ['#ffffff', 'Eraser'],
];
const SIZES = [3, 8, 18, 36];

let roomState = null;
let view = null;
let options = null;
const isHost = () => roomState?.hostPlayerId === playerId;

// --- landing and lobby (the same flow as /desk/) ------------------------------------------
$('nameInput').value = store.get('gtc_draw_name') || '';
const params = new URLSearchParams(location.search);
if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase().slice(0, 4);

function nickname() {
  const name = $('nameInput').value.trim();
  if (name) store.set('gtc_draw_name', name);
  return name;
}

function enterRoom(state) {
  roomState = state;
  store.set('gtc_draw_room', state.code);
  history.replaceState(null, '', `?room=${encodeURIComponent(state.code)}`);
  $('landingErr').textContent = '';
  renderRoom();
}

// `quiet`: a rejoin the page attempted by itself, which says nothing if the room has gone.
function join(code, name, { quiet = false } = {}) {
  socket.emit('room:join', { code, nickname: name }, (res) => {
    if (!res?.ok) {
      if (quiet) return store.set('gtc_draw_room', '');
      return ($('landingErr').textContent = res?.error || 'Could not join that room.');
    }
    enterRoom(res.state);
  });
}

$('createBtn').addEventListener('click', () => {
  const name = nickname();
  if (!name) return ($('landingErr').textContent = 'Type your name first.');
  socket.emit('room:create', { nickname: name }, (res) => {
    if (!res?.ok) return ($('landingErr').textContent = res?.error || 'Could not create a room.');
    enterRoom(res.state);
  });
});
$('joinBtn').addEventListener('click', () => {
  const name = nickname();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) return ($('landingErr').textContent = 'Type your name first.');
  if (code.length !== 4) return ($('landingErr').textContent = 'Room codes are 4 characters.');
  join(code, name);
});
$('codeInput').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase()));
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

// A reload mid-game rejoins -- but only the room this link is for.
socket.on('connect', () => {
  const last = store.get('gtc_draw_room');
  const name = store.get('gtc_draw_name');
  const linked = params.get('room')?.toUpperCase();
  if (roomState?.code) return join(roomState.code, name || nickname(), { quiet: true });
  if (last && name && (!linked || linked === last)) join(last, name, { quiet: true });
});

function leave() {
  socket.emit('room:leave', {}, () => {});
  store.set('gtc_draw_room', '');
  roomState = null;
  view = null;
  history.replaceState(null, '', location.pathname);
  show('landing');
}
$('leaveBtn').addEventListener('click', leave);
$('leaveOverBtn').addEventListener('click', leave);

// The title goes home -- asking first when that means leaving a room, in words that say what it costs.
GTC.homeTitle($('title'), {
  leave,
  leaving() {
    if (!roomState) return null;
    if (roomState.status === 'playing') return 'Leave the game? You stop drawing and guessing; your score stays on the board.';
    return 'Leave this room and go back to the start?';
  },
});

socket.on('room:state', (state) => {
  roomState = state;
  renderRoom();
});

function renderRoom() {
  if (!roomState || roomState.status !== 'lobby') return;
  show('lobby');
  $('roomCode').innerHTML = roomCodeHtml(roomState.code);
  $('shareLink').value = `${location.origin}/draw/?room=${roomState.code}`;
  $('rosterLabel').textContent = `Players (${roomState.players.length}/${roomState.maxPlayers})`;
  $('roster').innerHTML = roomState.players
    .map((p) => `<li class="pill"><span class="dot${p.connected ? '' : ' off'}"></span>${esc(p.nickname)}${p.playerId === playerId ? ' (you)' : ''}${p.isHost ? ' <span class="crown">HOST</span>' : ''}</li>`)
    .join('');
  $('hostPanel').hidden = !isHost();
  $('guestPanel').hidden = isHost();
  if (!isHost()) return;
  $('startBtn').disabled = roomState.players.length < 2;
  $('lobbyErr').textContent = roomState.players.length < 2 ? 'Waiting for at least one more player to join.' : '';
  if (!options) {
    socket.emit('draw:options', {}, (res) => {
      options = res;
      // Its own memory: what a room likes to draw is not what it likes to wear.
      poolPicker = GTCPickers.poolPicker($('poolPicker'), { options: res, request: ask, storageKey: 'gtc_draw_pool' });
      // Easy first: a character has to be recognisable from a sketch.
      $('difficultySelect').innerHTML = (res?.difficulties ?? [])
        .map((d) => `<option value="${esc(d.key)}"${d.key === 'easy' ? ' selected' : ''}>${esc(d.label)}: ${esc(d.blurb)}</option>`)
        .join('');
    });
  }
}

// Built once, when the options first arrive: the server keeps this room's curation.
let poolPicker = null;
const ask = (event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

$('copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('shareLink').value);
    $('copyBtn').textContent = 'Copied';
  } catch {
    $('shareLink').select();
    $('copyBtn').textContent = 'Press Ctrl+C';
  }
  setTimeout(() => ($('copyBtn').textContent = 'Copy Link'), 1800);
});

$('startBtn').addEventListener('click', () => {
  if (!poolPicker) return; // the options have not arrived yet
  $('startBtn').disabled = true;
  socket.emit(
    'draw:start',
    {
      ...poolPicker.value(),
      difficulty: $('difficultySelect').value || undefined,
      rounds: Number($('roundsSelect').value),
      drawSeconds: Number($('timeSelect').value),
    },
    (res) => {
      $('startBtn').disabled = false;
      if (!res?.ok) $('lobbyErr').textContent = res?.error || 'Could not start.';
    }
  );
});

// --- the picture -----------------------------------------------------------------------------
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let strokes = []; // { id, color, size, points: [[x, y], ...] }
const W = () => canvas.width;
const H = () => canvas.height;
// Sizes are in units of an 800px-wide picture, scaled to the canvas.
const widthOf = (size) => (size * W()) / 800;

function strokeSegment(s, from) {
  if (!s.points.length) return;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = widthOf(s.size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.points.length === 1) {
    // A tap is a dot, not nothing.
    const [x, y] = s.points[0];
    ctx.beginPath();
    ctx.arc(x * W(), y * H(), ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const start = Math.max(0, from - 1);
  ctx.beginPath();
  ctx.moveTo(s.points[start][0] * W(), s.points[start][1] * H());
  for (let i = start + 1; i < s.points.length; i++) ctx.lineTo(s.points[i][0] * W(), s.points[i][1] * H());
  ctx.stroke();
}

function redraw() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W(), H());
  for (const s of strokes) strokeSegment(s, 0);
}
redraw();

// Someone else's stroke arriving in pieces.
socket.on('draw:stroke', (piece) => {
  let s = strokes.find((x) => x.id === piece.id);
  if (!s) {
    s = { id: piece.id, color: piece.color, size: piece.size, points: [] };
    strokes.push(s);
  }
  const from = s.points.length;
  s.points.push(...piece.points);
  strokeSegment(s, from);
});
// The whole picture: a new turn (empty), an undo or clear, or a reconnect catching up.
socket.on('draw:canvas', ({ strokes: all }) => {
  strokes = (all ?? []).map((s) => ({ ...s, points: [...s.points] }));
  redraw();
});

// The drawer's pen. Drawn here at once; sent in pieces every PIECE_MS.
let pen = { color: PALETTE[0][0], size: SIZES[1] };
let live = null; // the stroke being drawn
let pending = [];
let seq = 0;
const PIECE_MS = 50;
const canDraw = () => view?.isDrawer && view.phase === 'drawing';

function pointOf(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
}

function flush() {
  if (!live || !pending.length) return;
  socket.emit('draw:stroke', { id: live.id, color: live.color, size: live.size, points: pending });
  pending = [];
}
setInterval(flush, PIECE_MS);

canvas.addEventListener('pointerdown', (e) => {
  if (!canDraw()) return;
  // Keeps the stroke when the pen leaves the canvas mid-line. Can refuse (a pointer the browser
  // no longer tracks), and a refusal must not cost the stroke.
  try { canvas.setPointerCapture(e.pointerId); } catch { /* draw without capture */ }
  live = { id: `${playerId.slice(0, 8)}-${++seq}`, color: pen.color, size: pen.size, points: [pointOf(e)] };
  strokes.push(live);
  pending = [...live.points];
  strokeSegment(live, 0);
});
canvas.addEventListener('pointermove', (e) => {
  if (!live) return;
  const p = pointOf(e);
  const last = live.points[live.points.length - 1];
  if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.002) return; // not worth a point
  live.points.push(p);
  pending.push(p);
  strokeSegment(live, live.points.length - 1);
});
const endStroke = () => {
  flush();
  live = null;
};
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

function renderTools() {
  $('swatches').innerHTML = PALETTE.map(
    ([c, name]) => `<button class="swatch${pen.color === c ? ' on' : ''}" style="background:${c}" data-color="${c}" title="${name}" aria-label="${name}" aria-pressed="${pen.color === c}"></button>`
  ).join('');
  $('sizes').innerHTML = SIZES.map(
    (s, i) => `<button class="size${pen.size === s ? ' on' : ''}" data-size="${s}" aria-label="Brush size ${i + 1} of ${SIZES.length}" aria-pressed="${pen.size === s}"><i style="width:${Math.min(28, 4 + s * 0.7)}px;height:${Math.min(28, 4 + s * 0.7)}px"></i></button>`
  ).join('');
}
$('swatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  if (!b) return;
  pen.color = b.dataset.color;
  renderTools();
});
$('sizes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-size]');
  if (!b) return;
  pen.size = Number(b.dataset.size);
  renderTools();
});
renderTools();
$('undoBtn').addEventListener('click', () => socket.emit('draw:undo'));
$('clearBtn').addEventListener('click', () => socket.emit('draw:clear'));
document.addEventListener('keydown', (e) => {
  if (canDraw() && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.closest?.('input')) {
    e.preventDefault();
    socket.emit('draw:undo');
  }
});

// --- the game --------------------------------------------------------------------------------
let clockTimer = null;
function setClock(seconds, total) {
  clearInterval(clockTimer);
  let left = seconds;
  const draw = () => {
    $('clockSecs').textContent = left == null ? '' : `${left}s`;
    $('clockFill').style.width = left == null ? '100%' : `${Math.max(0, (left / (total || 80)) * 100)}%`;
    // The colour carries "nearly out of time" without anything moving.
    $('clock').classList.toggle('crit', left != null && left <= 10);
  };
  draw();
  if (left == null) return;
  clockTimer = setInterval(() => {
    if (left > 0) left -= 1;
    draw();
  }, 1000);
}

function characterArt(c) {
  return c?.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="" referrerpolicy="no-referrer" />` : '<span class="hint">No picture</span>';
}

socket.on('draw:state', (v) => {
  const turnChanged = !view || view.drawer.playerId !== v.drawer.playerId || view.phase !== v.phase;
  view = v;
  show('game');
  renderGame(turnChanged);
});

function renderGame(turnChanged) {
  const v = view;
  $('roundLabel').textContent = `Round ${v.round} of ${v.rounds}`;
  const total = v.phase === 'choosing' ? 15 : v.phase === 'reveal' ? 6 : v.drawSeconds;
  setClock(v.secondsLeft, total);

  // The clue: the drawer and anyone who has it see the name; everyone else the blanks.
  if (v.phase === 'drawing') {
    if (v.character) $('mask').textContent = v.character.name;
    else {
      const words = v.mask.split(' ').map((w) => w.length);
      $('mask').innerHTML = `${esc(v.mask)} <span class="len">(${words.join(' ')})</span>`;
    }
  } else $('mask').textContent = '';

  // The drawer's reference picture, for as long as they draw. Repainted only when the character
  // changes: every guess sends a new view, and resetting the <img> each time would make it blink.
  const ref = v.phase === 'drawing' && v.isDrawer ? v.character : null;
  $('refCard').hidden = !ref;
  const refKey = ref ? `${ref.name}|${ref.imageUrl ?? ''}` : '';
  if ($('refCard').dataset.key !== refKey) {
    $('refCard').dataset.key = refKey;
    $('refArt').innerHTML = ref ? characterArt(ref) : '';
    $('refName').textContent = ref ? ref.name : '';
  }

  $('players').innerHTML = v.players
    .map((p) => {
      const tag = p.drawing ? '<span class="tag drawing">▲ Drawing</span>' : p.guessed ? '<span class="tag got">✓ Got it</span>' : '';
      return `<li class="${p.guessed ? 'got' : ''}${p.left ? ' left' : ''}">${esc(p.name)}${p.playerId === playerId ? ' (you)' : ''} ${tag}<span class="score">${p.score}</span></li>`;
    })
    .join('');

  // Overlays on the picture: choosing, waiting for the drawer to choose, the reveal.
  $('chooseOverlay').hidden = !(v.phase === 'choosing' && v.isDrawer);
  if (v.phase === 'choosing' && v.isDrawer) {
    $('pick').innerHTML = v.choices
      .map((c, i) => `<button data-i="${i}"><div class="art">${characterArt(c)}</div><span>${esc(c.name)}</span><span class="hint" title="${esc(c.source)}">${esc(c.source)}</span></button>`)
      .join('');
    $('rerollChoicesBtn').disabled = v.rerollsLeft === 0;
    $('rerollChoicesBtn').textContent = v.rerollsLeft > 0 ? `New Choices (${v.rerollsLeft} Left)` : 'New Choices';
  }
  $('waitOverlay').hidden = !(v.phase === 'choosing' && !v.isDrawer);
  $('waitText').textContent = `${v.drawer.name} is choosing a character...`;
  $('revealOverlay').hidden = v.phase !== 'reveal';
  if (v.phase === 'reveal' && v.lastTurn) {
    const lt = v.lastTurn;
    $('revealTitle').textContent = lt.character ? `It was ${lt.character.name}` : 'Turn over';
    $('revealArt').innerHTML = characterArt(lt.character);
    const why = lt.reason === 'all' ? 'Everyone got it!' : lt.reason === 'drawer-left' ? `${lt.drawer} left.` : "Time's up.";
    const got = lt.guessed.length
      ? lt.guessed.map((x) => `${esc(x.name)} +${x.points}`).join(', ') + ` -- ${esc(lt.drawer)} +${lt.drawerPoints} for drawing`
      : 'Nobody got it.';
    $('revealPoints').innerHTML = `${esc(why)} ${got}`;
  }

  $('tools').hidden = !(v.isDrawer && v.phase === 'drawing');
  canvas.classList.toggle('can-draw', canDraw());

  // The chat box: a guess box for those still guessing; a quiet word with the others who know
  // for the drawer and anyone who has it.
  const knows = v.isDrawer || v.guessedIt;
  $('chatTitle').textContent = v.phase === 'drawing' && knows ? 'Chat (only others who know see yours)' : 'Guesses';
  $('chatInput').placeholder = v.phase === 'drawing' && !knows ? 'Type your guess' : 'Say something';
  renderChat();
  if (turnChanged && v.phase === 'drawing' && !v.isDrawer) $('chatInput').focus();
}

$('pick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (!b) return;
  socket.emit('draw:choose', { index: Number(b.dataset.i) }, (res) => { if (res && !res.ok) toast(esc(res.error)); });
});

$('rerollChoicesBtn').addEventListener('click', () => {
  const b = $('rerollChoicesBtn');
  b.disabled = true; // one request at a time; the new view re-enables it
  socket.emit('draw:reroll', {}, (res) => {
    b.disabled = false;
    if (res && !res.ok) toast(esc(res.error));
  });
});

// The server's chat, plus lines only this player sees: their own close calls, and the "got it"
// announcements, which are events rather than chat.
let localLines = [];
function renderChat() {
  const server = (view?.chat ?? []).map((m) => ({
    key: `m${m.id}`,
    cls: m.insider ? 'insider' : '',
    html: `<span class="who">${esc(m.name)}:</span> ${esc(m.text)}`,
  }));
  const lines = [...server, ...localLines].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const ul = $('chat');
  const atBottom = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 40;
  ul.innerHTML = lines.map((l) => `<li class="${l.cls}">${l.html}</li>`).join('');
  if (atBottom) ul.scrollTop = ul.scrollHeight;
}
function localLine(cls, html) {
  localLines.push({ cls, html, at: Date.now() });
  localLines = localLines.slice(-12);
  renderChat();
}

socket.on('draw:correct', ({ name, points }) => {
  localLine('sys', `✓ ${esc(name)} got it! +${points}`);
});

// Sent the moment Enter is pressed, and the box emptied at once: a fast typist is already on the
// next guess, and clearing on the reply glued two guesses together on /desk/.
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  $('chatInput').value = '';
  $('chatErr').textContent = '';
  socket.emit('draw:say', { text }, (res) => {
    if (!res?.ok) {
      if (!$('chatInput').value) $('chatInput').value = text;
      return ($('chatErr').textContent = res?.error || 'That did not send.');
    }
    if (res.verdict === 'close') localLine('close', `"${esc(text)}" is close!`);
    if (res.verdict === 'correct') localLine('sys', `✓ You got it! +${res.points}`);
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && view && view.phase !== 'over') socket.emit('draw:resync', {}, () => {});
});

// --- results ---------------------------------------------------------------------------------
socket.on('draw:over', ({ standings }) => {
  show('over');
  clearInterval(clockTimer);
  view = null;
  localLines = [];
  const top = standings.filter((s) => s.place === 1).map((s) => (s.playerId === playerId ? 'You' : s.name));
  $('overTitle').textContent = top.length ? `${top.join(' and ')} won!` : 'Game over';
  $('standings').innerHTML = standings
    .map((s) => `<li><span class="place">${s.place}</span><div><strong>${esc(s.name)}</strong>${s.left ? ' <span class="hint">(left)</span>' : ''}<div class="hint">${s.score} points</div></div></li>`)
    .join('');
  $('hostOver').hidden = !isHost();
  $('guestOver').hidden = isHost();
  $('overErr').textContent = '';
});
$('rematchBtn').addEventListener('click', () =>
  socket.emit('draw:rematch', {}, (res) => { if (!res?.ok) $('overErr').textContent = res?.error || 'Could not rematch.'; }));
$('againBtn').addEventListener('click', () =>
  socket.emit('draw:again', {}, (res) => { if (!res?.ok) $('overErr').textContent = res?.error || 'Could not restart.'; }));

socket.on('room:error', ({ error } = {}) => ($('landingErr').textContent = error || 'Something went wrong.'));
