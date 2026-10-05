// Seasonal theme for the computer games -- the same switch as the phones' page
// (src/web/party/public/index.html). Loaded as a blocking script in <head>, so the first paint is
// already in season and never flashes purple on its way to orange. It ends by itself on
// November 1 (the visitor's local midnight). The favicon is the one place an emoji is allowed.
if (new Date() < new Date(2026, 10, 1)) {
  document.documentElement.dataset.season = 'spooky';
  const theme = document.querySelector('meta[name=theme-color]');
  if (theme) theme.content = '#cc4a0c';
  const icon = document.querySelector('link[rel=icon]');
  if (icon) icon.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>🎃</text></svg>";
}
