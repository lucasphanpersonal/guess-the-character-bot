// The read-only character compendium (Browse): categories, lists, characters, and the browser
// history that makes Back work inside it. Loaded after app.js.

// --- compendium ---------------------------------------------------------------------------
//
// Read-only browsing over plain HTTP, so it never contends with the game socket and the browser
// can cache it. Three depths -- categories, lists, characters -- each ordered the way the game
// orders things, so the top of a page is the part people actually recognise.
const browseState = { view: 'categories', category: null, list: null, offset: 0, loading: false, filter: '' };
let browseLists = []; // the current category's lists, kept client-side so filtering is instant
// Popular (the server's order) or A-Z. The same key as the setup picker's (shared/pickers.js):
// one preference for how this person likes lists ordered.
const LIST_SORT_KEY = 'gtc_list_sort';
const listSort = () => (store.get(LIST_SORT_KEY) === 'az' ? 'az' : 'popular');
function paintBrowseSort() {
  for (const b of $('browseSort').querySelectorAll('[data-sort]')) b.setAttribute('aria-pressed', String(b.dataset.sort === listSort()));
}

const PAGE = 60;
async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function browseBusy(on) {
  browseState.loading = on;
  if (on) $('browseBody').innerHTML = '<p class="hint center">Loading…</p>';
}

async function openBrowse({ push = true } = {}) {
  // Mark the entry we are leaving, so backing out of the compendium lands on the app rather
  // than on whatever the tab's history happens to hold below it.
  if (push && !$('browse').classList.contains('active')) {
    try { history.replaceState({ gtcExit: true }, ''); } catch { historyWorks = false; }
  }
  browseState.view = 'categories';
  browseState.category = null;
  browseState.list = null;
  show('browse');
  $('browseFilter').style.display = 'none';
  $('browseSort').style.display = 'none';
  $('browseMore').style.display = 'none';
  setCrumb(['Everything in the game']);
  if (push) pushBrowseHistory('categories');
  browseBusy(true);
  try {
    const { categories } = await getJson('/api/browse/categories');
    const body = $('browseBody');
    body.innerHTML = '';
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    categories.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = `tile c${i % 4}`;
      b.innerHTML = `${escapeHtml(c.category)}<span class="n">${c.lists} lists · ${c.playable} in play</span>`;
      b.addEventListener('click', () => openCategory(c.category));
      tiles.appendChild(b);
    });
    body.appendChild(tiles);
  } catch (err) {
    $('browseBody').innerHTML = `<p class="hint center">Could not load (${escapeHtml(err.message)}).</p>`;
  } finally {
    browseState.loading = false;
  }
}

async function openCategory(category, { push = true } = {}) {
  // Coming BACK to a category keeps what was typed; arriving at a new one starts clean. Retyping
  // a filter after every look at a list is the kind of friction that stops people browsing.
  if (browseState.category !== category) browseState.filter = '';
  browseState.view = 'lists';
  browseState.category = category;
  setCrumb(['All', category]);
  if (push) pushBrowseHistory('lists', { category });
  $('browseMore').style.display = 'none';
  browseBusy(true);
  try {
    const data = await getJson(`/api/browse/lists?category=${encodeURIComponent(category)}`);
    browseLists = data.lists;
    // A filter box rather than paging: the whole category is already here, and 437 titles is a
    // lot to thumb past when you know the name you want.
    const filter = $('browseFilter');
    filter.style.display = '';
    filter.value = browseState.filter;
    filter.placeholder = `Filter ${browseLists.length} lists…`;
    $('browseSort').style.display = '';
    paintBrowseSort();
    renderBrowseLists(browseState.filter);
  } catch (err) {
    $('browseBody').innerHTML = `<p class="hint center">Could not load (${escapeHtml(err.message)}).</p>`;
  } finally {
    browseState.loading = false;
  }
}

function renderBrowseLists(query) {
  const q = query.trim().toLowerCase();
  const matching = q ? browseLists.filter((l) => l.name.toLowerCase().includes(q)) : browseLists;
  const shown = listSort() === 'az'
    ? [...matching].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
    : matching;
  const body = $('browseBody');
  body.innerHTML = '';
  if (!shown.length) {
    body.innerHTML = '<p class="hint center">Nothing matches.</p>';
    return;
  }
  // Capped rather than virtualised: a few hundred buttons is fine, thousands is not, and the
  // filter is the intended way through a long category.
  for (const l of shown.slice(0, 300)) {
    const b = document.createElement('button');
    b.className = 'rowbtn';
    b.innerHTML =
      `<span style="flex:1">${escapeHtml(l.name)}</span>` +
      (l.playable ? '' : '<span class="off-pool">NOT IN POOL</span>') +
      `<span class="n">${l.characters}</span>`;
    b.addEventListener('click', () => openList(l));
    body.appendChild(b);
  }
  if (shown.length > 300) {
    const p = document.createElement('p');
    p.className = 'hint center';
    p.textContent = `Showing 300 of ${shown.length} — keep typing to narrow it down.`;
    body.appendChild(p);
  }
}

async function openList(list, { push = true } = {}) {
  browseState.view = 'characters';
  browseState.list = list;
  browseState.offset = 0;
  $('browseFilter').style.display = 'none';
  $('browseSort').style.display = 'none';
  setCrumb(['All', browseState.category, list.name]);
  if (push) pushBrowseHistory('characters', { category: browseState.category, list });
  browseBusy(true); // loadCharacterPage replaces this with the grid
  await loadCharacterPage(true);
}

async function loadCharacterPage(first) {
  const { list, offset } = browseState;
  try {
    const data = await getJson(`/api/browse/characters?listId=${list.id}&limit=${PAGE}&offset=${offset}`);
    const body = $('browseBody');
    if (first) body.innerHTML = '';
    let grid = body.querySelector('.chargrid');
    if (!grid) {
      grid = document.createElement('div');
      grid.className = 'chargrid';
      body.appendChild(grid);
    }
    for (const c of data.characters) {
      const tile = document.createElement('div');
      tile.className = 'chartile';
      // loading="lazy": a 60-tile page would otherwise fire 60 image requests at once, and each
      // miss makes the server fetch upstream. Only what scrolls into view is paid for.
      tile.innerHTML =
        (c.imageUrl
          ? `<img src="${escapeHtml(c.imageUrl)}" alt="" loading="lazy" decoding="async">`
          : '<div class="noimg">no picture</div>') +
        `<span class="cname">${escapeHtml(c.name)}</span>`;
      grid.appendChild(tile);
    }
    browseState.offset = offset + data.characters.length;
    const more = browseState.offset < data.total;
    $('browseMore').style.display = more ? '' : 'none';
    $('browseMore').textContent = `Load more (${browseState.offset} of ${data.total})`;
    setCrumb(['All', browseState.category,
      `${data.list.name} · ${data.total}${data.list.playable ? '' : ' · not in play'}`]);
  } catch (err) {
    $('browseBody').innerHTML = `<p class="hint center">Could not load (${escapeHtml(err.message)}).</p>`;
  } finally {
    browseState.loading = false;
  }
}

// A breadcrumb where every level above the current one is tappable, so going up two steps does
// not mean pressing Back twice. Taps rewind history instead of pushing, so the phone's own Back
// gesture keeps agreeing with what is on screen.
function setCrumb(parts) {
  const el = $('browseCrumb');
  el.innerHTML = '';
  parts.forEach((label, i) => {
    if (i) el.appendChild(document.createTextNode(' › '));
    const span = document.createElement('span');
    span.textContent = label;
    if (i < parts.length - 1) {
      span.className = 'up';
      span.addEventListener('click', () => (historyWorks
        ? history.go(i - (parts.length - 1))
        : (i === 0 ? openBrowse() : openCategory(browseState.category))));
    }
    el.appendChild(span);
  });
}

// The phone's own Back gesture is what people reach for first, so each depth gets a history
// entry. Guarded on the browse screen being active: a game can pull the player out of browsing
// at any moment, and a stray back-swipe must not then drag them out of the game.
let historyWorks = true;
function pushBrowseHistory(view, extra = {}) {
  try {
    history.pushState({ gtcBrowse: { view, ...extra } }, '');
  } catch {
    // Some embedded webviews refuse pushState. Note it, so Back walks the levels by hand
    // instead of calling history.back() and sailing off the page entirely.
    historyWorks = false;
  }
}

window.addEventListener('popstate', (e) => {
  if (!$('browse').classList.contains('active')) return;
  const st = e.state?.gtcExit ? null : e.state?.gtcBrowse;
  if (!st) return show(currentRoom ? 'lobby' : startScreen);
  if (st.view === 'categories') return openBrowse({ push: false });
  if (st.view === 'lists') return openCategory(st.category, { push: false });
  if (st.view === 'characters') {
    // Restore the category the entry was CREATED in. Reading it from browseState instead meant
    // a back-navigation across two categories drew the right list under the wrong parent.
    browseState.category = st.category ?? browseState.category;
    return openList(st.list, { push: false });
  }
});

function browseBack() {
  if (historyWorks) return history.back();
  if (browseState.view === 'characters') return openCategory(browseState.category);
  if (browseState.view === 'lists') return openBrowse();
  show(currentRoom ? 'lobby' : startScreen);
}

