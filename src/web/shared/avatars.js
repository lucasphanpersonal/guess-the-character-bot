// The players' faces: a set of small pixel sprites, one per seat, picked in the lobby.
//
// The server holds only a number per seat (rooms.js), and takes its count from here, so a sprite
// added below is a sprite every room can hand out. Loaded by node for that count and by every
// page (after common.js) for the drawing and the lobby's picker.
//
// The art is original and drawn for this site, a 12 x 12 grid per sprite. Each sprite sits on a
// coloured square of its own, so a face is told apart by its colour AND its shape -- at 24px, in a
// roster of eight, the colour is what the eye finds first and the shape is what confirms it. The
// colours are fixed here, not tokens: an image cannot read the page's theme, and every square is a
// mid-tone that holds against cream and against the dark field alike.
//
// Pixels are for the UI layer, and these are UI: they render with crisp edges at whole multiples
// of the grid (24px, 36px, 48px). Decoration beside a name, never instead of it.
(function (root) {
  const SIZE = 12;

  // Shared inks. A sprite's own colours sit beside these in its `ink`.
  const INK = {
    k: '#0c0a24', // outline
    w: '#fff6e0', // white, the site's cream
    y: '#ffd84d', // yellow
    o: '#ff9a4d', // orange
    r: '#e8364f', // red
    p: '#ff8fb1', // pink
    c: '#7fd6ff', // sky
    s: '#d6d6e8', // silver
    d: '#8a86a8', // shade
  };

  // name, square, extra inks, rows. '.' is the square showing through.
  const SET = [
    { name: 'Cat', bg: '#2a64d6', ink: {}, rows: [
      '............',
      '.k........k.',
      '.kk......kk.',
      '.kok....kok.',
      '.kookkkkook.',
      '.kooooooook.',
      '.kowkoowkok.',
      '.koooppoook.',
      '.koowwwwook.',
      '..kooooook..',
      '...kkkkkk...',
      '............'] },
    { name: 'Frog', bg: '#6b4fd6', ink: { g: '#7ee07e', G: '#1c8237' }, rows: [
      '............',
      '.kkk....kkk.',
      'kwwwk..kwwwk',
      'kwkwkkkkwkwk',
      'kwwwggggwwwk',
      '.kggggggggk.',
      'kggggggggggk',
      'kgkggggggkgk',
      'kggkkkkkkggk',
      '.kGggggggGk.',
      '..kkkkkkkk..',
      '............'] },
    { name: 'Robot', bg: '#d42a4a', ink: {}, rows: [
      '.....rr.....',
      '.....kk.....',
      '.kkkkkkkkkk.',
      '.kssssssssk.',
      '.ksccssccsk.',
      'kksccssccskk',
      'kksssssssskk',
      '.kssssssssk.',
      '.ksdkdkdksk.',
      '.kssssssssk.',
      '.kkkkkkkkkk.',
      '............'] },
    { name: 'Alien', bg: '#2b2a86', ink: { l: '#b6f05a' }, rows: [
      '............',
      '...kkkkkk...',
      '..kllllllk..',
      '.kllllllllk.',
      'kllllllllllk',
      'klkkkllkkklk',
      'klkwkllkwklk',
      '.klkkllkklk.',
      '.kllllllllk.',
      '..kllkkllk..',
      '...kllllk...',
      '....kkkk....'] },
    { name: 'Octopus', bg: '#0f8a8a', ink: { u: '#c9a0ff', U: '#8f63d6' }, rows: [
      '............',
      '...kkkkkk...',
      '..kuuuuuuk..',
      '.kuuuuuuuuk.',
      '.kuwkuuwkuk.',
      '.kuuuuuuuuk.',
      '.kuuuUUuuuk.',
      '.kuuuuuuuuk.',
      'kuukuukuukuk',
      'kuk.kuk.kuk.',
      '.k...k...k..',
      '............'] },
    { name: 'Owl', bg: '#1c8237', ink: { b: '#a0643c', t: '#e8c08a' }, rows: [
      '............',
      '.kk......kk.',
      '.kbk....kbk.',
      '.kbbkkkkbbk.',
      'kbwwwbbwwwbk',
      'kbwkwbbwkwbk',
      'kbwwwyywwwbk',
      'kbbbbyybbbbk',
      'kbttttttttbk',
      '.kttkttkttk.',
      '..kttttttk..',
      '...kykkyk...'] },
    { name: 'Bear', bg: '#c25a9e', ink: { B: '#8a5a34', n: '#d9a877' }, rows: [
      '.kk......kk.',
      'kBBk....kBBk',
      'kBnBkkkkBnBk',
      '.kBBBBBBBBk.',
      'kBBBBBBBBBBk',
      'kBBkBBBBkBBk',
      'kBBBnnnnBBBk',
      'kBBnnkknnBBk',
      'kBBnnnnnnBBk',
      '.kBBBBBBBBk.',
      '..kkkkkkkk..',
      '............'] },
    { name: 'Chick', bg: '#2a64d6', ink: {}, rows: [
      '.....kk.....',
      '...kkyykk...',
      '..kyyyyyyk..',
      '.kyyyyyyyyk.',
      '.kyykyykyyk.',
      '.kyyyyyyyyk.',
      '.kyyoooooyk.',
      '.kyykkkkyyk.',
      'kyyyyyyyyyyk',
      'kyyyyyyyyyyk',
      '.kkkokkokkk.',
      '....o..o....'] },
    { name: 'Slime', bg: '#6b4fd6', ink: {}, rows: [
      '............',
      '............',
      '.....kk.....',
      '....kcck....',
      '...kccwck...',
      '..kccccwck..',
      '.kcckcckcck.',
      '.kcckcckcck.',
      'kcccccccccck',
      'kcccckkcccck',
      '.kkkkkkkkkk.',
      '............'] },
    { name: 'Dragon', bg: '#ffb000', ink: { D: '#2f9e4f', n: '#a8f0b0' }, rows: [
      'k..........k',
      'kk........kk',
      '.kk.kkkk.kk.',
      '..kkDDDDkk..',
      '.kDDDDDDDDk.',
      '.kDykDDkyDk.',
      '.kDDDDDDDDk.',
      '..kDDDDDDk..',
      '..kDnnnnDk..',
      '..kDknnkDk..',
      '...kkkkkk...',
      '............'] },
    { name: 'Knight', bg: '#0f8a8a', ink: {}, rows: [
      '.....rrr....',
      '....rrkk....',
      '...kkkkkk...',
      '..ksssssdk..',
      '.ksssssssdk.',
      '.kssssssssk.',
      '.kskkkkkksk.',
      '.kssssssssk.',
      '.ksdsdsdssk.',
      '.kssssssssk.',
      '..kkkkkkkk..',
      '............'] },
    { name: 'Wizard', bg: '#d42a4a', ink: { P: '#6b4fd6', f: '#f2c59a' }, rows: [
      '.....kk.....',
      '....kPPk....',
      '....kPyk....',
      '...kPPPPk...',
      '..kPyPPPPk..',
      'kkkkkkkkkkkk',
      '.kffffffffk.',
      '.kfkffffkfk.',
      '.kwwwwwwwwk.',
      '..kwwwwwwk..',
      '...kwwwwk...',
      '....kkkk....'] },
    { name: 'Rocket', bg: '#2b2a86', ink: {}, rows: [
      '.....kk.....',
      '....krrk....',
      '...kwwwwk...',
      '...kwccwk...',
      '...kwccwk...',
      '...kwwwwk...',
      '..krwwwwrk..',
      '.krrwwwwrrk.',
      '.kkkkkkkkkk.',
      '....oyyo....',
      '.....oo.....',
      '............'] },
    { name: 'Saucer', bg: '#c25a9e', ink: {}, rows: [
      '............',
      '............',
      '....kkkk....',
      '...kcwcck...',
      '...kcccck...',
      '.kkkkkkkkkk.',
      'kssssssssssk',
      'ksyssyyssysk',
      '.kkkkkkkkkk.',
      '...y.yy.y...',
      '..y..yy..y..',
      '............'] },
    { name: 'Cactus', bg: '#ffb000', ink: { g: '#3fbf5f', G: '#1c8237', t: '#d26a3a' }, rows: [
      '.....pp.....',
      '....kggk....',
      '....kgGk.k..',
      '.k..kggkkgk.',
      'kgk.kgGkggk.',
      'kgkkkggkkk..',
      '.kgggGgk....',
      '..kkkggk....',
      '..kttttttk..',
      '..kttttttk..',
      '...kttttk...',
      '...kkkkkk...'] },
    { name: 'Pizza', bg: '#1c8237', ink: { C: '#d99a4a' }, rows: [
      'kkkkkkkkkkkk',
      'kCCCCCCCCCCk',
      '.kyyyyyyyyk.',
      '.kyrryyyryk.',
      '..kyrryyyk..',
      '..kyyyyrrk..',
      '...kyyyrk...',
      '...kyryyk...',
      '....kyyk....',
      '....kyyk....',
      '.....kk.....',
      '............'] },
  ];

  // A face the room no longer holds -- someone who left, a view sent before the roster -- is a
  // plain grey square with a question mark: it keeps the row's shape and claims nobody's colour.
  const NOBODY = { name: 'Nobody', bg: '#5a5272', ink: {}, rows: [
    '............',
    '............',
    '....kkkk....',
    '...kwwwwk...',
    '...kwkkwk...',
    '......kwk...',
    '.....kwk....',
    '.....kwk....',
    '......k.....',
    '.....kwk....',
    '......k.....',
    '............'] };

  // Rows to SVG, a rect per horizontal run of one ink. Built once per sprite and kept: a roster is
  // rewritten whole on every state push, and Draw rooms hold fifty.
  const cache = new Map();
  function svgOf(sprite, size) {
    const key = `${sprite.name}|${size}`;
    if (cache.has(key)) return cache.get(key);
    let rects = `<rect width="${SIZE}" height="${SIZE}" fill="${sprite.bg}"/>`;
    sprite.rows.forEach((row, y) => {
      let x = 0;
      while (x < SIZE) {
        const ch = row[x];
        let end = x + 1;
        while (end < SIZE && row[end] === ch) end++;
        const fill = sprite.ink[ch] ?? INK[ch];
        if (ch !== '.' && fill) rects += `<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${fill}"/>`;
        x = end;
      }
    });
    const svg = `<svg class="avatar" width="${size}" height="${size}" viewBox="0 0 ${SIZE} ${SIZE}" aria-hidden="true" shape-rendering="crispEdges">${rects}</svg>`;
    cache.set(key, svg);
    return svg;
  }

  const valid = (n) => Number.isInteger(n) && n >= 0 && n < SET.length;

  const api = {
    count: SET.length,
    grid: SIZE,
    names: SET.map((s) => s.name),
    // For the tests: every sprite's rows, and the inks they may use.
    sprites: SET,
    inks: INK,
    nobody: NOBODY,
    valid,
    /** Markup for face `n` (a number from room state); anything else draws as Nobody. */
    svg: (n, size = 24) => svgOf(valid(n) ? SET[n] : NOBODY, size),
    nameOf: (n) => (valid(n) ? SET[n].name : ''),
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }
  root.GTCAvatars = api;

  // --- the pages ---------------------------------------------------------------------------
  const GTC = root.GTC;
  const KEY = 'gtc_avatar'; // the face this browser last chose, offered again in every new room

  /** The face this browser last picked, sent with create and join; the server may give another. */
  function preferred() {
    const n = Number(GTC.store.get(KEY));
    return GTC.store.get(KEY) != null && valid(n) ? n : undefined;
  }

  /** A player's face from a roster, by public id. Someone not in it (gone) draws as Nobody. */
  const faceOf = (players, playerId, size) => api.svg((players || []).find((p) => p.playerId === playerId)?.avatar, size);

  /**
   * The lobby's picker: a grid of every face, a 44px button each. It has no line of its own. The
   * roster already shows who you are, so your own row there is what opens the grid (`mine`, set by
   * each page's roster): tap it again, or press Enter on it, to fold the grid away. It opens by
   * itself only for someone who has never picked, which is the moment it is news. One pick folds it
   * away again, which gives the lobby back its Start button.
   *
   * Taken faces are disabled with the wearer's name on them: a face is one per seat while there are
   * enough to go round (rooms.js), and the server would refuse it anyway. Chosen is a mark and a
   * heavier frame, not colour alone. Buttons are built once and only their state changes after, so
   * a roster push while someone is tabbing through them keeps their focus.
   *
   * @param {HTMLElement} el  an empty element to fill
   * @param {(n: number, done: (res) => void) => void} pick  asks the server for face n
   * @param {HTMLElement} roster  the lobby's roster, whose own row opens and shuts the grid
   */
  function mountPicker(el, pick, roster) {
    el.classList.add('avpick');
    el.innerHTML = `<div class="avgrid" role="radiogroup" aria-label="Pick your player"${GTC.store.get(KEY) == null ? '' : ' hidden'}>${SET.map((s, n) =>
        `<button type="button" class="avopt" role="radio" aria-checked="false" data-av="${n}">${api.svg(n, 36)}<span class="avmark" aria-hidden="true"></span></button>`).join('')}</div>
      <p class="hint avnote" role="status"></p>`;
    const grid = el.querySelector('.avgrid');
    const note = el.querySelector('.avnote');
    const buttons = [...el.querySelectorAll('.avopt')];
    let last = null;

    const toggle = () => { grid.hidden = !grid.hidden; };
    roster.addEventListener('click', (e) => { if (e.target.closest('.mine')) toggle(); });
    roster.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('.mine')) { e.preventDefault(); toggle(); }
    });

    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.avopt');
      if (!b || b.disabled) return;
      const n = Number(b.dataset.av);
      note.textContent = '';
      pick(n, (res) => {
        if (!res?.ok) { note.textContent = res?.error || 'That one did not work. Try another.'; return; }
        GTC.store.set(KEY, String(res.avatar));
        grid.hidden = true;
      });
    });

    return {
      /** Redraw from room state: your face, and who wears the rest. */
      update(players, me) {
        const mine = players.find((p) => p.playerId === me);
        if (!mine) return;
        const wornBy = new Map();
        for (const p of players) if (p.playerId !== me && !wornBy.has(p.avatar)) wornBy.set(p.avatar, p.nickname);
        // A room with more people than faces (a big Draw room) shares them, so none is closed off.
        const full = players.length > SET.length;
        const key = `${mine.avatar}|${full}|${[...wornBy].join(',')}`;
        if (key === last) return;
        last = key;
        buttons.forEach((b, n) => {
          const chosen = n === mine.avatar;
          const by = wornBy.get(n);
          b.setAttribute('aria-checked', String(chosen));
          b.classList.toggle('taken', !!by && !full);
          b.disabled = !!by && !full;
          b.querySelector('.avmark').textContent = chosen ? '✓' : b.disabled ? '✕' : '';
          const label = by ? `${SET[n].name}, taken by ${by}` : SET[n].name;
          b.setAttribute('aria-label', label);
          b.title = label;
        });
      },
    };
  }

  if (GTC) Object.assign(GTC, { avatar: (n, size) => api.svg(n, size), faceOf, preferredAvatar: preferred, mountAvatarPicker: mountPicker });
})(typeof window !== 'undefined' ? window : globalThis);
