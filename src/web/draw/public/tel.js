// Telephone, on the Draw page: everyone at once, each on a chain passed one seat along per step --
// pick, draw, guess, draw ... -- then the replay, a card at a time, and the album.
//
// Loaded after app.js, pad.js and gallery.js, whose pieces it uses: the socket, the pad and the tools row (makePad,
// activePad), the clock (setClock), pictures (characterArt, thumbnail, paintDrawing) and the
// viewer (galleryItems, openViewer). The server's rules are ../telephone.js; this only shows them.
// During play the server sends each player their own task and nothing else, so neither can this.

let telView = null;
// Which task is on screen: a fresh view arrives every time anyone hands in, and that must not
// wipe a drawing or a guess half done.
let telTaskKey = '';
let telShownKey = '';

const TEL_CLOCK = { secs: 'telClockSecs', fill: 'telClockFill', bar: 'telClock' };

// The Telephone canvas. Unlike the classic one, nobody else is drawing on it or watching: undo and
// clear happen here at once, and the server is told so its copy (the one a timeout hands in) agrees.
const telPad = makePad($('telCanvas'), {
  canDraw: () => telView?.task?.kind === 'draw' && !telView.paused,
  send: (piece) => socket.emit('tel:stroke', piece),
  undo: (pad) => {
    pad.strokes.pop();
    pad.redraw();
    socket.emit('tel:undo');
  },
  clear: (pad) => {
    pad.strokes = [];
    pad.redraw();
    socket.emit('tel:clear');
  },
});

socket.on('tel:state', (v) => {
  telView = v;
  view = null; // the classic game's view: this room is not playing that
  show('tel');
  renderTel();
});

const KIND_LABEL = { pick: 'Start a Chain', draw: 'Draw', guess: 'Guess' };
const listNames = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '');

function renderTel() {
  const v = telView;
  if (!v) return;
  const playing = !!v.kind;
  $('telStep').textContent = playing ? `Step ${v.step + 1} of ${v.steps} · ${KIND_LABEL[v.kind]}` : v.phase === 'replay' ? 'The Replay' : 'The Album';
  $('telClockRow').hidden = !playing;
  if (playing) setClock(v.secondsLeft, v.stepSeconds, null, v.paused, TEL_CLOCK);
  else clearInterval(clockTimer);

  const task = v.task;
  const key = task ? `${v.step}:${task.kind}` : `${v.phase}:${v.step}`;
  const fresh = key !== telTaskKey;
  telTaskKey = key;
  for (const id of ['telPick', 'telDraw', 'telGuess', 'telWait', 'telReplay', 'telAlbum']) $(id).hidden = true;
  $('telPrompt').innerHTML = '';

  if (task?.kind === 'pick') {
    $('telPick').hidden = false;
    $('telPrompt').textContent = 'Pick a character. Someone else will draw it.';
    $('telChoices').innerHTML = task.choices
      .map((c, i) => `<button type="button" data-tel-pick="${i}"><div class="art">${characterArt(c)}</div><span>${esc(c.name)}</span><span class="hint" title="${esc(c.source)}">${esc(c.source)}</span></button>`)
      .join('');
  } else if (task?.kind === 'draw') {
    $('telDraw').hidden = false;
    $('telPrompt').innerHTML = `Draw <b>${esc(task.prompt)}</b>`;
    // The tools row is one element, shared with the classic game: it comes here while drawing.
    $('telToolsSlot').append($('tools'));
    $('tools').hidden = false;
    activePad = telPad;
    if (fresh) {
      // A new step starts a blank page -- or, coming back to this one, the drawing so far.
      telPad.strokes = (task.draft ?? []).map((s) => ({ ...s, points: [...s.points] }));
      telPad.redraw();
    }
    $('telDone').disabled = !!v.paused;
  } else if (task?.kind === 'guess') {
    $('telGuess').hidden = false;
    $('telPrompt').textContent = task.skipped ? 'Whoever had this drawing left. Guess anything!' : !task.drawing?.length ? 'Nothing was drawn here. Guess anyway!' : 'What is this a drawing of?';
    if (fresh) {
      paintDrawing($('telSeen'), task.drawing ?? []);
      $('telGuessInput').value = '';
      if (matchMedia('(pointer: fine)').matches) $('telGuessInput').focus();
    }
  } else if (playing) {
    $('telWait').hidden = false;
    // Count, then name: whose phone to go and look at.
    const n = v.waitingOn.length;
    $('telWaitText').textContent = n ? `Waiting on ${listNames(v.waitingOn)}.` : 'Everyone is in.';
  } else if (v.phase === 'replay') {
    renderReplay(v);
  } else if (v.phase === 'over') {
    renderAlbum(v);
  }

  // Who has handed in, this step.
  $('telPlayers').innerHTML = v.players
    .map((p) => {
      const tag = p.left ? '<span class="tag gaveup">Left</span>' : playing && p.done ? '<span class="tag got">✓ In</span>' : '';
      const name = `${esc(p.name)}${p.playerId === me ? ' (you)' : ''}`;
      return `<li class="${p.done ? 'got' : ''}${p.left ? ' left' : ''}"><span class="pname" title="${name}">${name}</span>${tag}</li>`;
    })
    .join('');
}

// --- a chain, card by card ---------------------------------------------------------------------
// Drawings go to the viewer (open big, Save Image); `pics` collects them for it in order.
function chainHtml(chain, pics, { latest = false } = {}) {
  const cards = chain.entries.map((e, k) => {
    const last = latest && k === chain.entries.length - 1 ? ' fresh' : '';
    if (e.kind === 'pick') {
      return `<li class="tc tc-pick${last}"><div class="tcby">${esc(chain.owner)} started with</div><div class="tcrow"><div class="tcart">${characterArt(e.character)}</div><div class="tctext">${esc(e.text)}</div></div></li>`;
    }
    if (e.kind === 'draw') {
      if (e.skipped) return `<li class="tc tc-skipped${last}"><div class="tcby">${esc(e.by)} left</div><div class="tctext">No drawing</div></li>`;
      const prompt = chain.entries[k - 1]?.text ?? '';
      pics.push({ character: { name: `“${prompt}”` }, drawer: e.by, strokes: e.strokes, caption: `Drawn by ${e.by}, from “${prompt}”` });
      return `<li class="tc tc-draw${last}"><div class="tcby">${esc(e.by)} drew</div><button type="button" class="tcpic" data-pic="${pics.length - 1}" aria-label="Open ${esc(e.by)}'s drawing"></button></li>`;
    }
    const cls = e.blank || e.skipped ? ' blank' : '';
    const said = e.blank || e.skipped ? esc(e.text) : `“${esc(e.text)}”`;
    return `<li class="tc tc-guess${cls}${last}"><div class="tcby">${esc(e.by)} guessed</div><div class="tctext">${said}</div></li>`;
  });
  if (chain.madeIt != null) {
    cards.push(`<li class="tcend ${chain.madeIt ? 'yes' : 'no'}${latest ? ' fresh' : ''}">${chain.madeIt ? '✓ Made it through!' : '✗ Lost along the way'}</li>`);
  }
  return `<ol class="telchain">${cards.join('')}</ol>`;
}
// Drawings painted into their buttons once the cards are on the page.
function paintPics(root, pics) {
  for (const b of root.querySelectorAll('[data-pic]')) b.append(thumbnail(pics[Number(b.dataset.pic)]));
  galleryItems = pics; // the viewer's list, for ‹ › and Save Image
}

function renderReplay(v) {
  $('telReplay').hidden = false;
  const r = v.replay;
  const key = `${r.chain}:${r.entries.length}:${r.madeIt}`;
  $('telReplayTitle').textContent = `${r.owner}'s Chain · ${r.chain + 1} of ${r.of}`;
  if (key !== telShownKey) {
    telShownKey = key;
    const pics = [];
    $('telReplayChain').innerHTML = chainHtml(r, pics, { latest: true });
    paintPics($('telReplayChain'), pics);
    // The newest card into view: on a phone the chain soon runs past the bottom of the screen.
    $('telReplayChain').querySelector('.fresh')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  const host = isHost();
  $('telNav').hidden = !host;
  $('telReplayHint').hidden = host;
  const end = r.entries.length >= r.length;
  $('telNext').textContent = !end ? 'Next' : r.chain + 1 < r.of ? 'Next Chain' : 'To the Album';
  $('telBack').disabled = r.chain === 0 && r.entries.length <= 1;
}

function renderAlbum(v) {
  $('telAlbum').hidden = false;
  if (telShownKey !== 'album') {
    telShownKey = 'album';
    const pics = [];
    $('telChains').innerHTML = v.album
      .map((c) => `<div class="card stack"><h2>${esc(c.owner)}'s Chain</h2>${chainHtml(c, pics)}</div>`)
      .join('');
    paintPics($('telChains'), pics);
  }
  $('telHostOver').hidden = !isHost();
  $('telGuestOver').hidden = isHost();
}

// --- what the player does ----------------------------------------------------------------------
const telSend = (event, payload = {}) =>
  socket.emit(event, payload, (res) => {
    if (res && !res.ok) toast(esc(res.error || 'That did not work.'));
  });
$('telChoices').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tel-pick]');
  if (b) telSend('tel:pick', { index: Number(b.dataset.telPick) });
});
$('telReroll').addEventListener('click', () => telSend('tel:reroll'));
$('telDone').addEventListener('click', () => {
  telPad.flush(); // the last piece of the last stroke first
  telSend('tel:submit');
});
let telTyping = null;
$('telGuessInput').addEventListener('input', () => {
  // Kept on the server as it is typed: a clock that runs out hands in this, not nothing.
  clearTimeout(telTyping);
  telTyping = setTimeout(() => socket.emit('tel:typing', { text: $('telGuessInput').value }), 400);
});
$('telGuessForm').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(telTyping);
  telSend('tel:submit', { text: $('telGuessInput').value });
});
$('telNext').addEventListener('click', () => telSend('tel:next'));
$('telBack').addEventListener('click', () => telSend('tel:back'));
for (const root of ['telReplayChain', 'telChains']) {
  $(root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-pic]');
    if (b) openViewer(Number(b.dataset.pic));
  });
}
$('telRematchBtn').addEventListener('click', () => telSend('draw:rematch'));
$('telAgainBtn').addEventListener('click', () => telSend('draw:again'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && telView && telView.phase !== 'over') socket.emit('tel:resync', {}, () => {});
});
