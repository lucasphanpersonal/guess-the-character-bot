// Draw: after the game -- the results, the gallery of every drawing, the viewer, and the vote.
// Loaded after app.js and pad.js; Telephone (tel.js) uses the viewer too.

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
