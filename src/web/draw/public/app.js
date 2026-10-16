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
// `playerId` above is this browser's SECRET: it goes in the handshake and nowhere else. The server
// seats us under a public id derived from it, and that is the id every roster and view uses -- so
// "is this me?" is always asked of `me`, never of the secret.
let me = null;
socket.on('hello', ({ you }) => {
  me = you;
});
wobble($('title'), 'Draw the Character');
// Before bindThemeToggles: the menu carries a dark-mode switch of its own for phone widths.
const roomMenu = GTCRoomMenu.mount({
  button: $('roomBtn'),
  socket,
  room: () => roomState,
  me: () => me,
  leave,
  leaveCost,
  themeToggle: true,
  removeCost: (name, status) =>
    status !== 'playing'
      ? `Remove ${name} from the room?`
      : telView
        ? `Remove ${name}? Their seat is skipped from here on; the chains carry on.`
        : `Remove ${name}? Their score stays on the board; if they are drawing, the turn ends.`,
});
GTC.bindThemeToggles();

// Sound (/shared/sound.js): your turn to draw, someone getting it, time nearly up, the reveal.
// Optional-chained: a missing sound script costs the cues, never the game, and hides the switch.
const sound = (cue) => window.GTCSound?.play(cue);
$('soundToggle').hidden = !window.GTCSound;
window.GTCSound?.mountToggle($('soundToggle'));

// The palette ([colour, name] pairs) and brush sizes, as the server sends them in room state --
// declared once, in src/web/draw/socket.js, which refuses anything else. Empty until a room is
// joined, which is long before anyone can draw.
let PALETTE = [];
let SIZES = [];

let roomState = null;
let view = null;
let options = null;
const isHost = () => roomState?.hostPlayerId === me;

// --- landing and lobby (the same flow as /desk/) ------------------------------------------
$('nameInput').value = store.get('gtc_draw_name') || '';
const params = new URLSearchParams(location.search);
if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase().slice(0, 4);
// Handed over by the home page's computer start: a name, and "create" or a room code. Acted on once,
// at the first connection, and wiped from the address so a reload does not create a second room.
const handoff = { name: (params.get('name') || '').trim().slice(0, 20), create: params.get('create') === '1' };
if (handoff.name) $('nameInput').value = handoff.name;
if (params.has('name') || params.has('create')) {
  const room = params.get('room');
  history.replaceState(null, '', location.pathname + (room ? `?room=${encodeURIComponent(room)}` : ''));
}

function nickname() {
  const name = $('nameInput').value.trim();
  if (name) store.set('gtc_draw_name', name);
  return name;
}

// The drawing tools come with the room. Re-rendered only when they change, not on every update.
function takeTools(state) {
  if (!state?.palette || JSON.stringify([state.palette, state.sizes]) === JSON.stringify([PALETTE, SIZES])) return;
  PALETTE = state.palette;
  SIZES = state.sizes;
  if (!PALETTE.some(([c]) => c === pen.color)) pen.color = PALETTE[0][0];
  if (!SIZES.includes(pen.size)) pen.size = SIZES[Math.min(1, SIZES.length - 1)];
  renderTools();
}

function enterRoom(state) {
  roomState = state;
  takeTools(state);
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
  if (handoff.name && !roomState) {
    const { create } = handoff;
    handoff.name = '';
    nickname(); // remembers it for next time
    if (create) return $('createBtn').click();
    if (linked) return join(linked, $('nameInput').value.trim());
  }
  if (roomState?.code) return join(roomState.code, name || nickname(), { quiet: true });
  if (last && name && (!linked || linked === last)) join(last, name, { quiet: true });
});

// Resolves once the server has the leave (or after a moment without an answer), so a caller that is
// about to navigate away -- the title -- does not cut the request off and leave the seat held.
function leave() {
  const done = new Promise((resolve) => {
    socket.emit('room:leave', {}, resolve);
    setTimeout(resolve, 1500);
  });
  backToStart();
  return done;
}

// Out of the room, however that happened. The room is forgotten, link included, so neither a
// reload nor a reconnect walks back in.
function backToStart() {
  store.set('gtc_draw_room', '');
  roomState = null;
  roomMenu.update();
  view = null;
  telView = null;
  telTaskKey = '';
  telShownKey = '';
  clearInterval(clockTimer);
  history.replaceState(null, '', location.pathname);
  show('landing');
}
$('leaveBtn').addEventListener('click', leave);
$('leaveOverBtn').addEventListener('click', leave);

// What leaving costs, in words -- asked by the title (which goes home) and by Room's Leave.
function leaveCost() {
  if (!roomState) return null;
  if (roomState.status === 'playing' && telView) return 'Leave the game? Your seat is skipped from here on; the chains carry on.';
  if (roomState.status === 'playing') return 'Leave the game? You stop drawing and guessing; your score stays on the board.';
  return 'Leave this room and go back to the start?';
}
GTC.homeTitle($('title'), { leave, leaving: leaveCost });

socket.on('room:state', (state) => {
  roomState = state;
  takeTools(state);
  renderRoom();
  renderPlayers();
});

function renderRoom() {
  roomMenu.update(); // the Room button and its list follow every roster change
  if (!roomState || roomState.status !== 'lobby') return;
  show('lobby');
  $('roomCode').innerHTML = roomCodeHtml(roomState.code);
  $('shareLink').value = `${location.origin}/draw/?room=${roomState.code}`;
  $('rosterLabel').textContent = `Players (${roomState.players.length}/${roomState.maxPlayers})`;
  $('roster').innerHTML = roomState.players
    .map((p) => `<li class="pill"><span class="dot${p.connected ? '' : ' off'}"></span>${esc(p.nickname)}${p.playerId === me ? ' (you)' : ''}${p.isHost ? ' <span class="crown">HOST</span>' : ''}${removeButton(p.playerId, p.nickname)}</li>`)
    .join('');
  $('hostPanel').hidden = !isHost();
  $('guestPanel').hidden = isHost();
  if (!isHost()) return;
  renderModes();
  // Telephone passes each chain round the table: it needs three to be worth it.
  const need = drawMode === 'telephone' ? 3 : 2;
  const short = need - roomState.players.length;
  $('startBtn').disabled = short > 0;
  $('lobbyErr').textContent = short > 0 ? `Waiting for ${short === 1 ? 'one more player' : `${short} more players`} to join${drawMode === 'telephone' ? ' — Telephone needs three' : ''}.` : '';
  if (!options) {
    socket.emit('draw:options', {}, (res) => {
      options = res;
      // Difficulty first: it must never depend on the picker below having loaded. Easy by default:
      // a character has to be recognisable from a sketch.
      $('difficultySelect').innerHTML = (res?.difficulties ?? [])
        .map((d) => `<option value="${esc(d.key)}"${d.key === 'easy' ? ' selected' : ''}>${esc(d.label)}: ${esc(d.blurb)}</option>`)
        .join('');
      // Its own memory: what a room likes to draw is not what it likes to wear.
      poolPicker = GTC.mountPoolPicker($('poolPicker'), { options: res, request: ask, storageKey: 'gtc_draw_pool' });
    });
  }
}

// The host's way past someone who has walked away: in the lobby, and on the board mid-game, where
// an absent player otherwise costs the room a full clock every time their turn to draw comes up.
// Never on the host's own row, and never on someone who has already gone.
// `compact` for the in-game player list, whose rows have no room for the word.
function removeButton(id, name, { compact = false } = {}) {
  if (!isHost() || id === me) return '';
  const label = `Remove ${esc(name)}`;
  return compact
    ? `<button class="rmbtn icon" data-kick="${esc(id)}" data-name="${esc(name)}" aria-label="${label}" title="${label}">✕</button>`
    : `<button class="rmbtn" data-kick="${esc(id)}" data-name="${esc(name)}" aria-label="${label}">Remove</button>`;
}

function kick(e) {
  const b = e.target.closest('[data-kick]');
  if (!b) return;
  const mid = roomState?.status === 'playing';
  const cost = mid ? ' Their score stays on the board; if they are drawing, the turn ends.' : '';
  if (!confirm(`Remove ${b.dataset.name} from the ${mid ? 'game' : 'room'}?${cost}`)) return;
  b.disabled = true;
  socket.emit('room:kick', { playerId: b.dataset.kick }, (res) => {
    b.disabled = false;
    if (!res?.ok) toast(esc(res?.error || 'Could not remove them.'));
  });
}
$('roster').addEventListener('click', kick);
$('players').addEventListener('click', kick);

socket.on('room:kicked', ({ reason } = {}) => {
  backToStart();
  $('landingErr').textContent = reason || 'You were removed from the room.';
});

// How to play: Classic (turns) or Telephone (everyone at once, passed along). Remembered here.
let drawMode = store.get('gtc_draw_mode') === 'telephone' ? 'telephone' : 'classic';
function renderModes() {
  for (const b of document.querySelectorAll('#modes [data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === drawMode));
  // Telephone has no rounds: every chain goes once round the table.
  $('roundsField').hidden = drawMode === 'telephone';
}
$('modes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  drawMode = b.dataset.mode;
  store.set('gtc_draw_mode', drawMode);
  renderRoom();
});

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
      mode: drawMode,
    },
    (res) => {
      $('startBtn').disabled = false;
      if (!res?.ok) $('lobbyErr').textContent = res?.error || 'Could not start.';
    }
  );
});

// --- the picture -----------------------------------------------------------------------------
const canvas = $('canvas');
// Any canvas: the live one, and the end screen's thumbnails and viewer, which must draw a stroke
// exactly as the game did. `h` is the picture's height, which an exported image (with its caption
// strip below) does not share with the canvas.
function strokeOn(cv, s, from, h = cv.height) {
  if (!s.points.length) return;
  if (s.kind === 'fill') return floodFill(cv, s.points[0], s.color, h);
  const c = cv.getContext('2d');
  const w = cv.width;
  c.strokeStyle = s.color;
  c.fillStyle = s.color;
  c.lineWidth = (s.size * w) / 800; // sizes are in units of an 800px-wide picture, scaled to the canvas
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (s.points.length === 1) {
    // A tap is a dot, not nothing.
    const [x, y] = s.points[0];
    c.beginPath();
    c.arc(x * w, y * h, c.lineWidth / 2, 0, Math.PI * 2);
    c.fill();
    return;
  }
  const start = Math.max(0, from - 1);
  c.beginPath();
  c.moveTo(s.points[start][0] * w, s.points[start][1] * h);
  for (let i = start + 1; i < s.points.length; i++) c.lineTo(s.points[i][0] * w, s.points[i][1] * h);
  c.stroke();
}
const strokeSegment = (s, from) => strokeOn(canvas, s, from);

// The fill bucket: the colour under the point, and everything touching it within FILL_TOLERANCE,
// becomes the pen's colour -- then one pixel more all round, so the soft (anti-aliased) edge of a
// line does not leave a pale seam between the fill and the line. Bounded to the picture's own
// height: an exported image has a caption strip below it that a fill must not leak into.
const FILL_TOLERANCE = 96; // summed over R, G and B
function floodFill(cv, [fx, fy], color, h = cv.height) {
  const c = cv.getContext('2d');
  const w = cv.width;
  const x0 = Math.min(w - 1, Math.max(0, Math.floor(fx * w)));
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(fy * h)));
  const img = c.getImageData(0, 0, w, h);
  const d = img.data;
  const at = (y0 * w + x0) * 4;
  const [tr, tg, tb] = [d[at], d[at + 1], d[at + 2]];
  const n = parseInt(color.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  if (Math.abs(tr - r) + Math.abs(tg - g) + Math.abs(tb - b) < 6) return; // already that colour
  const like = (p) => Math.abs(d[p * 4] - tr) + Math.abs(d[p * 4 + 1] - tg) + Math.abs(d[p * 4 + 2] - tb) <= FILL_TOLERANCE;
  const hit = new Uint8Array(w * h);
  // Scanline: fill a run, then queue the rows above and below it -- one stack entry per run.
  const stack = [x0, y0];
  while (stack.length) {
    const y = stack.pop();
    let x = stack.pop();
    while (x > 0 && !hit[y * w + x - 1] && like(y * w + x - 1)) x--;
    let up = false;
    let down = false;
    for (; x < w && !hit[y * w + x] && like(y * w + x); x++) {
      hit[y * w + x] = 1;
      if (y > 0) {
        const a = !hit[(y - 1) * w + x] && like((y - 1) * w + x);
        if (a && !up) stack.push(x, y - 1);
        up = a;
      }
      if (y < h - 1) {
        const a = !hit[(y + 1) * w + x] && like((y + 1) * w + x);
        if (a && !down) stack.push(x, y + 1);
        down = a;
      }
    }
  }
  const paint = (p) => {
    d[p * 4] = r;
    d[p * 4 + 1] = g;
    d[p * 4 + 2] = b;
    d[p * 4 + 3] = 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (hit[p]) paint(p);
      else if ((x > 0 && hit[p - 1]) || (x < w - 1 && hit[p + 1]) || (y > 0 && hit[p - w]) || (y < h - 1 && hit[p + w])) paint(p);
    }
  }
  c.putImageData(img, 0, 0);
}

/** A whole drawing on any canvas, on white paper. */
function paintDrawing(cv, list, h = cv.height) {
  const c = cv.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, cv.width, h);
  for (const s of list) strokeOn(cv, s, 0, h);
}

// --- the pad ---------------------------------------------------------------------------------
// A canvas to draw on: the pointer, the strokes on it, and its pieces sent every PIECE_MS. Made
// twice -- the classic game's canvas, and Telephone's (telephone.js on this page) -- each with its
// own strokes and its own events. One pen and one tools row serve both: activePad is whichever
// is in use.
// tool: 'brush' (the sizes) or 'fill' (the bucket) -- picking a size picks the brush.
let pen = { color: null, size: null, tool: 'brush' }; // colour and size set by takeTools
let seq = 0;
// Prefixes this page's stroke ids, which every screen in the room receives -- random, so they
// say nothing about the player id they used to be cut from.
const STROKE_TAG = Math.random().toString(36).slice(2, 10);
const PIECE_MS = 50;
const pads = [];
setInterval(() => pads.forEach((pad) => pad.flush()), PIECE_MS);

// The pen-on-paper sound (sound.js scribble) for a run of points drawn over `seconds`: as loud as
// the pen was fast. A pause between moves reads as a slow stroke, not a fast one.
function scribbleOver(points, seconds, size) {
  if (!window.GTCSound?.scribble || points.length < 2) return;
  let dist = 0;
  for (let i = 1; i < points.length; i++) dist += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  window.GTCSound.scribble(dist / Math.max(0.016, seconds), size);
}

function makePad(cv, { canDraw, send, undo, clear }) {
  const pad = { cv, strokes: [], live: null, pending: [], canDraw };
  const pointOf = (e) => {
    const r = cv.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
  };
  pad.redraw = () => paintDrawing(cv, pad.strokes);
  pad.flush = () => {
    if (!pad.live || !pad.pending.length) return;
    send({ id: pad.live.id, color: pad.live.color, size: pad.live.size, points: pad.pending });
    pad.pending = [];
  };
  pad.undo = () => undo(pad);
  pad.clear = () => clear(pad);
  cv.addEventListener('pointerdown', (e) => {
    if (!pad.canDraw()) return;
    if (pen.tool === 'fill') {
      // One tap, one fill: sent whole, painted here at once, and never a live stroke to extend.
      const fill = { id: `${STROKE_TAG}-${++seq}`, kind: 'fill', color: pen.color, size: 0, points: [pointOf(e)] };
      pad.strokes.push(fill);
      strokeOn(cv, fill, 0);
      send(fill);
      return;
    }
    // Keeps the stroke when the pen leaves the canvas mid-line. Can refuse (a pointer the browser
    // no longer tracks), and a refusal must not cost the stroke.
    try { cv.setPointerCapture(e.pointerId); } catch { /* draw without capture */ }
    pad.live = { id: `${STROKE_TAG}-${++seq}`, color: pen.color, size: pen.size, points: [pointOf(e)] };
    pad.strokes.push(pad.live);
    pad.pending = [...pad.live.points];
    pad.movedAt = performance.now();
    strokeOn(cv, pad.live, 0);
  });
  cv.addEventListener('pointermove', (e) => {
    const live = pad.live;
    if (!live) return;
    const p = pointOf(e);
    const last = live.points[live.points.length - 1];
    if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.002) return; // not worth a point
    live.points.push(p);
    pad.pending.push(p);
    strokeOn(cv, live, live.points.length - 1);
    // Your own pen is heard at once, from your hand, not after the server echoes it.
    const t = performance.now();
    scribbleOver([last, p], (t - (pad.movedAt ?? t - 16)) / 1000, live.size);
    pad.movedAt = t;
  });
  const endStroke = () => {
    pad.flush();
    pad.live = null;
  };
  cv.addEventListener('pointerup', endStroke);
  cv.addEventListener('pointercancel', endStroke);
  pads.push(pad);
  pad.redraw();
  return pad;
}

// The classic game's canvas. The server holds its picture: an undo or a clear is answered with the
// whole of it (draw:canvas), so neither is done here first.
const mainPad = makePad(canvas, {
  canDraw: () => view?.isDrawer && view.phase === 'drawing',
  send: (piece) => socket.emit('draw:stroke', piece),
  undo: () => socket.emit('draw:undo'),
  clear: () => socket.emit('draw:clear'),
});
let activePad = mainPad;
const canDraw = () => mainPad.canDraw();
const redraw = () => mainPad.redraw();

// Someone else's stroke arriving in pieces.
socket.on('draw:stroke', (piece) => {
  let s = mainPad.strokes.find((x) => x.id === piece.id);
  if (!s) {
    s = { id: piece.id, ...(piece.kind ? { kind: piece.kind } : {}), color: piece.color, size: piece.size, points: [] };
    mainPad.strokes.push(s);
  }
  const from = s.points.length;
  s.points.push(...piece.points);
  strokeSegment(s, from);
  // The drawer's pen, heard as the picture grows. A piece covers PIECE_MS of their drawing, and
  // starts where the last one ended.
  if (s.kind !== 'fill') scribbleOver(s.points.slice(Math.max(0, from - 1)), PIECE_MS / 1000, s.size);
});
// The whole picture: a new turn (empty), an undo or clear, or a reconnect catching up.
socket.on('draw:canvas', ({ strokes: all }) => {
  mainPad.strokes = (all ?? []).map((s) => ({ ...s, points: [...s.points] }));
  redraw();
});

function renderTools() {
  $('swatches').innerHTML = PALETTE.map(
    ([c, name]) => `<button class="swatch${pen.color === c ? ' on' : ''}" style="background:${esc(c)}" data-color="${esc(c)}" title="${esc(name)}" aria-label="${esc(name)}" aria-pressed="${pen.color === c}"></button>`
  ).join('');
  const brush = pen.tool === 'brush';
  $('sizes').innerHTML =
    SIZES.map(
      (s, i) => `<button class="size${brush && pen.size === s ? ' on' : ''}" data-size="${s}" aria-label="Brush size ${i + 1} of ${SIZES.length}" aria-pressed="${brush && pen.size === s}"><i style="width:${Math.min(28, 4 + s * 0.7)}px;height:${Math.min(28, 4 + s * 0.7)}px"></i></button>`
    ).join('') +
    // The bucket sits with the sizes: one choice of what a touch does, so picking one un-picks the other.
    `<button class="size fill${brush ? '' : ' on'}" data-tool="fill" aria-label="Fill" title="Fill an area with the colour" aria-pressed="${!brush}"><span aria-hidden="true">Fill</span></button>`;
  for (const pad of pads) pad.cv.classList.toggle('filling', !brush);
}
$('swatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  if (!b) return;
  pen.color = b.dataset.color;
  renderTools();
});
$('sizes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-size], [data-tool]');
  if (!b) return;
  if (b.dataset.tool === 'fill') pen.tool = 'fill';
  else {
    pen.tool = 'brush';
    pen.size = Number(b.dataset.size);
  }
  renderTools();
});
renderTools();
$('undoBtn').addEventListener('click', () => activePad.undo());
$('clearBtn').addEventListener('click', () => activePad.clear());
document.addEventListener('keydown', (e) => {
  if (activePad.canDraw() && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.closest?.('input')) {
    e.preventDefault();
    activePad.undo();
  }
});

// --- reactions -------------------------------------------------------------------------------
const REACTION_GLYPH = { star: '★', wow: '!!', huh: '?!', ha: 'ha' };
$('reactions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-react]');
  if (!b) return;
  // The float comes back from the server like everyone else's, so a refused tap shows nothing.
  socket.emit('draw:react', { kind: b.dataset.react }, (res) => {
    if (res && !res.ok && res.error) toast(esc(res.error), 2500, { max: 2 });
  });
});
// Over the picture, anywhere along it; a dozen at once at most, so a burst cannot bury the drawing.
socket.on('draw:reaction', ({ kind } = {}) => {
  const glyph = REACTION_GLYPH[kind];
  if (!glyph) return;
  const wrap = canvas.parentElement;
  if (wrap.querySelectorAll('.floater').length >= 12) return;
  const f = document.createElement('span');
  f.className = `floater r-${kind}`;
  f.setAttribute('aria-hidden', 'true');
  f.textContent = glyph;
  f.style.left = `${8 + Math.random() * 80}%`;
  f.addEventListener('animationend', () => f.remove());
  setTimeout(() => f.remove(), 2500); // and if no animation runs at all
  wrap.append(f);
});

// --- the game --------------------------------------------------------------------------------
let clockTimer = null;
// "Nearly out of time": the clock bar turns colour here, and the hurry cue sounds as it does.
const CRIT_SECONDS = 10;
// `onTick(left)`: told each second's value, for the cue below.
// `ids`: the classic game's clock by default; Telephone has one of its own (tel.js).
function setClock(seconds, total, onTick = null, paused = false, ids = { secs: 'clockSecs', fill: 'clockFill', bar: 'clock' }) {
  clearInterval(clockTimer);
  let left = seconds;
  const draw = () => {
    $(ids.secs).textContent = left == null ? '' : `${left}s`;
    $(ids.fill).style.width = left == null ? '100%' : `${Math.max(0, (left / (total || 80)) * 100)}%`;
    // The colour carries "nearly out of time" without anything moving.
    $(ids.bar).classList.toggle('crit', left != null && left <= CRIT_SECONDS);
    onTick?.(left);
  };
  draw();
  // Paused by the host: the reading it stopped at, standing still.
  if (left == null || paused) return;
  clockTimer = setInterval(() => {
    if (left > 0) left -= 1;
    draw();
  }, 1000);
}

function characterArt(c) {
  return c?.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="" referrerpolicy="no-referrer" />` : '<span class="hint">No picture</span>';
}

// The cue for each phase of each turn, sounded once however many states that phase sends (every
// guess sends one). Keyed by round and drawer as well as phase, so a turn is never mistaken for
// the last one.
let heardPhase = '';
// The hurry cue sounds once per drawing turn, as the clock is SEEN to cross into the last ten
// seconds -- so a reload with nine seconds left does not knock the moment it arrives.
let hurry = { turn: '', above: false, done: false };
function hurryWatch(turn) {
  if (hurry.turn !== turn) hurry = { turn, above: false, done: false };
  return (left) => {
    if (left == null) return;
    if (left > CRIT_SECONDS) hurry.above = true;
    else if (left > 0 && hurry.above && !hurry.done) {
      hurry.done = true;
      sound('hurry');
    }
  };
}

socket.on('draw:state', (v) => {
  const turnChanged = !view || view.drawer.playerId !== v.drawer.playerId || view.phase !== v.phase;
  // A new drawer is a new chat: the server starts its own afresh each turn, so this player's own
  // lines ("... is close!") go with it rather than piling up under the next drawing.
  if (!view || view.drawer.playerId !== v.drawer.playerId || view.round !== v.round) localLines = [];
  view = v;
  // A rematch from the end screen: last game's drawing must not stay open over the new one.
  closeViewer();
  show('game');
  renderGame(turnChanged);
  const phase = `${v.round}:${v.drawer.playerId}:${v.phase}`;
  if (phase !== heardPhase) {
    heardPhase = phase;
    if (v.phase === 'choosing' && v.isDrawer) sound('turn');
    if (v.phase === 'reveal') sound('reveal');
  }
});

// The tools row is one element: Telephone borrows it (tel.js); the classic game takes it back.
const toolsHome = $('tools').parentElement;
function homeTools() {
  if ($('tools').parentElement !== toolsHome) toolsHome.insertBefore($('tools'), $('reactions'));
  activePad = mainPad;
}

function renderGame(turnChanged) {
  homeTools();
  const v = view;
  $('roundLabel').textContent = `Round ${v.round} of ${v.rounds}`;
  // Choosing has no clock (secondsLeft is null): the bar sits full and says nothing.
  const total = v.phase === 'reveal' ? 6 : v.drawSeconds;
  setClock(v.secondsLeft, total, v.phase === 'drawing' ? hurryWatch(`${v.round}:${v.drawer.playerId}`) : null, v.paused);

  // The clue: the drawer and anyone who has it see the name; everyone else the blanks from half
  // time, and until then when they will come.
  const turnKey = `${v.round}:${v.drawer.playerId}`;
  if (v.phase !== 'drawing') setMask('', '');
  else if (v.character) setMask(`name|${v.shownAs ?? v.character.name}`, esc(v.shownAs ?? v.character.name));
  else if (v.mask) renderBlanks(v.mask, turnKey);
  else if (v.maskAt != null) setMask(`later|${v.maskAt}`, `<span class="tag later">Blanks at ${v.maskAt}s</span>`);
  else setMask('', '');

  // Where it is from. Rewritten only when it changes, so the live region announces each hint
  // once, as it arrives, rather than on every guess that sends a new view.
  const clue = v.phase === 'drawing' ? v.clue : null;
  const clueHtml = clue
    ? [
        clue.category ? `<span class="tag">${esc(clue.category)}</span>` : '',
        clue.categoryAt != null ? `<span class="tag later">Category at ${clue.categoryAt}s</span>` : '',
        clue.work ? `<span class="tag work" title="The title, with any word of the name blanked">${esc(clue.work)}</span>` : '',
        clue.workAt != null ? `<span class="tag later">Title at ${clue.workAt}s</span>` : '',
      ].join('')
    : '';
  // Compared by the string built here, not innerHTML: the browser re-serialises what it was given.
  if ($('clueBar').dataset.key !== clueHtml) {
    $('clueBar').dataset.key = clueHtml;
    $('clueBar').innerHTML = clueHtml;
  }

  // The drawer's reference picture, for as long as they draw. Repainted only when the character
  // changes: every guess sends a new view, and resetting the <img> each time would make it blink.
  const ref = v.phase === 'drawing' && v.isDrawer ? v.character : null;
  $('refCard').hidden = !ref;
  // What else the drawer said would count, beside the picture they draw from.
  const also = ref ? v.alsoAccept ?? [] : [];
  $('refAccept').hidden = !also.length;
  $('refAccept').textContent = also.length ? `Also accepting: ${also.join(', ')}` : '';
  const refKey = ref ? `${ref.name}|${ref.imageUrl ?? ''}` : '';
  if ($('refCard').dataset.key !== refKey) {
    $('refCard').dataset.key = refKey;
    $('refArt').innerHTML = ref ? characterArt(ref) : '';
    $('refName').textContent = ref ? ref.name : '';
  }

  renderPlayers();

  // Overlays on the picture: choosing, waiting for the drawer to choose, the reveal.
  $('chooseOverlay').hidden = !(v.phase === 'choosing' && v.isDrawer);
  // The confirm dialog is for one choice of one turn: gone with the turn (picked, the game over,
  // removed by the host) or with the choice itself.
  if (confirming && !(v.phase === 'choosing' && v.isDrawer && v.choices?.[confirming.index]?.name === confirming.name)) closeConfirm();
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
    // As the blanks spelled it, with the library's name beside it when the drawer chose another.
    $('revealTitle').textContent = lt.character ? `It was ${lt.shownAs ? `${lt.shownAs} (${lt.character.name})` : lt.character.name}` : 'Turn over';
    $('revealArt').innerHTML = characterArt(lt.character);
    const why =
      lt.reason === 'all'
        ? 'Everyone got it!'
        : lt.reason === 'given-up'
          ? 'Nobody left guessing.'
          : lt.reason === 'drawer-left'
            ? `${lt.drawer} left.`
            : "Time's up.";
    const got = lt.guessed.length
      ? lt.guessed.map((x) => `${esc(x.name)} +${x.points}`).join(', ') + ` -- ${esc(lt.drawer)} +${lt.drawerPoints} for drawing`
      : 'Nobody got it.';
    const quit = lt.gaveUp?.length ? ` Gave up: ${lt.gaveUp.map(esc).join(', ')}.` : '';
    const also = lt.alsoAccepted?.length ? ` Also accepted: ${lt.alsoAccepted.map(esc).join(', ')}.` : '';
    $('revealPoints').innerHTML = `${esc(why)} ${got}${quit}${also}`;
  }

  $('tools').hidden = !(v.isDrawer && v.phase === 'drawing');
  $('reactions').hidden = !(!v.isDrawer && v.phase === 'drawing' && !v.paused);
  canvas.classList.toggle('can-draw', canDraw());

  // The chat box: a guess box for those still guessing; a quiet word with the others who know
  // for the drawer, anyone who has it, and anyone who gave up on it.
  const knows = v.isDrawer || v.guessedIt || v.gaveUpIt;
  $('giveUpBtn').hidden = !(v.phase === 'drawing' && !knows);
  // The heading stays one word; who can read what you type is said in the box itself, where it is
  // read at the moment it matters (and a long heading wrapped to two lines on a phone).
  $('chatTitle').textContent = v.phase === 'drawing' && knows ? 'Chat' : 'Guesses';
  $('chatInput').placeholder =
    v.phase === 'drawing' ? (knows ? 'Only those who know see this' : 'Type your guess') : 'Say something';
  renderChat();
  if (turnChanged && v.phase === 'drawing' && !v.isDrawer) $('chatInput').focus();
}

// --- the blanks ------------------------------------------------------------------------------
// Rewritten only when what they say changes -- every guess sends a view, and rebuilding the slots
// each time would replay the newest letter's pen stroke on every guess.
function setMask(key, html, cls = '') {
  const el = $('mask');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.className = `mask${cls ? ` ${cls}` : ''}`;
  el.innerHTML = html;
}
// Which letters this page has already shown, this turn: only a letter it has not is written in.
// A page that arrives mid-turn (a reload) sees what is there already standing still.
let inked = { turn: '', at: new Set() };
const isLetterCh = (ch) => /[\p{L}\p{N}]/u.test(ch);
function renderBlanks(mask, turn) {
  const firstSight = inked.turn !== turn;
  if (firstSight) inked = { turn, at: new Set() };
  const chars = [...mask];
  const shown = chars.map((ch, i) => (ch !== '_' && isLetterCh(ch) ? i : -1)).filter((i) => i >= 0);
  const fresh = firstSight ? new Set() : new Set(shown.filter((i) => !inked.at.has(i)));
  for (const i of shown) inked.at.add(i);
  // Words kept whole (a slot run never breaks mid-word); slots numbered for the underline cascade.
  const words = [[]];
  chars.forEach((ch, i) => (ch === ' ' ? words.push([]) : words[words.length - 1].push([ch, i])));
  let n = 0;
  const slot = ([ch, i]) => {
    if (ch === '_') return `<span class="slot" style="--i:${n++}"></span>`;
    if (!isLetterCh(ch)) return `<span class="punct">${esc(ch)}</span>`;
    return `<span class="slot inked${fresh.has(i) ? ' fresh' : ''}" style="--i:${n++};--rot:${GTC.ANGLES[i % GTC.ANGLES.length]}deg"><b>${esc(ch)}</b></span>`;
  };
  // A screen reader gets it in words ("blank" for each gap), not as a row of empty boxes.
  const spoken = words.map((w) => w.map(([ch]) => (ch === '_' ? 'blank' : ch)).join(' ')).join(', ');
  const html =
    `<span class="sr">${esc(spoken)}</span>` +
    words.map((w) => `<span class="mword" aria-hidden="true">${w.map(slot).join('')}</span>`).join('') +
    `<span class="len" aria-hidden="true">(${words.map((w) => w.length).join(' ')})</span>`;
  setMask(`blanks|${turn}|${mask}`, html, firstSight ? 'blanks drawlines' : 'blanks');
}

// Also from room:state, which is what says who the host is now: a host who leaves mid-game hands
// the Remove buttons on, and the next view could be a whole drawing away.
// Rewritten only when it changes: a view arrives with every guess, and replacing the list between
// the press and release of a Remove button would swallow the click.
let lastPlayersHtml = '';
function renderPlayers() {
  if (!view) return;
  const html = view.players
    .map((p) => {
      const tag = p.drawing
        ? '<span class="tag drawing">▲ Drawing</span>'
        : p.guessed
          ? '<span class="tag got">✓ Got it</span>'
          : p.gaveUp
            ? '<span class="tag gaveup">Gave up</span>'
            : '';
      const name = `${esc(p.name)}${p.playerId === me ? ' (you)' : ''}`;
      return `<li class="${p.guessed ? 'got' : ''}${p.left ? ' left' : ''}"><span class="pname" title="${name}">${name}</span>${tag}<span class="score">${p.score}</span>${p.left ? '' : removeButton(p.playerId, p.name, { compact: true })}</li>`;
    })
    .join('');
  if (html !== lastPlayersHtml) $('players').innerHTML = lastPlayersHtml = html;
}

// Picking is two steps: the card, then the dialog saying what will count (the server's
// acceptedNames, so it is the judge's own answer) with room for another name. The clock starts
// only on Start Drawing.
let confirming = null; // { index, name } of the choice the dialog is open for
function openConfirm(index) {
  const c = view?.choices?.[index];
  if (!c) return;
  confirming = { index, name: c.name, choice: c };
  $('confirmArt').innerHTML = characterArt(c);
  $('confirmName').textContent = c.name;
  $('confirmCounts').innerHTML = (c.accepts ?? [c.name]).map((n) => `<li>${esc(n)}</li>`).join('');
  // Other names are for this character: starting blank each time, so Back and another pick
  // cannot carry one character's names onto the next.
  $('alsoAccept').value = '';
  renderSpellings(c, c.name);
  $('confirmGo').disabled = false;
  $('confirmPick').showModal();
  // Straight into the box with a keyboard to hand; on a phone the button keeps the focus
  // (autofocus), so the on-screen keyboard does not cover the names on opening.
  if (matchMedia('(pointer: fine)').matches) $('alsoAccept').focus();
}
// The spellings the blanks may take, as the server allows them (game.js spellingsFor): the name,
// its words swapped when the server offers that (romanised names), and each name typed above --
// cleaned as the server cleans them, so what is offered here is what the server will take.
function spellingOptions(c) {
  const typed = $('alsoAccept')
    .value.split(/[,\n]/)
    .map((s) => s.trim().slice(0, 40))
    .filter((s) => s.replace(/[^\p{L}\p{N}]/gu, '').length >= 1);
  const out = [c.name, ...(c.swapped ? [c.swapped] : [])];
  for (const n of [...new Set(typed)].slice(0, 3)) if (!out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  return out;
}
function renderSpellings(c, keep) {
  const options = spellingOptions(c);
  const picked = options.includes(keep) ? keep : c.name;
  $('confirmSpellings').innerHTML = options
    .map((o) => `<label><input type="radio" name="spelling" value="${esc(o)}"${o === picked ? ' checked' : ''} />${esc(o)}</label>`)
    .join('');
}
const pickedSpelling = () => document.querySelector('#confirmSpellings input:checked')?.value ?? null;
// Typing another name offers it as a spelling at once; what was picked stays picked while it exists.
$('alsoAccept').addEventListener('input', () => confirming && renderSpellings(confirming.choice, pickedSpelling()));

function closeConfirm() {
  confirming = null;
  if ($('confirmPick').open) $('confirmPick').close();
}
$('confirmPick').addEventListener('close', () => {
  confirming = null;
});
$('confirmBack').addEventListener('click', closeConfirm);
$('confirmForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!confirming) return;
  $('confirmGo').disabled = true; // once; the next view closes the dialog
  socket.emit('draw:choose', { index: confirming.index, alsoAccept: $('alsoAccept').value, shownAs: pickedSpelling() }, (res) => {
    if (res && !res.ok) {
      $('confirmGo').disabled = false;
      toast(esc(res.error));
    }
  });
});

$('pick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (b) openConfirm(Number(b.dataset.i));
});

$('rerollChoicesBtn').addEventListener('click', () => {
  const b = $('rerollChoicesBtn');
  b.disabled = true; // one request at a time; the new view re-enables it
  socket.emit('draw:reroll', {}, (res) => {
    b.disabled = false;
    if (res && !res.ok) toast(esc(res.error));
  });
});

// The server's chat, plus the lines only this player sees: their own close calls.
let localLines = [];
function renderChat() {
  // A right or close guess reaches only those who know (the drawer sees them all), and says which
  // it was: ✓ for right, "close" for close.
  const server = (view?.chat ?? []).map((m) => ({
    key: `m${m.id}`,
    cls: m.kind === 'correct' ? 'insider right' : m.kind === 'close' ? 'insider near' : m.insider ? 'insider' : '',
    html:
      `<span class="who">${esc(m.name)}:</span> ${m.kind === 'correct' ? '✓ ' : ''}${esc(m.text)}` +
      (m.kind === 'close' ? ' <span class="kind">close</span>' : ''),
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

// "Got it" is an announcement, not chat, so it is a toast that goes away rather than a line in the
// chat box: in a room of six, one turn's worth of them pushed the guesses off the top, and they
// piled up turn after turn. Who has it stays visible where it belongs -- the player list's tag.
// The guesser's own comes from here too (the ack says nothing), so they see it once.
socket.on('draw:correct', ({ playerId: who, name, points }) => {
  // Two at most: a room guessing it in a burst would stack them up over the chat box above.
  toast(who === me ? `✓ You got it! +${points}` : `✓ ${esc(name)} got it! +${points}`, 3500, { max: 2 });
  // To everyone, the guesser included -- so the guesser's own cue is played here too, not on the
  // ack, or they would hear two.
  sound(who === me ? 'gotMine' : 'got');
});

// Giving up shows you the answer, which cannot be taken back -- so it asks first.
$('giveUpBtn').addEventListener('click', () => {
  if (!confirm("Give up on this drawing? You'll see who it is, and score nothing for it.")) return;
  socket.emit('draw:giveup', {}, (res) => {
    if (!res?.ok) $('chatErr').textContent = res?.error || 'That did not go through.';
  });
});
socket.on('draw:gaveup', ({ playerId: who, name }) => {
  toast(who === me ? 'You gave up.' : `${esc(name)} gave up.`, 3500, { max: 2 });
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
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && view && view.phase !== 'over') socket.emit('draw:resync', {}, () => {});
});

// --- results ---------------------------------------------------------------------------------
socket.on('draw:over', ({ standings, gallery = [], accolades = [], votes: counts = [] }) => {
  telView = null;
  show('over');
  renderGallery(gallery, accolades);
  // A new end screen is a new vote; a page coming back to one is told its own by draw:votes.
  votes = { counts, mine: null };
  renderVotes();
  clearInterval(clockTimer);
  view = null;
  localLines = [];
  heardPhase = '';
  const top = standings.filter((s) => s.place === 1).map((s) => (s.playerId === me ? 'You' : s.name));
  $('overTitle').textContent = top.length ? `${top.join(' and ')} won!` : 'Game over';
  $('standings').innerHTML = standings
    .map((s) => `<li><span class="place">${s.place}</span><div><strong>${esc(s.name)}</strong>${s.left ? ' <span class="hint">(left)</span>' : ''}<div class="hint">${s.score} points</div></div></li>`)
    .join('');
  $('hostOver').hidden = !isHost();
  $('guestOver').hidden = isHost();
  $('overErr').textContent = '';
});
// --- the gallery ------------------------------------------------------------------------------
// Every drawing of the game, from the server's draw:over (draw/gallery.js), as thumbnails that
// open into the viewer. Painted from strokes, not sent as images: a stroke list is a fraction of a
// picture's size, and it paints at whatever size it is shown.
let galleryItems = [];
let viewing = -1;
const gotLine = (d) =>
  !d.guessers ? 'Nobody else was guessing' : d.got.length === d.guessers ? 'Everyone got it' : d.got.length ? `${d.got.length} of ${d.guessers} got it` : 'Nobody got it';
function thumbnail(d) {
  const cv = document.createElement('canvas');
  cv.width = 400;
  cv.height = 300;
  cv.setAttribute('aria-hidden', 'true');
  paintDrawing(cv, d.strokes);
  return cv;
}
function renderGallery(gallery, accolades) {
  galleryItems = gallery;
  closeViewer();
  $('galleryCard').hidden = !gallery.length;
  $('gallery').innerHTML = gallery
    .map((d, i) => {
      const own = d.drawerId === me;
      return `<div class="gitem"><button type="button" class="open" data-view="${i}"><span class="thumb"></span><span class="name">${esc(d.character?.name ?? '?')}</span><span class="hint">by ${esc(d.drawer)} · ${esc(gotLine(d))}</span></button>
        <button type="button" class="vote" data-vote="${i}" aria-pressed="false"${own ? ' disabled title="Your drawing"' : ''} aria-label="Vote for ${esc(d.character?.name ?? 'this drawing')}">★ <span class="n">0</span></button></div>`;
    })
    .join('');
  for (const b of $('gallery').querySelectorAll('[data-view]')) b.querySelector('.thumb').replaceWith(thumbnail(gallery[Number(b.dataset.view)]));
  // Shapes paired with the colours, as everywhere else: ▲ ◆ ● ■.
  const shapes = ['▲', '◆', '●', '■'];
  lastAccolades = accolades;
  $('accoladesCard').hidden = !accolades.length;
  $('accolades').innerHTML = accolades
    .map((a, i) => {
      const thumb = a.drawing != null && gallery[a.drawing] ? `<button type="button" class="thumbbtn" data-view="${a.drawing}" aria-label="See ${esc(gallery[a.drawing].character?.name ?? 'the drawing')}"></button>` : '';
      return `<li><span class="medal" aria-hidden="true">${shapes[i % 4]}</span><div class="what"><div class="title">${esc(a.title)}</div><div class="who">${esc(a.playerId === me ? 'You' : a.name)}</div><div class="detail">${esc(a.detail)}</div></div>${thumb}</li>`;
    })
    .join('');
  for (const b of $('accolades').querySelectorAll('.thumbbtn')) b.append(thumbnail(gallery[Number(b.dataset.view)]));
}
// --- the vote ----------------------------------------------------------------------------------
// One each, changeable, never your own (the server's rule; own drawings' buttons are disabled to
// say so). Crowd Favourite is the leader -- or leaders, tied -- above the other accolades, and moves
// as votes come in.
let lastAccolades = [];
let votes = { counts: [], mine: null };
function renderVotes() {
  for (const b of $('gallery').querySelectorAll('[data-vote]')) {
    const i = Number(b.dataset.vote);
    b.querySelector('.n').textContent = votes.counts[i] ?? 0;
    b.setAttribute('aria-pressed', String(votes.mine === i));
  }
  $('accolades').querySelector('li.crowd')?.remove();
  const top = Math.max(0, ...votes.counts);
  if (top < 1) {
    $('accoladesCard').hidden = !lastAccolades.length;
    return;
  }
  const leaders = votes.counts.map((n, i) => (n === top ? i : -1)).filter((i) => i >= 0);
  const names = [...new Set(leaders.map((i) => (galleryItems[i].drawerId === me ? 'You' : galleryItems[i].drawer)))];
  const detail = leaders.length === 1 ? `★ ${top} for ${galleryItems[leaders[0]].character?.name ?? 'their drawing'}` : `★ ${top} each`;
  const li = document.createElement('li');
  li.className = 'crowd';
  li.innerHTML = `<span class="medal" aria-hidden="true">★</span><div class="what"><div class="title">Crowd Favourite</div><div class="who">${esc(names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0])}</div><div class="detail">${esc(detail)}</div></div><button type="button" class="thumbbtn" data-view="${leaders[0]}" aria-label="See it"></button>`;
  li.querySelector('.thumbbtn').append(thumbnail(galleryItems[leaders[0]]));
  $('accolades').prepend(li);
  $('accoladesCard').hidden = false;
}
$('gallery').addEventListener('click', (e) => {
  const b = e.target.closest('[data-vote]');
  if (!b || b.disabled) return;
  socket.emit('draw:vote', { drawing: Number(b.dataset.vote) }, (res) => {
    if (!res?.ok) return toast(esc(res?.error || 'Could not vote.'));
    votes.mine = res.mine;
    renderVotes();
  });
});
socket.on('draw:votes', ({ counts = [], mine } = {}) => {
  votes.counts = counts;
  if (mine !== undefined) votes.mine = mine;
  renderVotes();
});

function openViewer(i) {
  const d = galleryItems[i];
  if (!d) return;
  viewing = i;
  paintDrawing($('viewerCanvas'), d.strokes);
  $('viewerTitle').textContent = d.character?.realName ? `${d.character.name} (${d.character.realName})` : d.character?.name ?? '?';
  const got = d.got?.length ? ` · ${d.got.map((x) => `${x.name} (${x.seconds}s)`).join(', ')}` : '';
  $('viewerSub').textContent = d.caption ?? `Drawn by ${d.drawer} · ${gotLine(d)}${got}`;
  $('viewerPrev').disabled = i === 0;
  $('viewerNext').disabled = i === galleryItems.length - 1;
  if (!$('viewer').open) $('viewer').showModal();
}
function closeViewer() {
  viewing = -1;
  if ($('viewer').open) $('viewer').close();
}
for (const list of ['gallery', 'accolades']) {
  $(list).addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) openViewer(Number(b.dataset.view));
  });
}
$('viewerPrev').addEventListener('click', () => openViewer(viewing - 1));
$('viewerNext').addEventListener('click', () => openViewer(viewing + 1));
$('viewerClose').addEventListener('click', closeViewer);
$('viewer').addEventListener('close', () => (viewing = -1));
$('viewer').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' && viewing > 0) openViewer(viewing - 1);
  if (e.key === 'ArrowRight' && viewing < galleryItems.length - 1) openViewer(viewing + 1);
});
// The picture as a PNG, with a strip under it saying what it is and who drew it -- a drawing
// saved to a phone's photos is otherwise a mystery a week later.
$('viewerSave').addEventListener('click', () => {
  const d = galleryItems[viewing];
  if (!d) return;
  const out = document.createElement('canvas');
  out.width = 1200;
  out.height = 990;
  paintDrawing(out, d.strokes, 900);
  const c = out.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 900, 1200, 90);
  c.fillStyle = '#e6e2ef';
  c.fillRect(0, 900, 1200, 2);
  c.fillStyle = '#1b1033';
  c.font = '900 34px "Trebuchet MS", system-ui, sans-serif';
  c.textBaseline = 'middle';
  c.fillText(`${d.character?.name ?? '?'} — drawn by ${d.drawer}`, 28, 946, 860);
  c.fillStyle = '#6b6480';
  c.font = '700 24px "Trebuchet MS", system-ui, sans-serif';
  c.textAlign = 'right';
  c.fillText('Draw the Character', 1172, 946);
  const file = `${d.character?.name ?? 'drawing'} by ${d.drawer}`.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'drawing';
  // Built synchronously (toDataURL, not toBlob): the share sheet below only opens straight from the
  // tap, and Safari counts an async callback as no longer the tap.
  const [, b64] = out.toDataURL('image/png').split(',');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'image/png' });
  const download = () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${file}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  // On a phone the share sheet is where Save to Photos lives; a download lands in Files, where
  // nobody looks for a picture. A computer downloads. Cancelling the sheet is not a failure.
  const asFile = typeof File === 'function' ? new File([blob], `${file}.png`, { type: 'image/png' }) : null;
  if (asFile && matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [asFile] })) {
    navigator.share({ files: [asFile] }).catch((e) => {
      if (e?.name !== 'AbortError') download();
    });
    return;
  }
  download();
});

$('rematchBtn').addEventListener('click', () =>
  socket.emit('draw:rematch', {}, (res) => { if (!res?.ok) $('overErr').textContent = res?.error || 'Could not rematch.'; }));
$('againBtn').addEventListener('click', () =>
  socket.emit('draw:again', {}, (res) => { if (!res?.ok) $('overErr').textContent = res?.error || 'Could not restart.'; }));

socket.on('room:error', ({ error } = {}) => ($('landingErr').textContent = error || 'Something went wrong.'));
