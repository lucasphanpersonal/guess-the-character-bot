// The computer games' first-paint switches (/desk/, /draw/): the season, and dark mode. Loaded
// as a blocking script in <head>, so the first paint is already right -- never purple on its way
// to orange, never white on its way to dark. The phones' page decides the same two things inline
// (src/web/party/public/index.html), with the same values.

// Spooky season ends by itself on November 1 (the visitor's local midnight). The favicon is the
// one place an emoji is allowed.
if (new Date() < new Date(2026, 10, 1)) {
  document.documentElement.dataset.season = 'spooky';
  const icon = document.querySelector('link[rel=icon]');
  if (icon) icon.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>🎃</text></svg>";
}

// Dark mode: the toggle's choice (gtc_theme -- the same key as the phones' page, so a browser that
// chose dark there is dark here) wins; until somebody presses it, the computer's own setting
// does. Storage can be blocked, hence the try. GTC.applyTheme (common.js) is the toggle side.
(function () {
  let saved = null;
  try { saved = localStorage.getItem('gtc_theme'); } catch { /* follow the computer */ }
  const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.dataset.theme = 'dark';
  // The browser's own chrome matches the field: purple or orange, or their dark versions.
  const spooky = document.documentElement.dataset.season === 'spooky';
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = dark ? (spooky ? '#2a1307' : '#170d2b') : spooky ? '#cc4a0c' : '#46178f';
})();
