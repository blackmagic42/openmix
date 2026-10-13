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
    title: 'Choose your music folder',
    properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

// Import Rekordbox : choisir l'export XML de la collection
ipcMain.handle('pick-xml', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the Rekordbox XML export',
    properties: ['openFile'],
    filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }]
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// SAMPLER : choisir un ou plusieurs fichiers audio à poser sur les pads
ipcMain.handle('pick-samples', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose samples',
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

// --- 📨 DEMANDES DU PUBLIC (100 % local, sans compte ni service tiers) :
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
    // RECHERCHE SOUNDCLOUD POUR LES INVITÉS : ils cherchent dans TOUT le
    // catalogue depuis leur téléphone, pas seulement dans ta bibliothèque
    if (req.url.startsWith('/scsearch')) {
      const q = decodeURIComponent((/[?&]q=([^&]*)/.exec(req.url) || [, ''])[1] || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      scSearchTracks(q).then((r) => {
        // On ne propose PAS aux invités les morceaux protégés (DRM) : ils ne
        // pourraient pas être chargés, autant ne pas les faire voter dessus
        const tracks = (r.ok ? r.tracks : []).filter((t) => !t.drm).slice(0, 40).map((t) => ({
          name: t.name,
          url: t.permalink,
          art: t.artwork || null,
          dur: t.duration || 0
        }));
        res.end(JSON.stringify({ ok: !!r.ok, error: r.error || null, tracks }));
      }).catch((err) => {
        res.end(JSON.stringify({ ok: false, error: String(err.message || err), tracks: [] }));
      });
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
            // Demande venue de la RECHERCHE SOUNDCLOUD : on garde le lien et
            // la pochette — le DJ charge le morceau en un clic même s'il
            // n'est pas dans sa bibliothèque
            if (v.url) cur.url = String(v.url).slice(0, 400);
            if (v.art) cur.art = String(v.art).slice(0, 400);
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
// LE BON PYTHON. « python » tout court prend le PREMIER du PATH : il a
// suffi qu'un autre logiciel (un venv « hermes-agent ») se glisse en tête
// pour que les stems disparaissent — son Python n'a pas Demucs. On cherche
// donc UN Python qui sait importer demucs (lanceur py, installations
// classiques, conda…), puis on retient son chemin.
let demucsPy = null;      // chemin du python validé
let demucsCuda = false;    // torch voit une carte graphique NVIDIA
let demucsPySearch = null; // recherche en cours (partagée)

function pyTest(exe, args = []) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try {
      p = spawn(exe, [...args, '-c',
        'import demucs, sys, torch; print(int(torch.cuda.is_available())); print(sys.executable)'],
        { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch { finish(null); return; }
    // import torch peut prendre plusieurs secondes à froid
    const t = setTimeout(() => { try { p.kill(); } catch { /* rien */ } finish(null); }, 90000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(t); finish(null); });
    p.on('close', (code) => {
      clearTimeout(t);
      const lines = out.trim().split(/\r?\n/);
      const exePath = lines.pop();
      if (code === 0 && exePath) demucsCuda = lines.pop() === '1';
      finish(code === 0 && exePath ? exePath : null);
    });
  });
}

function pyCandidates() {
  const fs = require('fs');
  const list = [];
  const add = (exe, args = []) => {
    if (!list.some((c) => c.exe === exe && c.args.join() === args.join())) list.push({ exe, args });
  };
  const local = process.env.LOCALAPPDATA || '';
  const home = process.env.USERPROFILE || '';
  const dirs = [
    path.join(local, 'Programs', 'Python'),
    path.join(local, 'Python'),
    'C:\\Program Files',
    'C:\\'
  ];
  for (const dir of dirs) {
    try {
      for (const n of fs.readdirSync(dir)) {
        if (/^python(core-)?3/i.test(n)) {
          const exe = path.join(dir, n, 'python.exe');
          if (fs.existsSync(exe)) add(exe);
        }
      }
    } catch { /* dossier absent */ }
  }
  for (const c of ['anaconda3', 'miniconda3', 'Anaconda3', 'Miniconda3']) {
    const exe = path.join(home, c, 'python.exe');
    if (fs.existsSync(exe)) add(exe);
  }
  // Versions récentes d'abord (Demucs est en général installé sur la plus
  // récente que torch supporte), puis le lanceur py et le python du PATH
  list.sort((a, b) => b.exe.localeCompare(a.exe, undefined, { numeric: true }));
  for (const v of ['3.13', '3.12', '3.11', '3.10']) add('py', [`-${v}`]);
  add('python');
  add('python3');
  return list;
}

function findDemucsPython() {
  if (demucsPy) return Promise.resolve(demucsPy);
  if (demucsPySearch) return demucsPySearch;
  demucsPySearch = (async () => {
    const fs = require('fs');
    // chemin retenu lors d'une séance précédente : on le revérifie
    const saved = settings.demucsPython;
    if (saved && fs.existsSync(saved) && await pyTest(saved)) {
      demucsPy = saved;
      return demucsPy;
    }
    for (const c of pyCandidates()) {
      const exe = await pyTest(c.exe, c.args);
      if (exe) {
        demucsPy = exe;
        settings.demucsPython = exe;
        saveSettings();
        console.log(`[midi] stems : Demucs trouvé → ${exe}`);
        return demucsPy;
      }
    }
    return null;
  })();
  demucsPySearch.finally(() => { demucsPySearch = null; });
  return demucsPySearch;
}

// Recherche lancée dès le démarrage, en tâche de fond : le premier clic sur
// VOX/DRM/INST n'attend pas l'import de torch
app.whenReady().then(() => setTimeout(() => { findDemucsPython(); }, 4000));

// État du moteur de stems pour l'interface : avec une carte graphique, la
// séparation est assez légère pour tourner PENDANT le mix
ipcMain.handle('stems-info', async () => {
  const py = await findDemucsPython();
  return { ok: !!py, cuda: !!(py && demucsCuda) };
});

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

    const py = await findDemucsPython();
    if (!py) {
      return {
        ok: false,
        error: 'Demucs not found — install it with “py -m pip install demucs” then try again'
      };
    }
    await fsp.mkdir(finalDir, { recursive: true });
    const tmpOut = path.join(outRoot, `tmp-${hash}`);
    await fsp.rm(tmpOut, { recursive: true, force: true });
    const result = await new Promise((resolve) => {
      // UTF-8 forcé : un titre avec « — » ou « ä » faisait planter
      // l'affichage console de Demucs sous Windows (encodage cp1252)
      const p = spawn(py, ['-m', 'demucs', '-n', 'htdemucs', '-o', tmpOut, trackPath], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
      // PRIORITÉ BASSE : Demucs ne doit JAMAIS voler le CPU de l'audio en
      // cours — sinon le son grésille et la manette répond avec des secondes
      // de retard pendant la séparation
      try { require('os').setPriority(p.pid, 19); } catch { /* déjà mort */ }
      let err = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      p.on('error', () => resolve({ code: -1, err: 'python introuvable' }));
      p.on('close', (code) => resolve({ code, err }));
    });
    if (result.code !== 0) {
      const last = String(result.err || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      console.log(`[midi] stems : échec Demucs (${result.code}) ${last}`);
      await fsp.rm(tmpOut, { recursive: true, force: true }).catch(() => {});
      // le python retenu ne marche plus (désinstallé ?) : on recherchera
      if (result.code === -1) { demucsPy = null; delete settings.demucsPython; }
      return { ok: false, error: `Demucs failed${last ? ` — ${last.slice(0, 140)}` : ''}` };
    }
    // Dossier de sortie : Demucs le nomme d'après le fichier — on prend
    // celui qu'il a réellement créé (pas de devinette sur les points/accents)
    const modelDir = path.join(tmpOut, 'htdemucs');
    const sub = (await fsp.readdir(modelDir).catch(() => []))[0];
    const src = sub ? path.join(modelDir, sub) : path.join(modelDir, path.parse(trackPath).name);
    for (const n of names) {
      await fsp.copyFile(path.join(src, `${n}.wav`), stems[n]);
    }
    await fsp.rm(tmpOut, { recursive: true, force: true });
    return { ok: true, stems };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------------------------------------------------------------------
// yt-dlp : téléchargement depuis YouTube, SoundCloud et tout site que yt-dlp
// connaît. OpenMix garde SA PROPRE copie (version officielle, installée une
// fois depuis GitHub avec l'accord de l'utilisateur) : dépendre d'un yt-dlp
// « trouvé » dans le PATH, c'est se faire casser par le premier logiciel qui
// en glisse un autre devant (vécu avec Python et les stems).
// Rien n'est réencodé : on garde le meilleur flux audio d'origine (m4a si
// possible, lisible partout, platines comprises).
// ---------------------------------------------------------------------------
const YTDLP_ASSET = process.platform === 'win32' ? 'yt-dlp.exe'
  : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`;
const ytdlpManaged = () => path.join(app.getPath('userData'), 'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
// DOSSIER DE MUSIQUE NATIF d'OpenMix : reçoit les téléchargements, toujours
// en tête de l'explorateur. Par défaut Musique\OpenMix, déplaçable (⚙).
const ytdlpOutDir = () => settings.dlRoot || path.join(app.getPath('music'), 'OpenMix');
app.whenReady().then(() => fsp.mkdir(ytdlpOutDir(), { recursive: true }).catch(() => {}));

// Un chemin est-il DANS le dossier natif ? (on n'écrit jamais ailleurs)
function insideDlRoot(p) {
  const rel = path.relative(ytdlpOutDir(), String(p || ''));
  return !!p && !rel.startsWith('..') && !path.isAbsolute(rel);
}
const cleanSeg = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 80);

// Sous-dossiers du dossier natif (3 niveaux), pour choisir où ranger
ipcMain.handle('dl-info', async () => {
  const rootDir = ytdlpOutDir();
  await fsp.mkdir(rootDir, { recursive: true }).catch(() => {});
  const folders = [];
  const walkDirs = async (dir, rel, depth) => {
    if (depth > 3 || folders.length > 300) return;
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    for (const e of dirs) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      folders.push({ rel: r, path: path.join(dir, e.name) });
      await walkDirs(path.join(dir, e.name), r, depth + 1);
    }
  };
  await walkDirs(rootDir, '', 1);
  return { root: rootDir, folders };
});

// Nouveau dossier (« House » ou « House/Deep ») dans le dossier natif
// (parent = dossier où le créer — l'explorateur crée DANS le dossier ouvert)
ipcMain.handle('dl-mkdir', async (_e, rel, parent) => {
  const segs = String(rel || '').split(/[\\/]+/).map(cleanSeg).filter(Boolean);
  if (!segs.length) return { ok: false, error: 'empty name' };
  const base = parent && (insideDlRoot(parent) || isDlRoot(parent)) ? parent : ytdlpOutDir();
  const dir = path.join(base, ...segs);
  if (!insideDlRoot(dir)) return { ok: false, error: 'outside' };
  await fsp.mkdir(dir, { recursive: true });
  return { ok: true, path: dir, rel: path.relative(ytdlpOutDir(), dir).split(path.sep).join('/') };
});

// --- RANGEMENT dans le dossier natif (glisser-déposer de l'explorateur) ---
// Tout reste DANS le dossier natif : on n'écrit, ne déplace et ne jette
// jamais rien ailleurs.
const isDlRoot = (p) => !!p && path.resolve(p) === path.resolve(ytdlpOutDir());
// Nom libre dans destDir : « Nom (2) », « Nom (3) »…
async function freeName(destDir, base, ext = '') {
  let target = path.join(destDir, base + ext);
  for (let k = 2; k < 200; k++) {
    try { await fsp.access(target); } catch { return target; }
    target = path.join(destDir, `${base} (${k})${ext}`);
  }
  return target;
}
// Sons d'un dossier (récursif) : leur clé d'analyse suit le déplacement
async function audioUnder(dir, max = 5000) {
  const out = [];
  const walk = async (d) => {
    if (out.length >= max) return;
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
        try {
          const st = await fsp.stat(p);
          out.push({ path: p, size: st.size, mtime: st.mtimeMs });
        } catch { /* fichier disparu */ }
      }
    }
  };
  await walk(dir);
  return out;
}
const remapMoves = (files, from, to) => files.map((f) => ({
  from: f.path, to: path.join(to, path.relative(from, f.path)), size: f.size, mtime: f.mtime
}));

// Déplacer un DOSSIER dans un autre (les deux dans le dossier natif)
ipcMain.handle('dl-move-dir', async (_e, src, destDir) => {
  try {
    if (!insideDlRoot(src) || isDlRoot(src)) return { ok: false, error: 'outside' };
    if (!insideDlRoot(destDir) && !isDlRoot(destDir)) return { ok: false, error: 'outside' };
    const rel = path.relative(src, destDir);
    if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { ok: false, error: 'into itself' };
    if (path.resolve(path.dirname(src)) === path.resolve(destDir)) return { ok: false, error: 'same folder' };
    const files = await audioUnder(src);
    const target = await freeName(destDir, path.basename(src));
    await fsp.rename(src, target);
    return { ok: true, path: target, name: path.basename(target), moves: remapMoves(files, src, target) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Renommer un son ou un dossier du dossier natif
ipcMain.handle('dl-rename', async (_e, p, newName) => {
  try {
    if (!insideDlRoot(p) || isDlRoot(p)) return { ok: false, error: 'outside' };
    const st = await fsp.stat(p);
    let name = cleanSeg(newName);
    if (!name) return { ok: false, error: 'empty name' };
    const ext = path.extname(p);
    // un son garde son extension, même si on ne l'a pas retapée
    if (!st.isDirectory() && path.extname(name).toLowerCase() !== ext.toLowerCase()) name += ext;
    const target = path.join(path.dirname(p), name);
    if (path.resolve(target) === path.resolve(p)) return { ok: false, error: 'same name' };
    try {
      await fsp.access(target);
      // (Windows : changer seulement la casse vise le « même » fichier)
      if (target.toLowerCase() !== p.toLowerCase()) return { ok: false, error: 'exists' };
    } catch { /* libre */ }
    const files = st.isDirectory() ? await audioUnder(p) : [{ path: p, size: st.size, mtime: st.mtimeMs }];
    await fsp.rename(p, target);
    const moves = st.isDirectory()
      ? remapMoves(files, p, target)
      : [{ from: p, to: target, size: st.size, mtime: st.mtimeMs }];
    return { ok: true, path: target, name: path.parse(target).name, dir: st.isDirectory(), moves };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// À la CORBEILLE (récupérable) — seulement dans le dossier natif
ipcMain.handle('dl-trash', async (_e, p) => {
  try {
    if (!insideDlRoot(p) || isDlRoot(p)) return { ok: false, error: 'outside' };
    await require('electron').shell.trashItem(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Choisir un autre emplacement pour le dossier natif
ipcMain.handle('dl-choose-root', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'OpenMix music folder (downloads)',
    defaultPath: ytdlpOutDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  settings.dlRoot = r.filePaths[0];
  await saveSettings();
  return { ok: true, root: settings.dlRoot };
});

// RANGER un son dans un dossier du dossier natif : TOUJOURS DÉPLACÉ, d'où
// qu'il vienne — jamais de copie, jamais de doublon (demande David : « on ne
// fait pas de copier-coller »). Même son déjà présent à l'arrivée (même nom,
// même taille) : l'original part à la CORBEILLE au lieu de créer « (2) ».
ipcMain.handle('dl-place', async (_e, file, destDir) => {
  let target = null;
  let copied = false;
  try {
    if (!insideDlRoot(destDir) && !isDlRoot(destDir)) return { ok: false, error: 'outside' };
    await fsp.mkdir(destDir, { recursive: true });
    if (path.resolve(path.dirname(file)) === path.resolve(destDir)) return { ok: false, error: 'same folder' };
    const st0 = await fsp.stat(file);
    if (!st0.isFile()) return { ok: false, error: 'not a file' };
    target = path.join(destDir, path.basename(file));
    const same = await fsp.stat(target).catch(() => null);
    if (same && same.isFile() && same.size === st0.size) {
      await require('electron').shell.trashItem(file);
      return { ok: true, moved: true, dedup: true, path: target, name: path.parse(target).name, size: same.size, mtime: same.mtimeMs };
    }
    if (same) target = await freeName(destDir, path.parse(file).name, path.parse(file).ext);
    try {
      await fsp.rename(file, target);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      // autre disque : copie (même date → la clé d'analyse reste valable)
      // puis suppression de l'original ; si elle échoue, on retire la copie
      copied = true;
      await fsp.copyFile(file, target);
      await fsp.utimes(target, st0.atime, st0.mtime).catch(() => {});
      await fsp.unlink(file);
    }
    const st = await fsp.stat(target);
    return { ok: true, moved: true, path: target, name: path.parse(target).name, size: st.size, mtime: st.mtimeMs };
  } catch (err) {
    if (copied && target) await fsp.unlink(target).catch(() => {});
    const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM');
    return { ok: false, error: busy ? 'file in use' : String(err.message || err) };
  }
});
let ytdlpCmd = null;          // { exe, args, source, version }
const ytdlpJobs = new Map();  // id → processus en cours

function ytdlpVersion(exe, args = []) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try {
      p = spawn(exe, [...args, '--version'], { windowsHide: true });
    } catch { finish(null); return; }
    const t = setTimeout(() => { try { p.kill(); } catch { /* rien */ } finish(null); }, 30000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(t); finish(null); });
    p.on('close', (code) => {
      clearTimeout(t);
      const v = out.trim().split(/\r?\n/).pop();
      finish(code === 0 && v ? v : null);
    });
  });
}

async function findYtDlp(force = false) {
  if (ytdlpCmd && !force) return ytdlpCmd;
  const fs = require('fs');
  const cands = [];
  if (fs.existsSync(ytdlpManaged())) cands.push({ exe: ytdlpManaged(), args: [], source: 'openmix' });
  if (settings.ytdlpPath && fs.existsSync(settings.ytdlpPath)) cands.push({ exe: settings.ytdlpPath, args: [], source: 'perso' });
  cands.push({ exe: 'yt-dlp', args: [], source: 'système' });
  for (const c of cands) {
    const v = await ytdlpVersion(c.exe, c.args);
    if (v) {
      ytdlpCmd = { ...c, version: v };
      return ytdlpCmd;
    }
  }
  ytdlpCmd = null;
  return null;
}

ipcMain.handle('ytdlp-status', async () => {
  const c = await findYtDlp();
  return c ? { ok: true, version: c.version, source: c.source, dir: ytdlpOutDir() } : { ok: false, dir: ytdlpOutDir() };
});

// Installe (ou met à jour) la copie d'OpenMix : la DERNIÈRE version
// officielle, publiée par le projet yt-dlp sur GitHub
ipcMain.handle('ytdlp-install', async () => {
  try {
    const dest = ytdlpManaged();
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const r = await fetch(YTDLP_URL);
    if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1000000) throw new Error('download too small');
    const tmp = `${dest}.part`;
    await fsp.writeFile(tmp, buf);
    if (process.platform !== 'win32') await fsp.chmod(tmp, 0o755);
    await fsp.rm(dest, { force: true });
    await fsp.rename(tmp, dest);
    const c = await findYtDlp(true);
    if (!c) throw new Error('yt-dlp does not start');
    console.log(`[midi] yt-dlp ${c.version} installé (${dest})`);
    return { ok: true, version: c.version, source: c.source };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Nom de fichier « Artiste - Titre » (la bibliothèque coupe sur le 1er tiret)
const ytClean = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);

ipcMain.handle('ytdlp-download', async (e, url, id, destDir) => {
  const { spawn } = require('child_process');
  const c = await findYtDlp();
  if (!c) return { ok: false, error: 'yt-dlp not installed' };
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'bad url' };
  // dossier choisi par l'utilisateur, à condition qu'il soit DANS le dossier natif
  const outDir = destDir && insideDlRoot(destDir) ? destDir : ytdlpOutDir();
  await fsp.mkdir(outDir, { recursive: true });
  const send = (msg) => { try { e.sender.send('ytdlp-progress', { id, ...msg }); } catch { /* fenêtre fermée */ } };
  // YouTube exige désormais un moteur JavaScript : on prête à yt-dlp le
  // Node.js EMBARQUÉ dans Electron (ELECTRON_RUN_AS_NODE) — rien à installer
  const args = [
    ...c.args,
    '--js-runtimes', `node:${process.execPath}`,
    '--no-playlist',            // une vidéo avec &list= : seulement la vidéo
    '--newline', '--progress', '--no-colors', '--encoding', 'utf-8',
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--windows-filenames', '--trim-filenames', '200', // (yt-dlp compte le CHEMIN entier)
    '-o', path.join(outDir, '%(title)s.%(ext)s'),
    '--print', 'after_move:OMFILE\t%(filepath)s\t%(uploader)s\t%(title)s',
    String(url)
  ];
  const files = [];
  let lastErr = '';
  const code = await new Promise((resolve) => {
    let p;
    try {
      p = spawn(c.exe, args, {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', ELECTRON_RUN_AS_NODE: '1' }
      });
    } catch (err) {
      lastErr = String(err.message || err);
      resolve(-1);
      return;
    }
    ytdlpJobs.set(id, p);
    try { require('os').setPriority(p.pid, 10); } catch { /* rien */ }
    let item = 1;
    let of = 1;
    let title = '';
    const onLine = (line) => {
      const l = line.trim();
      if (!l) return;
      let m;
      if (l.startsWith('OMFILE\t')) {
        const [, fp, up, ti] = l.split('\t');
        files.push({ fp, up, ti });
      } else if ((m = l.match(/^\[download\] Downloading item (\d+) of (\d+)/))) {
        item = +m[1];
        of = +m[2];
        send({ item, of, pct: 0, title });
      } else if ((m = l.match(/^\[download\] Destination: (.+)$/))) {
        title = path.parse(m[1]).name;
        send({ item, of, pct: 0, title });
      } else if ((m = l.match(/^\[download\]\s+([\d.]+)%/))) {
        send({ item, of, pct: +m[1], title });
      } else if ((m = l.match(/^\[download\] (.+) has already been downloaded/))) {
        files.push({ fp: m[1].trim(), up: '', ti: path.parse(m[1].trim()).name });
      } else if (/^ERROR:/.test(l)) {
        lastErr = l.replace(/^ERROR:\s*/, '');
      }
    };
    let bufOut = '';
    let bufErr = '';
    p.stdout.on('data', (d) => {
      bufOut += d;
      const parts = bufOut.split(/\r?\n/);
      bufOut = parts.pop();
      parts.forEach(onLine);
    });
    p.stderr.on('data', (d) => {
      bufErr += d;
      const parts = bufErr.split(/\r?\n/);
      bufErr = parts.pop();
      parts.forEach(onLine);
    });
    p.on('error', (err) => { lastErr = String(err.message || err); resolve(-1); });
    p.on('close', (cd) => {
      if (bufOut) onLine(bufOut);
      if (bufErr) onLine(bufErr);
      resolve(cd);
    });
  });
  const cancelled = ytdlpJobs.get(id) && ytdlpJobs.get(id)._omCancelled;
  ytdlpJobs.delete(id);
  if (cancelled) return { ok: false, cancelled: true, error: 'cancelled' };
  // Renommage « Artiste - Titre » quand le titre ne porte pas l'artiste
  const out = [];
  for (const f of files) {
    let fp = f.fp;
    try {
      const ext = path.extname(fp);
      const base = path.parse(fp).name;
      if (f.up && !/ - /.test(base) && !/ - /.test(f.ti || '')) {
        const target = path.join(path.dirname(fp), `${ytClean(f.up)} - ${ytClean(base)}${ext}`);
        try {
          await fsp.access(target);
        } catch {
          await fsp.rename(fp, target);
          fp = target;
        }
      }
      const st = await fsp.stat(fp);
      out.push({ path: fp, name: path.parse(fp).name, size: st.size, mtime: st.mtimeMs });
    } catch { /* fichier introuvable : ignoré */ }
  }
  if (!out.length) {
    return { ok: false, error: lastErr || (code === 0 ? 'nothing downloaded' : `yt-dlp exit ${code}`) };
  }
  return { ok: true, files: out, dir: outDir, partial: code !== 0 ? lastErr : null };
});

// RECHERCHE YouTube (yt-dlp « ytsearch ») : titres, chaîne, durée,
// miniature — sans rien télécharger
ipcMain.handle('ytdlp-search', async (_e, query, n = 20) => {
  const { spawn } = require('child_process');
  const c = await findYtDlp();
  if (!c) return { ok: false, error: 'yt-dlp not installed' };
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { ok: true, items: [] };
  const count = Math.max(1, Math.min(40, n | 0));
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let p;
    try {
      p = spawn(c.exe, [...c.args, '--flat-playlist', '-J', '--no-warnings', '--encoding', 'utf-8',
        `ytsearch${count}:${q}`], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (ex) {
      resolve({ ok: false, error: String(ex.message || ex) });
      return;
    }
    const t = setTimeout(() => { try { p.kill(); } catch { /* rien */ } }, 40000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (ex) => { clearTimeout(t); resolve({ ok: false, error: String(ex.message || ex) }); });
    p.on('close', () => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out);
        const items = (j.entries || []).filter((e) => e && e.id).map((e) => ({
          src: 'yt',
          id: e.id,
          url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
          title: e.title || e.id,
          // « Artiste - Topic » = la chaîne officielle de l'artiste
          artist: String(e.channel || e.uploader || '').replace(/ - Topic$/, ''),
          duration: e.duration || null,
          views: e.view_count || null,
          thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`
        }));
        resolve({ ok: true, items });
      } catch {
        resolve({ ok: false, error: (err.trim().split(/\r?\n/).pop() || 'search failed').replace(/^ERROR:\s*/, '') });
      }
    });
  });
});

ipcMain.handle('ytdlp-cancel', async (_e, id) => {
  const p = ytdlpJobs.get(id);
  if (!p) return false;
  p._omCancelled = true;
  try {
    if (process.platform === 'win32') {
      // yt-dlp.exe relance un sous-processus : on arrête tout l'arbre
      require('child_process').spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
    } else {
      p.kill();
    }
  } catch { /* déjà fini */ }
  return true;
});

// Relance pour une mise à jour SANS perdre les decks chargés : un fichier
// « restore-once » posé dans le dossier de données fait restaurer la séance
// au prochain démarrage, UNE fois (le fichier est consommé)
ipcMain.handle('take-restore-once', async () => {
  const f = path.join(app.getPath('userData'), 'restore-once');
  try {
    await fsp.access(f);
    await fsp.rm(f, { force: true });
    return true;
  } catch {
    return false;
  }
});

// --- Explorateur de fichiers (arborescence classique) ---
ipcMain.handle('fs-roots', async () => {
  const fs = require('fs');
  const roots = [];
  const add = (name, p) => {
    try { if (p && fs.existsSync(p)) roots.push({ name, path: p }); } catch { /* rien */ }
  };
  // dossier NATIF d'OpenMix : toujours en tête (l'interface lui donne son nom)
  try {
    await fsp.mkdir(ytdlpOutDir(), { recursive: true });
    roots.push({ name: '📁 OpenMix', path: ytdlpOutDir(), native: true });
  } catch { /* emplacement inaccessible */ }
  add('📁 Musique', app.getPath('music'));
  add('📁 Téléchargements', app.getPath('downloads'));
  add('📁 Bureau', app.getPath('desktop'));
  add('📁 Documents', app.getPath('documents'));
  for (const l of ['C', 'D', 'E', 'F', 'G']) add(`Disque ${l}:`, `${l}:\\`);
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
      title: 'Choose the destination USB drive (or folder)',
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
// SoundCloud : API publique v2 du site + client_id extrait comme le fait le lecteur web
// ---------------------------------------------------------------------------

const SC_API = 'https://api-v2.soundcloud.com';
let scClientId = null;

// `acct` est l'OBJET compte de settings.scAccounts (pas un jeton nu) : c'est
// ce qui permet d'invalider LE BON compte sur un 401 sans toucher aux autres
function scAuthHeaders(acct) {
  return acct && acct.token ? { 'Authorization': `OAuth ${acct.token}` } : {};
}

// Sonde d'identité : le SEUL verdict qui autorise à effacer un jeton.
// /me répond 200 avec un OAuth valide MÊME SANS client_id — un client_id
// périmé ne peut donc plus faire passer une session vivante pour morte.
// Mémoïsée 30 s : une playlist qui échoue en boucle ne doit pas déclencher
// une sonde par piste.
let scProbe = { at: 0, key: null, dead: false, pending: null };
async function scTokenReallyDead(acct) {
  const key = acct.token;
  if (scProbe.key === key && !scProbe.pending && Date.now() - scProbe.at < 30000) return scProbe.dead;
  if (scProbe.pending && scProbe.key === key) return scProbe.pending;
  scProbe = { at: 0, key, dead: false, pending: null };
  scProbe.pending = (async () => {
    let dead = false;
    try {
      const r = await fetch(`${SC_API}/me`, {
        headers: { 'Accept': 'application/json', 'Authorization': `OAuth ${key}` }
      });
      dead = r.status === 401; // 403 / 404 / 429 / 5xx : on ne conclut RIEN
    } catch {
      dead = false;            // réseau coupé : surtout ne pas déconnecter
    }
    scProbe = { at: Date.now(), key, dead, pending: null };
    return dead;
  })();
  return scProbe.pending;
}

async function scGetJson(url, acct = null, opts = {}) {
  const get = () => fetch(url, { headers: { 'Accept': 'application/json', ...scAuthHeaders(acct) } });
  let r = await get();
  // 429 = trop de requêtes (SoundCloud limite le débit) : on patiente et on
  // retente au lieu d'afficher une erreur de chargement à l'utilisateur
  for (let i = 0; i < 2 && r.status === 429; i++) {
    await new Promise((ok) => setTimeout(ok, 1200 * (i + 1)));
    r = await get();
  }
  // opts.keepToken : un 401 venu de l'URL D'UN FLUX ne prouve RIEN sur la
  // session (il manque le plus souvent track_authorization) — invalider le
  // jeton là-dessus déconnectait un compte payant parfaitement valide, et
  // faisait échouer tous les morceaux suivants en cascade.
  if (r.status === 401 && acct && acct.token && !opts.keepToken) {
    // Un 401 ne PROUVE PAS que la session est morte : ce peut être le
    // client_id public périmé, une piste sans droits, une URL mal formée.
    // On ne déconnecte QUE si la sonde /me le confirme — sinon on éjectait
    // des comptes payants valides, DE FAÇON PERSISTANTE (le null repart
    // dans les réglages), et tout le reste de la soirée échouait.
    if (await scTokenReallyDead(acct)) {
      // Invalidation CIBLÉE : seul CE compte est marqué expiré (l'entrée
      // reste dans la liste pour proposer la reconnexion) — en b2b, le
      // jeton mort du pote ne doit pas déconnecter tout le monde.
      acct.token = null;
      await saveSettings();
      throw new Error(`SoundCloud session for ${acct.name || 'your account'} expired — reconnect this account`);
    }
    // Session vivante : c'est très probablement le client_id. On laisse
    // « SoundCloud HTTP 401 » remonter pour que scTry en réextraie un frais.
    throw new Error('SoundCloud HTTP 401');
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
    // ANCRÉ sur « SoundCloud HTTP » : seuls les appels d'API justifient de
    // réextraire le client_id. Un « Segment HTTP 403 » (URL de CDN signée
    // qui expire) relançait tout le téléchargement du morceau — alors qu'un
    // client_id neuf ne resigne évidemment pas une URL de CDN.
    if (/SoundCloud HTTP (401|403)/.test(String(e))) {
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
    if (!token) return { ok: false, error: 'Login canceled' };
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
        return { ok: false, error: `Account ${name} already connected` };
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
    if (!acct) return { ok: false, error: 'Unknown account' };
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
    if (!acct || !acct.token) return { ok: false, needLogin: true, error: 'Not connected to SoundCloud' };
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
            name: p.title,
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
      items.unshift({ scLikes: true, name: '❤ Likes', trackCount: null });
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
    if (!acct || !acct.token) return { ok: false, needLogin: true, error: 'Not connected to SoundCloud' };
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

// Un flux « encrypted-hls » est protégé par DRM (FairPlay/Widevine) : sa clé
// n'est délivrée qu'au lecteur du site. On ne peut ni le lire ni l'analyser —
// il faut le DIRE, pas afficher « erreur de chargement ».
const scIsDrm = (c) => /encrypted/i.test((c.format && c.format.protocol) || '');

function scSimplifyTrack(t) {
  const codings = (t.media && t.media.transcodings) || [];
  const drm = codings.length > 0 && codings.every(scIsDrm);
  return {
    drm,
    scId: t.id,
    name: `${(t.user && t.user.username) || '?'} - ${t.title || t.id}`,
    duration: t.duration ? t.duration / 1000 : null,
    // LIEN DU MORCEAU — sans lui, les demandes du public venues de la
    // recherche SoundCloud arrivaient sans adresse et étaient TOUTES refusées
    permalink: t.permalink_url || null,
    // Droits : on les affiche au lieu de faire disparaître la ligne
    policy: t.policy || null,             // ALLOW / MONETIZE / SNIP / BLOCK
    snipped: t.snipped === true || codings.some((c) => c.snipped === true),
    blocked: t.policy === 'BLOCK',
    streamable: t.streamable !== false && t.policy !== 'BLOCK',
    // Jaquette SoundCloud (t500 = grande taille) — pochette sur le deck
    artwork: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : null,
    // Forme d'onde publiée par SoundCloud : l'aperçu dans la liste SANS
    // télécharger le son
    waveform: t.waveform_url || null
  };
}

// Forme d'onde SoundCloud (wave.sndcdn.com) : la version .json donne
// ~1800 hauteurs 0-140. Réduite à 600 points pour l'aperçu de la liste.
ipcMain.handle('sc-waveform', async (_e, url) => {
  try {
    if (!/^https:\/\/([a-z0-9-]+\.)*sndcdn\.com\//i.test(String(url || ''))) return { ok: false };
    const r = await fetch(String(url).replace(/\.png(\?.*)?$/i, '.json'));
    if (!r.ok) return { ok: false };
    const j = await r.json();
    const src = Array.isArray(j.samples) ? j.samples : [];
    if (!src.length) return { ok: false };
    const n = Math.min(600, src.length);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor((i / n) * src.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / n) * src.length));
      let m = 0;
      for (let k = a; k < b; k++) if (src[k] > m) m = src[k];
      out[i] = m;
    }
    return { ok: true, samples: out };
  } catch {
    return { ok: false };
  }
});

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
        name: p.title,
        trackCount: p.track_count
      }));
      return { ok: true, kind: 'user', title: obj.username, playlists: items };
    }
    if (obj.kind === 'track') {
      return { ok: true, kind: 'playlist', title: obj.title, tracks: [scSimplifyTrack(obj)] };
    }
    return { ok: false, error: `Unsupported link type: ${obj.kind}` };
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Recherche dans TOUT le catalogue SoundCloud (pas seulement les playlists).
// Fonction partagée : utilisée par le logiciel (IPC) ET par la page des
// invités (/scsearch) — ils cherchent depuis leur téléphone.
async function scSearchTracks(query, accountIdx) {
  try {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'Recherche vide' };
    const acct = scAcctOrDefault(accountIdx);
    return await scTry(async () => {
      const cid = await scEnsureClientId();
      const res = await scGetJson(
        `${SC_API}/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=50`, acct);
      const tracks = (res.collection || [])
        .filter(t => t && t.id && (t.kind === 'track' || !t.kind))
        .map(scSimplifyTrack)
        // « streamable » est un champ HÉRITÉ de l'ancienne API : il vaut
        // false sur des pistes qui se lisent très bien une fois authentifié
        // — il supprimait EN SILENCE des résultats. On ne masque plus que
        // le vrai retrait (BLOCK), qu'aucun abonnement ne débloque.
        .filter(t => !t.blocked);
      return { ok: true, tracks };
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
ipcMain.handle('sc-search', (_e, query, accountIdx) => scSearchTracks(query, accountIdx));

// Ouvre un lien dans le NAVIGATEUR du système (page invités cliquable)
ipcMain.handle('open-external', (_e, url) => {
  try {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return false;
    require('electron').shell.openExternal(u);
    return true;
  } catch {
    return false;
  }
});

// Téléchargement du flux audio d'une piste SoundCloud vers un fichier.
// Le compte (acct) ouvre l'accès aux pistes privées/Go+ ; les fetch bruts du
// flux plus bas restent sans auth : ce sont des URLs déjà signées.
// Téléchargements SoundCloud EN COURS (scId → AbortController) : charger un
// autre son sur le deck ANNULE le premier (un set de 3 h lancé par erreur)
const scAborts = new Map();
ipcMain.handle('sc-cancel', async (_e, scId) => {
  const ac = scAborts.get(String(scId));
  if (ac) ac.abort();
  return !!ac;
});

async function scDownloadToFile(scId, dest, acct = null, signal = null) {
    const cid = await scEnsureClientId();
    const arr = await scGetJson(`${SC_API}/tracks?ids=${scId}&client_id=${cid}`, acct);
    const track = arr && arr[0];
    if (!track) throw new Error('Track not found');

    const allCodings = (track.media && track.media.transcodings) || [];
    if (!allCodings.length) {
      throw new Error(track.policy === 'BLOCK'
        ? 'Track blocked in your country'
        : 'This track has no available stream (removed, private, or deleted)');
    }
    // On ÉCARTE les flux protégés par DRM : leur clé est réservée au lecteur
    // du site (FairPlay/Widevine). Les télécharger ne donnerait que des
    // octets chiffrés — un faux « succès » avec un fichier illisible.
    const codings = allCodings.filter((c) => !scIsDrm(c));
    if (!codings.length) {
      // Flux chiffré : la clé n'est délivrée qu'au lecteur du site. Rien à
      // « réparer » côté code, et rien à contourner — on le dit, c'est tout.
      throw new Error('Protected track (DRM): playback outside the service’s site isn’t allowed. Use a file you own, or another track.');
    }

    // ORDRE DE PRÉFÉRENCE des flux — on ne rejette plus RIEN d'emblée :
    // beaucoup de pistes (dont les Go+) n'exposent que de l'AAC ou de
    // l'Opus, et l'ancien filtre « mpeg|mp3 » les déclarait illisibles.
    const score = (c) => {
      const p = (c.format && c.format.protocol) || '';
      const m = (c.format && c.format.mime_type) || '';
      if (p === 'progressive' && /mpeg/.test(m)) return 0; // mp3 direct : idéal
      if (p === 'progressive') return 1;
      if (p === 'hls' && /mpeg/.test(m)) return 2;
      if (p === 'hls' && /(mp4|aac)/.test(m)) return 3;    // AAC : Chromium sait lire
      return 4;                                            // opus & co : dernier recours
    };
    const ordered = [...codings].sort((a, b) => score(a) - score(b));
    // track_authorization : jeton PAR PISTE renvoyé avec le morceau — sans
    // lui l'API répond 401/403 sur la plupart des pistes. C'était LA cause
    // des « erreurs de chargement » à répétition, compte payant compris.
    const ta = track.track_authorization
      ? `&track_authorization=${encodeURIComponent(track.track_authorization)}`
      : '';

    const getBin = async (u, what) => {
      if (signal && signal.aborted) throw new Error('Chargement annulé');
      let r = await fetch(u, { signal });
      for (let i = 0; i < 2 && (r.status === 429 || r.status >= 500); i++) {
        await new Promise((ok) => setTimeout(ok, 900 * (i + 1)));
        r = await fetch(u, { signal });
      }
      if (!r.ok) throw new Error(`${what} HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    };

    // On ESSAIE CHAQUE FLUX dans l'ordre : un transcodage cassé ne condamne
    // plus le morceau tant qu'il en reste un autre
    let lastErr = null;
    for (const chosen of ordered) {
      try {
        const sep = chosen.url.includes('?') ? '&' : '?';
        const { url: streamUrl } = await scGetJson(
          `${chosen.url}${sep}client_id=${cid}${ta}`, acct, { keepToken: true });
        let buf;
        if ((chosen.format && chosen.format.protocol) === 'progressive') {
          buf = await getBin(streamUrl, 'Stream');
        } else {
          const m3u8 = await (await fetch(streamUrl, { signal })).text();
          const segs = m3u8.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
          if (!segs.length) throw new Error('Empty stream playlist');
          const parts = [];
          for (const seg of segs) parts.push(await getBin(seg, 'Segment'));
          buf = Buffer.concat(parts);
        }
        if (!buf || buf.length < 2048) throw new Error('Empty stream');
        await fsp.writeFile(dest, buf);
        // Piste « extrait » : SoundCloud ne sert que 30 s quand le compte
        // n'a pas les droits. On le SIGNALE et on le note dans le cache —
        // sinon l'extrait était rejoué éternellement, même après avoir
        // connecté le compte abonné.
        return {
          dest,
          bytes: buf.length,
          full: !track.snipped,
          warning: track.snipped
            ? '30s preview: connect the subscribed SoundCloud account for the full track'
            : null
        };
      } catch (e) {
        // annulé : on n'essaie surtout pas le flux suivant
        if (signal && signal.aborted) throw new Error('Chargement annulé');
        lastErr = e;
      }
    }
    throw new Error(track.snipped
      ? 'Track reserved for subscribers (Go+) — connect the subscribed account in ⚙'
      : `No playable stream: ${lastErr ? lastErr.message : 'unknown'}`);
}

// Télécharge la piste dans le cache local (pour la lecture) — le reste du
// pipeline (décodage, BPM) est identique aux fichiers locaux.
// accountIdx : le compte d'où vient la piste (ses Go+/privées à lui).
// Identité du compte qui a rempli le cache : si on connecte enfin le compte
// abonné, un extrait de 30 s en cache DOIT être retéléchargé au lieu d'être
// rejoué à vie.
function scAcctKey(acct) {
  return acct && acct.token ? `u:${acct.name || 'sans-nom'}` : 'anonyme';
}

// Chemin du son SoundCloud déjà en cache COMPLET (sinon null) — pour
// analyser sa tonalité en tâche de fond sans rien télécharger
ipcMain.handle('sc-cached-path', async (_e, scId) => {
  try {
    const dir = path.join(app.getPath('userData'), 'sc-cache');
    const dest = path.join(dir, `${String(scId).replace(/[^0-9]/g, '')}.mp3`);
    const st = await fsp.stat(dest);
    const m = JSON.parse(await fsp.readFile(path.join(dir, `${String(scId).replace(/[^0-9]/g, '')}.json`), 'utf8'));
    return st.size > 0 && m.full !== false ? dest : null;
  } catch {
    return null;
  }
});

ipcMain.handle('sc-fetch-track', async (_e, scId, accountIdx) => {
  try {
    const dir = path.join(app.getPath('userData'), 'sc-cache');
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${scId}.mp3`);
    const meta = path.join(dir, `${scId}.json`);
    const acct = scAcctOrDefault(accountIdx);
    const key = scAcctKey(acct);
    // Le cache n'est réutilisé que s'il est PROUVÉ complet, ou s'il vient du
    // MÊME compte. Un fichier sans fiche vient d'une version qui ne savait
    // pas repérer les extraits : on le retélécharge une fois — c'est la
    // purge automatique des extraits déjà sur le disque.
    try {
      const st = await fsp.stat(dest);
      const m = JSON.parse(await fsp.readFile(meta, 'utf8'));
      if (st.size > 0 && (m.full === true || m.acct === key)) {
        return { ok: true, path: dest, full: m.full !== false, warning: m.warning || null };
      }
    } catch { /* pas en cache, extrait, ou cache d'ancienne version */ }
    const ac = new AbortController();
    scAborts.set(String(scId), ac);
    let r;
    try {
      r = await scTry(() => scDownloadToFile(scId, dest, acct, ac.signal));
    } finally {
      if (scAborts.get(String(scId)) === ac) scAborts.delete(String(scId));
    }
    if (ac.signal.aborted) return { ok: false, cancelled: true, error: 'Loading cancelled' };
    try {
      await fsp.writeFile(meta, JSON.stringify({
        full: r.full, bytes: r.bytes, acct: key, at: Date.now(), warning: r.warning || null
      }));
    } catch { /* fiche non écrite : on retéléchargera, sans gravité */ }
    return { ok: true, path: dest, full: r.full, warning: r.warning || null };
  } catch (err) {
    const cancelled = /annulé|abort/i.test(String(err && (err.name + err.message)));
    return { ok: false, cancelled, error: cancelled ? 'Loading cancelled' : String(err.message || err) };
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
    // Déjà dans le cache de lecture ? On copie — MAIS seulement si c'est le
    // morceau ENTIER : on ne veut pas exporter un extrait de 30 s dans la
    // discothèque de l'utilisateur.
    const cdir = path.join(app.getPath('userData'), 'sc-cache');
    const cached = path.join(cdir, `${scId}.mp3`);
    try {
      const st = await fsp.stat(cached);
      const m = JSON.parse(await fsp.readFile(path.join(cdir, `${scId}.json`), 'utf8'));
      if (st.size > 0 && m.full === true) {
        await fsp.copyFile(cached, dest);
        return { ok: true, path: dest };
      }
    } catch { /* pas en cache, ou extrait : on télécharge proprement */ }
    const r = await scTry(() => scDownloadToFile(scId, dest, scAcctOrDefault(accountIdx)));
    return { ok: true, path: dest, full: r.full, warning: r.warning || null };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
