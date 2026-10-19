// The host's config screen: how characters are chosen (dealt, picked for each other, or picked
// by the host, who then sits out), the pool, and the deal itself. Loaded after app.js.

// --- config (host) ------------------------------------------------------------------------
function openConfig({ pick } = {}) {
  if (pick !== undefined) pickMode = pick;
  if (!['deal', 'each', 'host'].includes(pickMode)) pickMode = 'deal';
  socket.emit('setup:options', {}, (opts) => {
    options = opts;
    renderConfig(opts);
    renderModeChoices();
    show('config');
  });
}

// --- host picks ------------------------------------------------------------------------------
//
// The mode where the host chooses everyone's character and sits the game out. Picks live here,
// keyed by playerId, rather than in the form: the picker is rebuilt whenever the roster changes,
// and a deal that gets called off (somebody removed for not locking in) should come back to the
// host's choices, not an empty form. They are dropped when a game ends -- by then everyone has
// seen them.
//   playerId -> { id, name, list, imageUrl }   a character from the library
//            -> { name, typed: true }           a name typed in, which has no picture
const hostPicks = new Map();
// Who picks the characters: 'deal' (at random), 'each' (every player picks for the one they
// check, on the next screen), 'host' (the host picks them all and sits out).
let pickMode = 'deal';

const othersInRoom = () => (lastState?.players ?? []).filter((p) => p.playerId !== me);
// Two, not one: each player checks the NEXT player's character, and a lone guesser's next
// player is themselves. The server refuses it too; this just says so before the host bothers.
const canPickForEveryone = () => othersInRoom().length >= 2;

// Who the picker was last built for. Roster broadcasts also fire whenever somebody's connection
// dot flickers, and rebuilding on those would wipe whatever the host was halfway through typing;
// only a change of people (a join, a leave, a rename) is worth that.
let pickerRosterKey = '';
const rosterKey = () => othersInRoom().map((p) => `${p.playerId}:${p.nickname}`).join('|');

function renderModeChoices() {
  pickerRosterKey = rosterKey();
  if (pickMode === 'host' && !canPickForEveryone()) pickMode = 'deal';
  const box = $('modeChoices');
  box.innerHTML = '';
  const modes = [
    { v: 'deal', label: 'Deal at random', sub: 'everyone plays, you included', shape: '▲' },
    { v: 'each', label: 'Pick for each other', sub: 'everyone chooses who the next player is', shape: '●' },
    {
      v: 'host', label: "I'll pick them", shape: '◆', disabled: !canPickForEveryone(),
      sub: canPickForEveryone() ? 'you choose, and sit this one out' : 'needs 2 players besides you',
    },
  ];
  modes.forEach((m, i) => {
    const l = document.createElement('label');
    l.className = `choice c${i}`;
    if (m.disabled) l.style.opacity = '.55';
    const checked = m.v === pickMode;
    l.innerHTML = `<input type="radio" name="mode" value="${m.v}" ${checked ? 'checked' : ''} ${m.disabled ? 'disabled' : ''}>
      <span class="shape">${m.shape}</span>
      <span><div>${escapeHtml(m.label)}</div><div class="sub">${escapeHtml(m.sub)}</div></span>`;
    box.appendChild(l);
  });
  box.onchange = () => {
    pickMode = box.querySelector('input[name=mode]:checked')?.value || 'deal';
    syncPickMode();
  };
  syncPickMode();
}

function syncPickMode() {
  const host = pickMode === 'host';
  $('pickerBox').style.display = host ? '' : 'none';
  // The pool still matters in both picking modes -- for anyone the host leaves blank, and for a
  // player who taps Random -- so it stays, and says what it is now for.
  $('poolLabel').textContent =
    host ? 'Anyone left blank is drawn from' : pickMode === 'each' ? 'Random picks come from' : 'Draw characters from';
  $('dealBtn').textContent = host ? 'Start With These Picks' : pickMode === 'each' ? 'Start Picking' : 'Deal Characters';
  if (host) renderPicker();
  retilt($('config'));
}

function renderPicker() {
  const ul = $('pickerList');
  ul.innerHTML = '';
  const others = othersInRoom();
  // A pick for somebody who has left can't be dealt, and the server refuses the whole deal
  // rather than quietly drop it -- so forget it here, where the host can see it go.
  for (const id of [...hostPicks.keys()]) if (!others.some((p) => p.playerId === id)) hostPicks.delete(id);
  for (const p of others) ul.appendChild(pickSlot(p));
}

function pickSlot(p) {
  const li = document.createElement('li');
  li.className = 'pickslot';
  const head = document.createElement('div');
  head.className = 'pickhead';
  const who = document.createElement('span');
  who.className = 'name';
  who.textContent = p.nickname;
  const current = document.createElement('span');
  current.className = 'pickcurrent';
  head.append(who, current);
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search, or type any name';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', `Character for ${p.nickname}`);
  const results = document.createElement('div');
  li.append(head, input, results);

  const paint = () => {
    const pick = hostPicks.get(p.playerId);
    current.innerHTML = '';
    current.classList.toggle('random', !pick);
    if (!pick) { current.textContent = 'Random'; return; }
    if (pick.imageUrl) {
      const img = document.createElement('img');
      img.className = 'pickthumb';
      img.alt = '';
      img.src = pick.imageUrl;
      current.appendChild(img);
    }
    const label = document.createElement('span');
    label.className = 'lbl';
    label.textContent = pick.typed ? `“${pick.name}”` : pick.name;
    label.title = pick.typed ? 'Typed in — no picture' : pick.list || '';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'pickclear';
    clear.textContent = '✕';
    clear.setAttribute('aria-label', `Back to random for ${p.nickname}`);
    clear.addEventListener('click', () => { hostPicks.delete(p.playerId); paint(); });
    current.append(label, clear);
  };
  // Search and the typed-name row are /shared/pickers.js, shared with the pick-for-each-other
  // screen and the computers.
  window.GTCPickers?.characterSearch(input, results, (pick) => {
    hostPicks.set(p.playerId, pick);
    paint();
  });
  paint();
  return li;
}
// The host's last pool picker, read by deal(). Rebuilt each time the config screen opens, so it
// starts from the server's current curation for this room.
let poolPicker = null;
const ask = (event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

function renderConfig(opts) {
  // Through the fallback: if the picker script is missing or throws, a plain dropdown stands in
  // rather than the config screen never opening at all (this runs before show('config')).
  poolPicker = window.GTC?.mountPoolPicker
    ? GTC.mountPoolPicker($('poolPicker'), { options: opts, request: ask })
    : GTCPickers.poolPicker($('poolPicker'), { options: opts, request: ask });

  const diff = $('diffChoices');
  diff.innerHTML = '';
  const shapes = ['▲', '◆', '●', '■'];
  opts.difficulties.forEach((d, i) => {
    const l = document.createElement('label');
    l.className = `choice c${i}`;
    l.innerHTML = `<input type="radio" name="diff" value="${d.key}" ${d.key === opts.defaultDifficulty ? 'checked' : ''}>
      <span class="shape">${shapes[i % 4]}</span>
      <span><div>${d.label}</div><div class="sub">${d.blurb}</div></span>`;
    diff.appendChild(l);
  });
}

function deal() {
  const difficulty = $('diffChoices').querySelector('input[name=diff]:checked')?.value;
  const turnSeconds = Number($('turnSecondsSelect').value) || 60;
  $('configErr').textContent = 'Dealing…';
  const preferImages = $('preferImagesInput').checked;
  const config = { ...poolPicker.value(), difficulty, turnSeconds, preferImages };
  if (pickMode === 'each') config.eachPicks = true;
  if (pickMode === 'host') {
    const inRoom = new Set(othersInRoom().map((p) => p.playerId));
    config.hostPicks = true;
    // Blank slots are simply absent: the server deals those at random.
    config.picks = Object.fromEntries(
      [...hostPicks].filter(([id]) => inRoom.has(id)).map(([id, pk]) => [id, pk.typed ? { name: pk.name } : { id: pk.id }])
    );
  }
  socket.emit('setup:start', config, (res) => {
    $('configErr').textContent = res?.ok ? '' : (res?.error || 'Could not start.');
    // On success the server broadcasts status + setup:state, which switches the screen.
  });
}

