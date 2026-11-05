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

  // A small pixel face for a player, drawn from their name: a 5x5 mirrored grid, so it reads as a
  // creature rather than noise, and the same name gets the same face on every screen. Decoration,
  // alongside the name and never instead of it. Only numbers and our own colours reach the markup.
  const AVATAR_COLOURS = ['#ff6b82', '#ffb000', '#7fd6ff', '#7ee07e', '#c9a0ff', '#ff9a4d'];
  function avatar(name) {
    let h = 2166136261;
    for (const ch of String(name)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
    const colour = AVATAR_COLOURS[h % AVATAR_COLOURS.length];
    let rects = '';
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 3; x++) {
        h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
        if (h % 100 < 58) {
          rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
          if (x < 2) rects += `<rect x="${4 - x}" y="${y}" width="1" height="1"/>`;
        }
      }
    }
    return `<svg class="avatar" viewBox="-1 -1 7 7" aria-hidden="true" shape-rendering="crispEdges" fill="${colour}">${rects}</svg>`;
  }

  // One row of the end screen's high-score table. `place` is the server's, so level players share
  // one; `score` and `unit` are what this game ranks by. Everything is escaped here.
  const ordinal = (n) => {
    const tens = n % 100;
    const end = tens >= 11 && tens <= 13 ? 'TH' : { 1: 'ST', 2: 'ND', 3: 'RD' }[n % 10] ?? 'TH';
    return `${n}${end}`;
  };
  function hiscoreRow({ place, imageUrl, name, detail, score, unit }) {
    const rank = place >= 1 && place <= 3 ? ` rank${place}` : '';
    const img = imageUrl ? `<img src="${esc(imageUrl)}" alt="" referrerpolicy="no-referrer" />` : '';
    return `<li class="hs${rank}"><span class="hs-place">${place ? ordinal(place) : '--'}</span>${img}` +
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

  // Tunes both sound systems play -- the computers' (shared/sound.js) and the phones'
  // (party/public/audio.js) -- kept here, once, so the same moment cannot come to sound different
  // on a phone and a computer. Each note: [Hz, ms, gain, voice, start in seconds]. A voice of
  // undefined is the pulse; gains are the computers', and the phones scale them up (TUNE_SCALE).
  const TUNES = {
    // Somebody joined the lobby: a tiny rising blip, the quietest cue there is.
    join: [[988, 60, 0.14, undefined, 0], [1319, 90, 0.14, undefined, 0.06]],
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

  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
  }

  // A passing note in the corner. `html` must already be escaped by the caller. `max` caps how
  // many stack at once (oldest dropped): the stack grows upward, into whatever sits above it.
  function toast(html, ms = 4500, { max = 4 } = {}) {
    const feed = $('feed');
    if (!feed) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = html;
    feed.appendChild(t);
    setTimeout(() => t.remove(), ms);
    while (feed.children.length > max) feed.firstChild.remove();
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
      if (cost && !confirm(cost)) return;
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

  // Dark mode's switch. season.js already applied the saved choice (or the computer's setting)
  // before first paint; this wires every switch on the page (.themetoggle, role="switch" -- the
  // same as the phones' page: the title row's, and the Room menu's at phone width) to flip it,
  // saves the choice in gtc_theme (shared with the phones' page),
  // and keeps aria-checked true to the theme, which is also what slides the knob.
  function bindThemeToggles() {
    const root = document.documentElement;
    const isDark = () => root.dataset.theme === 'dark';
    const label = () => {
      for (const b of document.querySelectorAll('.themetoggle')) b.setAttribute('aria-checked', String(isDark()));
    };
    for (const b of document.querySelectorAll('.themetoggle')) {
      b.addEventListener('click', () => {
        const dark = !isDark();
        if (dark) root.dataset.theme = 'dark';
        else delete root.dataset.theme;
        store.set('gtc_theme', dark ? 'dark' : 'light');
        const spooky = root.dataset.season === 'spooky';
        const meta = document.querySelector('meta[name=theme-color]');
        if (meta) meta.content = dark ? (spooky ? '#2a1307' : '#0e0f1a') : spooky ? '#cc4a0c' : '#1f1a4d';
        label();
      });
    }
    label();
  }

  window.GTC = { $, esc, store, playerIdFor, wobble, roomCodeHtml, show, toast, homeTitle, mountPoolPicker, bindThemeToggles, avatar, hiscoreRow, isNewSeat, someoneArrived, forgetRosters, TUNES, flash, shake, confetti };
})();
