// Web client -- the party-mode frontend's core. Vanilla JS, no build step.
//
// Rooms, confirm/reroll, the grace countdown, forehead mode + tilt, and the results screen. The
// rest is in files of its own, loaded as plain scripts in this order (index.html):
//
//   app.js         this: shared state, every screen but the ones below, the socket's handlers
//   audio.js       cues, the turn bed, the sound check, mute
//   config.js      the host's config screen and the deal
//   compendium.js  Browse
//   eggs.js        idle easter eggs
//   boot.js        wiring and boot -- LAST, and it connects the socket
//
// Plain scripts share one global scope, so a function here may call one in a later file -- but
// only once that file has run. Nothing at the top level of an earlier file may call into a later
// one, which is why the wiring is all in boot.js; and the socket is created here but connected
// only there, or a room:state arriving while audio.js was still downloading (a phone on mobile
// data, through the tunnel) would call functions that did not exist yet.
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
let roomMenu = null;             // the Room button (/shared/roommenu.js), mounted below
let nickname = store.get('gtc_nick') || '';
let options = null;              // setup options (categories/difficulties), fetched for host
// Why setup ended, held rather than written straight to the lobby hint: the room:state that
// follows re-renders the lobby and would wipe it. renderLobby consumes it once.
let abortNote = '';

// Not connected until boot.js, the last script: see the header.
const socket = io({ auth: { playerId }, autoConnect: false });
// `playerId` above is this browser's SECRET: it goes in the handshake and nowhere else. The server
// seats us under a public id derived from it, and that is the id every roster and view uses -- so
// "is this me?" is always asked of `me`, never of the secret.
let me = null;
socket.on('hello', ({ you }) => {
  me = you;
});

// Sets text one character at a time, each in its own colour. Written with textContent per span, so
// the source string is never treated as markup.
//
// Characters are grouped into WORDS, and that grouping is load-bearing rather than tidiness:
// giving every character its own inline-block box removes ordinary word-boundary line breaking,
// because the browser may then break between any two boxes. "Guess the Character" duly wrapped
// with a lone "r" on the second line. A nowrap word wrapper puts the break opportunities back
// where they belong -- between words only.
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
      span.textContent = ch;
      holder.appendChild(span);
      i++;
    }
    el.appendChild(holder);
    if (w < words.length - 1) el.appendChild(document.createTextNode(' '));
  });
}

function show(screen) {
  // A screen that was not showing starts at the top. The page keeps its scroll across screens, so
  // the deal screen opened where the settings screen had been scrolled to, with its check card off
  // the top. Only on entry: the setup screen re-renders on every state push and must not jump.
  const entering = document.getElementById(screen) && !document.getElementById(screen).classList.contains('active');
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === screen);
  if (entering) window.scrollTo(0, 0);
  // Idle whimsy stops once play starts -- phones are on foreheads, and the only thing that
  // should be moving is the game.
  document.body.classList.toggle('at-play', screen === 'playing' || screen === 'countdown');
  // The same for the shared styles (retro.css), which know no game's screen names.
  document.documentElement.toggleAttribute('data-playing', screen === 'playing' || screen === 'countdown');
  // Every way in or out of a room ends on a screen change, so this is where Room follows it.
  roomMenu?.update();
}

const amHost = () => lastState && lastState.hostPlayerId === me;

// --- lobby rendering ----------------------------------------------------------------------
function renderLobby(state) {
  // Rendered per character so each can carry its own colour (see .roomcode .ch).
  const codeEl = $('lobbyCode');
  codeEl.innerHTML = '';
  [...state.code].forEach((c) => {
    const sp = document.createElement('span');
    sp.className = 'ch';
    sp.textContent = c;
    codeEl.appendChild(sp);
  });
  const joinUrl = `${location.origin}/?room=${state.code}`;
  $('shareUrl').textContent = joinUrl;
  const qr = $('qrImg');
  qr.src = `/api/qr?room=${encodeURIComponent(state.code)}`;
  // 'block' (not '') -- an <img> defaults to inline, and margin:auto centering (see CSS) only
  // takes effect on a block-level box. Leaving it inline was why the QR rendered off-center.
  qr.style.display = 'block';
  if (GTC.someoneArrived(state.code, state.players, me)) joinBlip();
  $('playerCount').textContent = `Players (${state.players.length}/${state.maxPlayers ?? 8})`;
  window.GTCFx?.players(state.players.length);
  const roster = $('roster');
  roster.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    li.className = GTC.isNewSeat(state.code, p.playerId) ? 'seat new' : 'seat';
    const dot = document.createElement('span');
    dot.className = 'dot' + (p.connected ? '' : ' off');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.nickname;
    if (p.playerId === me) { const y = document.createElement('span'); y.className = 'you'; y.textContent = ' (you)'; name.appendChild(y); }
    li.innerHTML = GTC.avatar(p.nickname);
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

// --- setup / confirm ----------------------------------------------------------------------
function charCardHtml(ch) {
  const img = GTC.art(ch.imageUrl);
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
// When the host's Remove buttons may first appear for this deal. Entering the deal screen from
// another screen holds them back a few seconds, so the host does not hit Remove on the cards as they land.
const REMOVE_HOLD_MS = 4000;
let removeArmedAt = 0;
function renderSetup(view) {
  keepAwake();
  clearInterval(countdown); // a player left during the grace: back to setup, no game to count to
  overHeard = false; // a new game: its end will be news
  finishCelebrated = false;
  // Arm on ENTERING the deal screen, not on the first setup view of the page: a rematch, a second
  // game or a re-deal after a removal all come back through here from another screen.
  if (!document.getElementById('setup').classList.contains('active')) removeArmedAt = Date.now() + REMOVE_HOLD_MS;
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
  const waiting = (view.waitingPlayers ?? []).filter((p) => p.playerId !== me);
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
  // Held back right after a deal (see REMOVE_HOLD_MS). Hidden rather than disabled, so the row
  // does not look like it has a button that is broken; the row re-renders on every state push, so
  // the timer only needs to reveal this one element.
  const wait = removeArmedAt - Date.now();
  if (wait > 0) {
    b.style.visibility = 'hidden';
    setTimeout(() => { b.style.visibility = ''; }, wait);
  }
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
      banner.innerHTML = frozen(view)
        ? (view.hostPaused ? '<b>Paused</b> — the clock has stopped' : `Waiting for <b>${name}</b> to reconnect…`)
        : `<b>${name}</b> is guessing — turn ${view.current.turnNumber}${remaining != null ? ` · ${remaining}s` : ''}`;
    };
    paint();
    if (!frozen(view) && remaining != null) {
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
      GTC.art(ch?.imageUrl, 'class="pickthumb"') +
      `<span style="flex:1;min-width:0"><span class="name">${escapeHtml(r.name)}</span><br>` +
      `<span style="font-weight:700">${escapeHtml(ch?.name ?? '—')}</span><br>` +
      `<span class="you">${escapeHtml(r.meta)}</span></span>`;
    if (r.removable) li.append(removeButton(r));
    ul.appendChild(li);
  }
}

// --- playing ------------------------------------------------------------------------------
let countdown = null;          // local 1s ticker
let overHeard = false;         // this game's end fanfare has played (renderOver)
// The clock is frozen when the current player has dropped (their turn waits for them) or the host
// has paused the game -- the same stillness either way: no ticking, no bed, no cues.
const frozen = (v) => !!(v?.paused || v?.hostPaused);
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
  // Play began on the server's clock: a local countdown a beat behind would blip over the turn.
  clearInterval(countdown);
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
  const live = view.isMyTurn && !frozen(view) && remaining != null && total > 0;
  bar.style.display = live ? 'block' : 'none';
  fh.classList.toggle('warn', live && remaining <= total / 2 && remaining > CRIT_SECONDS);
  fh.classList.toggle('crit', live && remaining <= CRIT_SECONDS);
  if (live) bar.firstElementChild.style.width = `${Math.max(0, (remaining / total) * 100)}%`;
}

function turnCue(view, remaining) {
  if (!view.isMyTurn || frozen(view) || remaining == null) return;
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
  // Not "by the host": a game that went quiet for two rounds pauses itself (the Paused screen says so).
  const pausedMsg = view.hostPaused ? 'Paused' : `Waiting for ${escapeHtml(view.current.name)} to reconnect…`;
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
      $('foreheadTurn').innerHTML = (frozen(view) ? pausedMsg
        : view.isMyTurn ? `YOUR TURN${remaining != null ? ` · ${remaining}s` : ''} — ${downHint}`
        : `${escapeHtml(view.current.name)}'s turn${remaining != null ? ` · ${remaining}s` : ''}`) + ooc;
    } else {
      $('turnBanner').innerHTML = frozen(view) ? pausedMsg : bannerText(view, remaining);
    }
    paintTurnClock(view, remaining);
    // In paint() rather than turnCue(): this has to run on the first render of a turn as well as
    // on every later second, or the bed would not start until a second in.
    updateBed(view, remaining);
  };
  paint();
  if (frozen(view) || remaining == null) return; // the current player is away, or the host paused
  turnTicker = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    paint();
    turnCue(view, remaining);
    if (remaining === 0) clearInterval(turnTicker);
  }, 1000);
}

// The screen a player sees once they've got their character: their reveal, turn count, and the
// live standings while everyone else plays on.
let finishCelebrated = false; // renderFinished runs on every state push until the game ends
function renderFinished(view) {
  if (!finishCelebrated) {
    finishCelebrated = true;
    GTC.flash('good', 'Got It!');
  }
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
}

function renderOver(result) {
  allowSleep();
  GTC.confetti();
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
  // `place` comes from the server (Game.standings): turns first, then time left, with level
  // players sharing a place. Re-deriving it here from turns alone is how this screen and the
  // Discord reveal could have ranked one game two different ways.
  $('finalStandings').innerHTML = result.standings.map((s) => {
    const how = s.turns === null ? (s.outcome === 'gave_up' ? 'gave up' : 'did not finish')
      : s.secondsLeft == null ? '' : `${s.secondsLeft}s left`;
    return GTC.hiscoreRow({
      place: s.place,
      imageUrl: s.character?.imageUrl ?? null,
      name: s.name,
      detail: `was ${s.character?.name ?? '—'}${how ? ` · ${how}` : ''}`,
      score: s.turns ?? '--',
      unit: s.turns === 1 ? 'turn' : 'turns',
    });
  }).join('');
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
  $('rematchBtn').textContent = result.hostPicked ? 'Pick Characters Again' : 'Rematch — Same Settings';
  // Once per game: a reconnect on the results screen (a phone waking from its lock) is sent
  // game:over again, and the results are not news the second time. Re-armed by the next setup.
  if (!overHeard) { overHeard = true; fanfare(result.winners.some((w) => w.playerId === me)); }
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
  plainScreen(true);
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

function hideForehead() { $('forehead').classList.remove('active'); plainScreen(false); foreheadMyTurn = false; resetForeheadHold(); }
// The forehead view is a display surface read across a room: while it is up, <html> says the screen
// must be plain (data-plain), and the shared look's decoration -- the CRT glass -- steps aside.
function plainScreen(on) { document.documentElement.toggleAttribute('data-plain', on); }

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
    plainScreen(true);
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
  countBlip(n);
  navigator.vibrate?.(80);
  // A reconnect in the last half-second is told 0: nothing is left to count, and a ticker would
  // only run on into negative numbers.
  if (n <= 0) return;
  countdown = setInterval(() => {
    n -= 1;
    paint();
    countBlip(n);
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
    // A Draw room plays on phones too, so a Draw code typed here is sent there rather than
    // refused: from the home page it is one box for any code a phone can play.
    if (res?.kind === 'draw') return location.assign(`/draw/?room=${encodeURIComponent(code)}&name=${encodeURIComponent(nick)}`);
    if (!res?.ok) return ($('landingErr').textContent = res?.error || 'Could not join.');
    lastState = res.state; enterRoom(res.state); routeByStatus(res.state);
  });
}
function leaveRoom() {
  allowSleep();
  stopBed();
  clearInterval(countdown);
  GTC.forgetRosters();
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
  // The countdown too: a host who cancels during the grace sends everyone here, and a ticker left
  // running would go on sounding beats and a "go" for a game that is not starting.
  if (state.status === 'lobby') { lastPlayView = null; clearInterval(countdown); renderLobby(state); show('lobby'); }
  // 'setup' -> setup:state handler; 'playing' -> game:state handler; 'finished' -> game:over.
  // Those carry the per-player payloads, so status alone doesn't switch to them here.
}

// --- socket lifecycle -----------------------------------------------------------------------
socket.on('room:state', (state) => {
  if (!currentRoom || state.code !== currentRoom.code) return;
  lastState = state;
  roomMenu?.update(); // a roster change (someone joined, left or was removed)
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
  GTC.forgetRosters(); // the room may have changed while this phone was away (common.js)
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

