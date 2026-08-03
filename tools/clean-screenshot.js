// Remplace les titres de morceaux RÉELS de la capture d'écran du README par
// des noms neutres : la vitrine reste, mais le dépôt public ne diffuse plus
// de titres commerciaux ni de noms de dossiers tiers.
//
//   npx electron tools/clean-screenshot.js
//
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SHOT = path.join(__dirname, '..', 'docs', 'screenshot-main.png');

// Zones à repeindre : x, y, largeur, hauteur, texte de remplacement, taille,
// couleur du texte. Les coordonnées sont celles de l'image d'origine.
const ZONES = [
  // titres des 4 platines
  { x: 44, y: 312, w: 250, h: 19, t: 'Demo Loop 01 — OpenMix', s: 12, c: '#e6ecf7' },
  { x: 1060, y: 312, w: 250, h: 19, t: 'Demo Loop 02 — OpenMix', s: 12, c: '#e6ecf7' },
  { x: 44, y: 537, w: 250, h: 19, t: 'Demo Loop 03 — OpenMix', s: 12, c: '#e6ecf7' },
  { x: 1060, y: 537, w: 250, h: 19, t: 'Demo Loop 04 — OpenMix', s: 12, c: '#e6ecf7' },
  // colonne TITRE de la bibliothèque (la ligne 1, sélectionnée, est laissée
  // telle quelle : « .. (dossier parent) » ne pose aucun problème)
  { x: 416, y: 845, w: 340, h: 21, t: 'Mes boucles', s: 11.5, c: '#cfd7e6' },
  { x: 416, y: 871, w: 340, h: 21, t: 'Demo Loop 01 — OpenMix', s: 11.5, c: '#cfd7e6' },
  { x: 416, y: 897, w: 340, h: 21, t: 'Demo Loop 02 — OpenMix', s: 11.5, c: '#cfd7e6' },
  { x: 416, y: 924, w: 340, h: 21, t: 'Demo Loop 03 — OpenMix', s: 11.5, c: '#cfd7e6' },
  { x: 416, y: 951, w: 340, h: 21, t: 'Demo Loop 04 — OpenMix', s: 11.5, c: '#cfd7e6' },
  { x: 416, y: 977, w: 340, h: 21, t: 'Demo Loop 05 — OpenMix', s: 11.5, c: '#cfd7e6' }
];

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000}</style></head><body>
<canvas id="c"></canvas><script>
window.nettoie = function (url, zones) {
  return new Promise((ok, ko) => {
    const i = new Image();
    i.onload = () => {
      const cv = document.getElementById('c');
      cv.width = i.naturalWidth;
      cv.height = i.naturalHeight;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(i, 0, 0);
      for (const z of zones) {
        // Couleur de fond RÉELLE, prélevée juste à gauche de la zone :
        // le rectangle se fond dans l'interface au lieu de faire une tache
        const p = g.getImageData(Math.min(cv.width - 1, z.x + z.w + 30), z.y + Math.floor(z.h / 2), 1, 1).data;
        g.fillStyle = 'rgb(' + p[0] + ',' + p[1] + ',' + p[2] + ')';
        g.fillRect(z.x, z.y, z.w, z.h);
        g.fillStyle = z.c;
        g.font = '600 ' + z.s + 'px system-ui, "Segoe UI", sans-serif';
        g.textBaseline = 'middle';
        g.fillText(z.t, z.x + 2, z.y + z.h / 2 + 0.5);
      }
      ok(cv.toDataURL('image/png'));
    };
    i.onerror = () => ko(new Error('capture illisible'));
    i.src = url;
  });
};
</script></body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  if (!fs.existsSync(SHOT)) {
    console.log('capture introuvable : ' + SHOT);
    app.quit();
    return;
  }
  const page = path.join(path.dirname(SHOT), '_clean.html');
  fs.writeFileSync(page, PAGE);
  const win = new BrowserWindow({ width: 400, height: 300, show: false });
  await win.loadFile(page);
  const url = 'file:///' + SHOT.replace(/\\/g, '/').replace(/ /g, '%20');
  const dataUrl = await win.webContents.executeJavaScript(
    `window.nettoie(${JSON.stringify(url)}, ${JSON.stringify(ZONES)})`);
  fs.writeFileSync(SHOT, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
  win.destroy();
  fs.unlinkSync(page);
  console.log('capture nettoyee -> ' + SHOT);
  app.quit();
});
