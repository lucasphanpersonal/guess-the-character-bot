// The two pickers every web game's setup uses, phones and computers alike: where the characters
// come from (poolPicker), and finding one character by name (characterSearch). Loaded before the
// game's own script; exposes one global, GTCPickers.
//
// Shared rather than copied per client because three copies of the pool picker already existed --
// a radio row and a hidden <select> each -- and they had started to disagree (the phones could
// untick lists, the computers could not). Behaviour lives here; each client styles the classes
// (pp-*, cs-*) in its own sheet, because the phones' look is not the computers' stylesheet.
//
// Pure DOM, no framework. Every interpolated value is escaped, list and category names included:
// /list create in Discord lets anyone name a list.
(function () {
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* a convenience only */ } },
  };
  const fmt = (n) => Number(n).toLocaleString();

  // How lists are ordered wherever they are listed: 'popular' (the server's order, best-known
  // first) or 'az'. One preference per browser, shared with the phones' library browser
  // (party/public/compendium.js reads the same key), because it is how this person likes to look.
  const SORT_KEY = 'gtc_list_sort';
  const listSort = () => (store.get(SORT_KEY) === 'az' ? 'az' : 'popular');
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  const inOrder = (ls) => (listSort() === 'az' ? [...ls].sort(byName) : ls);
  // The switch itself: two buttons, aria-pressed, the chosen one filled -- never colour alone.
  const sortSwitch = () => {
    const now = listSort();
    const btn = (value, label) => `<button type="button" data-sort="${value}" aria-pressed="${now === value}">${label}</button>`;
    return `<div class="pp-sort" role="group" aria-label="Order the lists"><span class="pp-sortlabel">Order</span>${btn('popular', 'Popular')}${btn('az', 'A–Z')}</div>`;
  };

  /**
   * Where the characters come from: "Surprise me", "Everything", or any number of categories
   * picked as chips -- tap what you want to play, the way a person thinks about it ("anime and
   * games"), instead of a mode radio that reveals a dropdown that reveals a list. A chosen
   * category's lists can be fine-tuned underneath, with All / None.
   *
   * @param {HTMLElement} root
   * @param {object} opts
   * @param {{categories: {category: string, enabled: number}[]}} opts.options  the server's setup options
   * @param {(event: string, payload: object) => Promise<any>} opts.request     an acknowledged socket emit
   * @param {string} [opts.storageKey]  remembers the host's last choice between games (a convenience),
   *   and, under `${storageKey}_off`, the lists they switched off -- re-applied to each new room
   * @returns {{ value(): {poolType: string, categories?: string[]} }}
   */
  function poolPicker(root, { options, request, storageKey = 'gtc_pool' }) {
    const categories = (options?.categories ?? []).map((c) => ({ name: c.category, lists: c.enabled }));
    const known = new Set(categories.map((c) => c.name));

    // mode: 'random' | 'everything' | 'categories'. `chosen` keeps its order of choosing, so the
    // fine-tune sections below appear in the order the host tapped them.
    let mode = 'random';
    let chosen = [];
    try {
      const saved = JSON.parse(store.get(storageKey) || 'null');
      if (saved?.mode === 'everything') mode = 'everything';
      if (saved?.mode === 'categories') {
        chosen = (saved.categories ?? []).filter((c) => known.has(c));
        if (chosen.length) mode = 'categories';
      }
    } catch { /* a stale or foreign value: start from the default */ }

    // category -> lists as the server last said ({id, name, count, playing}); filled on demand.
    const lists = new Map();
    const open = new Set(); // which fine-tune sections the host has opened

    // The lists this host has switched off, remembered in their browser so a new room starts the
    // way they left the last one. The room is still what the server deals from (Room.
    // excludedListIds): this only re-applies the host's own ticks to it, at mount, before any
    // list is shown -- so a tick on screen is never one the server is about to change.
    const offKey = `${storageKey}_off`;
    let off = new Set();
    try {
      off = new Set((JSON.parse(store.get(offKey) || '[]') || []).map(Number).filter(Number.isInteger));
    } catch { /* a stale or foreign value: remember nothing */ }
    const saveOff = () => store.set(offKey, JSON.stringify([...off]));
    // The ones switched off in THIS room -- the remembered ones the server took (a list can have
    // left the selection since), plus any ticked off here. What the summary counts.
    const offHere = new Set();
    // What the server said after a tick: each list's playing state, remembered as it now stands.
    const remember = (ids, playing) => {
      ids.forEach((id, i) => {
        if (playing[i]) { off.delete(id); offHere.delete(id); } else { off.add(id); offHere.add(id); }
      });
      saveOff();
    };
    const restored = off.size
      ? request('setup:keepOff', { listIds: [...off] })
          .then((res) => { if (res?.ok) res.off.forEach((id) => offHere.add(id)); })
          .catch(() => {})
      : Promise.resolve();

    root.classList.add('pp');
    root.innerHTML = `
      <div class="pp-chips pp-quick" role="group" aria-label="Quick choices"></div>
      <div class="pp-or">or choose categories — as many as you like</div>
      <div class="pp-chips pp-cats" role="group" aria-label="Categories"></div>
      <p class="pp-summary" aria-live="polite"></p>
      <div class="pp-lists"></div>`;
    const quick = root.querySelector('.pp-quick');
    const cats = root.querySelector('.pp-cats');
    const summary = root.querySelector('.pp-summary');
    const detail = root.querySelector('.pp-lists');

    const save = () => store.set(storageKey, JSON.stringify({ mode, categories: chosen }));

    // A chip is a button with aria-pressed: the state is announced, and the ✓ means the selection
    // is never shown by colour alone.
    const chip = (label, sub, pressed, extra = '') =>
      `<button type="button" class="pp-chip${pressed ? ' on' : ''}" aria-pressed="${pressed}" ${extra}>` +
      `<span class="pp-tick" aria-hidden="true">${pressed ? '✓' : ''}</span>` +
      `<span class="pp-label">${esc(label)}</span>${sub != null ? `<span class="pp-n">${esc(sub)}</span>` : ''}</button>`;

    function paintChips() {
      quick.innerHTML =
        chip('Surprise Me', 'one random category', mode === 'random', 'data-mode="random"') +
        chip('Everything', 'every category', mode === 'everything', 'data-mode="everything"');
      cats.innerHTML = categories
        .map((c) => chip(c.name, `${c.lists}`, chosen.includes(c.name), `data-cat="${esc(c.name)}" title="${esc(`${c.lists} list${c.lists === 1 ? '' : 's'}`)}"`))
        .join('');
    }

    function paintSummary() {
      let text = '';
      let warn = false;
      // In the two modes that show no lists, the ones switched off would otherwise be invisible --
      // and they stay off in these too.
      const leftOut = offHere.size ? ` ${fmt(offHere.size)} list${offHere.size === 1 ? '' : 's'} you switched off stay${offHere.size === 1 ? 's' : ''} off.` : '';
      if (mode === 'random') text = `A random category is picked when you deal.${leftOut}`;
      else if (mode === 'everything') {
        const total = categories.reduce((n, c) => n + c.lists, 0);
        text = offHere.size ? `Every category — ${fmt(Math.max(0, total - offHere.size))} of ${fmt(total)} lists.${leftOut}` : `Every category — ${fmt(total)} lists.`;
      } else {
        const loaded = chosen.map((c) => lists.get(c)).filter(Boolean);
        const on = loaded.flatMap((ls) => ls.filter((l) => l.playing));
        const all = loaded.flat();
        const what = chosen.length <= 3 ? chosen.join(' + ') : `${chosen.length} categories`;
        if (loaded.length < chosen.length) text = `${what}…`;
        else if (!on.length) { text = `${what}: every list is switched off. Switch at least one back on.`; warn = true; }
        else {
          // "Up to": the same character can sit in two lists, and difficulty trims the pool again.
          const chars = on.reduce((n, l) => n + (l.count || 0), 0);
          text = `${what} — ${on.length === all.length ? `all ${on.length}` : `${on.length} of ${all.length}`} list${all.length === 1 ? '' : 's'}, up to ${fmt(chars)} characters.`;
        }
      }
      summary.textContent = text;
      summary.classList.toggle('warn', warn);
    }

    function paintDetail() {
      if (mode !== 'categories') { detail.innerHTML = ''; return; }
      detail.innerHTML = (chosen.length ? sortSwitch() : '') + chosen
        .map((c) => {
          const ls = lists.get(c);
          const on = ls ? ls.filter((l) => l.playing).length : null;
          const count = ls ? (on === ls.length ? `all ${ls.length} lists` : `${on} of ${ls.length} lists`) : 'loading…';
          const rows = ls
            ? inOrder(ls).map((l) => `<label class="pp-row"><input type="checkbox" data-list="${l.id}" ${l.playing ? 'checked' : ''}>` +
                `<span class="pp-rowname">${esc(l.name)}</span><span class="pp-n">${fmt(l.count)}</span></label>`).join('')
            : '';
          return `<details class="pp-cat${on === 0 ? ' off' : ''}" data-cat="${esc(c)}" ${open.has(c) ? 'open' : ''}>
              <summary><span class="pp-catname">${esc(c)}</span><span class="pp-count">${count}</span><span class="pp-edit"><span class="closed">Choose Lists</span><span class="opened">Done</span></span></summary>
              <div class="pp-bulk"><button type="button" class="pp-all" data-cat="${esc(c)}">All</button><button type="button" class="pp-none" data-cat="${esc(c)}">None</button></div>
              <div class="pp-rows">${rows}</div>
            </details>`;
        })
        .join('');
    }

    // A tick changes counts and boxes, never the structure -- rebuilding it would jump a long list
    // back to the top under the host's thumb.
    function refreshCounts() {
      for (const d of detail.querySelectorAll('details[data-cat]')) {
        const ls = lists.get(d.dataset.cat);
        if (!ls) continue;
        const on = ls.filter((l) => l.playing).length;
        d.querySelector('.pp-count').textContent = on === ls.length ? `all ${ls.length} lists` : `${on} of ${ls.length} lists`;
        d.classList.toggle('off', on === 0);
        for (const l of ls) {
          const cb = d.querySelector(`input[data-list="${l.id}"]`);
          if (cb) cb.checked = l.playing;
        }
      }
      paintSummary();
    }

    const paint = () => { paintChips(); paintSummary(); paintDetail(); };

    async function load(category) {
      if (lists.has(category)) return;
      await restored; // the ticks shown must already include the remembered ones
      if (lists.has(category)) return;
      const res = await request('setup:categoryLists', { category }).catch(() => null);
      lists.set(category, res?.ok ? res.lists : []);
      paintSummary();
      paintDetail();
    }

    quick.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      mode = b.dataset.mode;
      chosen = [];
      save();
      paint();
    });
    cats.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      const c = b.dataset.cat;
      chosen = chosen.includes(c) ? chosen.filter((x) => x !== c) : [...chosen, c];
      // Un-choosing the last category falls back to the default rather than leaving nothing
      // chosen: there is always an answer to "where do the characters come from".
      mode = chosen.length ? 'categories' : 'random';
      save();
      paint();
      if (chosen.includes(c)) load(c);
    });
    // <details> toggling is remembered so a repaint (a tick elsewhere) does not snap it shut.
    detail.addEventListener('toggle', (e) => {
      const d = e.target.closest?.('details[data-cat]');
      if (!d) return;
      if (d.open) open.add(d.dataset.cat);
      else open.delete(d.dataset.cat);
    }, true);
    detail.addEventListener('change', async (e) => {
      const cb = e.target.closest('input[data-list]');
      if (!cb) return;
      const id = Number(cb.dataset.list);
      cb.disabled = true;
      const res = await request('setup:toggleList', { listId: id }).catch(() => null);
      cb.disabled = false;
      for (const ls of lists.values()) for (const l of ls) if (l.id === id && res?.ok) l.playing = res.playing;
      if (res?.ok) remember([id], [res.playing]);
      refreshCounts(); // and a failed tick is put back to what the server holds
    });
    detail.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sort]');
      if (!b) return;
      store.set(SORT_KEY, b.dataset.sort);
      paintDetail(); // the open sections stay open (the `open` set)
    });
    detail.addEventListener('click', async (e) => {
      const b = e.target.closest('.pp-all, .pp-none');
      if (!b) return;
      const ls = lists.get(b.dataset.cat);
      if (!ls?.length) return;
      const playing = b.classList.contains('pp-all');
      b.disabled = true;
      const res = await request('setup:setLists', { listIds: ls.map((l) => l.id), playing }).catch(() => null);
      b.disabled = false;
      if (res?.ok) {
        ls.forEach((l, i) => { l.playing = res.playing[i]; });
        remember(ls.map((l) => l.id), res.playing);
      }
      refreshCounts();
    });

    paint();
    for (const c of chosen) load(c);
    restored.then(paintSummary); // the count of what stays off, once the server has taken it

    return {
      value() {
        if (mode === 'categories' && chosen.length) return { poolType: 'categories', categories: [...chosen] };
        return { poolType: mode === 'everything' ? 'everything' : 'random' };
      },
    };
  }

  /**
   * Search the library for one character, or use whatever was typed. Debounced, and every answer
   * is checked against the latest question asked: typing "Zoro" fires four searches, and whichever
   * lands last must not paint a list for "Zo" over "Zoro".
   *
   * @param {HTMLInputElement} input
   * @param {HTMLElement} results
   * @param {(pick: {id?: number, name: string, list?: string, imageUrl?: string, typed?: boolean}) => void} onChoose
   */
  function characterSearch(input, results, onChoose) {
    results.classList.add('cs-results');
    let asked = 0;
    let timer = null;
    const clear = () => { input.value = ''; results.innerHTML = ''; };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { asked++; results.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const mine = ++asked;
        let found = [];
        try {
          if (q.length >= 2) found = (await fetch(`/api/browse/search?q=${encodeURIComponent(q)}`).then((r) => r.json())).characters ?? [];
        } catch { /* offline: the typed-name row below still works */ }
        if (mine !== asked) return;
        results.innerHTML = '';
        for (const c of found.slice(0, 8)) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'cs-row';
          b.innerHTML = GTC.art(c.imageUrl, 'class="cs-thumb"') +
            `<span class="cs-name">${esc(c.name)}</span><span class="cs-list">${esc(c.list || '')}</span>`;
          b.addEventListener('click', () => { clear(); onChoose({ id: c.id, name: c.name, list: c.list, imageUrl: c.imageUrl }); });
          results.appendChild(b);
        }
        // Always offered, not just on no results: "Grandma Jean" may well share letters with
        // somebody in the library, and the person still means Grandma Jean.
        const typed = document.createElement('button');
        typed.type = 'button';
        typed.className = 'cs-row';
        typed.innerHTML = `${GTC.art(null, 'class="cs-thumb"')}<span class="cs-name">Use “${esc(q)}” as Typed</span><span class="cs-list">no picture</span>`;
        typed.addEventListener('click', () => { const name = q.slice(0, 60); clear(); onChoose({ name, typed: true }); });
        results.appendChild(typed);
      }, 200);
    });
    return { clear };
  }

  window.GTCPickers = { poolPicker, characterSearch };
})();
