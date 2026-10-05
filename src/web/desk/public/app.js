// Guess the Character on a computer -- the client.
//
// Talks to the /desk socket.io namespace (src/web/desk/index.js). The server decides everything;
// this draws what it is sent. Two rules carried over from the phones' client because they were
// learned there:
//
//   - Escape every interpolated value (esc), including URLs going into src attributes.
//   - Always surface the server's error string. A button that "does nothing" is usually a server
//     explaining itself to a client that threw the reason away.

const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Per-browser conveniences only. Storage can be blocked or empty (private windows, cleared site
// data), so every access is guarded and the page works without it.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* fine */ } },
};

// A persistent id, so a reload or a dropped connection reclaims the same seat.
let playerId = store.get('gtc_desk_player');
if (!playerId) {
  playerId = (crypto.randomUUID?.() ?? `p${Date.now()}${Math.random().toString(36).slice(2)}`);
  store.set('gtc_desk_player', playerId);
}

const socket = io('/desk', { auth: { playerId } });

// The title is hand-set, like the phones': a per-character angle, words kept whole.
const ANGLES = [-6, 4, -3, 5, -5, 3, -4, 6];
function wobble(el, text) {
  el.innerHTML = '';
  let i = 0;
  String(text).split(' ').forEach((word, w, words) => {
    const holder = document.createElement('span');
    holder.className = 'wob-word';
    for (const ch of word) {
      const s = document.createElement('span');
      s.className = `wob w${i % 4}`;
      s.style.setProperty('--rot', `${ANGLES[i % ANGLES.length]}deg`);
      s.textContent = ch;
      holder.appendChild(s);
      i++;
    }
    el.appendChild(holder);
    if (w < words.length - 1) el.appendChild(document.createTextNode(' '));
  });
}
wobble($('title'), 'Guess the Character');

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
}

function toast(html, ms = 4500) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = html;
  $('feed').appendChild(t);
  setTimeout(() => t.remove(), ms);
  while ($('feed').children.length > 4) $('feed').firstChild.remove();
}

// --- state --------------------------------------------------------------------------------
let roomState = null;
let options = null;
let gameView = null;
let clock = { remaining: null, total: 60, timer: null };
let lastBoardHtml = '';
const isHost = () => roomState?.hostPlayerId === playerId;

// --- landing ------------------------------------------------------------------------------
$('nameInput').value = store.get('gtc_desk_name') || '';
const params = new URLSearchParams(location.search);
if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase().slice(0, 4);

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
  const last = store.get('gtc_desk_room');
  const name = store.get('gtc_desk_name');
  const linked = params.get('room')?.toUpperCase();
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

function leave() {
  socket.emit('room:leave', {}, () => {});
  store.set('gtc_desk_room', '');
  roomState = null;
  gameView = null;
  history.replaceState(null, '', location.pathname);
  show('landing');
}
$('leaveBtn').addEventListener('click', leave);
$('leaveOverBtn').addEventListener('click', leave);

// --- lobby --------------------------------------------------------------------------------
socket.on('room:state', (state) => {
  roomState = state;
  renderRoom();
});

function renderRoom() {
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
  $('roomCode').innerHTML = [...code].map((ch, i) => `<span class="ch" style="--rot:${ANGLES[i]}deg">${esc(ch)}</span>`).join('');
  $('shareLink').value = `${location.origin}/desk/?room=${code}`;
  $('rosterLabel').textContent = `Players (${roomState.players.length}/${roomState.maxPlayers})`;
  $('roster').innerHTML = roomState.players
    .map((p) => `<li class="pill"><span class="dot${p.connected ? '' : ' off'}"></span>${esc(p.nickname)}${p.playerId === playerId ? ' (you)' : ''}${p.isHost ? ' <span class="crown">HOST</span>' : ''}</li>`)
    .join('');
  $('hostPanel').hidden = !isHost();
  $('guestPanel').hidden = isHost();
  if (isHost()) {
    $('startBtn').disabled = roomState.players.length < 2;
    $('lobbyErr').textContent = roomState.players.length < 2 ? 'Waiting for at least one more player to join.' : '';
    loadOptions();
  }
}

function loadOptions() {
  if (options) return;
  socket.emit('setup:options', {}, (res) => {
    options = res;
    $('categorySelect').innerHTML = (res?.categories ?? [])
      .map((c) => `<option value="${esc(c.category)}">${esc(c.category)} (${c.enabled} lists)</option>`)
      .join('');
    $('difficultySelect').innerHTML = (res?.difficulties ?? [])
      .map((d) => `<option value="${esc(d.key)}"${d.key === res.defaultDifficulty ? ' selected' : ''}>${esc(d.label)}: ${esc(d.blurb)}</option>`)
      .join('');
  });
}

for (const radio of document.querySelectorAll('input[name=pool]')) {
  radio.addEventListener('change', () => ($('categoryRow').hidden = radio.value !== 'category' || !radio.checked));
}

$('copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('shareLink').value);
    $('copyBtn').textContent = 'Copied';
  } catch {
    $('shareLink').select();
    $('copyBtn').textContent = 'Press Ctrl+C';
  }
  setTimeout(() => ($('copyBtn').textContent = 'Copy link'), 1800);
});

$('startBtn').addEventListener('click', () => {
  const poolType = document.querySelector('input[name=pool]:checked').value;
  const config = {
    poolType,
    category: poolType === 'category' ? $('categorySelect').value : null,
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
function cardHtml({ name, character, badge = '', current = false, mystery = false, done = false, turns = null }) {
  let art;
  if (mystery) art = '<div class="art mystery">?</div>';
  else if (character?.imageUrl) art = `<div class="art"><img src="${esc(character.imageUrl)}" alt="" referrerpolicy="no-referrer" loading="lazy" /></div>`;
  else art = '<div class="art"><span class="noimg">No picture</span></div>';
  return `<div class="pcard${current ? ' current' : ''}${done ? ' done' : ''}">
      <div class="who">${esc(name)}${badge}${turns != null ? `<span class="turns">${turns} turn${turns === 1 ? '' : 's'}</span>` : ''}</div>
      ${art}
      <div class="cname">${mystery ? 'Who are you?' : esc(character?.name)}</div>
      <div class="src">${mystery ? '' : esc(character?.source)}</div>
    </div>`;
}

socket.on('setup:state', (view) => {
  show('setup');
  gameView = null;
  $('checkTitle').textContent = `You check ${view.checking.ownerName}'s character`;
  $('checkCard').innerHTML = `<div class="cards" style="grid-template-columns:1fr">${cardHtml({ name: view.checking.ownerName, character: view.checking.character })}</div>`;
  const rerolls = view.rerollsLeft === -1 ? 'unlimited rerolls' : `${view.rerollsLeft} reroll${view.rerollsLeft === 1 ? '' : 's'} left`;
  $('checkHint').textContent = view.rerollAllowed
    ? `Is this a character ${view.checking.ownerName} has a fair chance of knowing? If not, reroll it (${rerolls}).`
    : 'The host picked these characters, so there are no rerolls.';
  $('rerollBtn').hidden = !view.rerollAllowed;
  $('rerollBtn').disabled = view.confirmed || view.rerollsLeft === 0;
  $('undoBtn').hidden = !view.rerollAllowed;
  $('undoBtn').disabled = view.confirmed || !view.canUndo;
  $('confirmBtn').textContent = view.confirmed ? 'Locked in. Change my mind' : 'Looks good';
  $('confirmBtn').className = view.confirmed ? 'ghost grow' : 'good grow';
  $('confirmBtn').dataset.confirmed = view.confirmed ? '1' : '';
  $('referenceCards').innerHTML = view.reference.map((r) => cardHtml({ name: r.ownerName, character: r.character })).join('');
  // Two players: the one you check IS everyone else, and an empty panel reads as a fault.
  $('referenceCards').closest('.card').hidden = !view.reference.length;
  // Count, then name: "waiting on 1" tells nobody whose screen to go and look at.
  $('waitingNote').textContent = view.allReady
    ? 'Everyone is in. Starting...'
    : `Waiting on ${view.waitingPlayers.map((p) => (p.playerId === playerId ? 'you' : p.name)).join(', ')}.`;
  $('cancelDealBtn').hidden = !isHost();
  $('setupErr').textContent = '';
});

const setupAction = (event) => () =>
  socket.emit(event, {}, (res) => { if (res && !res.ok) $('setupErr').textContent = res.error || 'That did not work.'; });
$('rerollBtn').addEventListener('click', setupAction('setup:reroll'));
$('undoBtn').addEventListener('click', setupAction('setup:undo'));
$('confirmBtn').addEventListener('click', () => setupAction($('confirmBtn').dataset.confirmed ? 'setup:unlock' : 'setup:confirm')());
$('cancelDealBtn').addEventListener('click', setupAction('setup:cancel'));

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

socket.on('game:state', (view) => {
  const wasMyTurn = gameView?.isMyTurn;
  gameView = view;
  show('game');
  renderGame();
  if (view.isMyTurn && !wasMyTurn) $('guessInput').focus();
});

function renderGame() {
  const v = gameView;
  if (!v) return;
  $('turnWho').textContent = v.isMyTurn ? 'Your turn' : `${v.current.name}'s turn`;
  setClock(v.paused ? null : v.turnRemaining, v.turnSeconds, v.paused);

  // Redrawn only when something on it changed. Every guess and every clock correction sends a new
  // state, and rebuilding the cards each time reloaded every picture -- a board that blinks
  // whenever anyone types.
  const boardHtml = v.board
    .map((b) =>
      cardHtml({
        name: b.isMe ? `${b.name} (you)` : b.name,
        character: b.character,
        mystery: !b.character,
        badge: STATUS_BADGE[b.status] ?? '',
        current: b.playerId === v.current.playerId && v.phase === 'playing',
        done: b.status === 'finished' || b.status === 'gave_up',
        turns: b.turns || null,
      })
    )
    .join('');
  if (lastBoardHtml !== boardHtml) {
    $('board').innerHTML = boardHtml;
    lastBoardHtml = boardHtml;
  }

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
        : 'Answer their yes-or-no questions. Their character is on their card.';
  }

  $('logTitle').textContent = v.isMyTurn ? 'Your guesses' : `${v.current.name}'s guesses`;
  $('guessLog').innerHTML = v.guesses.length
    ? v.guesses
        .map((g) => {
          const note = g.lapsed ? ' <span class="by">(nobody ruled)</span>' : g.ruledBy ? ` <span class="by">(ruled by ${esc(g.ruledBy)})</span>` : '';
          return `<li><span class="verdict ${g.verdict === 'correct' ? 'correct' : 'wrong'}">${esc(g.text)}</span>${note}</li>`;
        })
        .join('')
    : '<li class="hint">No guesses yet.</li>';
}

// The clock is the server's: it sends seconds remaining, and this only counts down between
// updates. A tab that was hidden asks for a fresh one on the way back (game:resync).
function setClock(remaining, total, paused) {
  clearInterval(clock.timer);
  clock = { remaining, total, timer: null };
  const draw = () => {
    const secs = clock.remaining;
    $('clockSecs').textContent = paused ? 'paused' : secs == null ? '' : `${secs}s`;
    $('clockFill').style.width = secs == null ? '100%' : `${Math.max(0, (secs / (clock.total || 60)) * 100)}%`;
    $('clock').classList.toggle('crit', secs != null && secs <= 10);
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
    if (res.verdict === 'wrong') $('guessErr').textContent = `"${text}" isn't it. Keep asking.`;
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
  toast(lapsed ? 'Nobody ruled in time, so it counts as a miss.' : `${esc(by)} ruled: ${accepted ? '✓ it counts' : '✗ not it'}`);
});
socket.on('game:reveal', (r) => {
  const who = r.playerId === playerId ? 'You' : esc(r.name);
  const what = `<strong>${esc(r.character?.name)}</strong>`;
  if (r.kind === 'got') toast(`${who} got it: ${what}, in ${r.turns} turn${r.turns === 1 ? '' : 's'}.`, 7000);
  else if (r.kind === 'gaveup') toast(`${who} gave up. They were ${what}.`, 7000);
  else toast(`${who} left. They were ${what}.`, 7000);
});
socket.on('game:timeout', ({ name }) => toast(`Time's up for ${esc(name)}.`));

// --- results ------------------------------------------------------------------------------
socket.on('game:over', (res) => {
  show('over');
  clearInterval(clock.timer);
  gameView = null;
  const winners = res.winners.map((w) => (w.playerId === playerId ? 'You' : w.name));
  $('overTitle').textContent = winners.length ? `${winners.join(' and ')} won!` : 'Game over';
  $('standings').innerHTML = res.standings
    .map((s) => {
      const img = s.character?.imageUrl ? `<img src="${esc(s.character.imageUrl)}" alt="" referrerpolicy="no-referrer" />` : '';
      const how = s.outcome === 'gave_up' ? 'gave up' : s.turns != null ? `${s.turns} turn${s.turns === 1 ? '' : 's'}` : 'did not get it';
      return `<li><span class="place">${s.place ?? '-'}</span>${img}<div><strong>${esc(s.name)}</strong> was <strong>${esc(s.character?.name)}</strong><div class="hint">${esc(how)}</div></div></li>`;
    })
    .join('');
  $('hostOver').hidden = !isHost();
  $('guestOver').hidden = isHost();
  $('rematchBtn').hidden = !!res.hostPicked;
  $('overErr').textContent = '';
});
$('rematchBtn').addEventListener('click', () =>
  socket.emit('game:rematch', {}, (res) => { if (!res?.ok) $('overErr').textContent = res?.error || 'Could not rematch.'; }));
$('againBtn').addEventListener('click', () =>
  socket.emit('game:again', {}, (res) => { if (!res?.ok) $('overErr').textContent = res?.error || 'Could not restart.'; }));

socket.on('room:kicked', ({ reason } = {}) => {
  store.set('gtc_desk_room', '');
  roomState = null;
  show('landing');
  $('landingErr').textContent = reason || 'You were removed from the room.';
});
socket.on('room:error', ({ error } = {}) => ($('landingErr').textContent = error || 'Something went wrong.'));
