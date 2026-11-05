// The 3D accents: a voxel object on the landing, lobby and results screens, drawn by Three.js at a
// low resolution and scaled up with hard edges, which is both the look and why a phone can afford it.
//
// Everything here is decoration, and the rules that follow from that:
//   - The game never waits for it. Every .fx3d box has a fixed height, a flat sprite of the same object
//     is drawn into it at once, and the renderer is fetched only after the page has settled. If
//     Three.js never arrives, WebGL is missing, or the device is too slow, the sprite simply stays.
//   - Nothing about a game reaches it. It takes model names, a player count and the names already on
//     the results table. The renderer never sees a character.
//   - One canvas and one WebGL context, moved to whichever box is on screen. Nothing renders when none
//     is, or when the tab is hidden: the forehead view and play have no box, so 3D costs nothing there.
//   - Device tilt is never read. iOS asks for motion once per site, ever, and the game needs that one
//     answer for itself (see primeMotion in party/public/app.js). Only a mouse moves these.
//
// Loaded as a plain script, last on each page. Its one global is GTCFx; callers use GTCFx?.x().
(function () {
  const Voxels = window.GTCVoxels;
  if (!Voxels) return;

  // A version in the name: a stylesheet's or script's own fetches are not stamped by server.js, so a
  // changed file must get a new name or a proxy will serve the old one for hours.
  const RENDERER_URL = '/shared/vendor/three-0.187.0.gtc.min.js';

  const media = (q) => window.matchMedia?.(q) ?? { matches: false, addEventListener() {} };
  const reduced = media('(prefers-reduced-motion: reduce)');
  const small = media('(pointer: coarse), (max-width: 760px)');
  const finePointer = media('(hover: hover) and (pointer: fine)');

  const hosts = new Map();          // .fx3d element -> { name, sprite }
  const onScreen = new Set();
  let active = null;                // the host the canvas is in
  let status = 'sprite';            // 'sprite' | 'loading' | 'webgl' | 'off:<why>'
  let three = null, renderer = null, scene = null, camera = null, group = null, canvas = null;
  let meshName = null, raf = 0, last = 0, startedAt = 0, frames = 0;
  let hopAt = -1e9, players = -1;
  let pointerX = 0, pointerY = 0, lookX = 0, lookY = 0;
  let slowSince = 0, resolutionDropped = false;

  // What a box is showing. The podium needs width a phone does not have, so a phone gets the trophy.
  const modelFor = (host) => {
    const name = host.dataset.fx || 'mascot';
    return name === 'podium' && small.matches ? 'trophy' : name;
  };

  // --- the flat version -----------------------------------------------------------------------

  // The same cubes, drawn front-on with a little of the top and right showing, onto a tiny 2D canvas
  // scaled up hard-edged. Front-on and not isometric, because the front is the point: isometric hid
  // the question mark on the mascot's phone. It needs no WebGL and no download, and it is what
  // reduced motion, a failed load or a slow device all see.
  const shade = (colour, f) => {
    const c = (s) => Math.round(((colour >> s) & 255) * f);
    return `rgb(${c(16)},${c(8)},${c(0)})`;
  };
  function drawSprite(cubes, spriteCanvas) {
    const u = Math.max(...cubes.map((c) => c.x)) - Math.min(...cubes.map((c) => c.x)) > 30 ? 2 : 3; // pixels a cube
    const d = 1;                                                                                     // depth a cube
    const sx = (c) => c.x * u - c.z * d, sy = (c) => -c.y * u + c.z * d;
    const xs = cubes.map(sx), ys = cubes.map(sy);
    const minX = Math.min(...xs), minY = Math.min(...ys) - d;
    spriteCanvas.width = Math.max(...xs) - minX + u + d;
    spriteCanvas.height = Math.max(...ys) - minY + u;
    const g = spriteCanvas.getContext('2d');
    if (!g) return;
    const poly = (pts, fill) => {
      g.fillStyle = fill;
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fill();
    };
    // Back to front, bottom to top, left to right, so nearer cubes paint over farther ones.
    for (const c of [...cubes].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x)) {
      const x = sx(c) - minX, y = sy(c) - minY;
      poly([[x, y], [x + u, y], [x + u + d, y - d], [x + d, y - d]], shade(c.colour, 1));                  // top
      poly([[x + u, y], [x + u + d, y - d], [x + u + d, y - d + u], [x + u, y + u]], shade(c.colour, 0.6)); // right
      g.fillStyle = shade(c.colour, 0.85);
      g.fillRect(x, y, u, u);                                                                               // front
    }
  }

  function setUpHost(host) {
    const sprite = document.createElement('canvas');
    sprite.className = 'fx3d-sprite';
    host.prepend(sprite);
    host.setAttribute('aria-hidden', 'true');
    const entry = { sprite, drawn: null };
    hosts.set(host, entry);
    paintSprite(host);
  }
  function paintSprite(host) {
    const entry = hosts.get(host);
    const name = modelFor(host);
    if (!entry || entry.drawn === name) return;
    entry.drawn = name;
    drawSprite(Voxels.build(name), entry.sprite);
  }

  // --- the renderer ---------------------------------------------------------------------------
  function loadRenderer() {
    return new Promise((resolve, reject) => {
      if (window.GTCThree) return resolve(window.GTCThree);
      const s = document.createElement('script');
      s.src = RENDERER_URL;
      s.onload = () => (window.GTCThree ? resolve(window.GTCThree) : reject(new Error('no renderer')));
      s.onerror = () => reject(new Error('renderer did not load'));
      document.head.append(s);
    });
  }

  const resolution = () => (small.matches ? 112 : 176) / (resolutionDropped ? 2 : 1);
  const sizeCanvas = () => renderer.setSize(Math.round(resolution() * (camera?.aspect ?? 1)), resolution(), false);

  function createRenderer() {
    canvas = document.createElement('canvas');
    canvas.className = 'fx3d-canvas';
    canvas.addEventListener('webglcontextlost', () => stop('context lost'));
    // No antialiasing and a pixel ratio of 1: hard edges are the look, and every pixel not drawn is
    // battery saved. Low-power asks a two-GPU laptop not to wake the big one for a decoration.
    renderer = new three.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(1);
    sizeCanvas();
    scene = new three.Scene();
    scene.add(new three.AmbientLight(0xffffff, 1.5));
    const sun = new three.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3, 6, 7);
    scene.add(sun);
    camera = new three.PerspectiveCamera(28, 1, 1, 400);
    group = new three.Group();
    scene.add(group);
  }

  function showModel(name) {
    if (meshName === name) return;
    meshName = name;
    while (group.children.length) {
      const m = group.children[0];
      group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
      m.dispose?.();
    }
    const cubes = Voxels.build(name);
    const mesh = new three.InstancedMesh(new three.BoxGeometry(1, 1, 1), new three.MeshLambertMaterial(), cubes.length);
    const at = new three.Object3D();
    const colour = new three.Color();
    const mid = (k) => (Math.min(...cubes.map((c) => c[k])) + Math.max(...cubes.map((c) => c[k]))) / 2;
    const [cx, cy, cz] = [mid('x'), mid('y'), mid('z')];
    let radius = 1;
    cubes.forEach((c, i) => {
      at.position.set(c.x - cx, c.y - cy, c.z - cz);
      at.updateMatrix();
      mesh.setMatrixAt(i, at.matrix);
      mesh.setColorAt(i, colour.setHex(c.colour));
      radius = Math.max(radius, Math.hypot(c.x - cx, c.y - cy, c.z - cz));
    });
    group.add(mesh);
    // A wide object gets a wide canvas, or it would shrink visibly as the wider sprite gives way to it.
    const pose = Voxels.pose(name);
    camera.aspect = pose.wide ?? 1;
    camera.updateProjectionMatrix();
    sizeCanvas();
    // Back far enough to fit. The radius reaches the object's farthest corner, which is only ever in
    // the frame at one angle, so 0.8 of the strict distance fills the box without cutting anything.
    camera.position.set(0, radius * 0.18, ((pose.fit ?? 0.8) * (radius + 1)) / Math.sin((camera.fov / 2) * Math.PI / 180));
    camera.lookAt(0, 0, 0);
  }

  // --- the loop -------------------------------------------------------------------------------
  // A fixed, low frame rate rather than the screen's: it is part of the look, and a phone at 24 draws
  // a second lasts longer than one at 60.
  const fps = () => (small.matches ? 24 : 30);

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const gap = now - last;
    if (gap < 1000 / fps() - 2) return;
    last = now;
    watchPace(gap, now);
    pose(now);
    renderer.render(scene, camera);
    frames++;
  }

  function pose(now) {
    const p = Voxels.pose(meshName);
    const t = (now - startedAt) / 1000;
    lookX += (pointerX - lookX) * 0.12;
    lookY += (pointerY - lookY) * 0.12;
    group.rotation.y = (p.spin ? t * 0.7 : p.yaw + Math.sin(t * 0.8) * p.sway) + lookX * 0.45;
    group.rotation.x = 0.12 + lookY * 0.25;
    group.rotation.z = p.tilt;
    // A hop when someone joins: up and back, with a squash as it lands.
    const h = (now - hopAt) / 420;
    const hop = h >= 0 && h < 1 ? Math.sin(h * Math.PI) : 0;
    const squash = h >= 0.8 && h < 1.1 ? 0.9 : 1;
    group.position.y = hop * 5;
    group.scale.set(1, squash, 1);
  }

  // Too slow first means fewer pixels, then no 3D at all. Only sustained slowness counts: one long
  // frame is a garbage collection or a screen change, and a hidden tab never gets here.
  const SLOW_FRAME_MS = 70, SLOW_FOR_MS = 2500;
  function watchPace(gap, now) {
    if (gap > 1000) { slowSince = 0; return; }   // back from a pause; says nothing about the device
    if (gap < SLOW_FRAME_MS) { slowSince = 0; return; }
    slowSince ||= now;
    if (now - slowSince < SLOW_FOR_MS) return;
    slowSince = 0;
    if (!resolutionDropped) {
      resolutionDropped = true;
      sizeCanvas();
    } else {
      stop('too slow');
    }
  }

  // Which box should have the canvas, and whether anything should run.
  function update() {
    const want = document.hidden || reduced.matches ? null : [...onScreen][0] ?? null;
    const live = want && renderer && !status.startsWith('off');
    if (active && active !== want) {
      active.classList.remove('live');
      canvas?.remove();
      active = null;
    }
    if (!live) {
      cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    if (active !== want) {
      showModel(modelFor(want));
      want.append(canvas);
      want.classList.add('live');
      active = want;
    }
    if (!raf) {
      startedAt ||= performance.now();
      last = 0;
      raf = requestAnimationFrame(tick);
    }
  }

  // The sprite stays where it is; the canvas goes, and does not come back this page load.
  function stop(why) {
    if (status.startsWith('off')) return;  // disposing below fires the context-lost event back here
    status = `off:${why}`;
    cancelAnimationFrame(raf);
    raf = 0;
    active?.classList.remove('live');
    active = null;
    canvas?.remove();
    try { renderer?.dispose(); renderer?.forceContextLoss?.(); } catch { /* it is going anyway */ }
    renderer = null;
  }

  async function start() {
    if (status !== 'sprite' || reduced.matches) return;
    status = 'loading';
    try {
      three = await loadRenderer();
      createRenderer();
      status = 'webgl';
      update();
    } catch (err) {
      stop(err.message || 'failed');
    }
  }

  // After the page has settled, and only once a box is actually on screen.
  const whenIdle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 400));

  // --- boot -----------------------------------------------------------------------------------
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) onScreen.add(e.target);
      else onScreen.delete(e.target);
    }
    if (onScreen.size && status === 'sprite') whenIdle(start);
    update();
  });

  for (const host of document.querySelectorAll('.fx3d')) {
    setUpHost(host);
    seen.observe(host);
  }

  document.addEventListener('visibilitychange', update);
  // Asking for less motion mid-session: settle at once, on the sprite.
  reduced.addEventListener?.('change', update);
  small.addEventListener?.('change', () => {
    for (const host of hosts.keys()) paintSprite(host);
    meshName = null;
    if (renderer) sizeCanvas();
    if (active) {
      const host = active;
      active = null;
      host.classList.remove('live');
      canvas?.remove();
    }
    update();
  });
  if (finePointer.matches) {
    window.addEventListener('pointermove', (e) => {
      pointerX = (e.clientX / innerWidth) * 2 - 1;
      pointerY = (e.clientY / innerHeight) * 2 - 1;
    }, { passive: true });
  }

  window.GTCFx = {
    // Someone joined: the object hops. Called with the count on every lobby render, so it only hops
    // when the count went up, and not for the first render or anyone leaving.
    players(n) {
      if (players >= 0 && n > players && !reduced.matches) hopAt = performance.now();
      players = n;
    },
    // The names under the podium, at most three: first, second, third. textContent, because they are
    // whatever people typed.
    podium(names) {
      for (const el of document.querySelectorAll('[data-podium-place]')) {
        el.textContent = names[Number(el.dataset.podiumPlace) - 1] ?? '';
      }
    },
    // What is running, for checking by hand and in a browser: there is no other way to tell a sprite
    // from a paused canvas.
    state: () => ({ status, model: meshName, frames, active: !!active, running: !!raf, onScreen: onScreen.size }),
    stop,
  };
})();
