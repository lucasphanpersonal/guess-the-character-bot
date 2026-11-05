// The menu pointer: a white glove that points at what you are about to choose, as the hand did in
// the menus of the 16-bit RPGs. The art below is our own, drawn for this site -- an homage to that
// hand, not a copy of anyone's sprite.
//
// Decoration, with the rules decoration has here:
//   - It never takes a tap (pointer-events), screen readers never see it, and a page that did not
//     load this file works exactly the same. Focus rings and hover states are untouched: the glove
//     is beside them, never instead of them.
//   - With a mouse it points at the control under the pointer, or at the one keyboard focus is on.
//     On touch there is no hover, so it points at what you last tapped while that is still on
//     screen: the thing you chose. GTC.ask points it at a question's safe answer.
//   - Never over the forehead view (data-plain), which stays plain; never on touch during play
//     (data-playing), where a phone's screen is the game; and not beside the drawing tools, which
//     are aimed at a hundred times a turn.
//   - It sits on the control's left, the way the hand sat in a menu. Where the control reaches the
//     screen's left edge there is no room for it, and it simply does not show.
//   - It lives inside an open <dialog> when it points at something in one: a modal dialog is in the
//     top layer, which no z-index on the page can reach.
// The glove keeps its own colours in both themes, like a picture: white with a dark outline reads
// on the cream panels and on the night sky alike.
(function () {
  if (window.GTCPointer) return;

  // 20 x 13. # outline, w glove, g shade. The cuff is the column on the left.
  const ROWS = [
    '....######..........',
    '...#wwwwww#.........',
    '..#wwwwwwww########.',
    '###wwwwwwwwwwwwwwww#',
    '#w#wwwwwwwwwwwwwwgg#',
    '#w#wwwwwwww########.',
    '#w#wwwwwwwwwwwwg#...',
    '#g#wwwwwwgg#####....',
    '#g#wwwwwwwwwwwg#....',
    '###wwwwwwgg####.....',
    '..#gwwwwwwwwwg#.....',
    '...#gggggggg##......',
    '....########........',
  ];
  const FILL = { '#': '#0c0a24', w: '#ffffff', g: '#b0b4ce' };
  const SCALE = 2; // whole screen pixels per art pixel, so it stays crisp
  const W = ROWS[0].length * SCALE;
  const H = ROWS.length * SCALE;
  const GAP = 4; // between the fingertip and the control
  let rects = '';
  ROWS.forEach((row, y) => [...row].forEach((ch, x) => {
    if (FILL[ch]) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${FILL[ch]}"/>`;
  }));
  const glove = document.createElement('div');
  glove.className = 'glove';
  glove.setAttribute('aria-hidden', 'true');
  glove.innerHTML = `<svg viewBox="0 0 ${ROWS[0].length} ${ROWS.length}" width="${W}" height="${H}" shape-rendering="crispEdges">${rects}</svg>`;
  glove.hidden = true;

  const TARGETS = 'button, a[href], label.choice, summary, select, [role="button"], [role="radio"], [role="option"], [role="switch"]';
  // The drawing tools, aimed at constantly; the small switches in the title row, which sit at the
  // field's edge; anything a page opts out.
  const SKIP = '[data-noglove], .swatch, .size, .canvaswrap, .themetoggle, .crttoggle';
  const root = document.documentElement;
  const coarse = matchMedia('(hover: none)');

  let target = null;
  let viaTouch = false;
  let timer = 0;

  const pointable = (el) => {
    const t = el?.closest?.(TARGETS);
    if (!t || t.closest(SKIP) || t.disabled || t.getAttribute('aria-disabled') === 'true') return null;
    return t;
  };
  const quiet = () => root.hasAttribute('data-plain') || (viaTouch && root.hasAttribute('data-playing'));

  function hide() { glove.hidden = true; }
  function place() {
    if (!target) return hide();
    if (!target.isConnected || quiet()) { aim(null); return; }
    const r = target.getBoundingClientRect();
    const x = Math.round(r.left - W - GAP);
    // Off screen, collapsed (its screen went away), or no room on its left: no glove.
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || x < 2) return hide();
    // Level with the first line of a tall control, not its middle.
    const y = Math.round(r.top + Math.min(r.height, 48) / 2 - H / 2);
    const home = target.closest('dialog[open]') || document.body;
    if (glove.parentNode !== home) home.append(glove);
    glove.style.transform = `translate(${x}px, ${y}px)`;
    glove.hidden = false;
  }
  // While it points at something, it looks again a few times a second: screens change, panels open
  // and rosters are rewritten under it, and none of that says so. Nothing runs while it points at
  // nothing.
  function aim(el) {
    target = el;
    clearInterval(timer);
    timer = 0;
    if (target) timer = setInterval(place, 250);
    place();
  }

  let frame = 0;
  const soon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); }); };

  // Off the controls, a question's box still has a choice in hand: the one with the focus.
  const held = () => (document.activeElement?.closest('dialog[open]') ? pointable(document.activeElement) : null);
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    viaTouch = false;
    aim(pointable(e.target) || held());
  }, { passive: true });
  // Leaving the window, or into something that is not a control, puts it away.
  document.addEventListener('pointerout', (e) => { if (e.pointerType !== 'touch' && !e.relatedTarget) aim(null); }, { passive: true });
  document.addEventListener('focusin', (e) => {
    const t = pointable(e.target);
    if (t && t.matches(':focus-visible')) { viaTouch = false; aim(t); }
  });
  document.addEventListener('focusout', (e) => { if (e.target === target && !e.target.matches(':hover')) aim(null); });
  document.addEventListener('click', (e) => {
    if (!(e.pointerType === 'touch' || (coarse.matches && !e.pointerType))) return;
    viaTouch = true;
    aim(pointable(e.target));
  }, { passive: true });
  addEventListener('scroll', soon, { capture: true, passive: true });
  addEventListener('resize', soon, { passive: true });

  const mount = () => { document.body.append(glove); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  window.GTCPointer = {
    // Point at this control now, however it came to matter (GTC.ask gives it the focus in code).
    point(el) { viaTouch = coarse.matches; aim(pointable(el)); },
  };
})();
