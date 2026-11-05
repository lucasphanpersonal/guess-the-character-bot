// Guess the Character on a computer -- the client.
//
// Talks to the /desk socket.io namespace (src/web/desk/index.js). The server decides everything;
// this draws what it is sent. Two rules carried over from the phones' client because they were
// learned there:
//
//   - Escape every interpolated value (esc), including URLs going into src attributes.
//   - Always surface the server's error string. A button that "does nothing" is usually a server
//     explaining itself to a client that threw the reason away.

// The helpers every computer game shares -- $, esc, guarded storage, the hand-set title, toasts
// -- are /shared/common.js (src/web/shared), loaded first.
const { $, esc, store, show, toast, wobble, roomCodeHtml } = GTC;

// A persistent id, so a reload or a dropped connection reclaims the same seat.
const playerId = GTC.playerIdFor('gtc_desk_player');
const socket = io('/desk', { auth: { playerId } });
// `playerId` above is this browser's SECRET: it goes in the handshake and nowhere else. The server
// seats us under a public id derived from it, and that is the id every roster and view uses -- so
// "is this me?" is always asked of `me`, never of the secret.
let me = null;
socket.on('hello', ({ you }) => {
  me = you;
});
wobble($('title'), 'Guess the Character');
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
    status === 'playing'
      ? `Remove ${name}? Their character is revealed and they drop out of the game.`
      : status === 'setup' || status === 'ready'
        ? `Remove ${name}? This deal is called off and everyone goes back to the lobby.`
        : `Remove ${name} from the room?`,
});
GTC.bindThemeToggles();
GTC.bindCrtToggles();

// Sound (/shared/sound.js): short cues for your turn, a result, and a call to rule. Optional-
// chained like the pickers: a missing sound script costs the cues, never the game -- and hides the
// switch rather than leave one that does nothing.
const sound = (cue, ...args) => window.GTCSound?.play(cue, ...args);
$('soundToggle').hidden = !window.GTCSound;
window.GTCSound?.mountToggle($('soundToggle'));

// --- state --------------------------------------------------------------------------------
let roomState = null;
let options = null;
let gameView = null;
let clock = { remaining: null, total: 60, timer: null };
let lastBoardHtml = '';
let lastSpotHtml = ''; // the spotlight, redrawn on the same terms as the board
let lastLogHtml = '';  // the guess log, likewise (and its scroll reset with it)
// Everyone's notes, by player. Kept apart from the board's HTML and filled into it in place, so a
// note arriving with every keystroke never rebuilds the cards (and reloads every picture).
const notesBy = new Map();
const isHost = () => roomState?.hostPlayerId === me;

// --- landing ------------------------------------------------------------------------------
$('nameInput').value = store.get('gtc_desk_name') || '';
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
  if (name) store.set('gtc_desk_name', name);
  return name;
}

$('createBtn').addEventListener('click', () => {
  const name = nickname();
  if (!name) return ($('landingErr').textContent = 'Type your name first.');
  socket.emit('room:create', { nickname: name }, (res) => {
    if (!res?.ok) return ($('landingErr').textContent = res?.error || 'Could not create a room.');
    enterRoom(res.state);
  });
});

// `quiet`: a rejoin the page attempted by itself. If that room has gone, say nothing -- an error
// for something the person never asked for reads as the page being broken.
function join(code, name, { quiet = false } = {}) {
  socket.emit('room:join', { code, nickname: name }, (res) => {
    if (!res?.ok) {
      if (quiet) return store.set('gtc_desk_room', '');
      return ($('landingErr').textContent = res?.error || 'Could not join that room.');
    }
    enterRoom(res.state);
  });
}
$('joinBtn').addEventListener('click', () => {
  const name = nickname();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) return ($('landingErr').textContent = 'Type your name first.');
  if (code.length !== 4) return ($('landingErr').textContent = 'Room codes are 4 characters.');
  join(code, name);
});
$('codeInput').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase()));
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

// A reload mid-game: rejoin the room this browser was last in, and the server hands back the
// view for wherever the room has got to.
// Only the room this link is for: following somebody's invite to another room must not drop you
// back into yesterday's.
socket.on('connect', () => {
  GTC.forgetRosters(); // the room may have changed while this page was away (common.js)
  const last = store.get('gtc_desk_room');
  const name = store.get('gtc_desk_name');
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

function enterRoom(state) {
  roomState = state;
  store.set('gtc_desk_room', state.code);
  history.replaceState(null, '', `?room=${encodeURIComponent(state.code)}`);
  $('landingErr').textContent = '';
  renderRoom();
}

// Resolves once the server has the leave (or after a moment without an answer), so a caller that is
// about to navigate away -- the title -- does not cut the request off and leave the seat held.
function leave() {
  GTC.forgetRosters();
  const done = new Promise((resolve) => {
    socket.emit('room:leave', {}, resolve);
    setTimeout(resolve, 1500);
  });
  store.set('gtc_desk_room', '');
  roomState = null;
  gameView = null;
  roomMenu.update();
  history.replaceState(null, '', location.pathname);
  show('landing');
  return done;
}
$('leaveBtn').addEventListener('click', leave);
$('leaveOverBtn').addEventListener('click', leave);

// What leaving costs, in words -- asked by the title (which goes home) and by Room's Leave.
function leaveCost() {
  if (!roomState) return null;
  if ($('hosting').classList.contains('active')) return 'Leave the room? The game carries on without you.';
  if (roomState.status === 'playing') return 'Leave the game? Your character is revealed and you drop out.';
  if (roomState.status === 'setup' || roomState.status === 'ready') return 'Leave the room? This deal is called off and everyone goes back to the lobby.';
  return 'Leave this room and go back to the start?';
}
GTC.homeTitle($('title'), { leave, leaving: leaveCost });

// --- lobby --------------------------------------------------------------------------------
socket.on('room:state', (state) => {
  roomState = state;
  renderRoom();
});

function renderRoom() {
  roomMenu.update(); // the Room button and its list follow every roster change
  if (!roomState) return;
  if (roomState.status === 'lobby') {
    show('lobby');
    renderLobby();
  }
  // Every other status is driven by its own event (setup:state, game:state, game:over), which
  // carries the per-player view the room state does not.
}

function renderLobby() {
  const code = roomState.code;
  $('roomCode').innerHTML = roomCodeHtml(code);
  $('shareLink').value = `${location.origin}/desk/?room=${code}`;
  if (GTC.someoneArrived(code, roomState.players, me)) sound('join');
  $('rosterLabel').textContent = `Players (${roomState.players.length}/${roomState.maxPlayers})`;
  window.GTCFx?.players(roomState.players.length);
  $('roster').innerHTML = roomState.players
    .map((p) => `<li class="pill${GTC.isNewSeat(roomState.code, p.playerId) ? ' new' : ''}">${GTC.avatar(p.nickname)}<span class="dot${p.connected ? '' : ' off'}"></span>${esc(p.nickname)}${p.playerId === me ? ' (you)' : ''}${p.isHost ? ' <span class="crown">HOST</span>' : ''}</li>`)
    .join('');
  $('hostPanel').hidden = !isHost();
  $('guestPanel').hidden = isHost();
  if (isHost()) {
    $('startBtn').disabled = roomState.players.length < 2;
    $('lobbyErr').textContent = roomState.players.length < 2 ? 'Waiting for at least one more player to join.' : '';
    loadOptions();
    syncHostMode();
  }
}

// Built once per page, when the options first arrive: the server keeps this room's curation, so a
// rebuild would only lose which sections the host had open.
let poolPicker = null;
const ask = (event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

function loadOptions() {
  if (options) return;
  socket.emit('setup:options', {}, (res) => {
    options = res;
    // Difficulty first: it must never depend on the picker below having loaded.
    $('difficultySelect').innerHTML = (res?.difficulties ?? [])
      .map((d) => `<option value="${esc(d.key)}"${d.key === res.defaultDifficulty ? ' selected' : ''}>${esc(d.label)}: ${esc(d.blurb)}</option>`)
      .join('');
    poolPicker = GTC.mountPoolPicker($('poolPicker'), { options: res, request: ask });
  });
}

// Who picks: the hint and the button say what happens next, so the choice is never a guess.
const pickMode = () => document.querySelector('input[name=mode]:checked')?.value || 'deal';
const MODE_TEXT = {
  deal: { hint: "Everyone gets a random character, and checks the next player's.", pool: 'Characters from', start: 'Deal the Characters' },
  each: { hint: 'Nothing is dealt: each player chooses the character of the next player round the table.', pool: 'Random picks come from', start: 'Start Picking' },
  host: { hint: "You choose everyone's character, and sit this one out to watch.", pool: 'Anyone left blank is drawn from', start: 'Start With These Picks' },
};
function syncMode() {
  const text = MODE_TEXT[pickMode()] ?? MODE_TEXT.deal;
  $('modeHint').textContent = text.hint;
  $('poolLabel').textContent = text.pool;
  $('startBtn').textContent = text.start;
  $('hostPickBox').hidden = pickMode() !== 'host';
  if (pickMode() === 'host') renderPickSlots();
}
for (const radio of document.querySelectorAll('input[name=mode]')) radio.addEventListener('change', syncMode);

// --- I'll pick them ------------------------------------------------------------------------
//
// The host chooses everyone's character and sits the game out. Picks live here, keyed by
// playerId, not in the slots: the slots are rebuilt when the roster changes, and a deal that gets
// called off should come back to the host's choices, not an empty form. They are dropped when a
// game ends -- by then everyone has seen them.
//   playerId -> { id, name, list, imageUrl }   a character from the library
//            -> { name, typed: true }           a name typed in, which has no picture
const hostPicks = new Map();
const others = () => (roomState?.players ?? []).filter((p) => p.playerId !== me);
// Two, not one: each player checks the NEXT player's character, and a lone guesser's next player
// is themselves. The server refuses it too; this says so before the host bothers.
const canPickForEveryone = () => others().length >= 2;

// Every room:state re-renders the lobby, including a connection dot flickering. Rebuilding the
// slots on those would wipe a half-typed search, so only a change of people rebuilds them.
let slotsFor = '';
const rosterKey = () => others().map((p) => `${p.playerId}:${p.nickname}`).join('|');

function syncHostMode() {
  const ok = canPickForEveryone();
  const radio = document.querySelector('input[name=mode][value=host]');
  radio.disabled = !ok;
  $('hostModeChoice').classList.toggle('disabled', !ok);
  $('hostModeChoice').title = ok ? '' : 'Needs 2 players besides you';
  if (!ok && radio.checked) {
    document.querySelector('input[name=mode][value=deal]').checked = true;
    syncMode();
  }
  if (pickMode() === 'host' && rosterKey() !== slotsFor) renderPickSlots();
}

function renderPickSlots() {
  slotsFor = rosterKey();
  const people = others();
  // A pick for somebody who has left can't be dealt, and the server refuses the whole deal rather
  // than quietly drop it -- so forget it here, where the host can see it go.
  for (const id of [...hostPicks.keys()]) if (!people.some((p) => p.playerId === id)) hostPicks.delete(id);
  const ul = $('pickSlots');
  ul.innerHTML = '';
  for (const p of people) ul.appendChild(pickSlot(p));
}

function pickSlot(p) {
  const li = document.createElement('li');
  li.className = 'pickslot';
  li.innerHTML = `<div class="pickhead"><span class="name">${esc(p.nickname)}</span><span class="pickcurrent"></span></div>
    <input type="search" placeholder="Search, or type any name" autocomplete="off" aria-label="${esc(`Character for ${p.nickname}`)}" />
    <div></div>`;
  const current = li.querySelector('.pickcurrent');
  const paint = () => {
    const pick = hostPicks.get(p.playerId);
    current.classList.toggle('random', !pick);
    if (!pick) return void (current.textContent = 'Random');
    current.innerHTML =
      GTC.art(pick.imageUrl, 'class="pickthumb"') +
      `<span class="lbl" title="${esc(pick.typed ? 'Typed in, so no picture' : pick.list || '')}">${esc(pick.typed ? `“${pick.name}”` : pick.name)}</span>` +
      `<button type="button" class="pickclear" aria-label="${esc(`Back to random for ${p.nickname}`)}">✕</button>`;
    current.querySelector('.pickclear').addEventListener('click', () => { hostPicks.delete(p.playerId); paint(); });
  };
  window.GTCPickers?.characterSearch(li.querySelector('input'), li.querySelector('div:last-child'), (pick) => {
    hostPicks.set(p.playerId, pick);
    paint();
  });
  paint();
  return li;
}
// Once everything above exists: a browser restoring the form on reload can hand back any mode.
syncMode();

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
  const config = {
    ...poolPicker.value(),
    ...(pickMode() === 'each' ? { eachPicks: true } : {}),
    // Blank slots are simply absent: the server deals those at random.
    ...(pickMode() === 'host'
      ? {
          hostPicks: true,
          picks: Object.fromEntries(
            [...hostPicks]
              .filter(([id]) => others().some((p) => p.playerId === id))
              .map(([id, pk]) => [id, pk.typed ? { name: pk.name } : { id: pk.id }])
          ),
        }
      : {}),
    difficulty: $('difficultySelect').value || undefined,
    turnSeconds: Number($('turnSelect').value),
  };
  $('startBtn').disabled = true;
  socket.emit('setup:start', config, (res) => {
    $('startBtn').disabled = false;
    if (!res?.ok) $('lobbyErr').textContent = res?.error || 'Could not deal.';
  });
});

// --- setup: check and reroll --------------------------------------------------------------
function cardHtml({ name, character, badge = '', current = false, mystery = false, empty = false, done = false, turns = null }) {
  let art;
  if (mystery) art = '<div class="art mystery">?</div>';
  // A seat not picked for yet (pick-for-each-other). Not the mystery face: that one means "yours".
  else if (empty) art = '<div class="art"><span class="noimg">Not picked yet</span></div>';
  else art = `<div class="art">${GTC.art(character?.imageUrl, 'referrerpolicy="no-referrer" loading="lazy"')}</div>`;
  return `<div class="pcard${current ? ' current' : ''}${done ? ' done' : ''}">
      <div class="who">${esc(name)}${badge}${turns != null ? `<span class="turns">${turns} turn${turns === 1 ? '' : 's'}</span>` : ''}</div>
      ${art}
      <div class="cname">${mystery ? 'Who are you?' : empty ? '' : esc(character?.name)}</div>
      <div class="src">${mystery || empty ? '' : esc(character?.source)}</div>
    </div>`;
}

// Writes each player's notes into their card. textContent, never innerHTML: notes are typed by
// other people. A strip tile shows two lines; its tooltip is the whole of them.
function fillNotes() {
  for (const el of document.querySelectorAll('[data-notes-for]')) {
    el.textContent = notesBy.get(el.dataset.notesFor) ?? '';
    if (el.classList.contains('tnotes')) el.title = el.textContent;
  }
}

// The art of a seat on the board: its character, or the mystery face for your own.
function artHtml(cls, character) {
  if (!character) return `<div class="${cls} mystery">?</div>`;
  return `<div class="${cls}">${GTC.art(character.imageUrl, 'referrerpolicy="no-referrer" loading="lazy"')}</div>`;
}

// The middle of the screen: whoever is asking questions. For everyone else, their character, big
// -- the thing the room answers about. For them, the mystery card: it is their turn to work it out.
function spotlightHtml(b, v) {
  const turn = v.phase === 'playing' && b.playerId === v.current.playerId ? `<span class="turnno">Turn ${v.current.turnNumber}</span>` : '';
  // No "Guessing" badge: whoever is in the spotlight is the one guessing, so it would only repeat
  // the turn bar. Any other status is news.
  const badge = b.status === 'guessing' ? '' : STATUS_BADGE[b.status] ?? '';
  return `<div class="spothead"><span class="spotwho">${esc(b.isMe ? 'You' : b.name)}</span>${badge}${turn}</div>
    ${artHtml('art', b.character)}
    <div class="spotname">${b.character ? esc(b.character.name) : 'Who are you?'}</div>
    <div class="src">${b.character ? esc(b.character.source) : ''}</div>
    ${b.isMe ? '' : `<div class="notes" data-notes-for="${esc(b.playerId)}"></div>`}`;
}

// One face in the strip. Seat order, every turn: tiles that swapped places each turn would make
// the room hunt for each other.
function tileHtml(b, v) {
  const current = v.phase === 'playing' && b.playerId === v.current.playerId;
  const done = b.status === 'finished' || b.status === 'gave_up';
  const turns = b.turns ? `<span class="turns">${b.turns} turn${b.turns === 1 ? '' : 's'}</span>` : '';
  return `<div class="tile${current ? ' current' : ''}${done ? ' done' : ''}">
      ${artHtml('tart', b.character)}
      <div class="tname"><span class="n" title="${esc(b.name)}">${esc(b.isMe ? `${b.name} (you)` : b.name)}</span>${turns}</div>
      <div class="tchar">${b.character ? esc(b.character.name) : 'Who are you?'}</div>
      ${STATUS_BADGE[b.status] ?? ''}
      <div class="tnotes" data-notes-for="${esc(b.playerId)}"></div>
    </div>`;
}
// Your own box shows what the server holds -- unless you are typing in it right now.
function syncMyNotes() {
  const box = $('notesInput');
  if (document.activeElement !== box && !notesPending) box.value = notesBy.get(me) ?? '';
}

socket.on('setup:state', (view) => {
  show('setup');
  gameView = null;
  // A new deal is a new game: last game's notes were about last game's characters.
  notesBy.clear();
  $('notesInput').value = '';
  $('notesErr').textContent = '';
  heardTurn = '';
  heardRuling = null;
  overHeard = false;
  const picking = view.checkerPicks;
  const target = view.checking.ownerName;
  $('checkTitle').textContent = picking ? `You pick ${target}'s character` : `You check ${target}'s character`;
  $('checkCard').innerHTML = `<div class="cards" style="grid-template-columns:1fr">${cardHtml({ name: target, character: view.checking.character, empty: !view.checking.character })}</div>`;
  const rerolls = view.rerollsLeft === -1 ? 'unlimited rerolls' : `${view.rerollsLeft} reroll${view.rerollsLeft === 1 ? '' : 's'} left`;
  $('checkHint').textContent = picking
    ? `Choose someone ${target} would know: search the library, type any name, or pick at random. They have to guess it.`
    : view.rerollAllowed
      ? `Is this a character ${target} has a fair chance of knowing? If not, reroll it (${rerolls}).`
      : 'The host picked these characters, so there are no rerolls.';
  $('pickBox').hidden = !picking || view.confirmed;
  $('pickSearch').setAttribute('aria-label', `Character for ${target}`);
  $('rerollBtn').textContent = picking ? 'Pick at Random' : 'Reroll';
  $('rerollBtn').hidden = !view.rerollAllowed;
  $('rerollBtn').disabled = view.confirmed || view.rerollsLeft === 0;
  $('undoBtn').hidden = !view.rerollAllowed;
  $('undoBtn').disabled = view.confirmed || !view.canUndo;
  $('confirmBtn').textContent = view.confirmed ? 'Locked In — Change My Mind' : 'Looks Good';
  $('confirmBtn').className = view.confirmed ? 'ghost grow' : 'good grow';
  $('confirmBtn').dataset.confirmed = view.confirmed ? '1' : '';
  // The server refuses an empty seat too; this just says so before anyone clicks.
  $('confirmBtn').disabled = !view.confirmed && view.canConfirm === false;
  $('referenceCards').innerHTML = view.reference
    .map((r) => cardHtml({ name: r.ownerName, character: r.character, empty: !r.character }))
    .join('');
  // Two players: the one you check IS everyone else, and an empty panel reads as a fault.
  $('referenceCards').closest('.card').hidden = !view.reference.length;
  // Count, then name: "waiting on 1" tells nobody whose screen to go and look at.
  $('waitingNote').textContent = view.allReady
    ? 'Everyone is in. Starting...'
    : `Waiting on ${view.waitingPlayers.map((p) => (p.playerId === me ? 'you' : p.name)).join(', ')}.`;
  $('cancelDealBtn').hidden = !isHost();
  $('setupErr').textContent = '';
});

const setupAction = (event) => () =>
  socket.emit(event, {}, (res) => { if (res && !res.ok) $('setupErr').textContent = res.error || 'That did not work.'; });
$('rerollBtn').addEventListener('click', setupAction('setup:reroll'));
$('undoBtn').addEventListener('click', setupAction('setup:undo'));
$('confirmBtn').addEventListener('click', () => setupAction($('confirmBtn').dataset.confirmed ? 'setup:unlock' : 'setup:confirm')());
$('cancelDealBtn').addEventListener('click', setupAction('setup:cancel'));
// Optional-chained: if /shared/pickers.js did not load, a throw HERE, at the top level, stopped
// every handler below it -- the whole game. Without it the search box is inert; Random still works.
window.GTCPickers?.characterSearch($('pickSearch'), $('pickResults'), (pick) =>
  socket.emit('setup:pick', pick.typed ? { name: pick.name } : { id: pick.id }, (res) => {
    $('setupErr').textContent = res?.ok ? '' : res?.error || 'Could not pick that one.';
  }));

socket.on('setup:aborted', ({ reason } = {}) => {
  toast(`The deal was called off: ${esc(reason || 'it was cancelled')}.`);
  if (roomState) { roomState.status = 'lobby'; renderRoom(); }
});

// --- play ---------------------------------------------------------------------------------
const STATUS_BADGE = {
  guessing: '<span class="badge go">▲ Guessing</span>',
  finished: '<span class="badge got">✓ Got it</span>',
  gave_up: '<span class="badge out">✗ Out</span>',
  waiting: '',
};

// What this page has already sounded a cue for, so the many states of one turn (every guess,
// every clock correction) sound it once. Dropped with the game (setup:state, game:over).
let heardTurn = '';     // `${playerId}:${turnNumber}` of the turn last seen
let heardRuling = null; // id of the ruling on screen
let overHeard = false;  // this game's end fanfare has played (game:over)

socket.on('game:state', (view) => {
  const wasMyTurn = gameView?.isMyTurn;
  gameView = view;
  show('game');
  renderGame();
  if (view.isMyTurn && !wasMyTurn) $('guessInput').focus();

  // By turn number, not by isMyTurn flipping: the last player still guessing takes turn after
  // turn of their own, and each is a new turn.
  const turn = view.phase === 'playing' ? `${view.current.playerId}:${view.current.turnNumber}` : '';
  if (turn !== heardTurn) {
    heardTurn = turn;
    if (view.isMyTurn && !view.paused) sound('turn');
  }
  // A close guess wants a ruling, against a clock -- but only from those who can give one.
  const r = view.ruling;
  if (r && !r.waiting && r.canRule && r.id !== heardRuling) sound('ask');
  heardRuling = r?.id ?? null;
});

function renderGame() {
  const v = gameView;
  if (!v) return;
  $('turnWho').textContent = v.isMyTurn ? 'Your turn' : `${v.current.name}'s turn`;
  // Dropped: no reading (their turn waits for them). Host's pause: the reading it stopped at.
  setClock(v.paused ? null : v.turnRemaining, v.turnSeconds, v.paused || v.hostPaused);

  // Redrawn only when something on it changed. Every guess and every clock correction sends a new
  // state, and rebuilding the cards each time reloaded every picture -- a board that blinks
  // whenever anyone types.
  const boardHtml = v.board.map((b) => tileHtml(b, v)).join('');
  if (lastBoardHtml !== boardHtml) {
    $('board').innerHTML = boardHtml;
    lastBoardHtml = boardHtml;
  }
  const spot = v.board.find((b) => b.playerId === v.current?.playerId) ?? v.board.find((b) => b.isMe);
  const spotHtml = spot ? spotlightHtml(spot, v) : '';
  if (lastSpotHtml !== spotHtml) {
    $('spotlight').innerHTML = spotHtml;
    lastSpotHtml = spotHtml;
  }
  // You are in the spotlight (your turn, face down): your notes move under it (theme.css).
  $('game').toggleAttribute('data-spot-me', !!spot?.isMe);
  for (const b of v.board) notesBy.set(b.playerId, b.notes ?? '');
  fillNotes();
  syncMyNotes();

  $('myTurnPanel').hidden = !v.isMyTurn;
  const waitingOnRuling = v.ruling?.waiting;
  $('guessInput').disabled = !v.isMyTurn || !!waitingOnRuling;
  $('guessForm').querySelector('button').disabled = $('guessInput').disabled;
  if (v.isMyTurn) {
    $('passBtn').hidden = !v.buttons?.pass;
    $('giveUpBtn').hidden = !v.buttons?.giveUp;
    $('contentionNote').hidden = !v.outOfContentionNote;
    $('contentionNote').textContent = v.outOfContentionNote ?? '';
    $('guessErr').textContent = waitingOnRuling ? `"${v.ruling.text}" is close. The others are deciding whether it counts.` : $('guessErr').textContent;
  }

  // A close guess, held up for the others. The guesser sees only that it is waiting.
  const r = v.ruling;
  $('rulingPanel').hidden = !r || r.waiting;
  if (r && !r.waiting) {
    $('rulingQ').textContent = `${r.by} guessed "${r.text}". Does that count?`;
    $('rulingAnswer').innerHTML = `<p class="hint">Their character is <strong>${esc(r.answer?.name)}</strong>.</p>`;
    $('rulingButtons').hidden = !r.canRule;
  }

  const watching = !v.isMyTurn && !(r && !r.waiting);
  $('waitPanel').hidden = !watching;
  if (watching) {
    $('waitTitle').textContent = v.paused ? `${v.current.name} dropped out` : `${v.current.name} is guessing`;
    $('waitHint').textContent = v.paused
      ? 'Their clock is paused until they reconnect.'
      : v.me.finished
        ? "You've got yours. Answer their questions honestly."
        : 'Answer their yes-or-no questions. Their character is the big one in the middle.';
  }

  $('logTitle').textContent = v.isMyTurn ? 'Your guesses' : `${v.current.name}'s guesses`;
  const logHtml = v.guesses.length
    ? v.guesses
        .map((g) => {
          const note = g.lapsed ? ' <span class="by">(nobody ruled)</span>' : g.ruledBy ? ` <span class="by">(ruled by ${esc(g.ruledBy)})</span>` : '';
          return `<li><span class="verdict ${g.verdict === 'correct' ? 'correct' : 'wrong'}">${esc(g.text)}</span>${note}</li>`;
        })
        .join('')
    : '<li class="hint">No guesses yet.</li>';
  // On a computer the log scrolls inside its card once it outgrows it (theme.css, the fitted play
  // screen). Newest first, so back to the top when it CHANGES -- a new guess, a ruling, a new turn --
  // and not on every state push (clock corrections, notes), which would snatch an older guess away
  // from someone reading it. Keyed on the log itself: the guess count stops growing at the cap.
  if (logHtml !== lastLogHtml) {
    $('guessLog').innerHTML = logHtml;
    $('guessLog').scrollTop = 0;
    lastLogHtml = logHtml;
  }
}

// The clock is the server's: it sends seconds remaining, and this only counts down between
// updates. A tab that was hidden asks for a fresh one on the way back (game:resync).
// `ids`: the players' turn bar by default; the watching host has a bar of their own.
function setClock(remaining, total, paused, ids = { bar: 'clock', fill: 'clockFill', secs: 'clockSecs' }) {
  clearInterval(clock.timer);
  clock = { remaining, total, timer: null };
  const draw = () => {
    const secs = clock.remaining;
    $(ids.secs).textContent = paused ? 'paused' : secs == null ? '' : `${secs}s`;
    $(ids.fill).style.width = secs == null ? '100%' : `${Math.max(0, (secs / (clock.total || 60)) * 100)}%`;
    $(ids.bar).classList.toggle('crit', secs != null && secs <= 10);
  };
  draw();
  if (remaining == null || paused) return;
  clock.timer = setInterval(() => {
    if (clock.remaining > 0) clock.remaining -= 1;
    draw();
  }, 1000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && gameView?.phase === 'playing') socket.emit('game:resync', {}, () => {});
});

// The box empties the moment a guess is sent, not when the answer comes back: a fast typist is
// already typing the next one, and clearing on the reply glued the two together ("BatmanNico
// Rosberg"). If the guess did not go through, the text comes back so it is not lost.
$('guessForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('guessInput').value.trim();
  if (!text) return;
  $('guessErr').textContent = '';
  $('guessInput').value = '';
  socket.emit('game:guess', { text }, (res) => {
    if (!res?.ok) {
      if (!$('guessInput').value) $('guessInput').value = text;
      return ($('guessErr').textContent = res?.error || 'That guess did not go through.');
    }
    // Only the guesser hears their own miss or close call: misses are free and come by the dozen,
    // and a room of computers each sounding every one would be the room's loudest thing.
    if (res.verdict === 'wrong') {
      $('guessErr').textContent = `"${text}" isn't it. Keep asking.`;
      sound('miss');
      GTC.flash('bad', 'Miss');
    }
    if (res.verdict === 'close') {
      sound('close');
      GTC.flash('near', 'Close');
    }
    // A right one sounds from game:reveal, which also covers one the others rule in.
  });
});

$('passBtn').addEventListener('click', () =>
  socket.emit('game:pass', {}, (res) => { if (res && !res.ok) $('guessErr').textContent = res.error; }));
$('giveUpBtn').addEventListener('click', () => {
  if (!confirm('Give up? Your character is revealed and you are out of this game.')) return;
  socket.emit('game:giveup', {}, (res) => { if (res && !res.ok) $('guessErr').textContent = res.error; });
});

function rule(accept) {
  const r = gameView?.ruling;
  if (!r || r.waiting || !r.canRule) return;
  socket.emit('game:rule', { id: r.id, accept }, (res) => { if (res && !res.ok) toast(esc(res.error)); });
}
$('ruleYesBtn').addEventListener('click', () => rule(true));
$('ruleNoBtn').addEventListener('click', () => rule(false));
// Y / N, unless the key is being typed into something.
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if ($('rulingPanel').hidden) return;
  if (e.key === 'y' || e.key === 'Y') rule(true);
  if (e.key === 'n' || e.key === 'N') rule(false);
});

socket.on('desk:guess', ({ name, text, verdict }) => {
  if (verdict === 'close') return; // the ruling panel says it
  const mark = verdict === 'correct' ? '✓' : '✗';
  toast(`${mark} ${esc(name)} guessed "${esc(text)}"`);
});
socket.on('desk:ruled', ({ accepted, by, lapsed }) => {
  // Arrives before the state that clears the ruling, so `waiting` still says whose guess it was.
  if (!accepted && gameView?.ruling?.waiting) {
    sound('miss');
    GTC.flash('bad', 'Miss');
  }
  toast(lapsed ? 'Nobody ruled in time, so it counts as a miss.' : `${esc(by)} ruled: ${accepted ? '✓ it counts' : '✗ not it'}`);
});
socket.on('game:reveal', (r) => {
  const who = r.playerId === me ? 'You' : esc(r.name);
  const what = `<strong>${esc(r.character?.name)}</strong>`;
  if (r.kind === 'got') sound(r.playerId === me ? 'gotMine' : 'got');
  if (r.kind === 'got' && r.playerId === me) GTC.flash('good', 'Got It!');
  if (r.kind === 'got') toast(`${who} got it: ${what}, in ${r.turns} turn${r.turns === 1 ? '' : 's'}.`, 7000);
  else if (r.kind === 'gaveup') toast(`${who} gave up. They were ${what}.`, 7000);
  else toast(`${who} left. They were ${what}.`, 7000);
});
socket.on('game:timeout', ({ name }) => toast(`Time's up for ${esc(name)}.`));

// --- the host who sits out (I'll pick them) -------------------------------------------------
//
// Watch-only, as on the phones: every character, who is locked in, whose turn it is and the clock.
// Rulings stay with the players -- the server only lets players in the game rule.
let lastHostHtml = '';
socket.on('host:state', (view) => {
  show('hosting');
  gameView = null;
  $('hostErr').textContent = '';
  const playing = view.phase === 'playing';
  $('hostTurnbar').hidden = !playing;
  $('hostCancelBtn').hidden = playing;
  if (view.phase === 'setup') {
    $('hostTitle').textContent = view.allReady ? 'Everyone is in. Starting...' : `Waiting on ${view.waitingOn} to lock in`;
    $('hostNote').textContent = 'Everyone is checking the character of the next player. You sit this one out and watch.';
  } else if (view.phase === 'countdown') {
    $('hostTitle').textContent = 'Starting...';
  } else if (playing) {
    $('hostWho').textContent = view.paused ? `Waiting for ${view.current.name} to reconnect` : `${view.current.name} is guessing, turn ${view.current.turnNumber}`;
    setClock(view.paused ? null : view.turnRemaining, view.turnSeconds, view.paused || view.hostPaused, { bar: 'hostClock', fill: 'hostClockFill', secs: 'hostClockSecs' });
    $('hostTitle').textContent = 'You picked these';
    $('hostNote').textContent = 'Close guesses are ruled by the players. You are watching.';
  }
  const html = (view.players ?? [])
    .map((p) =>
      cardHtml({
        name: p.name,
        character: p.character,
        badge: view.phase === 'setup'
          ? (p.confirmed ? '<span class="badge got">✓ Locked in</span>' : '<span class="badge">Checking</span>')
          : STATUS_BADGE[p.status] ?? '',
        current: playing && p.playerId === view.current.playerId,
        done: p.status === 'finished' || p.status === 'gave_up',
        turns: playing ? p.turns || null : null,
      })
    )
    .join('');
  // Redrawn only on change, for the same reason as the board: every clock correction is a new view.
  if (html !== lastHostHtml) { $('hostBoard').innerHTML = html; lastHostHtml = html; }
});
$('hostCancelBtn').addEventListener('click', () =>
  socket.emit('setup:cancel', {}, (res) => { if (!res?.ok) $('hostErr').textContent = res?.error || 'Could not cancel.'; }));
$('hostLeaveBtn').addEventListener('click', () => {
  if (confirm('Leave the room? The game carries on without you.')) leave();
});

// --- results ------------------------------------------------------------------------------
// --- notes ---------------------------------------------------------------------------------
// Sent when typing pauses, not per keystroke. If the server refuses a note (it named somebody
// else's character), the reason shows under the box and the text stays, so it can be fixed.
let notesPending = null;
$('notesInput').addEventListener('input', () => {
  clearTimeout(notesPending);
  notesPending = setTimeout(() => {
    notesPending = null;
    socket.emit('desk:notes', { text: $('notesInput').value }, (res) => {
      $('notesErr').textContent = res && !res.ok ? res.error || 'Your notes were not saved.' : '';
    });
  }, 400);
});
socket.on('desk:notes', ({ playerId: id, text }) => {
  notesBy.set(id, text);
  fillNotes();
  if (id === me) syncMyNotes();
});

socket.on('game:over', (res) => {
  show('over');
  clearInterval(clock.timer);
  gameView = null;
  heardTurn = '';
  heardRuling = null;
  $('overTitle').textContent = GTC.winnersTitle(res.winners.map((w) => ({ name: w.name, you: w.playerId === me })));
  // Once per game: a reconnect on this screen is sent game:over again (re-armed by setup:state).
  if (!overHeard) { overHeard = true; sound('over', res.winners.some((w) => w.playerId === me)); }
  GTC.confetti();
  window.GTCFx?.podium(res.standings);
  $('standings').innerHTML = res.standings
    .map((s) => {
      // Same tiebreak the phones show: two players on the same turns are split by time left, so
      // a 3RD beside two 1STs with equal turns needs its seconds to look right.
      const out = s.turns != null
        ? (s.secondsLeft == null ? '' : ` · ${s.secondsLeft}s left`)
        : s.outcome === 'gave_up' ? ' · gave up' : ' · did not get it';
      return GTC.hiscoreRow({
        place: s.place,
        imageUrl: s.character?.imageUrl ?? null,
        name: s.name,
        detail: `was ${s.character?.name ?? '—'}${out}`,
        score: s.turns ?? '--',
        unit: s.turns === 1 ? 'turn' : 'turns',
      });
    })
    .join('');
  $('hostOver').hidden = !isHost();
  $('guestOver').hidden = isHost();
  $('rematchBtn').hidden = !!res.hostPicked;
  // Everyone has seen them now; picking again starts from blank slots.
  if (res.hostPicked) { hostPicks.clear(); slotsFor = ''; }
  lastHostHtml = '';
  $('overErr').textContent = '';
});
$('rematchBtn').addEventListener('click', () =>
  socket.emit('game:rematch', {}, (res) => { if (!res?.ok) $('overErr').textContent = res?.error || 'Could not rematch.'; }));
$('againBtn').addEventListener('click', () =>
  socket.emit('game:again', {}, (res) => { if (!res?.ok) $('overErr').textContent = res?.error || 'Could not restart.'; }));

socket.on('room:kicked', ({ reason } = {}) => {
  store.set('gtc_desk_room', '');
  roomState = null;
  roomMenu.update();
  show('landing');
  $('landingErr').textContent = reason || 'You were removed from the room.';
});
socket.on('room:error', ({ error } = {}) => ($('landingErr').textContent = error || 'Something went wrong.'));
