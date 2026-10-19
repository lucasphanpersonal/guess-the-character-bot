// Draw: the picture and the pad -- painting strokes in 0..1 coordinates, the fill, and makePad, the
// drawing surface the classic game and Telephone both use. Loaded after app.js (see its header).

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
// The eraser rubs rather than scratches: known by its palette name, as the server publishes it.
function scribbleOver(points, seconds, size, color) {
  if (!window.GTCSound?.scribble || points.length < 2) return;
  let dist = 0;
  for (let i = 1; i < points.length; i++) dist += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  const rub = PALETTE.some(([c, name]) => c === color && name === 'Eraser');
  window.GTCSound.scribble(dist / Math.max(0.016, seconds), size, { rub });
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
    scribbleOver([last, p], (t - (pad.movedAt ?? t - 16)) / 1000, live.size, live.color);
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
  if (s.kind !== 'fill') scribbleOver(s.points.slice(Math.max(0, from - 1)), PIECE_MS / 1000, s.size, s.color);
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

