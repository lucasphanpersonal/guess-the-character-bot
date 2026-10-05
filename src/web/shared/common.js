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

  // A passing note in the corner. `html` must already be escaped by the caller.
  function toast(html, ms = 4500) {
    const feed = $('feed');
    if (!feed) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = html;
    feed.appendChild(t);
    setTimeout(() => t.remove(), ms);
    while (feed.children.length > 4) feed.firstChild.remove();
  }

  window.GTC = { $, esc, store, playerIdFor, wobble, roomCodeHtml, show, toast, ANGLES };
})();
