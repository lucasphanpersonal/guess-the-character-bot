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

  // Big headings are hand-set: a per-character angle, words kept whole (a per-character inline
  // block otherwise breaks words anywhere -- a lone "r" on line two).
  const ANGLES = [-6, 4, -3, 5, -5, 3, -4, 6];
  function wobble(el, text) {
    el.innerHTML = '';
    let i = 0;
    String(text).split(' ').forEach((word, w, words) => {
      const holder = document.createElement('span');
      holder.className = 'wob-word';
      for (const ch of word) {
        const s = document.createElement('span');
        s.className = `wob w${i % 4}`;
        s.style.setProperty('--rot', `${ANGLES[i % ANGLES.length]}deg`);
        s.textContent = ch;
        holder.appendChild(s);
        i++;
      }
      el.appendChild(holder);
      if (w < words.length - 1) el.appendChild(document.createTextNode(' '));
    });
  }

  // The room code, a letter per colour at its own angle -- what everyone reads off the screen.
  const roomCodeHtml = (code) =>
    [...String(code)].map((ch, i) => `<span class="ch" style="--rot:${ANGLES[i % ANGLES.length]}deg">${esc(ch)}</span>`).join('');

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
        if (meta) meta.content = dark ? (spooky ? '#2a1307' : '#170d2b') : spooky ? '#cc4a0c' : '#46178f';
        label();
      });
    }
    label();
  }

  window.GTC = { $, esc, store, playerIdFor, wobble, roomCodeHtml, show, toast, homeTitle, mountPoolPicker, bindThemeToggles, ANGLES };
})();
