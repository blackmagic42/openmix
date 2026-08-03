// Fabrique l'icône Windows (build/icon.ico) À PARTIR DU LOGO OFFICIEL.
//
// Le logo complet porte le mot « OPENMIX » sous le symbole : illisible en
// 32 px. On RECADRE donc automatiquement sur le symbole (le cercle), en
// détectant ses bords, puis on génère toutes les tailles + le .ico.
//
//   npx electron tools/make-icon.js [chemin-du-logo.png]
//
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] && !process.argv[2].startsWith('-')
  ? process.argv[2]
  : path.join(__dirname, '..', 'build', 'logo.png');
const OUT = path.join(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000}</style></head><body>
<canvas id="c"></canvas><script>
let img = null;
let box = null;

// Cadre du SYMBOLE : on cherche les pixels clairs, en ignorant le bas de
// l'image (le texte du logo) — puis on prend un carré centré avec marge.
window.charger = function (url) {
  return new Promise((ok, ko) => {
    const i = new Image();
    i.onload = () => {
      img = i;
      const w = i.naturalWidth;
      const h = i.naturalHeight;
      const cv = document.getElementById('c');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(i, 0, 0);
      const HAUT = Math.floor(h * 0.62);   // le symbole seul : le texte du logo commence plus bas
      const d = g.getImageData(0, 0, w, HAUT).data;
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      for (let y = 0; y < HAUT; y++) {
        for (let x = 0; x < w; x++) {
          const p = (y * w + x) * 4;
          const lum = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
          if (d[p + 3] > 20 && lum > 95) {   // seuil haut : ignore le halo diffus
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 <= x0 || y1 <= y0) { ko(new Error('symbole introuvable')); return; }
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const cote = Math.max(x1 - x0, y1 - y0) * 1.14;   // 14 % de marge
      box = { x: cx - cote / 2, y: cy - cote / 2, c: cote };
      ok({ w, h, x0, y0, x1, y1, cote: Math.round(cote) });
    };
    i.onerror = () => ko(new Error('image illisible'));
    i.src = url;
  });
};

window.dessine = function (S) {
  const cv = document.getElementById('c');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  // Fond arrondi sombre : l'icône reste lisible sur un fond clair
  const r = S * 0.22;
  g.beginPath();
  g.moveTo(r, 0); g.lineTo(S - r, 0); g.quadraticCurveTo(S, 0, S, r);
  g.lineTo(S, S - r); g.quadraticCurveTo(S, S, S - r, S);
  g.lineTo(r, S); g.quadraticCurveTo(0, S, 0, S - r);
  g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0);
  g.closePath();
  const f = g.createLinearGradient(0, 0, 0, S);
  f.addColorStop(0, '#12151c');
  f.addColorStop(1, '#08090c');
  g.fillStyle = f;
  g.fill();
  g.save();
  g.clip();
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, box.x, box.y, box.c, box.c, 0, 0, S, S);
  g.restore();
  return cv.toDataURL('image/png');
};
</script></body></html>`;

function makeIco(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir[o] = p.size >= 256 ? 0 : p.size;
    dir[o + 1] = p.size >= 256 ? 0 : p.size;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(p.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += p.buf.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.buf)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  if (!fs.existsSync(SRC)) {
    console.log(`Logo introuvable : ${SRC}`);
    app.quit();
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const page = path.join(OUT, '_icon.html');
  fs.writeFileSync(page, PAGE);
  const win = new BrowserWindow({ width: 400, height: 400, show: false });
  await win.loadFile(page);
  const url = 'file:///' + SRC.replace(/\\/g, '/').replace(/ /g, '%20').replace(/'/g, "%27");
  const info = await win.webContents.executeJavaScript(`window.charger(${JSON.stringify(url)})`);
  console.log(`source ${info.w}x${info.h} — symbole détecté (${info.x0},${info.y0})-(${info.x1},${info.y1}), carré ${info.cote}px`);
  const pngs = [];
  for (const S of SIZES) {
    const dataUrl = await win.webContents.executeJavaScript(`window.dessine(${S})`);
    const buf = Buffer.from(String(dataUrl).split(',')[1], 'base64');
    pngs.push({ size: S, buf });
    fs.writeFileSync(path.join(OUT, `icon-${S}.png`), buf);
  }
  win.destroy();
  fs.unlinkSync(page);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), makeIco(pngs));
  console.log(`OK -> ${path.join(OUT, 'icon.ico')} (${SIZES.join(', ')})`);
  app.quit();
});
