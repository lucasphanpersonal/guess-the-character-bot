// The 3D objects, as lists of coloured cubes built here in code: no model files to fetch, so a phone
// on a bad connection downloads nothing but the renderer. Pure, so test/voxels.test.js can check them
// without a browser, and the same cubes draw both the WebGL version and the flat sprite that stands
// in for it (/shared/fx3d.js).
//
// Decoration only: none of this ever holds, or is passed, anything about a game. Used in the browser
// as a plain script (window.GTCVoxels), and from Node by the tests.
(function (root) {
  const INK = 0x1a1633, CREAM = 0xfff6e0, RED = 0xd42a4a, AMBER = 0xffb000, AMBER_D = 0xc77f00;
  const SILVER = 0xc9c9dc, BRONZE = 0xc9804a, INDIGO = 0x34297a, SKIN = 0xf0b98a, PINK = 0xf08aa8, GREY = 0x8d8aa6, WOOD = 0xe8c48c;

  // One object under construction: later cubes replace earlier ones in the same cell.
  function canvas() {
    const cells = new Map();
    const put = (x, y, z, colour) => cells.set(`${x},${y},${z}`, { x, y, z, colour });
    const box = (x0, x1, y0, y1, z0, z1, colour) => {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) put(x, y, z, colour);
    };
    // A pattern of rows, top row first, on the plane z, with its bottom-left cell at (x, y).
    const stamp = (rows, x, y, z, colour) => {
      rows.forEach((row, r) => {
        [...row].forEach((ch, c) => { if (ch === '#') put(x + c, y + rows.length - 1 - r, z, colour); });
      });
    };
    // Only the cubes that can be seen: a solid head of a thousand cubes is a few hundred from outside.
    const done = () => {
      const has = (x, y, z) => cells.has(`${x},${y},${z}`);
      return [...cells.values()].filter(({ x, y, z }) =>
        !(has(x + 1, y, z) && has(x - 1, y, z) && has(x, y + 1, z) && has(x, y - 1, z) && has(x, y, z + 1) && has(x, y, z - 1)));
    };
    return { put, box, stamp, done };
  }

  // The game itself as a mascot: a blocky head wearing a phone on its forehead, screen out, with a
  // question mark on it -- it does not know who it is either.
  function mascot() {
    const v = canvas();
    v.box(-5, 4, -5, 8, -5, 4, SKIN);
    v.box(-5, 4, 7, 9, -5, 4, INDIGO);    // hair
    v.box(-6, 5, 4, 5, -6, 5, RED);       // the band that holds the phone on
    v.box(-4, 3, 2, 11, 5, 5, INK);       // the phone
    v.box(-3, 2, 3, 10, 5, 5, CREAM);     // its screen
    v.stamp(['.####.', '#....#', '....#.', '...#..', '......', '...#..'], -3, 3, 5, RED);
    v.box(-4, -3, -1, 0, 5, 5, CREAM);    // eyes, looking up at the phone it cannot read
    v.put(-3, 0, 5, INK);
    v.box(2, 3, -1, 0, 5, 5, CREAM);
    v.put(2, 0, 5, INK);
    v.box(-1, 0, -3, -3, 5, 5, INK);      // a small, hopeful smile
    v.put(-2, -2, 5, INK);
    v.put(1, -2, 5, INK);
    return v.done();
  }

  // Draw's mascot: a chunky pencil, point down.
  function pencil() {
    const v = canvas();
    v.box(-3, 3, 0, 16, -3, 3, AMBER);
    v.box(-1, 1, 0, 16, 3, 3, AMBER_D);   // the flat of the pencil, so it reads as faceted
    v.box(-3, 3, 17, 18, -3, 3, GREY);    // ferrule
    v.box(-3, 3, 19, 22, -3, 3, PINK);    // eraser
    v.box(-2, 2, -2, -1, -2, 2, WOOD);    // sharpened wood, stepping in
    v.box(-1, 1, -4, -3, -1, 1, WOOD);
    v.box(-1, 1, -5, -5, -1, 1, INK);     // lead
    v.put(0, -6, 0, INK);
    return v.done();
  }

  function trophyAt(v, ox, oy, oz) {
    v.box(ox - 4, ox + 4, oy, oy + 1, oz - 4, oz + 4, INDIGO);        // plinth
    v.box(ox - 2, ox + 2, oy + 2, oy + 2, oz - 2, oz + 2, AMBER_D);
    v.box(ox - 1, ox + 1, oy + 3, oy + 5, oz - 1, oz + 1, AMBER);     // stem
    const radius = [2, 3, 4, 5, 5, 5, 5, 5, 5];                       // the cup, narrow at the bottom
    radius.forEach((r, i) => {
      const y = oy + 6 + i;
      for (let x = -r; x <= r; x++) {
        for (let z = -r; z <= r; z++) {
          const d = x * x + z * z;
          if (d > r * r) continue;
          // The top two rows are a rim around a hollow, so it is a cup and not a post.
          const hollow = i >= radius.length - 2 && d < (r - 1) * (r - 1);
          if (!hollow) v.put(ox + x, y, oz + z, AMBER);
        }
      }
    });
    for (const side of [-1, 1]) {                                     // handles
      v.box(ox + side * 6, ox + side * 7, oy + 12, oy + 12, oz, oz, AMBER_D);
      v.box(ox + side * 7, ox + side * 7, oy + 9, oy + 12, oz, oz, AMBER_D);
      v.box(ox + side * 6, ox + side * 7, oy + 9, oy + 9, oz, oz, AMBER_D);
    }
    return v;
  }

  function trophy() {
    return trophyAt(canvas(), 0, 0, 0).done();
  }

  const DIGITS = {
    1: ['.#.', '##.', '.#.', '.#.', '###'],
    2: ['##.', '..#', '.#.', '#..', '###'],
    3: ['##.', '..#', '.#.', '..#', '##.'],
  };

  // Three steps, the winner's in the middle with the trophy on it. Who stands where is said in HTML
  // beneath it, because names need to be read and may be in any script.
  function podium() {
    const v = canvas();
    const step = (x0, x1, height, top, digit) => {
      v.box(x0, x1, 0, height - 1, -6, 6, INDIGO);
      v.box(x0, x1, height, height, -6, 6, top);
      v.stamp(DIGITS[digit], Math.round((x0 + x1) / 2) - 1, Math.max(1, height - 7), 6, CREAM);
    };
    step(-7, 7, 11, AMBER, 1);
    step(-22, -8, 7, SILVER, 2);
    step(8, 22, 5, BRONZE, 3);
    return trophyAt(v, 0, 12, 0).done();
  }

  const MODELS = { mascot, pencil, trophy, podium };

  // Which way an object's best side faces, and how it moves: the mascot and the pencil sway so their
  // fronts stay in view; a trophy turns all the way round.
  const POSE = {
    mascot: { spin: false, tilt: 0, sway: 0.55, yaw: -0.3 },
    pencil: { spin: false, tilt: -0.6, sway: 0.5, yaw: -0.3 },
    trophy: { spin: true, tilt: 0, sway: 0, yaw: 0 },
    podium: { spin: false, tilt: 0, sway: 0.28, yaw: -0.18, wide: 1.6, fit: 0.58 },
  };

  const api = {
    names: Object.keys(MODELS),
    build: (name) => (MODELS[name] ?? mascot)(),
    pose: (name) => POSE[name] ?? POSE.mascot,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GTCVoxels = api;
})(typeof window !== 'undefined' ? window : globalThis);
