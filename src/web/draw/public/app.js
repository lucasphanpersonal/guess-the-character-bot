// Draw the Character -- the client.
//
// Talks to the /draw socket.io namespace (src/web/draw/socket.js). The server decides everything
// -- whose turn, the answer, the clock, the score -- and this draws what it is sent. The one thing
// drawn locally first is the drawer's own pen, so it never lags their hand; every stroke still
// goes through the server, which checks it and passes it on.
//
// The picture is kept in 0..1 coordinates, so it looks the same on every screen size.
//
// Plain scripts, one global scope, loaded in this order (index.html):
//
//   app.js      this: the room, the lobby, the game screen, the blanks, the chat, reactions
//   pad.js      the picture and the pad (makePad), shared with Telephone
//   gallery.js  results, the gallery and viewer, the vote
//   tel.js      Telephone
//   boot.js     connects the socket -- LAST
//
// A function may call into a later file only once that file has run, so nothing at the top level
// here does; and the socket is created here but connected only in boot.js, or an event arriving
// while pad.js was still downloading would reach for a mainPad that did not exist yet.

const { $, esc, store, show, toast, wobble, roomCodeHtml } = GTC;
const playerId = GTC.playerIdFor('gtc_draw_player');
// Not connected until boot.js: see above.
const socket = io('/draw', { auth: { playerId }, autoConnect: false });
// `playerId` above is this browser's SECRET: it goes in the handshake and nowhere else. The server
// seats us under a public id derived from it, and that is the id every roster and view uses -- so
// "is this me?" is always asked of `me`, never of the secret.
let me = null;
socket.on('hello', ({ you }) => {
  me = you;
});
wobble($('title'), 'Doodle Dash');
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
GTC.bindCrtToggles();

// Sound (/shared/sound.js): your turn to draw, someone getting it, time nearly up, the reveal.
// Optional-chained: a missing sound script costs the cues, never the game, and hides the switch.
const sound = (cue, ...args) => window.GTCSound?.play(cue, ...args);
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
  GTC.forgetRosters(); // the room may have changed while this page was away (common.js)
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
  GTC.forgetRosters();
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
  if (GTC.someoneArrived(roomState.code, roomState.players, me)) sound('join');
  $('rosterLabel').textContent = `Players (${roomState.players.length}/${roomState.maxPlayers})`;
  window.GTCFx?.players(roomState.players.length);
  $('roster').innerHTML = roomState.players
    .map((p) => `<li class="pill${GTC.isNewSeat(roomState.code, p.playerId) ? ' new' : ''}">${GTC.avatar(p.nickname)}<span class="dot${p.connected ? '' : ' off'}"></span>${esc(p.nickname)}${p.playerId === me ? ' (you)' : ''}${p.isHost ? ' <span class="crown">HOST</span>' : ''}${removeButton(p.playerId, p.nickname)}</li>`)
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

async function kick(e) {
  const b = e.target.closest('[data-kick]');
  if (!b) return;
  const mid = roomState?.status === 'playing';
  const cost = mid ? ' Their score stays on the board; if they are drawing, the turn ends.' : '';
  if (!(await GTC.ask(`Remove ${b.dataset.name} from the ${mid ? 'game' : 'room'}?${cost}`, { yes: 'Remove', danger: true }))) return;
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
  // Telephone has no rounds: every chain goes once round the table. Nor a drawer's search (classic).
  $('roundsField').hidden = drawMode === 'telephone';
  $('searchField').hidden = drawMode === 'telephone';
}
// Whether drawers may search for any character: off unless a host turns it on, then remembered
// in this browser like the mode.
$('searchToggle').checked = store.get('gtc_draw_search') === '1';
$('searchToggle').addEventListener('change', () => store.set('gtc_draw_search', $('searchToggle').checked ? '1' : '0'));
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
      search: $('searchToggle').checked,
    },
    (res) => {
      $('startBtn').disabled = false;
      if (!res?.ok) $('lobbyErr').textContent = res?.error || 'Could not start.';
    }
  );
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
  // The drawer hears it too: they are looking at the canvas, not at the floats over it.
  if (view?.isDrawer) window.GTCSound?.pop(kind);
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
  return GTC.art(c?.imageUrl, 'referrerpolicy="no-referrer"');
}

// The cue for each phase of each turn, sounded once however many states that phase sends (every
// guess sends one). Keyed by round and drawer as well as phase, so a turn is never mistaken for
// the last one.
let heardPhase = '';
let overHeard = false; // this game's end fanfare has played (gallery.js, draw:over)
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
  overHeard = false; // a game is on: its end will be news
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
  // The search belongs to choosing, like the dialog it leads to.
  if ($('searchPick').open && !v.canSearch) $('searchPick').close();
  if (v.phase === 'choosing' && v.isDrawer) {
    // A character found by search is a choice too, but opened straight into the dialog rather than
    // shown as a fourth card: the overlay is inside the canvas and has room for three.
    $('pick').innerHTML = v.choices
      .map((c, i) => (c.searched ? '' : `<button data-i="${i}"><div class="art">${characterArt(c)}</div><span>${esc(c.name)}</span><span class="hint" title="${esc(c.source)}">${esc(c.source)}</span></button>`))
      .join('');
    $('searchChoiceBtn').hidden = !v.canSearch;
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
    return `<span class="slot inked${fresh.has(i) ? ' fresh' : ''}" style="--i:${n++}"><b>${esc(ch)}</b></span>`;
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
      return `<li data-pid="${esc(p.playerId)}" class="${p.guessed ? 'got' : ''}${p.left ? ' left' : ''}"><span class="pname" title="${name}">${name}</span>${tag}<span class="score">${p.score}</span>${p.left ? '' : removeButton(p.playerId, p.name, { compact: true })}</li>`;
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
  syncConfirmGo();
  $('confirmGo').disabled = false;
  $('confirmPick').showModal();
  // autofocus scrolls Start Drawing into view, which on a short phone scrolled the dialog to its
  // foot and the other-name panel off the top -- the one thing this dialog is for. Back to the top.
  $('confirmPick').scrollTop = 0;
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
// With the other-name box empty, the button names the choice being made -- "No Other Name" -- so
// starting without one is something the drawer reads and agrees to, not a box they never saw.
// Players kept missing the box; this does not make anyone type, it makes skipping it visible.
function syncConfirmGo() {
  const typed = confirming && spellingOptions(confirming.choice).length > 1 + (confirming.choice.swapped ? 1 : 0);
  $('confirmGo').textContent = typed ? 'Start Drawing' : 'No Other Name — Start Drawing';
}
// Typing another name offers it as a spelling at once; what was picked stays picked while it exists.
$('alsoAccept').addEventListener('input', () => {
  if (!confirming) return;
  renderSpellings(confirming.choice, pickedSpelling());
  syncConfirmGo();
});

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

// The drawer's search (when the host allowed it). The character search the host's picker uses,
// asking /api/browse/search; a result is sent by id, so the server looks it up again itself. What
// comes back is the index of a choice holding it, opened in the same dialog as any of the three --
// the views arrive before the answer, so the choice is already in `view` (socket.js draw:search).
if (window.GTCPickers) {
  window.GTCPickers.characterSearch($('searchInput'), $('searchResults'), (found) => {
    $('searchErr').textContent = '';
    socket.emit('draw:search', found.typed ? { name: found.name } : { id: found.id }, (res) => {
      if (!res?.ok) return ($('searchErr').textContent = res?.error || 'Could not pick that one.');
      $('searchPick').close();
      openConfirm(res.index);
    });
  });
}
$('searchChoiceBtn').addEventListener('click', () => {
  $('searchErr').textContent = '';
  $('searchInput').value = '';
  $('searchResults').innerHTML = '';
  $('searchPick').showModal();
  $('searchInput').focus();
});
$('searchBack').addEventListener('click', () => $('searchPick').close());

$('rerollChoicesBtn').addEventListener('click', () => {
  const b = $('rerollChoicesBtn');
  b.disabled = true; // one request at a time; the new view re-enables it
  socket.emit('draw:reroll', {}, (res) => {
    b.disabled = false;
    if (res && !res.ok) toast(esc(res.error));
  });
});

// One column (a phone, or a narrow window): the guess list sits below the picture, not beside it.
// The same breakpoint as index.html's.
const oneColumn = matchMedia('(max-width: 1000px)');

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
  // In one column the list is a short strip UNDER the guess box (index.html), so the newest line
  // goes at the top, next to the box; beside the picture it is a full column, newest at the bottom.
  if (oneColumn.matches) {
    const atTop = ul.scrollTop < 40;
    ul.innerHTML = lines.reverse().map((l) => `<li class="${l.cls}">${l.html}</li>`).join('');
    if (atTop) ul.scrollTop = 0;
  } else {
    const atBottom = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 40;
    ul.innerHTML = lines.map((l) => `<li class="${l.cls}">${l.html}</li>`).join('');
    if (atBottom) ul.scrollTop = ul.scrollHeight;
  }
  floatNewGuesses();
}

// One column: the guess list is below the picture, so whoever is watching the drawing -- the drawer
// most of all -- never sees the guesses come in. Each new line from someone else floats over the
// picture's corner for a few seconds. Only what this player's view already carries (the server
// decides who may read which line), never their own, and never a backlog: lines already there when
// the page caught up are skipped.
let floatedUpTo = null; // the highest chat id seen; null until the first view
function floatNewGuesses() {
  const chat = view?.chat ?? [];
  const top = chat.reduce((n, m) => Math.max(n, m.id), 0);
  // A new game numbers its lines from the start again.
  if (floatedUpTo === null || top < floatedUpTo) {
    floatedUpTo = top;
    return;
  }
  const fresh = chat.filter((m) => m.id > floatedUpTo && !m.mine);
  floatedUpTo = Math.max(floatedUpTo, top);
  if (!oneColumn.matches || view?.phase !== 'drawing') return;
  const wrap = canvas.parentElement;
  let box = wrap.querySelector('.bubbles');
  if (!box) {
    box = document.createElement('div');
    box.className = 'bubbles';
    box.setAttribute('aria-hidden', 'true'); // the list below is the live region; this is decoration
    wrap.append(box);
  }
  for (const m of fresh.slice(-3)) {
    const b = document.createElement('div');
    b.className = `bubble${m.kind === 'correct' ? ' right' : m.kind === 'close' ? ' near' : ''}`;
    b.innerHTML = `<span class="who">${esc(m.name)}:</span> ${m.kind === 'correct' ? '✓ ' : ''}${esc(m.text)}`;
    b.addEventListener('animationend', () => b.remove());
    setTimeout(() => b.remove(), 3600); // and if no animation runs at all
    box.append(b);
  }
  // Three at most: a burst of guesses must not stack up over the drawing.
  while (box.children.length > 3) box.firstElementChild.remove();
}

// One column, keyboard up: keep the picture in view above it. iOS scrolls the focused box into
// view by itself, which in one column took the picture off the top of the screen -- typing a guess
// meant not seeing what you were guessing. Picture plus box (~320px on a phone) fit in the space
// above a phone keyboard, so the page is scrolled to put the picture's top at the top. When they
// do not fit (a short landscape screen), the browser's own scroll is left alone.
function keepPictureInView() {
  if (!oneColumn.matches || document.activeElement !== $('chatInput') || !matchMedia('(pointer: coarse)').matches) return;
  const vv = window.visualViewport;
  const room = vv ? vv.height : innerHeight;
  const top = canvas.getBoundingClientRect().top + scrollY - 8;
  const bottom = $('chatForm').getBoundingClientRect().bottom + scrollY + 8;
  if (bottom - top <= room) window.scrollTo(0, Math.max(0, top));
}
$('chatInput').addEventListener('focus', () => setTimeout(keepPictureInView, 350));
window.visualViewport?.addEventListener('resize', keepPictureInView);
function localLine(cls, html) {
  localLines.push({ cls, html, at: Date.now() });
  localLines = localLines.slice(-12);
  renderChat();
}

// "Got it" is an announcement, not chat, so it is a toast that goes away rather than a line in the
// chat box: in a room of six, one turn's worth of them pushed the guesses off the top, and they
// piled up turn after turn. Who has it stays visible where it belongs -- the player list's tag.
// The guesser's own comes from here too (the ack says nothing), so they see it once.
socket.on('draw:correct', ({ playerId: who, name, points, nth }) => {
  // Two at most: a room guessing it in a burst would stack them up over the chat box above.
  toast(who === me ? `✓ You got it! +${points}` : `✓ ${esc(name)} got it! +${points}`, 3500, { max: 2 });
  // To everyone, the guesser included -- so the guesser's own cue is played here too, not on the
  // ack, or they would hear two. Each one a step higher than the last (sound.js climb).
  sound(who === me ? 'gotMine' : 'got', nth);
  burst(who, who === me);
  if (who === me) GTC.flash('good', 'Got It!');
});

// A few pieces of colour flung out from whoever got it: their row in the player list, or the
// picture when that row is off screen (one column, scrolled). Decoration only -- the toast and
// the row's tag say who -- so nothing at all for anyone who asks for reduced motion. Laid over
// the page (fixed), because the row is rewritten by the view that follows a moment later.
const BURST_COLOURS = ['var(--red)', 'var(--blue)', 'var(--amber)', 'var(--green)'];
function burst(who, mine) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const row = $('players').querySelector(`[data-pid="${CSS.escape(String(who))}"]`);
  const seen = (el) => {
    const r = el?.getBoundingClientRect();
    return r && r.width && r.bottom > 0 && r.top < innerHeight ? r : null;
  };
  // The list scrolls in a big room: a row scrolled out of it is on the page but not on screen.
  const box = $('players').getBoundingClientRect();
  const inList = (r) => r && r.bottom > box.top && r.top < box.bottom ? r : null;
  const fromRow = inList(seen(row));
  const r = fromRow ?? seen(canvas);
  if (!r) return;
  // From the name on the row; from low on the picture, where the reactions rise from.
  const x = fromRow ? r.left + Math.min(r.width * 0.3, 90) : r.left + r.width / 2;
  const y = r.top + (fromRow ? r.height / 2 : r.height * 0.8);
  const n = mine ? 16 : 9;
  for (let i = 0; i < n; i++) {
    const b = document.createElement('i');
    b.className = `bit${i % 2 ? ' sq' : ''}`;
    b.setAttribute('aria-hidden', 'true');
    const angle = (i / n) * Math.PI * 2 + Math.random() * 0.5;
    const dist = (mine ? 70 : 45) + Math.random() * 30;
    b.style.cssText = `left:${x}px;top:${y}px;background:${BURST_COLOURS[i % 4]};--dx:${Math.cos(angle) * dist}px;--dy:${Math.sin(angle) * dist}px;--spin:${Math.round(Math.random() * 360)}deg`;
    b.addEventListener('animationend', () => b.remove());
    setTimeout(() => b.remove(), 1500); // and if no animation runs at all
    document.body.append(b);
  }
}

// Giving up shows you the answer, which cannot be taken back -- so it asks first.
$('giveUpBtn').addEventListener('click', async () => {
  if (!(await GTC.ask("Give up on this drawing? You'll see who it is, and score nothing for it.", { yes: 'Give Up', no: 'Keep Guessing', danger: true }))) return;
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
    // A flash for every miss would be a strobe in a game of fast guesses: the box shakes instead.
    if (res.verdict === 'wrong' || res.verdict === 'close') GTC.shake($('chatInput'));
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && view && view.phase !== 'over') socket.emit('draw:resync', {}, () => {});
});

