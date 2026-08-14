// macOS : les ronds rouge/jaune/vert natifs flottent toujours en haut à
// gauche par-dessus le logo (contrairement à Windows, où titleBarOverlay
// les met à droite) — on ajoute une classe pour décaler le contenu du
// topbar et leur laisser la place. Voir styles.css : html.is-mac #topbar.
if (window.api && window.api.platform === 'darwin') {
  document.documentElement.classList.add('is-mac');
}
