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
  view = null;
  clearInterval(clockTimer);
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
  takeTools(state);
  renderRoom();
  renderPlayers();
});

function renderRoom() {
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
  $('startBtn').disabled = roomState.players.length < 2;
  $('lobbyErr').textContent = roomState.players.length < 2 ? 'Waiting for at least one more player to join.' : '';
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
let pen = { color: null, size: null }; // set by takeTools when the room arrives
let live = null; // the stroke being drawn
let pending = [];
let seq = 0;
// Prefixes this page's stroke ids, which every screen in the room receives -- random, so they
// say nothing about the player id they used to be cut from.
const STROKE_TAG = Math.random().toString(36).slice(2, 10);
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
  live = { id: `${STROKE_TAG}-${++seq}`, color: pen.color, size: pen.size, points: [pointOf(e)] };
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
    ([c, name]) => `<button class="swatch${pen.color === c ? ' on' : ''}" style="background:${esc(c)}" data-color="${esc(c)}" title="${esc(name)}" aria-label="${esc(name)}" aria-pressed="${pen.color === c}"></button>`
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
// "Nearly out of time": the clock bar turns colour here, and the hurry cue sounds as it does.
const CRIT_SECONDS = 10;
// `onTick(left)`: told each second's value, for the cue below.
function setClock(seconds, total, onTick = null) {
  clearInterval(clockTimer);
  let left = seconds;
  const draw = () => {
    $('clockSecs').textContent = left == null ? '' : `${left}s`;
    $('clockFill').style.width = left == null ? '100%' : `${Math.max(0, (left / (total || 80)) * 100)}%`;
    // The colour carries "nearly out of time" without anything moving.
    $('clock').classList.toggle('crit', left != null && left <= CRIT_SECONDS);
    onTick?.(left);
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
  show('game');
  renderGame(turnChanged);
  const phase = `${v.round}:${v.drawer.playerId}:${v.phase}`;
  if (phase !== heardPhase) {
    heardPhase = phase;
    if (v.phase === 'choosing' && v.isDrawer) sound('turn');
    if (v.phase === 'reveal') sound('reveal');
  }
});

function renderGame(turnChanged) {
  const v = view;
  $('roundLabel').textContent = `Round ${v.round} of ${v.rounds}`;
  // Choosing has no clock (secondsLeft is null): the bar sits full and says nothing.
  const total = v.phase === 'reveal' ? 6 : v.drawSeconds;
  setClock(v.secondsLeft, total, v.phase === 'drawing' ? hurryWatch(`${v.round}:${v.drawer.playerId}`) : null);

  // The clue: the drawer and anyone who has it see the name; everyone else the blanks.
  if (v.phase === 'drawing') {
    if (v.character) $('mask').textContent = v.character.name;
    else {
      const words = v.mask.split(' ').map((w) => w.length);
      $('mask').innerHTML = `${esc(v.mask)} <span class="len">(${words.join(' ')})</span>`;
    }
  } else $('mask').textContent = '';

  // Where it is from. Rewritten only when it changes, so the live region announces the title
  // once, at half time, rather than on every guess that sends a new view.
  const clue = v.phase === 'drawing' ? v.clue : null;
  const clueHtml = clue
    ? [
        clue.category ? `<span class="tag">${esc(clue.category)}</span>` : '',
        clue.work ? `<span class="tag work" title="The title, with any word of the name blanked">${esc(clue.work)}</span>` : '',
        clue.workLater ? '<span class="tag later">Title at half time</span>' : '',
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
    $('revealTitle').textContent = lt.character ? `It was ${lt.character.name}` : 'Turn over';
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
  canvas.classList.toggle('can-draw', canDraw());

  // The chat box: a guess box for those still guessing; a quiet word with the others who know
  // for the drawer, anyone who has it, and anyone who gave up on it.
  const knows = v.isDrawer || v.guessedIt || v.gaveUpIt;
  $('giveUpBtn').hidden = !(v.phase === 'drawing' && !knows);
  $('chatTitle').textContent = v.phase === 'drawing' && knows ? 'Chat (only others who know see yours)' : 'Guesses';
  $('chatInput').placeholder = v.phase === 'drawing' && !knows ? 'Type your guess' : 'Say something';
  renderChat();
  if (turnChanged && v.phase === 'drawing' && !v.isDrawer) $('chatInput').focus();
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
  confirming = { index, name: c.name };
  $('confirmArt').innerHTML = characterArt(c);
  $('confirmName').textContent = c.name;
  $('confirmCounts').innerHTML = (c.accepts ?? [c.name]).map((n) => `<li>${esc(n)}</li>`).join('');
  // Other names are for this character: starting blank each time, so Back and another pick
  // cannot carry one character's names onto the next.
  $('alsoAccept').value = '';
  $('confirmGo').disabled = false;
  $('confirmPick').showModal();
  // Straight into the box with a keyboard to hand; on a phone the button keeps the focus
  // (autofocus), so the on-screen keyboard does not cover the names on opening.
  if (matchMedia('(pointer: fine)').matches) $('alsoAccept').focus();
}
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
  socket.emit('draw:choose', { index: confirming.index, alsoAccept: $('alsoAccept').value }, (res) => {
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
socket.on('draw:over', ({ standings }) => {
  show('over');
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
$('rematchBtn').addEventListener('click', () =>
  socket.emit('draw:rematch', {}, (res) => { if (!res?.ok) $('overErr').textContent = res?.error || 'Could not rematch.'; }));
$('againBtn').addEventListener('click', () =>
  socket.emit('draw:again', {}, (res) => { if (!res?.ok) $('overErr').textContent = res?.error || 'Could not restart.'; }));

socket.on('room:error', ({ error } = {}) => ($('landingErr').textContent = error || 'Something went wrong.'));
