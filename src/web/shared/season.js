// Every page's first-paint switches (/, /desk/, /draw/): the season, dark mode and the CRT screen.
// Loaded as a blocking script in <head>, after the theme-color meta and the icon link it edits, so
// the first paint is already right -- never purple on its way to orange, never white on its way to
// dark. One file for all three pages, so they cannot decide any of these differently.

// Spooky season ends by itself on November 1 (the visitor's local midnight). The favicon is the
// one place an emoji is allowed.
if (new Date() < new Date(2026, 10, 1)) {
  document.documentElement.dataset.season = 'spooky';
  const icon = document.querySelector('link[rel=icon]');
  if (icon) icon.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>🎃</text></svg>";
}

// Dark mode: the toggle's choice (gtc_theme, one key for every page, so a browser that chose dark
// on one is dark on all) wins; until somebody presses it, the computer's own setting
// does. Storage can be blocked, hence the try. GTC.bindThemeToggles (common.js) is the switch side.
(function () {
  let saved = null;
  try { saved = localStorage.getItem('gtc_theme'); } catch { /* follow the computer */ }
  const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.dataset.theme = 'dark';
  // The browser's own chrome matches the field: indigo or orange, or their dark versions.
  const spooky = document.documentElement.dataset.season === 'spooky';
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = dark ? (spooky ? '#2a1307' : '#0e0f1a') : spooky ? '#cc4a0c' : '#1f1a4d';
})();

// The CRT screen (retro.css): on unless this browser turned it off (gtc_crt, one key for every page). Here rather than at boot so the first paint already has the glass, or never does.
(function () {
  let saved = null;
  try { saved = localStorage.getItem('gtc_crt'); } catch { /* the default */ }
  if (saved !== 'off') document.documentElement.dataset.crt = 'on';
})();
