// macOS: the native red/yellow/green buttons always float at the top
// left over the logo (unlike Windows, where titleBarOverlay puts them
// on the right) — we add a class to shift the topbar content and make
// room for them. See styles.css: html.is-mac #topbar.
if (window.api && window.api.platform === 'darwin') {
  document.documentElement.classList.add('is-mac');
}
