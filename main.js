const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const path = require('path');
const fsp = require('fs').promises;

const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.webm']);

let win = null;

// Les DONNÉES restent dans le dossier historique « Turbo Mix » quel que
// soit le nom d'affichage (le renommage OpenMix ne doit JAMAIS faire
// perdre la bibliothèque, les analyses, les cues ni la session SoundCloud)
app.setPath('userData', path.join(app.getPath('appData'), 'Turbo Mix'));

// Autorise le Web MIDI **avec SysEx** (indispensable au keep-alive Pioneer
// qui débloque les LED des platines) — app locale, aucune page distante
app.whenReady().then(() => {
  const { session: sess } = require('electron');
  sess.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
  sess.defaultSession.setPermissionCheckHandler(() => true);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1720,
    height: 990,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#0b0d12',
    title: 'OpenMix',
    // Barre de titre INTÉGRÉE au design (finie la barre Windows blanche) :
    // la fenêtre est frameless, les boutons ⊟ ⊡ ✕ flottent en overlay
    // sombre et le topbar de l'app sert de zone de drag
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#8a94ae', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.setMenuBarVisibility(false);

  // Console du renderer piped vers stdout : indispensable pour diagnostiquer
  // les erreurs JS de l'interface depuis le terminal (2 signatures selon
  // la version d'Electron)
  win.webContents.on('console-message', (e, ...args) => {
    const msg = typeof args[1] === 'string' ? args[1]
      : (e && typeof e.message === 'string' ? e.message : String(args[0] ?? ''));
    const lvl = typeof args[0] === 'number' ? args[0] : (e && e.level) || 0;
    if (lvl >= 2 || /error|Erreur|TypeError|ReferenceError/i.test(msg) || msg.startsWith('[midi]')) {
      console.log(`[renderer] ${msg}`);
    }
  });

  // Verrouille le zoom de page : c'est lui qui faisait « grandir » l'interface
  // petit à petit (Ctrl+molette / pincement, mémorisé entre les sessions).
  win.webContents.setZoomFactor(1.0);
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on('zoom-changed', () => win.webContents.setZoomFactor(1.0));
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(1.0));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') {
      win.webContents.toggleDevTools();
      return;
    }
    if (input.control && ['+', '-', '=', '0'].includes(input.key)) {
      e.preventDefault();
      win.webContents.setZoomFactor(1.0);
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // supprime aussi les raccourcis de zoom du menu par défaut
  await loadSettings();
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// --- Réglages persistants côté main (jeton SoundCloud, client_id) ---
const settingsPath = () => path.join(app.getPath('userData'), 'turbo-settings.json');
let settings = {};
async function loadSettings() {
  try {
    settings = JSON.parse(await fsp.readFile(settingsPath(), 'utf8'));
  } catch {
    settings = {};
  }
}
async function saveSettings() {
  try {
    // Miroir rétro-compat : une ancienne version de l'app ne connaît que
    // settings.scToken — on y reflète le jeton du compte 0 à chaque
    // sauvegarde pour qu'un retour en arrière ne perde pas la session
    if (Array.isArray(settings.scAccounts)) {
      settings.scToken = (settings.scAccounts[0] && settings.scAccounts[0].token) || null;
    }
    await fsp.writeFile(settingsPath(), JSON.stringify(settings));
  } catch { /* non bloquant */ }
}

// Comptes SoundCloud connectés (b2b : le mien + celui du pote), chacun avec
// SON jeton. Migration paresseuse depuis l'ancien réglage mono-compte
// scToken — la garde teste la PRÉSENCE du tableau (même vide), jamais
// scToken : le miroir rétro-compat ci-dessus relancerait sinon la migration
// en boucle et ressusciterait des comptes supprimés.
function scAccounts() {
  if (!Array.isArray(settings.scAccounts)) {
    settings.scAccounts = settings.scToken
      ? [{ name: null, token: settings.scToken, fromCookie: true }]
      : [];
    // Le jeton historique venait du cookie de la session par défaut : la
    // migration vaut adoption, on ne relira plus jamais ce cookie
    if (settings.scToken) settings.scCookieMigrated = true;
    saveSettings();
  }
  return settings.scAccounts;
}

// Compte à utiliser pour une requête : celui demandé s'il a encore un jeton,
// sinon le premier compte valide, sinon null (requête anonyme au client_id)
function scAcctOrDefault(accountIdx) {
  const accounts = scAccounts();
  const acct = accountIdx != null ? accounts[accountIdx] : null;
  if (acct && acct.token) return acct;
  return accounts.find(a => a.token) || null;
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir le dossier de musiques',
    properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

// Import Rekordbox : choisir l'export XML de la collection
ipcMain.handle('pick-xml', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir l\'export XML Rekordbox',
    properties: ['openFile'],
    filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }]
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// SAMPLER : choisir un ou plusieurs fichiers audio à poser sur les pads
ipcMain.handle('pick-samples', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir des samples',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'aif', 'aiff', 'opus', 'webm'] }]
  });
  return r.canceled ? [] : r.filePaths;
});

async function walk(dir, out, depth = 0) {
  if (depth > 6) return;
  if (out.length > 4000) return; // plafond : une racine de disque ne doit pas noyer l'app
  // À la RACINE d'un disque on ne descend PAS en récursif (des heures de
  // scan) : la navigation par dossiers permet d'aller chercher la musique
  if (depth === 0 && /^[A-Za-z]:[\\/]?$/.test(dir)) {
    let entries0;
    try {
      entries0 = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries0) {
      if (!e.isDirectory() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
        const p = path.join(dir, e.name);
        try {
          const st = await fsp.stat(p);
          out.push({ path: p, name: path.parse(e.name).name, size: st.size, mtime: st.mtimeMs });
        } catch { /* illisible */ }
      }
    }
    return;
  }
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out, depth + 1);
    } else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
      try {
        const st = await fsp.stat(p);
        out.push({
          path: p,
          name: path.parse(e.name).name,
          size: st.size,
          mtime: st.mtimeMs
        });
      } catch { /* fichier illisible : on l'ignore */ }
    }
  }
}

ipcMain.handle('scan-folder', async (_e, dir) => {
  const out = [];
  await walk(dir, out);
  out.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  return out;
});

ipcMain.handle('read-file', async (_e, p) => {
  if (!p || typeof p !== 'string') return null; // chemin absent : pas de crash
  return fsp.readFile(p);
});

// POCHETTE d'un morceau : tags du fichier local (ID3/FLAC/MP4 via
// music-metadata) ou téléchargement d'une jaquette distante (SoundCloud).
// Retourne { data: base64, format: mime } ou null.
ipcMain.handle('read-cover', async (_e, src) => {
  try {
    if (/^https?:\/\//i.test(src)) {
      const r = await fetch(src);
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return { data: buf.toString('base64'), format: r.headers.get('content-type') || 'image/jpeg' };
    }
    const mm = await import('music-metadata'); // paquet ESM : import dynamique
    const meta = await mm.parseFile(src, { duration: false });
    const pic = meta.common.picture && meta.common.picture[0];
    if (!pic) return null;
    return { data: Buffer.from(pic.data).toString('base64'), format: pic.format || 'image/jpeg' };
  } catch {
    return null;
  }
});

const cachePath = () => path.join(app.getPath('userData'), 'turbo-mix-cache.json');

ipcMain.handle('cache-load', async () => {
  try {
    return JSON.parse(await fsp.readFile(cachePath(), 'utf8'));
  } catch {
    return {};
  }
});

ipcMain.handle('cache-save', async (_e, obj) => {
  try {
    await fsp.writeFile(cachePath(), JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
});

// Version SYNCHRONE pour la fermeture de l'app : bloque jusqu'à l'écriture
// disque — le quit ne peut plus couper une sauvegarde de calage en vol
ipcMain.on('cache-save-sync', (e, obj) => {
  try {
    require('fs').writeFileSync(cachePath(), JSON.stringify(obj));
    e.returnValue = true;
  } catch {
    e.returnValue = false;
  }
});

// --- Grilles Rekordbox : lecture des fichiers ANLZ (format documenté par
// rétro-ingénierie, projet crate-digger). PPTH = chemin du morceau,
// PQTZ = grille complète : chaque temps avec sa position (ms), son tempo
// local (BPM×100) et son numéro dans la mesure (1-2-3-4). Tout est big-endian.
function parseAnlz(b) {
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'PMAI') return null;
  const headerLen = b.readUInt32BE(4);
  const fileLen = Math.min(b.readUInt32BE(8), b.length);
  let off = headerLen;
  const out = { path: null, beats: [], anchor: 0, bpm: null };
  const tempos = [];
  while (off + 12 <= fileLen) {
    const tag = b.toString('ascii', off, off + 4);
    const totalLen = b.readUInt32BE(off + 8);
    if (totalLen <= 12) break;
    if (tag === 'PPTH' && off + 16 <= fileLen) {
      const pathLen = b.readUInt32BE(off + 12);
      let s = '';
      for (let i = off + 16; i + 1 < Math.min(off + 16 + pathLen, fileLen); i += 2) {
        const code = (b[i] << 8) | b[i + 1];
        if (code === 0) break;
        s += String.fromCharCode(code);
      }
      out.path = s;
    } else if (tag === 'PQTZ' && off + 24 <= fileLen) {
      const count = b.readUInt32BE(off + 20);
      let firstOne = -1;
      for (let i = 0, p = off + 24; i < count && p + 8 <= off + totalLen; i++, p += 8) {
        const beatNum = b.readUInt16BE(p);
        tempos.push(b.readUInt16BE(p + 2));
        out.beats.push(b.readUInt32BE(p + 4) / 1000);
        if (firstOne < 0 && beatNum === 1) firstOne = i;
      }
      out.anchor = Math.max(0, firstOne);
    }
    off += totalLen;
  }
  if (tempos.length) {
    tempos.sort((a, b2) => a - b2);
    out.bpm = tempos[tempos.length >> 1] / 100;
  }
  return out;
}

ipcMain.handle('rb-grids', async () => {
  const roots = [
    path.join(app.getPath('appData'), 'Pioneer', 'rekordbox', 'share', 'PIONEER', 'USBANLZ'),
    path.join(app.getPath('appData'), 'Pioneer', 'rekordbox6', 'share', 'PIONEER', 'USBANLZ')
  ];
  const out = [];
  for (const root of roots) {
    let dirs;
    try { dirs = await fsp.readdir(root); } catch { continue; }
    for (const d of dirs) {
      let subs;
      try { subs = await fsp.readdir(path.join(root, d)); } catch { continue; }
      for (const u of subs) {
        try {
          const r = parseAnlz(await fsp.readFile(path.join(root, d, u, 'ANLZ0000.DAT')));
          // < 8 temps = sample ou jingle, inutile pour une grille
          if (r && r.path && r.bpm && r.beats.length >= 8) {
            out.push({
              name: r.path.split('/').pop().toLowerCase(),
              beats: r.beats,
              anchor: r.anchor,
              bpm: r.bpm,
              lastBeat: r.beats[r.beats.length - 1]
            });
          }
        } catch { /* fichier absent ou illisible : on passe */ }
      }
    }
  }
  return out;
});

// --- Télécommande téléphone : petit serveur HTTP sur le réseau local ---
const REMOTE_PORT = 8722;
let remoteServer = null;
let remoteState = { decks: [], xf: 0.5 };

ipcMain.on('remote-state', (_e, s) => { remoteState = s; });

// Vagues compactes + bibliothèque poussées par le renderer pour la console
const remoteWaves = [null, null, null, null];
let remoteLibData = { stamp: 0, items: [] };
ipcMain.on('remote-wave', (_e, i, payload) => {
  if (i >= 0 && i < 4) remoteWaves[i] = payload;
});
ipcMain.on('remote-lib', (_e, d) => { remoteLibData = d; });

// --- 📨 DEMANDES DU PUBLIC (notre CoBeat, gratuit et 100 % local) :
// les invités votent des morceaux / envoient des messages depuis /guest ---
const guestVotes = new Map(); // nom du morceau -> { name, bpm, votes }
let guestMsgs = [];
function guestSnapshot() {
  return {
    votes: [...guestVotes.values()].sort((a, b) => b.votes - a.votes).slice(0, 60),
    msgs: guestMsgs.slice(-25)
  };
}
ipcMain.handle('guest-get', () => guestSnapshot());

// QR CODE de la page invités : les potes scannent l'écran du DJ et tombent
// direct sur /guest — généré côté main (paquet qrcode), renvoyé en dataURL
ipcMain.handle('guest-qr', async (_e, url) => {
  try {
    const QRCode = require('qrcode');
    return await QRCode.toDataURL(url, {
      margin: 1,
      width: 220,
      color: { dark: '#0a0b0e', light: '#eef0f5' }
    });
  } catch {
    return null;
  }
});
ipcMain.handle('guest-clear', () => {
  guestVotes.clear();
  guestMsgs = [];
  return guestSnapshot();
});

function lanIp() {
  const nets = require('os').networkInterfaces();
  for (const k of Object.keys(nets)) {
    for (const n of nets[k]) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return 'localhost';
}

function startRemoteServer() {
  if (remoteServer) return;
  const http = require('http');
  remoteServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/cmd') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try { win.webContents.send('remote-cmd', JSON.parse(body)); } catch { /* ignoré */ }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(remoteState));
      return;
    }
    if (req.url === '/shot') {
      // Capture de la fenêtre OpenMix (documentation/README) — UNIQUEMENT
      // depuis ce PC : jamais exposé au réseau
      const ip = req.socket.remoteAddress || '';
      if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        res.writeHead(403);
        res.end();
        return;
      }
      win.webContents.capturePage().then((img) => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(img.toPNG());
      }).catch(() => {
        res.writeHead(500);
        res.end();
      });
      return;
    }
    if (req.url.startsWith('/wave')) {
      const m = /d=(\d)/.exec(req.url);
      const w = m ? remoteWaves[Number(m[1])] : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(w || { stamp: 0 }));
      return;
    }
    if (req.url === '/lib') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(remoteLibData));
      return;
    }
    // --- pages et API des INVITÉS (votes de morceaux, messages) ---
    if (req.url === '/guest' || req.url.startsWith('/guest?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      try {
        res.end(require('fs').readFileSync(
          require('path').join(__dirname, 'src', 'guest.html'), 'utf8'));
      } catch (err) {
        res.end(`<h1>guest.html introuvable</h1><pre>${err}</pre>`);
      }
      return;
    }
    if (req.url === '/requests') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(guestSnapshot()));
      return;
    }
    if (req.method === 'POST' && req.url === '/vote') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const v = JSON.parse(body);
          if (v.msg && String(v.msg).trim()) {
            guestMsgs.push({ msg: String(v.msg).trim().slice(0, 140), at: Date.now() });
          } else if (v.name) {
            const key = String(v.name).slice(0, 200);
            const cur = guestVotes.get(key) || { name: key, bpm: v.bpm || null, votes: 0 };
            cur.votes++;
            guestVotes.set(key, cur);
          }
          try { win.webContents.send('guest-req', guestSnapshot()); } catch { /* fenêtre fermée */ }
        } catch { /* corps invalide : ignoré */ }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    // La console téléphone vit dans src/remote.html (relue à chaque
    // requête : rechargement téléphone = dernière version, sans rebuild)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    try {
      res.end(require('fs').readFileSync(
        require('path').join(__dirname, 'src', 'remote.html'), 'utf8'));
    } catch (err) {
      res.end(`<h1>remote.html introuvable</h1><pre>${err}</pre>`);
    }
  });
  remoteServer.on('error', () => { /* port pris : on garde l'app vivante */ });
  remoteServer.listen(REMOTE_PORT);
}

// La console téléphone est TOUJOURS prête : serveur lancé dès le démarrage
app.whenReady().then(() => startRemoteServer());

ipcMain.handle('remote-start', async () => {
  startRemoteServer();
  return { url: `http://${lanIp()}:${REMOTE_PORT}` };
});

// --- Stems : séparation voix/batterie/basse/instru via Demucs (IA locale) ---
ipcMain.handle('stems-separate', async (_e, trackPath) => {
  const { spawn } = require('child_process');
  const crypto = require('crypto');
  const fs = require('fs');
  try {
    const hash = crypto.createHash('md5').update(trackPath).digest('hex').slice(0, 12);
    const outRoot = path.join(app.getPath('userData'), 'stems');
    const finalDir = path.join(outRoot, hash);
    const names = ['vocals', 'drums', 'bass', 'other'];
    const stems = {};
    let allCached = true;
    for (const n of names) {
      stems[n] = path.join(finalDir, `${n}.wav`);
      if (!fs.existsSync(stems[n])) allCached = false;
    }
    if (allCached) return { ok: true, stems };

    await fsp.mkdir(finalDir, { recursive: true });
    const tmpOut = path.join(outRoot, `tmp-${hash}`);
    const result = await new Promise((resolve) => {
      const p = spawn('python', ['-m', 'demucs', '-n', 'htdemucs', '-o', tmpOut, trackPath], { windowsHide: true });
      // PRIORITÉ BASSE : Demucs ne doit JAMAIS voler le CPU de l'audio en
      // cours — sinon le son grésille et la manette répond avec des secondes
      // de retard pendant la séparation
      try { require('os').setPriority(p.pid, 19); } catch { /* déjà mort */ }
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', () => resolve({ code: -1, err: 'python introuvable' }));
      p.on('close', (code) => resolve({ code, err }));
    });
    if (result.code !== 0) {
      return {
        ok: false,
        error: 'Demucs indisponible — installe-le avec « pip install demucs » puis réessaie'
      };
    }
    const src = path.join(tmpOut, 'htdemucs', path.parse(trackPath).name);
    for (const n of names) {
      await fsp.copyFile(path.join(src, `${n}.wav`), stems[n]);
    }
    await fsp.rm(tmpOut, { recursive: true, force: true });
    return { ok: true, stems };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// --- Explorateur de fichiers (arborescence style Rekordbox) ---
ipcMain.handle('fs-roots', async () => {
  const fs = require('fs');
  const roots = [];
  const add = (name, p) => {
    try { if (p && fs.existsSync(p)) roots.push({ name, path: p }); } catch { /* rien */ }
  };
  add('🎵 Musique', app.getPath('music'));
  add('⬇️ Téléchargements', app.getPath('downloads'));
  add('🖥️ Bureau', app.getPath('desktop'));
  add('📄 Documents', app.getPath('documents'));
  for (const l of ['C', 'D', 'E', 'F', 'G']) add(`💽 ${l}:`, `${l}:\\`);
  return roots;
});

ipcMain.handle('fs-list', async (_e, dir) => {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
      .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
      .slice(0, 500);
  } catch {
    return [];
  }
});

// --- Export d'une playlist sur clé USB (format universel) ---
// Fichiers copiés + playlist M3U8 (lisible par les CDJ en navigation dossier
// et par quasiment tout le matériel) + turbomix.json (grilles, cues).
ipcMain.handle('export-playlist', async (_e, plName, items) => {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choisis la clé USB (ou le dossier) de destination',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const root = r.filePaths[0];
    const clean = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 120) || 'sans-nom';
    const dir = path.join(root, 'TurboMix', clean(plName));
    await fsp.mkdir(dir, { recursive: true });

    const m3u = ['#EXTM3U'];
    const meta = { format: 'turbomix-usb', version: 1, playlist: plName, tracks: [] };
    let n = 0;
    let skipped = 0;
    for (const it of items) {
      if (!it.path) { skipped++; continue; }
      const ext = path.extname(it.path) || '.mp3';
      const fname = `${String(n + 1).padStart(2, '0')} - ${clean(it.name)}${ext}`;
      try {
        await fsp.copyFile(it.path, path.join(dir, fname));
      } catch {
        skipped++;
        continue;
      }
      m3u.push(`#EXTINF:${Math.round(it.duration || 0)},${it.name}`);
      m3u.push(fname);
      meta.tracks.push({
        file: fname,
        name: it.name,
        bpm: it.bpm || null,
        beats: it.beats || null,
        hotCues: it.hotCues || null
      });
      n++;
    }
    await fsp.writeFile(path.join(dir, `${clean(plName)}.m3u8`), m3u.join('\n'), 'utf8');
    await fsp.writeFile(path.join(dir, 'turbomix.json'), JSON.stringify(meta), 'utf8');
    return { ok: true, count: n, skipped, dir };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Sauvegarde d'un enregistrement de mix (boîte de dialogue "Enregistrer sous")
ipcMain.handle('save-recording', async (_e, data, defaultName) => {
  try {
    const r = await dialog.showSaveDialog(win, {
      title: 'Enregistrer le mix',
      defaultPath: path.join(app.getPath('music'), defaultName),
      filters: [{ name: 'Audio WebM (Opus)', extensions: ['webm'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    await fsp.writeFile(r.filePath, Buffer.from(data));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------------------------------------------------------------------
// SoundCloud (même approche que soundcloud_playlist_tool.py : api-v2 + client_id)
// ---------------------------------------------------------------------------

const SC_API = 'https://api-v2.soundcloud.com';
let scClientId = null;

// `acct` est l'OBJET compte de settings.scAccounts (pas un jeton nu) : c'est
// ce qui permet d'invalider LE BON compte sur un 401 sans toucher aux autres
function scAuthHeaders(acct) {
  return acct && acct.token ? { 'Authorization': `OAuth ${acct.token}` } : {};
}

async function scGetJson(url, acct = null) {
  const r = await fetch(url, { headers: { 'Accept': 'application/json', ...scAuthHeaders(acct) } });
  if (r.status === 401 && acct && acct.token) {
    // Invalidation CIBLÉE : seul CE compte est marqué expiré (l'entrée reste
    // dans la liste pour proposer la reconnexion) — en b2b, le jeton mort du
    // pote ne doit surtout pas déconnecter tout le monde. Message
    // volontairement SANS « HTTP 401 » : scTry ne doit pas re-tenter avec un
    // client_id frais (comportement historique voulu).
    acct.token = null;
    await saveSettings();
    throw new Error(`Session SoundCloud de ${acct.name || 'ton compte'} expirée — reconnecte ce compte`);
  }
  if (!r.ok) throw new Error(`SoundCloud HTTP ${r.status}`);
  return r.json();
}

// Récupère un client_id : variable d'environnement, réglages sauvegardés,
// sinon découverte automatique dans les scripts du site web de SoundCloud.
async function scEnsureClientId(force = false) {
  if (!force) {
    if (scClientId) return scClientId;
    if (process.env.SOUNDCLOUD_CLIENT_ID) {
      scClientId = process.env.SOUNDCLOUD_CLIENT_ID;
      return scClientId;
    }
    if (settings.scClientId) {
      scClientId = settings.scClientId;
      return scClientId;
    }
  }
  const html = await (await fetch('https://soundcloud.com')).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+sndcdn\.com[^"]+\.js)"/g)].map(m => m[1]);
  for (const u of scripts.reverse()) {
    try {
      const js = await (await fetch(u)).text();
      const m = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{20,})"/);
      if (m) {
        scClientId = m[1];
        settings.scClientId = scClientId;
        await saveSettings();
        return scClientId;
      }
    } catch { /* script suivant */ }
  }
  throw new Error('client_id SoundCloud introuvable');
}

// Retente une fois avec un client_id frais si SoundCloud renvoie 401/403
async function scTry(fn) {
  try {
    return await fn();
  } catch (e) {
    if (/HTTP (401|403)/.test(String(e))) {
      await scEnsureClientId(true);
      return fn();
    }
    throw e;
  }
}

// Adopte le jeton de la session navigateur HISTORIQUE (connexion d'avant le
// multi-compte, cookie dans la session par défaut). ONE-SHOT : le flag
// scCookieMigrated garantit qu'on ne relit JAMAIS ce cookie ensuite — sinon
// supprimer le compte historique le ressusciterait au sc-status suivant.
async function scAdoptCookieToken() {
  const accounts = scAccounts(); // déclenche au passage la migration scToken
  if (settings.scCookieMigrated) return;
  settings.scCookieMigrated = true; // même en cas d'échec : une seule tentative
  try {
    const cookies = await session.defaultSession.cookies.get({ name: 'oauth_token' });
    const c = cookies.find(k => k.domain.includes('soundcloud.com') && k.value);
    // fromCookie : à la suppression de ce compte on saura qu'il faut AUSSI
    // retirer le cookie de la session par défaut
    if (c) accounts.push({ name: null, token: c.value, fromCookie: true });
  } catch { /* pas de cookie */ }
  await saveSettings();
}

// Fenêtre de connexion officielle SoundCloud ; on récupère le jeton de session
// (cookie oauth_token) une fois l'utilisateur connecté.
function scLoginWindow() {
  return new Promise((resolve) => {
    const lw = new BrowserWindow({
      width: 540,
      height: 760,
      parent: win,
      title: 'Connexion SoundCloud',
      autoHideMenuBar: true,
      // Partition ÉPHÉMÈRE (pas de préfixe « persist: » = session en RAM,
      // jetée à la fermeture) : chaque connexion part d'une page VIERGE.
      // Sans elle, le 2e compte tombait sur la session déjà connectée du 1er
      // (impossible d'ajouter le compte du pote sans déconnecter le sien).
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: `sc-login-${Date.now()}`
      }
    });
    lw.loadURL('https://soundcloud.com/signin');
    let done = false;
    const timer = setInterval(async () => {
      try {
        const cookies = await lw.webContents.session.cookies.get({ name: 'oauth_token' });
        const c = cookies.find(k => k.domain.includes('soundcloud.com') && k.value);
        if (c && !done) {
          done = true;
          clearInterval(timer);
          resolve(c.value);
          lw.close();
        }
      } catch { /* on réessaie */ }
    }, 700);
    lw.on('closed', () => {
      clearInterval(timer);
      if (!done) resolve(null);
    });
  });
}

// Connexion d'un compte : le MÊME handler sert au 1er login, à l'ajout du
// compte du pote (b2b) et à la reconnexion d'un compte expiré. Plus de
// court-circuit « déjà connecté » : chaque appel ouvre une fenêtre vierge.
ipcMain.handle('sc-login', async () => {
  try {
    const accounts = scAccounts();
    const token = await scLoginWindow();
    if (!token) return { ok: false, error: 'Connexion annulée' };
    let cid = '';
    try { cid = await scEnsureClientId(); } catch { /* le jeton peut suffire */ }
    const q = cid ? `?client_id=${cid}` : '';
    // /me avec CE jeton : identifie le compte (nom affiché + anti-doublon).
    // Objet compte jetable : un 401 ici ne doit invalider personne d'autre.
    const me = await scGetJson(`${SC_API}/me${q}`, { name: null, token });
    const name = me.username || null;
    // Un compte migré (name encore null) doit être identifié AVANT
    // l'anti-doublon, sinon se reconnecter à son propre compte le dupliquerait
    for (const a of accounts) {
      if (!a.name && a.token) {
        try {
          const m = await scGetJson(`${SC_API}/me${q}`, a);
          a.name = m.username || null;
        } catch { /* jeton mort : déjà invalidé par scGetJson */ }
      }
    }
    // Reconnexion IN-PLACE : même compte déjà connu → on RÉUTILISE son index,
    // les acctIdx tagués sur les lignes déjà affichées restent valables
    const existing = accounts.findIndex(a => name && a.name === name);
    if (existing >= 0) {
      if (accounts[existing].token) {
        await saveSettings(); // les noms fraîchement appris méritent d'être gardés
        return { ok: false, error: `Compte ${name} déjà connecté` };
      }
      accounts[existing].token = token;
      await saveSettings();
      return { ok: true, name, index: existing };
    }
    accounts.push({ name, token });
    await saveSettings();
    return { ok: true, name, index: accounts.length - 1 };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Retire un compte de la liste (clic droit sur sa ligne 👤 dans l'interface)
ipcMain.handle('sc-remove-account', async (_e, idx) => {
  try {
    const accounts = scAccounts();
    const acct = accounts[idx];
    if (!acct) return { ok: false, error: 'Compte inconnu' };
    accounts.splice(idx, 1);
    // Compte hérité de la session navigateur historique : on retire AUSSI le
    // cookie de la session par défaut, sinon le jeton traînerait sur le disque
    if (acct.fromCookie) {
      try {
        await session.defaultSession.cookies.remove('https://soundcloud.com', 'oauth_token');
      } catch { /* déjà absent */ }
    }
    await saveSettings();
    return { ok: true, accounts: accounts.map(a => ({ name: a.name, expired: !a.token })) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('sc-status', async () => {
  await scAdoptCookieToken();
  const accounts = scAccounts();
  return {
    connected: accounts.some(a => a.token),
    accounts: accounts.map(a => ({ name: a.name, expired: !a.token }))
  };
});

// Playlists DU COMPTE DEMANDÉ (accountIdx) : celles de l'utilisateur +
// celles de sa bibliothèque. Sans index → compte 0, comme avant le multi.
ipcMain.handle('sc-my-playlists', async (_e, accountIdx) => {
  try {
    await scAdoptCookieToken();
    const idx = accountIdx ?? 0;
    const acct = scAccounts()[idx];
    if (!acct || !acct.token) return { ok: false, needLogin: true, error: 'Pas connecté à SoundCloud' };
    return await scTry(async () => {
      let cid = '';
      try { cid = await scEnsureClientId(); } catch { /* le jeton peut suffire */ }
      const q = cid ? `client_id=${cid}&` : '';
      const me = await scGetJson(`${SC_API}/me?${q}`.replace(/[?&]$/, ''), acct);
      // Compte migré de l'ancien réglage mono-compte : on apprend son nom ici
      if (!acct.name && me.username) {
        acct.name = me.username;
        await saveSettings();
      }
      const seen = new Set();
      const items = [];
      const push = (p) => {
        if (p && p.permalink_url && !seen.has(p.permalink_url)) {
          seen.add(p.permalink_url);
          items.push({
            scPlaylist: true,
            permalink: p.permalink_url,
            name: `📂 ${p.title}`,
            trackCount: p.track_count
          });
        }
      };
      try {
        const lib = await scGetJson(`${SC_API}/me/library/all?${q}limit=100`, acct);
        for (const it of (lib.collection || [])) push(it.playlist);
      } catch { /* endpoint parfois indisponible */ }
      try {
        const own = await scGetJson(`${SC_API}/users/${me.id}/playlists?${q}limit=100`, acct);
        for (const p of (own.collection || [])) push(p);
      } catch { /* idem */ }
      // Les LIKES en tête, comme une playlist — « une playlist like » (David)
      items.unshift({ scLikes: true, name: '❤️ Likes', trackCount: null });
      return { ok: true, username: me.username, accountIdx: idx, playlists: items };
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Tous les sons LIKÉS du compte demandé (paginé) — sans index : compte 0
ipcMain.handle('sc-my-likes', async (_e, accountIdx) => {
  try {
    await scAdoptCookieToken();
    const idx = accountIdx ?? 0;
    const acct = scAccounts()[idx];
    if (!acct || !acct.token) return { ok: false, needLogin: true, error: 'Pas connecté à SoundCloud' };
    return await scTry(async () => {
      let cid = '';
      try { cid = await scEnsureClientId(); } catch { /* le jeton peut suffire */ }
      const q = cid ? `client_id=${cid}&` : '';
      const me = await scGetJson(`${SC_API}/me?${q}`.replace(/[?&]$/, ''), acct);
      if (!acct.name && me.username) {
        acct.name = me.username;
        await saveSettings();
      }
      const raw = [];
      let url = `${SC_API}/users/${me.id}/track_likes?${q}limit=100&linked_partitioning=1`;
      for (let page = 0; page < 10 && url; page++) {
        const r = await scGetJson(url, acct);
        for (const it of (r.collection || [])) {
          const t = it.track || it;
          if (t && t.id) raw.push(t);
        }
        url = r.next_href
          ? r.next_href + (cid && !r.next_href.includes('client_id') ? `&client_id=${cid}` : '')
          : null;
      }
      const tracks = await scHydrateTracks(raw, cid, acct);
      return { ok: true, username: me.username, accountIdx: idx, tracks: tracks.map(scSimplifyTrack) };
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

function scSimplifyTrack(t) {
  return {
    scId: t.id,
    name: `${(t.user && t.user.username) || '?'} - ${t.title || t.id}`,
    duration: t.duration ? t.duration / 1000 : null,
    streamable: t.streamable !== false && t.policy !== 'BLOCK',
    // Jaquette SoundCloud (t500 = grande taille) — pochette sur le deck
    artwork: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : null
  };
}

// Complète les pistes « stub » (les playlists ne renvoient en entier que les
// premières). Le compte est propagé : sans lui, les pistes privées/Go+ d'une
// playlist resteraient des stubs invisibles.
async function scHydrateTracks(tracks, cid, acct = null) {
  const stubs = tracks.filter(t => !t.title).map(t => t.id);
  const byId = new Map();
  for (let i = 0; i < stubs.length; i += 30) {
    const ids = stubs.slice(i, i + 30).join(',');
    try {
      const full = await scGetJson(`${SC_API}/tracks?ids=${ids}&client_id=${cid}`, acct);
      for (const t of full) byId.set(t.id, t);
    } catch { /* pistes indisponibles : ignorées */ }
  }
  return tracks
    .map(t => (t.title ? t : byId.get(t.id)))
    .filter(Boolean);
}

// Résout une URL SoundCloud : playlist -> pistes ; profil -> liste de playlists.
// accountIdx = compte dont le jeton accompagne les requêtes (playlists
// privées / Go+) ; à défaut, premier compte valide, sinon anonyme.
ipcMain.handle('sc-resolve', async (_e, url, accountIdx) => {
  try {
    if (!/^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//.test(url.trim())) {
      return { ok: false, error: 'Ce n’est pas un lien soundcloud.com' };
    }
    const acct = scAcctOrDefault(accountIdx);
    return await scTry(async () => {
    const cid = await scEnsureClientId();
    const obj = await scGetJson(`${SC_API}/resolve?url=${encodeURIComponent(url.trim())}&client_id=${cid}`, acct);

    if (obj.kind === 'playlist') {
      const tracks = await scHydrateTracks(obj.tracks || [], cid, acct);
      return { ok: true, kind: 'playlist', title: obj.title, tracks: tracks.map(scSimplifyTrack) };
    }
    if (obj.kind === 'user') {
      const pl = await scGetJson(`${SC_API}/users/${obj.id}/playlists?client_id=${cid}&limit=50`, acct);
      const items = (pl.collection || []).map(p => ({
        scPlaylist: true,
        permalink: p.permalink_url,
        name: `📂 ${p.title}`,
        trackCount: p.track_count
      }));
      return { ok: true, kind: 'user', title: obj.username, playlists: items };
    }
    if (obj.kind === 'track') {
      return { ok: true, kind: 'playlist', title: obj.title, tracks: [scSimplifyTrack(obj)] };
    }
    return { ok: false, error: `Type de lien non géré : ${obj.kind}` };
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Recherche dans TOUT le catalogue SoundCloud (pas seulement les playlists)
ipcMain.handle('sc-search', async (_e, query, accountIdx) => {
  try {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'Recherche vide' };
    const acct = scAcctOrDefault(accountIdx);
    return await scTry(async () => {
      const cid = await scEnsureClientId();
      const res = await scGetJson(
        `${SC_API}/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=50`, acct);
      const tracks = (res.collection || [])
        .filter(t => t && t.id)
        .map(scSimplifyTrack)
        .filter(t => t.streamable);
      return { ok: true, tracks };
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Téléchargement du flux audio d'une piste SoundCloud vers un fichier.
// Le compte (acct) ouvre l'accès aux pistes privées/Go+ ; les fetch bruts du
// flux plus bas restent sans auth : ce sont des URLs déjà signées.
async function scDownloadToFile(scId, dest, acct = null) {
    const cid = await scEnsureClientId();
    const arr = await scGetJson(`${SC_API}/tracks?ids=${scId}&client_id=${cid}`, acct);
    const track = arr && arr[0];
    if (!track) throw new Error('Piste introuvable');

    const codings = (track.media && track.media.transcodings) || [];
    const prog = codings.find(c => c.format && c.format.protocol === 'progressive');
    const hls = codings.find(c => c.format && c.format.protocol === 'hls' && /mpeg|mp3/.test(c.format.mime_type || ''));
    const chosen = prog || hls;
    if (!chosen) throw new Error('Aucun flux lisible pour cette piste');

    const sep = chosen.url.includes('?') ? '&' : '?';
    const { url: streamUrl } = await scGetJson(`${chosen.url}${sep}client_id=${cid}`, acct);

    let buf;
    if (chosen === prog) {
      const r = await fetch(streamUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
    } else {
      const m3u8 = await (await fetch(streamUrl)).text();
      const segs = m3u8.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      const parts = [];
      for (const seg of segs) {
        const r = await fetch(seg);
        if (!r.ok) throw new Error(`Segment HTTP ${r.status}`);
        parts.push(Buffer.from(await r.arrayBuffer()));
      }
      buf = Buffer.concat(parts);
    }

    await fsp.writeFile(dest, buf);
    return dest;
}

// Télécharge la piste dans le cache local (pour la lecture) — le reste du
// pipeline (décodage, BPM) est identique aux fichiers locaux.
// accountIdx : le compte d'où vient la piste (ses Go+/privées à lui).
ipcMain.handle('sc-fetch-track', async (_e, scId, accountIdx) => {
  try {
    const dir = path.join(app.getPath('userData'), 'sc-cache');
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${scId}.mp3`);
    try {
      const st = await fsp.stat(dest);
      if (st.size > 0) return { ok: true, path: dest };
    } catch { /* pas en cache */ }
    await scTry(() => scDownloadToFile(scId, dest, scAcctOrDefault(accountIdx)));
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Télécharge une piste EN DUR dans Musique\TurboMix (pour les playlists) —
// accountIdx : compte propriétaire de la piste (jeton pour les privées/Go+)
ipcMain.handle('sc-download-to', async (_e, scId, baseName, accountIdx) => {
  try {
    const dir = path.join(app.getPath('music'), 'TurboMix');
    await fsp.mkdir(dir, { recursive: true });
    const clean = String(baseName || scId).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 120) || String(scId);
    const dest = path.join(dir, `${clean}.mp3`);
    try {
      const st = await fsp.stat(dest);
      if (st.size > 0) return { ok: true, path: dest };
    } catch { /* pas encore téléchargé */ }
    // Déjà dans le cache de lecture ? On copie au lieu de retélécharger
    const cached = path.join(app.getPath('userData'), 'sc-cache', `${scId}.mp3`);
    try {
      const st = await fsp.stat(cached);
      if (st.size > 0) {
        await fsp.copyFile(cached, dest);
        return { ok: true, path: dest };
      }
    } catch { /* pas en cache */ }
    await scTry(() => scDownloadToFile(scId, dest, scAcctOrDefault(accountIdx)));
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
