// The Room button, in every game: who is in the room, the host's Remove beside each of them, and
// Leave Room -- one button away on every screen, from the lobby to the results.
//
// Before it, leaving and removing were wherever each screen happened to put them: the computer
// guessing game had no Remove anywhere and no way out mid-game but the title; Draw had Remove only
// beside the players it listed; the phones' Remove appeared only for players holding up a deal.
// The server has always allowed both at every stage, so this is the one place that offers them.
//
// Self-contained (its own escaping and styles) because the phones' page does not load
// /shared/common.js. It reuses each page's own way of leaving, so what leaving costs is asked in
// that game's words, and a leave from here is the same leave as anywhere else.
(function () {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Styles, scoped to the dialog. Tokens with fallbacks: the phones' page and the computer pages
  // define the same names, and either may be missing one.
  const CSS = `
    dialog.roommenu { border:none; border-radius:18px; padding:20px; width:min(26rem, calc(100vw - 32px));
      max-height:calc(100dvh - 32px); overflow-y:auto; overscroll-behavior:contain;
      background:var(--paper, #fff); color:var(--ink, #1b1033); box-shadow:0 6px 0 rgba(0,0,0,.22); }
    dialog.roommenu::backdrop { background:rgba(20,8,45,.62); }
    .roommenu h2 { margin:0 44px 4px 0; font-size:1.35rem; }
    .roommenu .rmsub { margin:0 0 14px; color:var(--muted, #6b6480); font-size:.88rem; }
    .roommenu .rmclose { position:absolute; top:12px; right:12px; width:2.5rem; height:2.5rem; padding:0; font-size:1.05rem; line-height:1; }
    .roommenu ul { list-style:none; margin:0 0 14px; padding:0; display:flex; flex-direction:column; gap:8px; }
    .roommenu li { display:flex; align-items:center; gap:8px; background:var(--soft, #f6f4fa); border-radius:12px; padding:8px 10px; min-height:2.9rem; }
    .roommenu .rmname { flex:1; min-width:0; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .roommenu .rmtag { flex:none; font-size:.66rem; font-weight:900; letter-spacing:.05em; text-transform:uppercase;
      border-radius:999px; padding:2px 7px; background:var(--amber, #ffa602); color:#2b1c00; }
    .roommenu .rmtag.off { background:var(--muted, #6b6480); color:#fff; }
    .roommenu .rmkick { flex:none; width:auto; padding:7px 12px; font-size:.85rem; }
    .roommenu .rmerr { color:var(--red, #e21b3c); font-weight:800; min-height:0; margin:0 0 10px; }
    .roommenu .rmerr:empty { display:none; }
    .roommenu .rmleave { width:100%; }
    .roommenu .rmtheme { display:none; align-items:center; justify-content:space-between; gap:12px; margin:0 0 14px; font-weight:800; }
    .roommenu .rmtheme .themetoggle { position:relative; top:auto; right:auto; left:auto; flex:none; }
    /* On a phone the title row has no room for the dark-mode switch beside Room and Sound, so it
       moves in here (theme.css hides the one in the row). */
    @media (max-width: 560px) { .roommenu .rmtheme { display:flex; } }
  `;

  /**
   * @param {object} o
   * @param {HTMLElement} o.button     the page's Room button; shown only while in a room
   * @param {object} o.socket
   * @param {() => object|null} o.room  the room's public state ({ code, status, hostPlayerId, players })
   * @param {() => string|null} o.me    this browser's public id
   * @param {() => string|null} o.leaveCost  what leaving costs, in the game's words (null: nothing)
   * @param {() => any} o.leave         the page's own leave
   * @param {(name, status) => string} o.removeCost  what removing someone costs right now
   * @param {boolean} [o.themeToggle]   carry a dark-mode switch for phone widths (computer pages)
   */
  function mount(o) {
    if (!document.getElementById('roommenu-css')) {
      const style = document.createElement('style');
      style.id = 'roommenu-css';
      style.textContent = CSS;
      document.head.append(style);
    }
    const dlg = document.createElement('dialog');
    dlg.className = 'roommenu';
    dlg.setAttribute('aria-labelledby', 'roommenuTitle');
    dlg.innerHTML = `
      <button type="button" class="ghost rmclose" aria-label="Close">✕</button>
      <h2 id="roommenuTitle"></h2>
      <p class="rmsub"></p>
      <ul></ul>
      <p class="rmerr" role="alert"></p>
      ${o.themeToggle ? '<div class="rmtheme"><span>Dark Mode</span><button class="themetoggle" type="button" role="switch" aria-checked="false" aria-label="Dark mode"><span class="knob" aria-hidden="true">◐</span></button></div>' : ''}
      <button type="button" class="bad rmleave">Leave Room</button>`;
    document.body.append(dlg);
    const list = dlg.querySelector('ul');
    const err = dlg.querySelector('.rmerr');

    function render() {
      const room = o.room();
      o.button.hidden = !room;
      if (!room) {
        if (dlg.open) dlg.close();
        return;
      }
      if (!dlg.open) return;
      const me = o.me();
      const host = room.hostPlayerId === me;
      dlg.querySelector('h2').textContent = `Room ${room.code}`;
      dlg.querySelector('.rmsub').textContent = host ? 'You are the host: you can remove anyone, at any point.' : `${room.players.length} in the room.`;
      // Rewritten only when it changes: a state arrives with every roster change, and replacing
      // the list between a press and its release would swallow the click.
      const html = room.players
        .map((p) => {
          const you = p.playerId === me;
          const tags = `${p.isHost ? '<span class="rmtag">Host</span>' : ''}${p.connected === false ? '<span class="rmtag off">Away</span>' : ''}`;
          const kick = host && !you ? `<button type="button" class="bad rmkick" data-kick="${esc(p.playerId)}" data-name="${esc(p.nickname)}">Remove</button>` : '';
          return `<li><span class="rmname" title="${esc(p.nickname)}">${esc(p.nickname)}${you ? ' (you)' : ''}</span>${tags}${kick}</li>`;
        })
        .join('');
      if (list.dataset.html !== html) list.innerHTML = list.dataset.html = html;
    }

    o.button.addEventListener('click', () => {
      err.textContent = '';
      dlg.showModal();
      render();
    });
    dlg.querySelector('.rmclose').addEventListener('click', () => dlg.close());
    dlg.querySelector('.rmleave').addEventListener('click', () => {
      const cost = o.leaveCost();
      if (cost && !confirm(cost)) return;
      dlg.close();
      o.leave();
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-kick]');
      if (!b) return;
      const room = o.room();
      if (!confirm(o.removeCost(b.dataset.name, room?.status))) return;
      b.disabled = true;
      err.textContent = '';
      o.socket.emit('room:kick', { playerId: b.dataset.kick }, (res) => {
        b.disabled = false;
        // The server's reason, always: a button that silently does nothing is the worse failure.
        if (!res?.ok) err.textContent = res?.error || 'Could not remove them.';
        render();
      });
    });
    // No render() here: a page mounts this near its top, before the state its getters read exists
    // (a `let` not yet declared throws). The button starts hidden; the page calls update().
    return { update: render, close: () => dlg.open && dlg.close() };
  }

  window.GTCRoomMenu = { mount };
})();
