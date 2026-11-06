// Wiring and boot, for the phones. LAST of the page's scripts on purpose: its top-level code runs
// at load and calls into every other file, so they must all be in -- and it is what connects the
// socket (at the very end), so no server event can arrive while a file is still downloading.

// --- wire up + boot -------------------------------------------------------------------------
$('createBtn').addEventListener('click', createRoom);
$('joinBtn').addEventListener('click', joinRoom);
$('leaveBtn').addEventListener('click', leaveRoom);
const LEAVE_GAME = 'Leave the game? Your character is revealed and you drop out.';
$('playLeaveBtn').addEventListener('click', async () => { if (await GTC.ask(LEAVE_GAME, { yes: 'Leave', no: 'Stay', danger: true })) leaveRoom(); });
// The forehead overlay covers everything else at full-screen, including playLeaveBtn above --
// this is the only way out while a phone is actually in forehead mode.
$('foreheadLeave').addEventListener('click', async () => { if (await GTC.ask(LEAVE_GAME, { yes: 'Leave', no: 'Stay', danger: true })) leaveRoom(); });
$('overLeaveBtn').addEventListener('click', leaveRoom);
let lastOverHostPicked = false;
$('rematchBtn').addEventListener('click', () => {
  $('overErr').textContent = '';
  if (lastOverHostPicked) {
    // Back to the lobby first -- setup can only start from there -- which also shows the players
    // "the host is picking characters" while that is exactly what is happening.
    socket.emit('game:again', {}, (res) => {
      if (res?.ok) openConfig({ pick: 'host' });
      else $('overErr').textContent = res?.error || 'Could not go back to picking.';
    });
    return;
  }
  primeMotion();
  $('rematchBtn').disabled = true;
  socket.emit('game:rematch', {}, (res) => {
    $('rematchBtn').disabled = false;
    // The server always says why it refused; discarding that was what made the button look
    // broken when a player had left.
    if (!res?.ok) $('overErr').textContent = res?.error || 'Could not start a rematch.';
  });
});
$('changeBtn').addEventListener('click', () => socket.emit('game:again', {}, () => {}));
// How-to-play is open by default (most people at a party have never played) but the choice is
// remembered, so a group that already knows isn't shown it every round.
const howtoHidden = () => store.get('gtc_howto') === 'hidden';
function syncHowto() {
  const hidden = howtoHidden();
  $('howtoCard').style.display = hidden ? 'none' : '';
  $('howtoToggle').textContent = hidden ? 'How to Play' : 'Hide How to Play';
}
$('howtoToggle').addEventListener('click', () => {
  store.set('gtc_howto', howtoHidden() ? 'shown' : 'hidden');
  syncHowto();
});
syncHowto();
// Wrapped: openConfig takes options, and would otherwise be handed the click event as them.
$('setupBtn').addEventListener('click', () => openConfig());
$('cfgBackBtn').addEventListener('click', () => show('lobby'));
$('dealBtn').addEventListener('click', deal);
$('setupCancelBtn').addEventListener('click', async () => {
  if (await GTC.ask('Cancel this deal and send everyone back to the lobby?', { yes: 'Call It Off', no: 'Keep Dealing', danger: true })) socket.emit('setup:cancel', {}, () => {});
});
$('setupLeaveBtn').addEventListener('click', async () => {
  if (await GTC.ask('Leave the room?', { yes: 'Leave', no: 'Stay', danger: true })) leaveRoom();
});
$('hostCancelBtn').addEventListener('click', async () => {
  if (await GTC.ask('Call off this deal and send everyone back to the lobby? Your picks are kept.', { yes: 'Call It Off', no: 'Keep Dealing', danger: true })) socket.emit('setup:cancel', {}, () => {});
});
$('hostLeaveBtn').addEventListener('click', async () => {
  if (await GTC.ask('Leave the room? The game carries on without you.', { yes: 'Leave', no: 'Stay', danger: true })) leaveRoom();
});
$('undoBtn').addEventListener('click', () => socket.emit('setup:undo', {}, (res) => {
  $('rerollNote').textContent = res?.ok ? `Put ${res.restored} back.` : res?.error || '';
}));
$('rerollBtn').addEventListener('click', () => socket.emit('setup:reroll', {}, (res) => {
  $('rerollNote').textContent = res?.ok ? '' : res?.error || '';
}));
// No primeMotion here, though this is a user gesture and iOS wants one: the button only exists
// once the gate has already turned tilt on, so by the time anyone can press it the phone is
// listening. The gate's own button is where the permission is actually asked for.
$('goodBtn').addEventListener('click', () => socket.emit('setup:confirm', {}, (res) => {
  if (!res?.ok) $('waitingNote').textContent = res?.error || 'Could not lock in.';
}));
// Pick-for-each-other: whatever is chosen here becomes the checked player's character. The view
// that comes back from the server repaints the card; the note only carries a refusal.
// Optional-chained: if /shared/pickers.js did not load, a throw HERE, at the top level, stopped
// every handler below it -- the whole game. Without it the search box is inert; Random still works.
window.GTCPickers?.characterSearch($('pickSearch'), $('pickResults'), (pick) => {
  socket.emit('setup:pick', pick.typed ? { name: pick.name } : { id: pick.id }, (res) => {
    $('rerollNote').textContent = res?.ok ? '' : res?.error || 'Could not pick that one.';
  });
});
// The gate's own button is a user gesture, which is what iOS requires before handing over the
// sensor -- so this is the request most likely to actually succeed.
$('motionGateBtn').addEventListener('click', () => {
  motionDenied = false; // someone who has just fixed Settings deserves another go
  enableMotion().then(() => { if (lastSetupView) renderSetup(lastSetupView); });
});
$('soundCheckBtn').addEventListener('click', playSoundCheck);
// Hearing what you chose is the point of the switch, and the tap is what lets audio start.
$('soundToggle').addEventListener('click', () => {
  setMuted(!muted);
  if (!muted) {
    ensureAudio();
    beep(880, 120);
    setTimeout(() => beep(1250, 160), 110);
  }
});
renderSoundCheck();
$('muteBtn').addEventListener('click', () => {
  setMuted(!muted);
  renderSoundCheck();
  // Turning it back on auditions immediately: the whole point of the control is being able to
  // hear what you just chose.
  if (muted) $('soundCheckNote').textContent = 'Game sounds are off on this phone.';
  else playSoundCheck();
});
$('unlockBtn').addEventListener('click', () => socket.emit('setup:unlock', {}, () => {}));
$('browseBtn').addEventListener('click', openBrowse);

// The computer-version link is a real link (somewhere to go, maybe in a new tab) dressed as the
// ghost button below it. Buttons don't inherit the page font -- each browser gives them its own
// (Arial here, the system font on an iPhone) -- so the link takes whatever a real button got,
// rather than guessing it in CSS and looking pasted in on the next browser.

// The title goes home. A real link (so it opens in a new tab), but a plain navigation would put a
// player straight back in their room, which the page rejoins on load -- so in a room it asks first,
// in words that say what leaving costs, and leaves properly. Out of a room it just shows the start
// screen, which is also the way back from Browse and Test Tilt.
$('homeTitle').addEventListener('click', async (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if (currentRoom) {
    if (!(await GTC.ask(leaveCost(), { yes: 'Leave', no: 'Stay', danger: true }))) return;
    leaveRoom();
  }
  // Home is the first question, which game -- the one screen every other start hangs off.
  show('splash');
  window.scrollTo(0, 0);
});

// What leaving costs, in words -- asked by the title and by Room's Leave.
function leaveCost() {
  if (!currentRoom) return null;
  const status = lastState?.status;
  const watching = document.getElementById('hosting')?.classList.contains('active');
  return watching
    ? 'Leave the room? The game carries on without you.'
    : status === 'playing' || status === 'countdown'
      ? 'Leave the game? Your character is revealed and you drop out.'
      : status === 'setup' || status === 'ready'
        ? 'Leave the room? This deal is called off and everyone goes back to the lobby.'
        : 'Leave this room and go back to the start?';
}
roomMenu = GTCRoomMenu.mount({
  button: $('roomBtn'),
  socket,
  room: () => (currentRoom ? lastState : null),
  me: () => me,
  leave: leaveRoom,
  leaveCost,
  removeCost: (name, status) =>
    status === 'playing' || status === 'countdown'
      ? `Remove ${name}? Their character is revealed and they drop out of the game.`
      : status === 'setup' || status === 'ready'
        ? `Remove ${name}? Everyone goes back to the lobby and you deal again.`
        : `Remove ${name} from the room?`,
});
roomMenu.update();
// The CRT screen's switch on the first screen (the Room menu's is bound by roommenu.js).
GTC.bindCrtToggles();

// --- the start: which game, then which way -------------------------------------------------
//
// Asked before anything else, because it decides what the rest of the start screen offers. Two
// games: Doodle Dash is its own page (a link), and Who Am I? is phones or computers -- a second
// question (#how), since a room is one or the other. The answer is remembered only as "where Back
// from Browse returns to" -- the questions are asked on every fresh visit, so a phone borrowed for
// one game is never stuck being a computer.
let startScreen = 'landing';
function go(screen) {
  show(screen);
  window.scrollTo(0, 0);
}
function pickDevice(screen) {
  startScreen = screen;
  go(screen);
}
$('pickGuess').addEventListener('click', () => go('how'));
$('pickPhone').addEventListener('click', () => pickDevice('landing'));
$('pickComputer').addEventListener('click', () => pickDevice('computer'));
for (const b of document.querySelectorAll('[data-splash]')) b.addEventListener('click', () => go('splash'));
for (const b of document.querySelectorAll('[data-how]')) b.addEventListener('click', () => go('how'));
// A hint between the two ways to play Who Am I?, never a decision: touch-first is a good guess at
// "phone", and a tablet or a touchscreen laptop can still pick the other one. Doodle Dash needs no
// hint: it plays on either.
$(matchMedia('(pointer: coarse)').matches ? 'likelyPhone' : 'likelyComputer').hidden = false;

// The computer game lives on a page of its own, so the computer start hands off: create goes to
// /desk/ with the name, join asks the server which game the code is for (a Draw code goes to Draw).
const pcNick = () => {
  const n = $('pcNickInput').value.trim();
  if (n) store.set('gtc_nick', n);
  return n;
};
$('pcNickInput').value = store.get('gtc_nick') || '';
$('pcCreateBtn').addEventListener('click', () => {
  const name = pcNick();
  if (!name) return ($('pcErr').textContent = 'Enter your name first.');
  location.assign(`/desk/?create=1&name=${encodeURIComponent(name)}`);
});
$('pcJoinBtn').addEventListener('click', async () => {
  const name = pcNick();
  const code = $('pcCodeInput').value.trim().toUpperCase();
  if (!name) return ($('pcErr').textContent = 'Enter your name first.');
  if (code.length !== 4) return ($('pcErr').textContent = 'Room codes are 4 letters.');
  $('pcErr').textContent = '';
  let found;
  try {
    const res = await fetch(`/api/room?code=${encodeURIComponent(code)}`);
    found = await res.json();
    if (!res.ok) return ($('pcErr').textContent = found?.error || 'No room with that code.');
  } catch {
    return ($('pcErr').textContent = "Couldn't reach the server. Check your connection and try again.");
  }
  // A phone room: the forehead game cannot be played from a computer, so say whose it is.
  if (found.path === '/') return ($('pcErr').textContent = "That room is Who Am I? on phones. Join it from a phone, or ask the host for a room at a screen.");
  location.assign(`${found.path}?room=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`);
});
$('pcCodeInput').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase()));
$('pcCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pcJoinBtn').click(); });
$('pcBrowseBtn').addEventListener('click', () => openBrowse());

// Dark mode's corner switch: the same binder as the computer pages (GTC.bindThemeToggles), so the
// three cannot drift. season.js already applied the stored choice before first paint.
GTC.bindThemeToggles();
$('browseBack').addEventListener('click', browseBack);
$('browseMore').addEventListener('click', () => { if (!browseState.loading) { browseState.loading = true; loadCharacterPage(false); } });
$('browseFilter').addEventListener('input', (e) => {
  browseState.filter = e.target.value;
  renderBrowseLists(e.target.value);
});
$('browseSort').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  store.set(LIST_SORT_KEY, b.dataset.sort);
  paintBrowseSort();
  renderBrowseLists(browseState.filter);
});
// Tilt calibration screen
$('tiltTestBtn').addEventListener('click', openTiltTest);
$('ttEnable').addEventListener('click', () => enableMotion().then(() => {
  $('ttEnable').style.display = motionEnabled ? 'none' : '';
  updateTiltTest();
}));
$('ttBack').addEventListener('click', () => show('landing'));
$('codeInput').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase()));
// Tapping a partly-filled code box should continue the code, not drop the caret mid-string.
// A deferred setSelectionRange, because the browser positions the caret after the tap resolves.
for (const ev of ['focus', 'click']) {
  $('codeInput').addEventListener(ev, (e) => {
    const end = e.target.value.length;
    setTimeout(() => e.target.setSelectionRange(end, end), 0);
  });
}
// The landing screen is active from the markup, so show() never runs for it -- tilt it here or
// the first screen anyone sees is the one screen with no lean at all.
scheduleEgg();
// show() names the heading, but never ran for the screen active in the markup.
setTitleFor(document.querySelector('.screen.active')?.id);
for (const el of document.querySelectorAll('[data-wobble]')) wobble(el, el.textContent, { colour: false });
if (nickname) $('nickInput').value = nickname;

const deepRoom = new URLSearchParams(location.search).get('room');
const resumeRoom = (deepRoom || store.get('gtc_lastRoom') || '').toUpperCase();
if (deepRoom) $('codeInput').value = deepRoom.toUpperCase();
if (resumeRoom && nickname) currentRoom = { code: resumeRoom };
else if (resumeRoom) $('codeInput').value = resumeRoom;
// A room link or a rejoin has already answered which game (only a phone page holds a phone
// room), so skip the question. It is also what shows while the rejoin lands.
if (resumeRoom) show('landing');
// `/?how` opens on the second question: the desk and Draw pages link here for "phones on
// foreheads", where the first question is already answered.
else if (new URLSearchParams(location.search).has('how')) show('how');

// Last of all: every script is in and currentRoom is decided, so the connect handler can rejoin.
socket.connect();
