// Flybys: now and then something crosses the starfield behind the page -- a rocket, a saucer, a
// tumbling asteroid, a comet, a satellite, and once in a while a husky in a space helmet.
//
// Decoration, and rare on purpose: one at a time, the first after 15-45 seconds and each next one
// 30-90 seconds after the last has gone. Something you notice now and then, not a screensaver.
//
//   - Behind everything and untouchable: one fixed layer at z-index -1 (just above the stars),
//     pointer-events none, aria-hidden. It never covers a word or takes a tap.
//   - Cheap on a phone: one small inline SVG at a time, moved by a transform on the compositor and
//     removed when it has crossed. Nothing exists between flybys, and no timer runs while the tab is
//     hidden (the one in flight is paused where it is and carries on when the tab comes back).
//   - Stepped, like the rest of the motion: the crossing moves in whole sprite pixels, never eased.
//   - Not for reduced motion (none are launched, and one in flight is removed), and not during play
//     on the phones (body.at-play), where the screen is on a forehead or about to be. retro.css hides
//     the layer in both cases too, so nothing slips past a launch that was already decided.
//   - All of it is drawn here, as pixel grids: no images, no fetches, nobody else's sprites.
//
// Loaded as a plain script on every page. Its one global is GTCFlybys; GTCFlybys.launch(kind) sends
// one across now, which is how to look at them without waiting.
(function () {
  if (!document.body || !window.matchMedia || !Element.prototype.animate) return;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const small = matchMedia('(max-width: 560px)');

  // --- the sprites --------------------------------------------------------------------------------
  // One character per pixel. Colours are fixed rather than tokens: they are things in space, on the
  // night field in both themes, like the stars. A second grid is a second frame (the rocket's flame,
  // the saucer's lights), swapped by retro.css.
  const INK = {
    k: '#0c0a24', w: '#fff6e0', g: '#a69fb8', G: '#6b6488', d: '#4a4466',
    r: '#d42a4a', R: '#8f1530', b: '#7fd6ff', B: '#2a64d6', y: '#ffb000', o: '#ff6b2a',
    p: '#c9a0ff',
  };

  const SPRITES = {
    rocket: {
      weight: 3, faces: true, speed: [70, 110],
      frames: [[
        '.......kkkk.........',
        '.......krrRk........',
        '.....kkkkkkkkkkkk...',
        '....kwwwwwwwwwwwwkk.',
        '..yykwwwbbwwwwwwwwrk',
        '.yookwwwbBwwwwwwwwrR',
        '..yykwwwwwwwwwwwwwrk',
        '....kwwwwwwwwwwwwkk.',
        '.....kkkkkkkkkkkk...',
        '.......krrRk........',
        '.......kkkk.........',
      ], [
        '.......kkkk.........',
        '.......krrRk........',
        '.....kkkkkkkkkkkk...',
        '...ykwwwwwwwwwwwwkk.',
        '.yookwwwbbwwwwwwwwrk',
        'yooykwwwbBwwwwwwwwrR',
        '.yookwwwwwwwwwwwwwrk',
        '...ykwwwwwwwwwwwwkk.',
        '.....kkkkkkkkkkkk...',
        '.......krrRk........',
        '.......kkkk.........',
      ]],
    },
    saucer: {
      weight: 2, bob: true, speed: [55, 85],
      frames: [[
        '......kkkkkk......',
        '.....kbbbbwbk.....',
        '.....kbbbbbbk.....',
        '..kkkkkkkkkkkkkk..',
        '.kgggwggggggggggk.',
        'kGyGGGGyGGGGyGGGGk',
        '.kkGGGGGGGGGGGGkk.',
        '...kkkkkkkkkkkk...',
      ], [
        '......kkkkkk......',
        '.....kbbbbwbk.....',
        '.....kbbbbbbk.....',
        '..kkkkkkkkkkkkkk..',
        '.kgggwggggggggggk.',
        'kGGGyGGGGyGGGGyGGk',
        '.kkGGGGGGGGGGGGkk.',
        '...kkkkkkkkkkkk...',
      ]],
    },
    asteroid: {
      weight: 3, tumble: true, speed: [35, 60],
      frames: [[
        '....kkkk....',
        '..kkGgggkk..',
        '.kGgggGgggk.',
        '.kgggggggGk.',
        'kGggGGggggGk',
        'kgggGdgggggk',
        'kggggggGgggk',
        'kGgggggGdggk',
        '.kGggggggGk.',
        '.kkGggGggk..',
        '...kkGGkk...',
        '.....kk.....',
      ]],
    },
    comet: {
      weight: 2, faces: true, speed: [220, 320],
      frames: [[
        '...........kkkk...',
        '......b..bbwwwwk..',
        '..b.bbbbwwwwyywwk.',
        'bb.bbwwwwwwyyyyywk',
        '..b.bbbbwwwwyywwk.',
        '......b..bbwwwwk..',
        '...........kkkk...',
      ]],
    },
    satellite: {
      weight: 2, tumble: true, speed: [40, 65],
      frames: [[
        '.........k.........',
        '........kyk........',
        '.........k.........',
        'kkkkkk..kkk..kkkkkk',
        'kBbBbk.kgggk.kBbBbk',
        'kbBbBkkkgwgkkkbBbBk',
        'kBbBbk.kgggk.kBbBbk',
        'kkkkkk..kkk..kkkkkk',
        '........kdk........',
        '.......kdddk.......',
      ]],
    },
    // The rare one.
    husky: {
      weight: 1, bob: true, speed: [30, 45],
      frames: [[
        '......bbbbbb......',
        '....bb......bb....',
        '...b..k....k..b...',
        '..bw.kGk..kGk..b..',
        '..bwkGGkkkkGGk.b..',
        '.b..kGGGGGGGGk..b.',
        '.b.kGGwwGGwwGGk.b.',
        '.b.kGwBkwwkBwGk.b.',
        '.b.kwwwwkkwwwwk.b.',
        '.b..kwwwwwwwwk..b.',
        '..b..kwwrrwwk..b..',
        '..b...kkrrkk...b..',
        '...b...kkkk...b...',
        '....bbrrrrrrbb....',
        '....kwwwwwwwwk....',
        '.....kwwggwwk.....',
      ]],
    },
  };

  // A grid to SVG: one rect per run of a colour along a row, crisp at any scale.
  function svgFor(frames, px) {
    const h = frames[0].length, w = Math.max(...frames[0].map((r) => r.length));
    const groups = frames.map((grid, f) => {
      let rects = '';
      grid.forEach((row, y) => {
        for (let x = 0; x < row.length;) {
          const c = row[x];
          let n = 1;
          while (row[x + n] === c) n++;
          if (INK[c]) rects += `<rect x="${x}" y="${y}" width="${n}" height="1" fill="${INK[c]}"/>`;
          x += n;
        }
      });
      return `<g class="fb-f${f}">${rects}</g>`;
    }).join('');
    return {
      w: w * px, h: h * px,
      html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * px}" height="${h * px}" shape-rendering="crispEdges">${groups}</svg>`,
    };
  }

  // --- the sky ------------------------------------------------------------------------------------
  const layer = document.createElement('div');
  layer.className = 'flybys';
  layer.setAttribute('aria-hidden', 'true');
  document.body.prepend(layer);

  let timer = 0, dueAt = 0, flight = null;
  const between = (a, b) => a + Math.random() * (b - a);
  const quiet = () => reduced.matches || document.body.classList.contains('at-play');

  function pick() {
    const kinds = Object.keys(SPRITES);
    let roll = Math.random() * kinds.reduce((t, k) => t + SPRITES[k].weight, 0);
    for (const k of kinds) if ((roll -= SPRITES[k].weight) < 0) return k;
    return kinds[0];
  }

  function launch(kind = pick()) {
    const s = SPRITES[kind];
    if (!s || flight) return false;
    const px = small.matches ? 3 : 4;
    const art = svgFor(s.frames, px);
    const vw = innerWidth, vh = innerHeight;
    const ltr = Math.random() < 0.5;
    const x0 = ltr ? -art.w - 8 : vw + 8, x1 = ltr ? vw + 8 : -art.w - 8;
    // Anywhere but the very top and bottom, drifting up or down a little on the way across.
    const y0 = between(0.08, 0.8) * vh, y1 = Math.min(0.88 * vh, Math.max(0.04 * vh, y0 + between(-0.25, 0.25) * vh));
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const ms = (dist / between(...s.speed)) * 1000;

    const el = document.createElement('div');
    el.className = `flyby fb-${kind}` + (s.frames.length > 1 ? ' fb-anim' : '') +
      (s.bob ? ' fb-bob' : '') + (s.tumble ? ' fb-tumble' : '');
    // Drawn facing right; a face going left is mirrored inside, so the crossing's transform is plain.
    el.innerHTML = `<div class="fb-art"${s.faces && !ltr ? ' style="transform:scaleX(-1)"' : ''}>${art.html}</div>`;
    layer.append(el);
    // Whole sprite pixels per step, at no more than 20 steps a second.
    const steps = Math.max(1, Math.round(Math.min(dist / px, (ms / 1000) * 20)));
    const anim = el.animate(
      [{ transform: `translate(${x0}px, ${y0}px)` }, { transform: `translate(${x1}px, ${y1}px)` }],
      { duration: ms, easing: `steps(${steps}, end)`, fill: 'both' });
    flight = { el, anim };
    if (document.hidden) anim.pause();
    const done = () => {
      if (flight?.el !== el) return;
      el.remove();
      flight = null;
      schedule(30, 90);
    };
    anim.onfinish = done;
    anim.oncancel = done;
    return true;
  }

  function schedule(minS, maxS) {
    clearTimeout(timer);
    if (document.hidden || reduced.matches) { timer = 0; return; }
    const wait = between(minS, maxS) * 1000;
    dueAt = Date.now() + wait;
    timer = setTimeout(tick, wait);
  }

  function tick() {
    timer = 0;
    // During play nothing goes up, and the clock simply restarts: no backlog to launch the moment
    // the game ends.
    if (quiet() || !launch()) schedule(30, 90);
  }

  // A hidden tab: the one in flight stops where it is and the wait is shelved; both pick up again
  // when it comes back, the wait from where it left off.
  let leftMs = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      flight?.anim.pause();
      if (timer) { clearTimeout(timer); timer = 0; leftMs = Math.max(0, dueAt - Date.now()); }
    } else {
      flight?.anim.play();
      if (!flight && !timer && !reduced.matches) {
        if (leftMs) { const s = leftMs / 1000; leftMs = 0; schedule(s, s); } else schedule(30, 90);
      }
    }
  });

  // Reduced motion switched on mid-flight: gone at once. Switched off: the usual wait.
  reduced.addEventListener?.('change', () => {
    if (reduced.matches) { clearTimeout(timer); timer = 0; flight?.anim.cancel(); }
    else if (!flight) schedule(30, 90);
  });

  schedule(15, 45);
  window.GTCFlybys = { launch, kinds: Object.keys(SPRITES) };
})();
