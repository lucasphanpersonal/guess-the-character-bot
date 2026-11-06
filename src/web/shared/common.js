// Helpers every computer game's client uses (/desk/, /draw/). Loaded before the game's own
// script; exposes one global, GTC.
//
// Two rules carried over from the phones' client, because they were learned there:
//   - Escape every interpolated value (esc), including URLs going into src attributes.
//   - Storage can be blocked or empty (private windows, cleared site data), so every access is
//     guarded and the page works without it. It holds conveniences only.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* fine */ } },
  };

  // A persistent id per game, so a reload or a dropped connection reclaims the same seat.
  function playerIdFor(key) {
    let id = store.get(key);
    if (!id) {
      id = crypto.randomUUID?.() ?? `p${Date.now()}${Math.random().toString(36).slice(2)}`;
      store.set(key, id);
    }
    return id;
  }

  // The title, one colour per letter, words kept whole (a per-character inline block otherwise
  // breaks words anywhere -- a lone "r" on line two).
  function wobble(el, text) {
    el.innerHTML = '';
    let i = 0;
    String(text).split(' ').forEach((word, w, words) => {
      const holder = document.createElement('span');
      holder.className = 'wob-word';
      for (const ch of word) {
        const s = document.createElement('span');
        s.className = `wob w${i % 4}`;
        s.textContent = ch;
        holder.appendChild(s);
        i++;
      }
      el.appendChild(holder);
      if (w < words.length - 1) el.appendChild(document.createTextNode(' '));
    });
  }

  // The room code, a letter per colour -- what everyone reads off the screen.
  const roomCodeHtml = (code) =>
    [...String(code)].map((ch) => `<span class="ch">${esc(ch)}</span>`).join('');

  // Every character picture goes through here. A picture that is missing, or fails to load (a
  // Commons image gone, an upstream down), becomes a pixel picture frame with a break in it at the
  // same size, so a row never shows a broken-image icon and keeps its place. It is drawn to read as
  // "no picture here" and not as the desk's "?" for a hidden character. It stays an <img>, so every
  // rule that sizes `img` still applies. The fallback is a data URI: no request, and it works when
  // the image host does not. Colours are fixed here, because an image cannot read the page's tokens;
  // the card is dark enough to sit on cream and on the dark theme alike.
  // Grid is 9 x 11 and the viewBox matches it cell for cell (no margin), so the rows below are the art.
  const NO_ART_ROWS = [
    '.........',
    '####.####',
    '#.......#',
    '#.....#.#',
    '#.......#',
    '#...#...#',
    '#..###..#',
    '#.#####.#',
    '#.......#',
    '##.######',
    '.........',
  ];
  const NO_ART = (() => {
    let cells = '';
    NO_ART_ROWS.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '#') cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 11" shape-rendering="crispEdges">' +
      `<rect width="9" height="11" fill="#2a2238"/><g fill="#ffd23f">${cells}</g></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  })();
  // `attrs` is any extra markup for the tag (class, loading...), already written by the caller.
  // data-art marks it for the error listener below; a missing url shows the card straight away.
  function art(url, attrs = '') {
    return url
      ? `<img src="${esc(url)}" alt="" data-art ${attrs} />`
      : `<img src="${NO_ART}" alt="" data-art ${attrs} />`;
  }
  // Images are not always written as markup (the phones build some with createElement), so the
  // fallback is also one document-wide listener. Image errors do not bubble, hence capture.
  function artFallback(img) { if (img.src !== NO_ART) img.src = NO_ART; }
  document.addEventListener('error', (e) => {
    if (e.target instanceof HTMLImageElement && e.target.hasAttribute('data-art')) artFallback(e.target);
  }, true);

  // The results title. "You won!" when you did; "Carmen and you won!" when you tied with Carmen.
  // Only the start of a sentence takes a capital, so "You" is lower case anywhere but first.
  // `people` is [{ name, you }] in order.
  function winnersTitle(people) {
    if (!people.length) return 'Game over';
    const names = people.map((p, i) => (p.you ? (i === 0 ? 'You' : 'you') : p.name));
    return `${names.join(' and ')} won!`;
  }

  // One row of the end screen's high-score table. `place` is the server's, so level players share
  // one; `score` and `unit` are what this game ranks by. Everything is escaped here. Pass
  // `imageUrl` (null when there is none) for a row that has a picture slot; leave the key out for
  // a row that has none, as the draw game's players do.
  const ordinal = (n) => {
    const tens = n % 100;
    const end = tens >= 11 && tens <= 13 ? 'TH' : { 1: 'ST', 2: 'ND', 3: 'RD' }[n % 10] ?? 'TH';
    return `${n}${end}`;
  };
  // `face` is a player's avatar markup (GTC.faceOf), built from numbers only, so it goes in as is.
  function hiscoreRow({ place, imageUrl, name, detail, score, unit, face = '' }) {
    const rank = place >= 1 && place <= 3 ? ` rank${place}` : '';
    const img = imageUrl !== undefined ? art(imageUrl, 'referrerpolicy="no-referrer"') : '';
    return `<li class="hs${rank}"><span class="hs-place">${place ? ordinal(place) : '--'}</span>${face}${img}` +
      `<span class="hs-who"><span class="hs-name">${esc(name)}</span>${detail ? `<span class="hs-detail">${esc(detail)}</span>` : ''}</span>` +
      `<span class="hs-score">${esc(score)}${unit ? `<small>${esc(unit)}</small>` : ''}</span></li>`;
  }

  // True once per player per room: so a badge pops in when someone joins, and not every time the
  // lobby is re-rendered around them. A roster is rewritten whole on every state push.
  const seatsSeen = new Set();
  function isNewSeat(code, id) {
    const key = `${code}:${id}`;
    if (seatsSeen.has(key)) return false;
    seatsSeen.add(key);
    return true;
  }

  // Whether somebody else sat down since this page last drew this room's lobby: the moment for a
  // join chime. Unlike isNewSeat, the roster the page first draws is not news -- opening a lobby
  // of five must not sound five arrivals, and nobody needs a chime for their own arrival.
  const rostersSeen = new Map(); // room code -> the ids in its lobby when last drawn
  function someoneArrived(code, players, me) {
    const before = rostersSeen.get(code);
    rostersSeen.set(code, new Set(players.map((p) => p.playerId)));
    return !!before && players.some((p) => p.playerId !== me && !before.has(p.playerId));
  }
  // Only arrivals this page SAW are news. Whoever joined while it was offline (a phone asleep in a
  // pocket) or out of the room is simply there on its return, so each page calls this on every
  // (re)connect and on leaving, and the next lobby it draws is a fresh baseline.
  const forgetRosters = () => rostersSeen.clear();

  // Menu selects: which click answers with a blip, and how often. Both sound systems (shared/sound.js
  // and party/public/audio.js) ask here, so they cannot disagree on what counts as a select.
  // `[data-no-blip]` opts a whole region out (Draw's tools: a colour change mid-drawing is not a menu).
  const SELECT = {
    target: 'button, [role="radio"], [role="option"], [role="checkbox"], [role="switch"], [role="tab"]',
    skip: '#soundToggle, #muteBtn, #soundCheckBtn, [data-no-blip]',
    gapMs: 70, // a run of quick taps chirps once, not per tap
  };
  let lastSelect = -1e9;
  const select = {
    // The element a click answers, or null: nothing for a disabled control, a sound control, or
    // anything inside a region that opted out.
    from(node) {
      const el = node?.closest?.(SELECT.target);
      if (!el || el.disabled || el.matches(SELECT.skip) || el.closest('[data-no-blip]')) return null;
      return el;
    },
    // True at most once per gap, and records the time when it says yes.
    due() {
      const now = performance.now();
      if (now - lastSelect < SELECT.gapMs) return false;
      lastSelect = now;
      return true;
    },
  };

  // Tunes both sound systems play -- the computers' (shared/sound.js) and the phones'
  // (party/public/audio.js) -- kept here, once, so the same moment cannot come to sound different
  // on a phone and a computer. Each note: [Hz, ms, gain, voice, start in seconds]. A voice of
  // undefined is the pulse; gains are the computers', and the phones scale them up (TUNE_SCALE).
  const TUNES = {
    // Somebody joined the lobby: a short rising jingle, three bright steps and a held top note. Long
    // enough to be a welcome, short enough that a whole party joining in a minute is not a song.
    join: [
      [784, 70, 0.14, undefined, 0], [988, 70, 0.14, undefined, 0.07], [1175, 70, 0.14, undefined, 0.14],
      [1568, 210, 0.16, undefined, 0.21],
    ],
    // A menu select: two quick high notes, like a cursor moving, and quieter than any cue, because a
    // screen full of buttons would otherwise chirp at every tap. Plays on every button and choice.
    select: [[1047, 35, 0.1, undefined, 0], [1568, 50, 0.1, undefined, 0.04]],
    // A correct guess, a level up: a rising arpeggio that resolves on a held top note. The guesser's
    // own fanfare, so it is the one place in the games that climbs all the way up.
    levelUp: [
      [523, 90, 0.2, 'triangle', 0], [659, 90, 0.2, 'triangle', 0.08], [784, 90, 0.2, 'triangle', 0.16],
      [1047, 90, 0.22, 'triangle', 0.24], [1319, 90, 0.22, 'triangle', 0.32],
      [1047, 460, 0.24, 'triangle', 0.4], [784, 460, 0.16, 'triangle', 0.4],
    ],
    // Game over: three repeated notes and a held one over a triangle bass. Not the got-it
    // arpeggio, so the end is not heard as one more right answer.
    over: [
      [784, 80, 0.24, undefined, 0], [784, 80, 0.24, undefined, 0.11], [784, 80, 0.24, undefined, 0.22],
      [1047, 480, 0.26, undefined, 0.33], [262, 480, 0.24, 'triangle', 0.33],
    ],
    // ...and a step up on top for the winners: the one part that is yours.
    overWon: [[1319, 110, 0.22, 'triangle', 0.86], [1568, 380, 0.24, 'triangle', 0.97]],
  };

  // Right, wrong, close: one quick tint of the whole screen and a stamped word. Rules, because this
  // is the one effect that covers everything:
  //   - One flash per event, never a loop, at a low opacity, and at most one in `FLASH_GAP_MS`. A
  //     fast typist's misses must never become a strobe.
  //   - Nothing at all under reduced motion: what happened is also said in words, on the page.
  //   - It never takes a tap (pointer-events), and the words are aria-hidden for the same reason.
  //   - Never called while the forehead overlay is up, and it would show if it were: main is its own
  //     stacking context, so a z-index here beats the overlay's. That screen stays plain.
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FLASH_GAP_MS = 800;
  let lastFlash = -1e9;
  function flash(kind, label) {
    if (calm()) return;
    const now = performance.now();
    if (now - lastFlash < FLASH_GAP_MS) return;
    lastFlash = now;
    const el = document.createElement('div');
    el.className = `flash ${kind}`;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<span class="flash-stamp">${esc(label)}</span>`;
    document.body.append(el);
    setTimeout(() => el.remove(), 1100);
  }

  // A wrong guess in a game where they come by the dozen: the box shakes, and that is all.
  function shake(el) {
    if (calm() || !el) return;
    el.classList.remove('shake');
    void el.offsetWidth; // so a second miss straight after the first plays it again
    el.classList.add('shake');
  }

  // Square confetti, once, for the end of a game. Fewer pieces on a phone. Transforms only, removed
  // when done, and it never takes a tap.
  const CONFETTI = ['var(--red)', 'var(--blue)', 'var(--amber)', 'var(--green)', 'var(--on-field)'];
  let lastConfetti = -1e9;
  function confetti() {
    if (calm()) return;
    const now = performance.now();
    if (now - lastConfetti < 4000) return; // a reconnect re-sending the results is not a second party
    lastConfetti = now;
    const box = document.createElement('div');
    box.className = 'confetti';
    box.setAttribute('aria-hidden', 'true');
    const n = matchMedia('(pointer: coarse), (max-width: 760px)').matches ? 26 : 48;
    for (let i = 0; i < n; i++) {
      const b = document.createElement('i');
      const size = i % 3 ? 8 : 12;
      b.style.cssText = `left:${Math.round(Math.random() * 100)}%;width:${size}px;height:${size}px;background:${CONFETTI[i % CONFETTI.length]};` +
        `animation-duration:${(1.3 + Math.random() * 0.9).toFixed(2)}s;animation-delay:${(Math.random() * 0.5).toFixed(2)}s`;
      box.append(b);
    }
    document.body.append(box);
    setTimeout(() => box.remove(), 3000);
  }

  // A screen marked data-play in the markup is play: <html> says so (data-playing) for as long as it
  // shows, so shared styles can quiet down without knowing any one game's screen names.
  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
    document.documentElement.toggleAttribute('data-playing', !!document.getElementById(id)?.hasAttribute('data-play'));
  }

  /**
   * The title is the way home: the site's home page (its href, "/"), where every game is linked.
   * A real link, so it still opens in a new tab. Walking out of a room is the catch: navigating away
   * reads to the server as a dropped connection, which KEEPS the seat -- so a host's room would wait
   * for them, and a player mid-game would hold up every turn of theirs until the clock ran out. In a
   * room it asks first (`leaving()` says what leaving costs right now, or null for "not in a room"),
   * leaves properly, and only navigates once the server has it: `leave()` resolves on the ack.
   */
  function homeTitle(link, { leaving, leave }) {
    link.addEventListener('click', async (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // a new tab: let it
      e.preventDefault();
      const cost = leaving();
      if (cost && !(await ask(cost, { yes: 'Leave', no: 'Stay', danger: true }))) return;
      if (cost) await leave();
      location.assign(link.href);
    });
  }

  /**
   * The pool picker (/shared/pickers.js), or -- when that script did not arrive or threw -- a plain
   * dropdown that still deals. Lives here, not in pickers.js, because it is for when pickers.js is
   * the part that failed: a cached page from before the picker, a blocked or half-deployed file.
   * Without it, one missing script left "Characters from" empty AND the difficulty list blank
   * (the same callback filled both), and the host had no way to start a game.
   *
   * The note saying so sits inside the picker's own box: a lobby's error line is rewritten on
   * every roster update, and would wipe it.
   *
   * @returns {{ value(): object }}
   */
  function mountPoolPicker(root, opts) {
    try {
      if (window.GTCPickers && root) return window.GTCPickers.poolPicker(root, opts);
    } catch (err) {
      console.error('pool picker failed, using the plain dropdown', err);
    }
    if (root) {
      root.innerHTML =
        '<p class="pp-fallback">Part of this page did not load, so this is a plain list. Reload the page to get the category picker back.</p>' +
        '<select aria-label="Characters from"><option value="random">Surprise Me — One Random Category</option><option value="everything">Everything</option>' +
        (opts?.options?.categories ?? []).map((c) => `<option value="cat:${esc(c.category)}">${esc(c.category)} (${esc(c.enabled)} lists)</option>`).join('') +
        '</select>';
    }
    const select = root?.querySelector('select');
    return {
      value() {
        const v = select?.value || 'random';
        return v.startsWith('cat:') ? { poolType: 'categories', categories: [v.slice(4)] } : { poolType: v };
      },
    };
  }

  // A switch for one setting held on <html> (dark mode, the CRT screen). season.js applied the saved
  // choice before first paint; this wires every switch matching `selector` inside `scope` to flip it,
  // saves the choice, and keeps every such switch on the page true to it (aria-checked, which is also
  // what slides the knob), whichever one was pressed. Idempotent and scoped, because switches arrive
  // at different times: a page's own at boot, the Room menu's when it mounts.
  function bindSwitch({ selector, isOn, set, scope = document }) {
    const sync = () => {
      for (const b of document.querySelectorAll(selector)) b.setAttribute('aria-checked', String(isOn()));
    };
    for (const b of scope.querySelectorAll(selector)) {
      if (b.dataset.bound) continue;
      b.dataset.bound = '1';
      b.addEventListener('click', () => {
        set(!isOn());
        sync();
      });
    }
    sync();
    return sync;
  }

  // Dark mode (gtc_theme, shared with the phones' page). The browser's own chrome follows the field.
  function bindThemeToggles(scope) {
    const root = document.documentElement;
    bindSwitch({
      selector: '.themetoggle',
      scope,
      isOn: () => root.dataset.theme === 'dark',
      set(dark) {
        if (dark) root.dataset.theme = 'dark';
        else delete root.dataset.theme;
        store.set('gtc_theme', dark ? 'dark' : 'light');
        const spooky = root.dataset.season === 'spooky';
        const meta = document.querySelector('meta[name=theme-color]');
        if (meta) meta.content = dark ? (spooky ? '#2a1307' : '#0e0f1a') : spooky ? '#cc4a0c' : '#1f1a4d';
      },
    });
  }

  // The CRT screen (retro.css, *the CRT screen*; gtc_crt, on until someone turns it off). Its rows
  // also say On or Off in words (.crtstate), so the state never rests on the knob alone.
  function bindCrtToggles(scope) {
    const root = document.documentElement;
    const words = () => {
      for (const s of document.querySelectorAll('.crtstate')) s.textContent = 'crt' in root.dataset ? 'On' : 'Off';
    };
    bindSwitch({
      selector: '.crttoggle',
      scope,
      isOn: () => 'crt' in root.dataset,
      set(on) {
        if (on) root.dataset.crt = 'on';
        else delete root.dataset.crt;
        store.set('gtc_crt', on ? 'on' : 'off');
        words();
      },
    });
    words();
  }

  // --- RPG text: words that type themselves out -----------------------------------------------
  // The text inside `el` appears letter by letter, as an old RPG's text box printed it. Two rules,
  // because this sits on messages people need:
  //   - Layout never moves while it types. The whole text is laid out from the first frame and the
  //     untyped rest is only invisible (visibility, not removed), so a box is its final size at once
  //     and nothing under it shifts line by line.
  //   - It is always quick: TYPE_MS a letter, and the whole of it inside TYPE_MAX_MS however long it
  //     is. Nothing waits for it -- a box's buttons work from the first frame. Under reduced motion,
  //     or in a hidden tab, it is simply all there.
  // Screen readers never see the typing: callers put the text out of sight in full (.sr) and mark
  // the typed copy aria-hidden, so it is read once and whole. `onDone` runs when it is all out.
  const TYPE_MS = 14;
  const TYPE_MAX_MS = 420;
  function typeOut(el, onDone) {
    const done = () => { el.classList.add('typed'); onDone?.(); };
    if (calm() || document.hidden) { done(); return; }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data) nodes.push(n);
    const pieces = nodes.map((orig) => {
      const chars = Array.from(orig.data); // by code point, so no emoji or accent is cut in half
      const shown = document.createTextNode('');
      const rest = document.createElement('span');
      rest.className = 'tw-rest';
      rest.textContent = orig.data;
      orig.replaceWith(shown, rest);
      return { orig, chars, shown, rest };
    });
    const total = pieces.reduce((s, p) => s + p.chars.length, 0);
    const perChar = Math.min(TYPE_MS, TYPE_MAX_MS / Math.max(total, 1));
    const start = performance.now();
    const tick = () => {
      let left = Math.floor((performance.now() - start) / perChar);
      for (const p of pieces) {
        const n = Math.max(0, Math.min(p.chars.length, left));
        left -= p.chars.length;
        p.shown.data = p.chars.slice(0, n).join('');
        p.rest.textContent = p.chars.slice(n).join('');
      }
      if (left < 0 && !el.dataset.twSkip) { setTimeout(tick, 16); return; }
      // All out: put the original text nodes back, so the box holds plain text again.
      for (const p of pieces) { p.rest.remove(); p.shown.replaceWith(p.orig); }
      done();
    };
    tick();
  }

  // A passing note in the corner, as an RPG text box. `html` must already be escaped by the caller.
  // `max` caps how many stack at once (oldest dropped): the stack grows upward, into whatever sits
  // above it. The feed is a live region, so the note's words are in it once and whole (.sr); the
  // typed copy is for the eyes only.
  function toast(html, ms = 4500, { max = 4 } = {}) {
    const feed = $('feed');
    if (!feed) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<span class="sr">${html}</span><span class="rpgtext" aria-hidden="true">${html}</span>`;
    feed.appendChild(t);
    typeOut(t.querySelector('.rpgtext'), () => t.classList.add('typed'));
    setTimeout(() => t.remove(), ms);
    while (feed.children.length > max) feed.firstChild.remove();
  }

  /**
   * A question in an RPG text box, in place of the browser's confirm(): the words type out, a ▼
   * blinks when they are done, and the choices sit underneath. Resolves true for `yes`, false for
   * `no`, Escape, or the box closing any other way. With `no: null` it is a notice with one button
   * (in place of alert()), and resolves true once it is dismissed.
   *
   * What confirm() did for free and this must do by hand:
   *   - Nothing behind it acts on a key while it is up. confirm() froze the page's scripts; a modal
   *     <dialog> only makes the page inert to the pointer and focus, and a key pressed in the box
   *     still bubbles to the document -- where the desk's Y/N rules on a guess. So keys stop here.
   *   - Anything that acts on its own while it is up checks GTC.asking() (the phones' tilt does:
   *     a phone held to read "Leave the game?" must not count as a tilt).
   * The safe answer has the focus, so an Enter pressed out of habit keeps you where you are. The
   * arrow keys move between the choices, as in a game's menu, and the menu pointer
   * (/shared/pointer.js) points at the one with the focus.
   * @returns {Promise<boolean>}
   */
  let openAsks = 0;
  let askSeq = 0;
  function ask(text, { yes = 'OK', no = 'Cancel', danger = false } = {}) {
    const dlg = document.createElement('dialog');
    if (typeof dlg.showModal !== 'function') {
      if (no == null) { alert(text); return Promise.resolve(true); }
      return Promise.resolve(confirm(text));
    }
    const id = `rpgq${++askSeq}`;
    dlg.className = 'rpgbox';
    dlg.setAttribute('aria-labelledby', id);
    dlg.innerHTML =
      `<p class="sr" id="${id}">${esc(text)}</p><p class="rpgtext" aria-hidden="true">${esc(text)}</p>` +
      '<div class="rpgchoices">' +
      (no != null ? `<button type="button" class="ghost" value="no">${esc(no)}</button>` : '') +
      `<button type="button" value="yes"${danger ? ' class="bad"' : ''}>${esc(yes)}</button></div>`;
    const choices = [...dlg.querySelectorAll('.rpgchoices button')];
    return new Promise((resolve) => {
      dlg.addEventListener('click', (e) => {
        const b = e.target.closest('.rpgchoices button');
        if (b) dlg.close(b.value);
        else dlg.querySelector('.rpgtext').dataset.twSkip = '1'; // a tap on the words finishes them
      });
      dlg.addEventListener('keydown', (e) => {
        e.stopPropagation();
        const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const at = choices.indexOf(document.activeElement);
        const next = choices[(at + step + choices.length) % choices.length];
        next.focus();
        window.GTCPointer?.point(next);
      });
      dlg.addEventListener('close', () => {
        openAsks--;
        dlg.remove();
        resolve(no == null ? true : dlg.returnValue === 'yes');
      });
      document.body.append(dlg);
      openAsks++;
      dlg.showModal();
      const safe = choices[0];
      safe.focus();
      window.GTCPointer?.point(safe);
      typeOut(dlg.querySelector('.rpgtext'));
    });
  }
  const asking = () => openAsks > 0;

  window.GTC = { $, esc, store, playerIdFor, wobble, roomCodeHtml, show, toast, ask, asking, typeOut, homeTitle, mountPoolPicker, bindThemeToggles, bindCrtToggles, art, artFallback, winnersTitle, hiscoreRow, isNewSeat, someoneArrived, forgetRosters, TUNES, select, flash, shake, confetti };
})();
