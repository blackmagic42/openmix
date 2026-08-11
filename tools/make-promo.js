// Fabrique l'image de promotion : logo + capture + accroches.
// Format 1600x900 : bon pour Reddit, Facebook, X, miniature YouTube.
//
//   npx electron tools/make-promo.js         -> docs/promo.png    (francais)
//   npx electron tools/make-promo.js --en    -> docs/promo-en.png (anglais)
//
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const SHOT = path.join(DOCS, 'screenshot-main.png');
const ICON = path.join(__dirname, '..', 'build', 'icon-256.png');

const EN = process.argv.includes('--en');
const OUT = path.join(DOCS, EN ? 'promo-en.png' : 'promo.png');

const MANETTE = '🎮';
const PLATINE = '🎛';
const TEL = '📱';
const BULLE = '💬';

const T = EN ? {
  sous: 'Free DJ software — 4 decks, DDJ, gamepads, phone',
  badge: 'FREE · OPEN SOURCE',
  args: [
    [MANETTE, 'Up to 4 players on gamepads'],
    [PLATINE, 'Any USB-MIDI controller'],
    [TEL, 'Phone as a second console'],
    [BULLE, 'Crowd requests via QR code']
  ]
} : {
  sous: 'Logiciel DJ libre — 4 platines, DDJ, manettes, téléphone',
  badge: 'GRATUIT · OPEN SOURCE',
  args: [
    [MANETTE, 'Jusqu’à 4 joueurs à la manette'],
    [PLATINE, 'Toute platine USB-MIDI'],
    [TEL, 'Console sur téléphone'],
    [BULLE, 'Demandes du public par QR']
  ]
};

const W = 1600;
const H = 900;

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000}</style></head><body>
<canvas id="c" width="${W}" height="${H}"></canvas><script>
const charge = (u) => new Promise((ok, ko) => {
  const i = new Image();
  i.onload = () => ok(i);
  i.onerror = () => ko(new Error('image ' + u));
  i.src = u;
});

// Rectangle a coins arrondis (roundRect n'existe pas partout)
function coinsRonds(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

window.fabrique = async function (urlShot, urlIcon, T) {
  const [shot, icon] = await Promise.all([charge(urlShot), charge(urlIcon)]);
  const cv = document.getElementById('c');
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;

  // Fond sombre + halo bleu derriere la capture
  const f = g.createLinearGradient(0, 0, 0, H);
  f.addColorStop(0, '#0e1219');
  f.addColorStop(1, '#05070a');
  g.fillStyle = f;
  g.fillRect(0, 0, W, H);
  const halo = g.createRadialGradient(W / 2, 470, 60, W / 2, 470, 780);
  halo.addColorStop(0, 'rgba(57,194,255,0.16)');
  halo.addColorStop(1, 'rgba(57,194,255,0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, W, H);

  // En-tete : logo + nom + sous-titre
  g.drawImage(icon, 54, 44, 76, 76);
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.font = '800 40px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = '#ffffff';
  g.fillText('OPEN', 148, 74);
  const wOpen = g.measureText('OPEN').width;
  g.fillStyle = '#39c2ff';
  g.fillText('MIX', 148 + wOpen, 74);
  g.font = '600 17px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = '#8a94ae';
  g.fillText(T.sous, 149, 106);

  // Badge a droite
  g.font = '800 17px "Segoe UI", system-ui, sans-serif';
  const bw = g.measureText(T.badge).width + 34;
  coinsRonds(g, W - 54 - bw, 56, bw, 40, 20);
  g.fillStyle = 'rgba(53,217,122,0.13)';
  g.fill();
  g.strokeStyle = 'rgba(53,217,122,0.55)';
  g.lineWidth = 1.5;
  g.stroke();
  g.fillStyle = '#35d97a';
  g.textAlign = 'center';
  g.fillText(T.badge, W - 54 - bw / 2, 77);

  // La capture, cadree et arrondie
  const cw = 1360;
  const ch = Math.round(cw * shot.height / shot.width);
  const cx = (W - cw) / 2;
  const cy = 150;
  const bas = Math.min(ch, 560);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.75)';
  g.shadowBlur = 46;
  g.shadowOffsetY = 16;
  coinsRonds(g, cx, cy, cw, bas, 12);
  g.fillStyle = '#0a0b0e';
  g.fill();
  g.restore();
  g.save();
  coinsRonds(g, cx, cy, cw, bas, 12);
  g.clip();
  g.drawImage(shot, cx, cy, cw, ch);
  // Fondu en bas : sans lui la capture parait coupee au couteau
  const fade = g.createLinearGradient(0, cy + bas - 110, 0, cy + bas);
  fade.addColorStop(0, 'rgba(7,9,13,0)');
  fade.addColorStop(1, 'rgba(7,9,13,0.97)');
  g.fillStyle = fade;
  g.fillRect(cx, cy + bas - 110, cw, 110);
  g.restore();
  g.strokeStyle = 'rgba(57,194,255,0.30)';
  g.lineWidth = 1.5;
  coinsRonds(g, cx, cy, cw, bas, 12);
  g.stroke();

  // Bandeau du bas : les arguments, la manette en tete
  const y = 762;
  const largeur = W - 108;
  const pas = largeur / T.args.length;
  T.args.forEach(([ico, txt], i) => {
    const x = 54 + pas * i;
    coinsRonds(g, x, y, pas - 18, 84, 10);
    g.fillStyle = 'rgba(255,255,255,0.035)';
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.09)';
    g.lineWidth = 1;
    g.stroke();
    g.textAlign = 'left';
    g.font = '400 30px "Segoe UI Emoji", "Segoe UI", sans-serif';
    g.fillStyle = '#e6ecf7';
    g.fillText(ico, x + 22, y + 43);
    g.font = '700 18px "Segoe UI", system-ui, sans-serif';
    g.fillStyle = '#cfd7e6';
    g.fillText(txt, x + 66, y + 43);
  });

  return cv.toDataURL('image/png');
};
</script></body></html>`;

const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const page = path.join(DOCS, '_promo.html');
  fs.writeFileSync(page, PAGE);
  const win = new BrowserWindow({ width: 300, height: 200, show: false });
  await win.loadFile(page);
  const dataUrl = await win.webContents.executeJavaScript(
    `window.fabrique(${JSON.stringify(fileUrl(SHOT))}, ${JSON.stringify(fileUrl(ICON))}, ${JSON.stringify(T)})`);
  fs.writeFileSync(OUT, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
  win.destroy();
  fs.unlinkSync(page);
  console.log('promo -> ' + OUT);
  app.quit();
});
