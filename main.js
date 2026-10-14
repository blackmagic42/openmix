const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const path = require('path');
const fsp = require('fs').promises;

const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.webm']);

let win = null;

// DATA stays in the historical "Turbo Mix" folder whatever the display
// name (the OpenMix rename must NEVER lose the library, the analyses,
// the cues or the SoundCloud session)
app.setPath('userData', path.join(app.getPath('appData'), 'Turbo Mix'));

// Allows Web MIDI **with SysEx** (required for the Pioneer keep-alive
// that unlocks the controllers' LEDs) — local app, no remote page
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
    // Title bar BUILT INTO the design (no more white Windows bar):
    // the window is frameless, the ⊟ ⊡ ✕ buttons float in a dark
    // overlay and the app's topbar serves as the drag area
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

  // Renderer console piped to stdout: essential for diagnosing UI JS
  // errors from the terminal (2 signatures depending on the Electron
  // version)
  win.webContents.on('console-message', (e, ...args) => {
    const msg = typeof args[1] === 'string' ? args[1]
      : (e && typeof e.message === 'string' ? e.message : String(args[0] ?? ''));
    const lvl = typeof args[0] === 'number' ? args[0] : (e && e.level) || 0;
    if (lvl >= 2 || /error|Erreur|TypeError|ReferenceError/i.test(msg) || msg.startsWith('[midi]')) {
      console.log(`[renderer] ${msg}`);
    }
  });

  // Locks the page zoom: it is what made the UI "grow" little by little
  // (Ctrl+wheel / pinch, remembered between sessions).
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
  Menu.setApplicationMenu(null); // also removes the default menu's zoom shortcuts
  await loadSettings();
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// --- Persistent main-side settings (SoundCloud token, client_id) ---
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
    // Backward-compat mirror: an older version of the app only knows
    // settings.scToken — account 0's token is mirrored there on every
    // save so that a rollback doesn't lose the session
    if (Array.isArray(settings.scAccounts)) {
      settings.scToken = (settings.scAccounts[0] && settings.scAccounts[0].token) || null;
    }
    await fsp.writeFile(settingsPath(), JSON.stringify(settings));
  } catch { /* non-blocking */ }
}

// Connected SoundCloud accounts (b2b: mine + my buddy's), each with ITS
// OWN token. Lazy migration from the old single-account scToken setting
// — the guard tests the PRESENCE of the array (even empty), never
// scToken: otherwise the backward-compat mirror above would rerun the
// migration in a loop and resurrect deleted accounts.
function scAccounts() {
  if (!Array.isArray(settings.scAccounts)) {
    settings.scAccounts = settings.scToken
      ? [{ name: null, token: settings.scToken, fromCookie: true }]
      : [];
    // The historical token came from the default session's cookie: the
    // migration counts as adoption, that cookie will never be read again
    if (settings.scToken) settings.scCookieMigrated = true;
    saveSettings();
  }
  return settings.scAccounts;
}

// Account to use for a request: the requested one if it still has a token,
// otherwise the first valid account, otherwise null (anonymous client_id request)
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

// Rekordbox import: pick the collection's XML export
ipcMain.handle('pick-xml', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the Rekordbox XML export',
    properties: ['openFile'],
    filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }]
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// SAMPLER: pick one or more audio files to put on the pads
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
  if (out.length > 4000) return; // cap: a drive root must not drown the app
  // At a drive ROOT we do NOT recurse (hours of scanning): folder
  // navigation lets the user go and find the music
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
        } catch { /* unreadable */ }
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
      } catch { /* unreadable file: skip it */ }
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
  if (!p || typeof p !== 'string') return null; // missing path: no crash
  return fsp.readFile(p);
});

// Track COVER ART: tags of the local file (ID3/FLAC/MP4 via
// music-metadata) or download of a remote artwork (SoundCloud).
// Returns { data: base64, format: mime } or null.
ipcMain.handle('read-cover', async (_e, src) => {
  try {
    if (/^https?:\/\//i.test(src)) {
      const r = await fetch(src);
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return { data: buf.toString('base64'), format: r.headers.get('content-type') || 'image/jpeg' };
    }
    const mm = await import('music-metadata'); // ESM package: dynamic import
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

// SYNCHRONOUS version for app shutdown: blocks until written to disk —
// quitting can no longer cut off a beatgrid save mid-flight
ipcMain.on('cache-save-sync', (e, obj) => {
  try {
    require('fs').writeFileSync(cachePath(), JSON.stringify(obj));
    e.returnValue = true;
  } catch {
    e.returnValue = false;
  }
});

// --- Rekordbox grids: reading ANLZ files (format documented by reverse
// engineering, crate-digger project). PPTH = track path,
// PQTZ = full grid: each beat with its position (ms), its local tempo
// (BPM×100) and its number within the bar (1-2-3-4). All big-endian.
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
          // < 8 beats = sample or jingle, useless for a grid
          if (r && r.path && r.bpm && r.beats.length >= 8) {
            out.push({
              name: r.path.split('/').pop().toLowerCase(),
              beats: r.beats,
              anchor: r.anchor,
              bpm: r.bpm,
              lastBeat: r.beats[r.beats.length - 1]
            });
          }
        } catch { /* missing or unreadable file: skip */ }
      }
    }
  }
  return out;
});

// --- Phone remote: small HTTP server on the local network ---
const REMOTE_PORT = 8722;
let remoteServer = null;
let remoteState = { decks: [], xf: 0.5 };

ipcMain.on('remote-state', (_e, s) => { remoteState = s; });

// Compact waveforms + library pushed by the renderer for the console
const remoteWaves = [null, null, null, null];
let remoteLibData = { stamp: 0, items: [] };
ipcMain.on('remote-wave', (_e, i, payload) => {
  if (i >= 0 && i < 4) remoteWaves[i] = payload;
});
ipcMain.on('remote-lib', (_e, d) => { remoteLibData = d; });

// --- 📨 CROWD REQUESTS (100% local, no account or third-party service):
// guests vote for tracks / send messages from /guest ---
const guestVotes = new Map(); // track name -> { name, bpm, votes }
let guestMsgs = [];
function guestSnapshot() {
  return {
    votes: [...guestVotes.values()].sort((a, b) => b.votes - a.votes).slice(0, 60),
    msgs: guestMsgs.slice(-25)
  };
}
ipcMain.handle('guest-get', () => guestSnapshot());

// QR CODE for the guest page: friends scan the DJ's screen and land
// straight on /guest — generated main-side (qrcode package), returned as a dataURL
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
        try { win.webContents.send('remote-cmd', JSON.parse(body)); } catch { /* ignored */ }
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
      // Screenshot of the OpenMix window (documentation/README) — ONLY
      // from this PC: never exposed to the network
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
    // SOUNDCLOUD SEARCH FOR GUESTS: they search the WHOLE catalog from
    // their phone, not just your library
    if (req.url.startsWith('/scsearch')) {
      const q = decodeURIComponent((/[?&]q=([^&]*)/.exec(req.url) || [, ''])[1] || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      scSearchTracks(q).then((r) => {
        // DRM-protected tracks are NOT offered to guests: they couldn't be
        // loaded, so there's no point letting them vote for them
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
    // --- GUEST pages and API (track votes, messages) ---
    if (req.url === '/guest' || req.url.startsWith('/guest?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      try {
        res.end(require('fs').readFileSync(
          require('path').join(__dirname, 'src', 'guest.html'), 'utf8'));
      } catch (err) {
        res.end(`<h1>guest.html not found</h1><pre>${err}</pre>`);
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
            // Request coming from the SOUNDCLOUD SEARCH: keep the link and
            // the cover art — the DJ loads the track in one click even if
            // it isn't in their library
            if (v.url) cur.url = String(v.url).slice(0, 400);
            if (v.art) cur.art = String(v.art).slice(0, 400);
            guestVotes.set(key, cur);
          }
          try { win.webContents.send('guest-req', guestSnapshot()); } catch { /* window closed */ }
        } catch { /* invalid body: ignored */ }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    // The phone console lives in src/remote.html (re-read on every
    // request: reloading the phone = latest version, no rebuild)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    try {
      res.end(require('fs').readFileSync(
        require('path').join(__dirname, 'src', 'remote.html'), 'utf8'));
    } catch (err) {
      res.end(`<h1>remote.html not found</h1><pre>${err}</pre>`);
    }
  });
  remoteServer.on('error', () => { /* port taken: keep the app alive */ });
  remoteServer.listen(REMOTE_PORT);
}

// The phone console is ALWAYS ready: server started at launch
app.whenReady().then(() => startRemoteServer());

ipcMain.handle('remote-start', async () => {
  startRemoteServer();
  return { url: `http://${lanIp()}:${REMOTE_PORT}` };
});

// --- Stems: vocals/drums/bass/instrumental separation via Demucs (local AI) ---
// THE RIGHT PYTHON. Plain "python" takes the FIRST one on the PATH: it
// only took another program (a "hermes-agent" venv) slipping in first
// for the stems to vanish — its Python has no Demucs. So we look for
// A Python that can import demucs (py launcher, standard installs,
// conda…), then remember its path.
let demucsPy = null;      // path of the validated python
let demucsCuda = false;    // torch sees an NVIDIA GPU
let demucsPySearch = null; // search in progress (shared)

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
    // import torch can take several seconds on a cold start
    const t = setTimeout(() => { try { p.kill(); } catch { /* nothing */ } finish(null); }, 90000);
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
    } catch { /* missing folder */ }
  }
  for (const c of ['anaconda3', 'miniconda3', 'Anaconda3', 'Miniconda3']) {
    const exe = path.join(home, c, 'python.exe');
    if (fs.existsSync(exe)) add(exe);
  }
  // Recent versions first (Demucs is usually installed on the newest one
  // torch supports), then the py launcher and the python on the PATH
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
    // path remembered from a previous session: re-check it
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
        console.log(`[midi] stems: Demucs found → ${exe}`);
        return demucsPy;
      }
    }
    return null;
  })();
  demucsPySearch.finally(() => { demucsPySearch = null; });
  return demucsPySearch;
}

// Search started at launch, in the background: the first click on
// VOX/DRM/INST doesn't wait for torch to import
app.whenReady().then(() => setTimeout(() => { findDemucsPython(); }, 4000));

// Stems engine status for the UI: with a GPU, separation is light
// enough to run DURING the mix
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
      // Forced UTF-8: a title with "—" or "ä" crashed Demucs's console
      // output on Windows (cp1252 encoding)
      const p = spawn(py, ['-m', 'demucs', '-n', 'htdemucs', '-o', tmpOut, trackPath], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
      // LOW PRIORITY: Demucs must NEVER steal CPU from the playing audio —
      // otherwise the sound crackles and the controller responds seconds
      // late during separation
      try { require('os').setPriority(p.pid, 19); } catch { /* already dead */ }
      let err = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      p.on('error', () => resolve({ code: -1, err: 'python not found' }));
      p.on('close', (code) => resolve({ code, err }));
    });
    if (result.code !== 0) {
      const last = String(result.err || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      console.log(`[midi] stems: Demucs failed (${result.code}) ${last}`);
      await fsp.rm(tmpOut, { recursive: true, force: true }).catch(() => {});
      // the remembered python no longer works (uninstalled?): search again
      if (result.code === -1) { demucsPy = null; delete settings.demucsPython; }
      return { ok: false, error: `Demucs failed${last ? ` — ${last.slice(0, 140)}` : ''}` };
    }
    // Output folder: Demucs names it after the file — take the one it
    // actually created (no guessing about dots/accents)
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
// yt-dlp: downloading from YouTube, SoundCloud and any site yt-dlp
// knows. OpenMix keeps ITS OWN copy (official release, installed once
// from GitHub with the user's consent): relying on a yt-dlp "found" on
// the PATH means getting broken by the first program that slips another
// one in front (happened with Python and the stems).
// Nothing is re-encoded: we keep the best original audio stream (m4a if
// possible, playable everywhere, decks included).
// ---------------------------------------------------------------------------
const YTDLP_ASSET = process.platform === 'win32' ? 'yt-dlp.exe'
  : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`;
const ytdlpManaged = () => path.join(app.getPath('userData'), 'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
// OpenMix's NATIVE MUSIC FOLDER: receives downloads, always at the top
// of the explorer. Music\OpenMix by default, movable (⚙).
const ytdlpOutDir = () => settings.dlRoot || path.join(app.getPath('music'), 'OpenMix');
app.whenReady().then(() => fsp.mkdir(ytdlpOutDir(), { recursive: true }).catch(() => {}));

// Is a path INSIDE the native folder? (we never write anywhere else)
function insideDlRoot(p) {
  const rel = path.relative(ytdlpOutDir(), String(p || ''));
  return !!p && !rel.startsWith('..') && !path.isAbsolute(rel);
}
const cleanSeg = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 80);

// Subfolders of the native folder (3 levels), to choose where to file
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

// New folder ("House" or "House/Deep") in the native folder
// (parent = folder to create it in — the explorer creates INSIDE the open folder)
ipcMain.handle('dl-mkdir', async (_e, rel, parent) => {
  const segs = String(rel || '').split(/[\\/]+/).map(cleanSeg).filter(Boolean);
  if (!segs.length) return { ok: false, error: 'empty name' };
  const base = parent && (insideDlRoot(parent) || isDlRoot(parent)) ? parent : ytdlpOutDir();
  const dir = path.join(base, ...segs);
  if (!insideDlRoot(dir)) return { ok: false, error: 'outside' };
  await fsp.mkdir(dir, { recursive: true });
  return { ok: true, path: dir, rel: path.relative(ytdlpOutDir(), dir).split(path.sep).join('/') };
});

// --- ORGANIZING inside the native folder (explorer drag and drop) ---
// Everything stays INSIDE the native folder: nothing is ever written,
// moved or trashed anywhere else.
const isDlRoot = (p) => !!p && path.resolve(p) === path.resolve(ytdlpOutDir());
// Free name in destDir: "Name (2)", "Name (3)"…
async function freeName(destDir, base, ext = '') {
  let target = path.join(destDir, base + ext);
  for (let k = 2; k < 200; k++) {
    try { await fsp.access(target); } catch { return target; }
    target = path.join(destDir, `${base} (${k})${ext}`);
  }
  return target;
}
// Audio files in a folder (recursive): their analysis key follows the move
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
        } catch { /* file vanished */ }
      }
    }
  };
  await walk(dir);
  return out;
}
const remapMoves = (files, from, to) => files.map((f) => ({
  from: f.path, to: path.join(to, path.relative(from, f.path)), size: f.size, mtime: f.mtime
}));

// Move a FOLDER into another (both inside the native folder)
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

// Rename an audio file or a folder in the native folder
ipcMain.handle('dl-rename', async (_e, p, newName) => {
  try {
    if (!insideDlRoot(p) || isDlRoot(p)) return { ok: false, error: 'outside' };
    const st = await fsp.stat(p);
    let name = cleanSeg(newName);
    if (!name) return { ok: false, error: 'empty name' };
    const ext = path.extname(p);
    // an audio file keeps its extension, even if it wasn't retyped
    if (!st.isDirectory() && path.extname(name).toLowerCase() !== ext.toLowerCase()) name += ext;
    const target = path.join(path.dirname(p), name);
    if (path.resolve(target) === path.resolve(p)) return { ok: false, error: 'same name' };
    try {
      await fsp.access(target);
      // (Windows: changing only the case targets the "same" file)
      if (target.toLowerCase() !== p.toLowerCase()) return { ok: false, error: 'exists' };
    } catch { /* free */ }
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

// To the RECYCLE BIN (recoverable) — only inside the native folder
ipcMain.handle('dl-trash', async (_e, p) => {
  try {
    if (!insideDlRoot(p) || isDlRoot(p)) return { ok: false, error: 'outside' };
    await require('electron').shell.trashItem(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Choose another location for the native folder
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

// FILE an audio file into a folder of the native folder: ALWAYS MOVED,
// wherever it comes from — never a copy, never a duplicate (David's request:
// "we don't do copy-paste"). Same file already at the destination (same name,
// same size): the original goes to the RECYCLE BIN instead of creating "(2)".
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
      // other drive: copy (same date → the analysis key stays valid)
      // then delete the original; if that fails, the copy is removed
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
const ytdlpJobs = new Map();  // id → running process

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
    const t = setTimeout(() => { try { p.kill(); } catch { /* nothing */ } finish(null); }, 30000);
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
  if (settings.ytdlpPath && fs.existsSync(settings.ytdlpPath)) cands.push({ exe: settings.ytdlpPath, args: [], source: 'custom' });
  cands.push({ exe: 'yt-dlp', args: [], source: 'system' });
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

// Installs (or updates) OpenMix's copy: the LATEST official release,
// published by the yt-dlp project on GitHub
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
    console.log(`[midi] yt-dlp ${c.version} installed (${dest})`);
    return { ok: true, version: c.version, source: c.source };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// "Artist - Title" file name (the library splits on the 1st dash)
const ytClean = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);

ipcMain.handle('ytdlp-download', async (e, url, id, destDir, opts = {}) => {
  const { spawn } = require('child_process');
  const c = await findYtDlp();
  if (!c) return { ok: false, error: 'yt-dlp not installed' };
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'bad url' };
  // folder chosen by the user, provided it is INSIDE the native folder
  const outDir = destDir && insideDlRoot(destDir) ? destDir : ytdlpOutDir();
  await fsp.mkdir(outDir, { recursive: true });
  const send = (msg) => { try { e.sender.send('ytdlp-progress', { id, ...msg }); } catch { /* window closed */ } };
  // YouTube now requires a JavaScript runtime: we lend yt-dlp the Node.js
  // BUNDLED with Electron (ELECTRON_RUN_AS_NODE) — nothing to install
  const args = [
    ...c.args,
    '--js-runtimes', `node:${process.execPath}`,
    ...(await ytCookieArgs(!!opts.browserCookies)), // signed-in YouTube account (age-restricted videos)
    '--no-playlist',            // a video with &list=: only the video
    '--newline', '--progress', '--no-colors', '--encoding', 'utf-8',
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--windows-filenames', '--trim-filenames', '200', // (yt-dlp counts the whole PATH)
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
    try { require('os').setPriority(p.pid, 10); } catch { /* nothing */ }
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
  // Rename to "Artist - Title" when the title doesn't include the artist
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
    } catch { /* file not found: ignored */ }
  }
  if (!out.length) {
    return { ok: false, error: lastErr || (code === 0 ? 'nothing downloaded' : `yt-dlp exit ${code}`) };
  }
  return { ok: true, files: out, dir: outDir, partial: code !== 0 ? lastErr : null };
});

// YouTube SEARCH (yt-dlp "ytsearch"): titles, channel, duration,
// thumbnail — without downloading anything
ipcMain.handle('ytdlp-search', async (_e, query, n = 20) => {
  const { spawn } = require('child_process');
  const c = await findYtDlp();
  if (!c) return { ok: false, error: 'yt-dlp not installed' };
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { ok: true, items: [] };
  const count = Math.max(1, Math.min(40, n | 0));
  const cookieArgs = await ytCookieArgs();
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let p;
    try {
      p = spawn(c.exe, [...c.args, ...cookieArgs, '--flat-playlist', '-J', '--no-warnings', '--encoding', 'utf-8',
        `ytsearch${count}:${q}`], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (ex) {
      resolve({ ok: false, error: String(ex.message || ex) });
      return;
    }
    const t = setTimeout(() => { try { p.kill(); } catch { /* nothing */ } }, 40000);
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
          // "Artist - Topic" = the artist's official channel
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

// --- YOUTUBE / GOOGLE ACCOUNT for yt-dlp ---
// Age-restricted videos ("Sign in to confirm your age") and YouTube's bot
// checks need a signed-in account. The user signs in to Google in an
// OpenMix window (persistent session of its own); its YouTube/Google
// cookies are then exported to a Netscape cookie file that yt-dlp reads
// with --cookies. The window is closed right after the login, so YouTube
// stops rotating the cookies and the exported ones stay valid (the method
// the yt-dlp wiki recommends).
const YT_PARTITION = 'persist:youtube-login';
const ytCookiesFile = () => path.join(app.getPath('userData'), 'yt-cookies.txt');
// Plain Chrome user agent: Google refuses sign-ins from browsers that
// announce themselves as Electron
const chromeUA = () => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

async function ytWriteCookies(ses) {
  const all = await ses.cookies.get({});
  const keep = all.filter((c) => /(^|\.)(youtube\.com|google\.[a-z.]+)$/i.test(String(c.domain || '').replace(/^\./, '')));
  const later = Math.floor(Date.now() / 1000) + 180 * 86400;
  const lines = ['# Netscape HTTP Cookie File', '# Exported by OpenMix for yt-dlp — do not share this file', ''];
  for (const c of keep) {
    const sub = !c.hostOnly;
    const dom = sub && !c.domain.startsWith('.') ? `.${c.domain}` : c.domain;
    // session cookies get an expiry: yt-dlp would skip them otherwise
    const exp = c.expirationDate ? Math.floor(c.expirationDate) : later;
    lines.push([dom, sub ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t'));
  }
  const signedIn = keep.some((c) => c.name === 'LOGIN_INFO' && /youtube\.com$/i.test(c.domain));
  // not signed in (window closed before the end): no cookie file at all
  if (!signedIn) {
    await fsp.rm(ytCookiesFile(), { force: true }).catch(() => {});
    return false;
  }
  await fsp.writeFile(ytCookiesFile(), lines.join('\n') + '\n', 'utf8');
  return true;
}

// DEFAULT BROWSER of the Windows user (fastest route: the YouTube session
// the user already has there, read by yt-dlp's --cookies-from-browser).
// Registry: HKCU\…\UrlAssociations\https\UserChoice → ProgId.
const BROWSER_PROGIDS = [
  [/^ChromeHTML/i, 'chrome', 'Chrome'],
  [/^MSEdge/i, 'edge', 'Edge'],
  [/^Firefox/i, 'firefox', 'Firefox'],
  [/^Brave/i, 'brave', 'Brave'],
  [/^Opera/i, 'opera', 'Opera'],
  [/^Vivaldi/i, 'vivaldi', 'Vivaldi'],
  [/^Chromium/i, 'chromium', 'Chromium']
];
let defaultBrowserCache;
function defaultBrowser() {
  if (defaultBrowserCache !== undefined) return Promise.resolve(defaultBrowserCache);
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { defaultBrowserCache = null; resolve(null); return; }
    require('child_process').execFile('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'],
    { windowsHide: true }, (err, out) => {
      const m = !err && /ProgId\s+REG_SZ\s+(\S+)/i.exec(String(out));
      const hit = m && BROWSER_PROGIDS.find(([re]) => re.test(m[1]));
      defaultBrowserCache = hit ? { id: hit[1], name: hit[2] } : null;
      resolve(defaultBrowserCache);
    });
  });
}

function ytLoginWindow() {
  return new Promise((resolve) => {
    const ses = session.fromPartition(YT_PARTITION);
    ses.setUserAgent(chromeUA());
    const lw = new BrowserWindow({
      width: 520,
      height: 720,
      parent: win,
      title: 'YouTube / Google sign-in',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: ses }
    });
    lw.webContents.setUserAgent(chromeUA());
    lw.loadURL(`https://accounts.google.com/ServiceLogin?service=youtube&continue=${encodeURIComponent('https://www.youtube.com/')}`);
    let done = false;
    // (closing the window by hand after signing in counts too)
    const finish = async () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      let signedIn = false;
      try { signedIn = await ytWriteCookies(ses); } catch { /* nothing exported */ }
      resolve(signedIn);
      if (!lw.isDestroyed()) lw.close();
    };
    // LOGIN_INFO on youtube.com = signed in on YouTube (set once Google
    // redirects back to youtube.com); a short delay lets the other cookies land
    const timer = setInterval(async () => {
      try {
        const c = await ses.cookies.get({ name: 'LOGIN_INFO' });
        if (c.some((k) => /youtube\.com$/i.test(k.domain)) && !done) setTimeout(finish, 2500);
      } catch { /* try again */ }
    }, 800);
    lw.on('closed', () => { finish(); });
  });
}

ipcMain.handle('yt-login', async () => {
  try {
    const ok = await ytLoginWindow();
    return { ok };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('yt-logout', async () => {
  try { await session.fromPartition(YT_PARTITION).clearStorageData(); } catch { /* nothing */ }
  await fsp.rm(ytCookiesFile(), { force: true }).catch(() => {});
  return { ok: true };
});

ipcMain.handle('yt-account', async () => {
  const browser = await defaultBrowser();
  try {
    const txt = await fsp.readFile(ytCookiesFile(), 'utf8');
    return { signedIn: /\tLOGIN_INFO\t/.test(txt), browser };
  } catch {
    return { signedIn: false, browser };
  }
});

// Cookies for yt-dlp: the account signed in through OpenMix first; else,
// when asked (useBrowser: retry of a video that needs a sign-in), the
// session of the default browser
async function ytCookieArgs(useBrowser) {
  try {
    await fsp.access(ytCookiesFile());
    return ['--cookies', ytCookiesFile()];
  } catch { /* no OpenMix sign-in */ }
  if (useBrowser) {
    const b = await defaultBrowser();
    if (b) return ['--cookies-from-browser', b.id];
  }
  return [];
}

ipcMain.handle('ytdlp-cancel', async (_e, id) => {
  const p = ytdlpJobs.get(id);
  if (!p) return false;
  p._omCancelled = true;
  try {
    if (process.platform === 'win32') {
      // yt-dlp.exe spawns a child process: kill the whole tree
      require('child_process').spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
    } else {
      p.kill();
    }
  } catch { /* already finished */ }
  return true;
});

// Restart for an update WITHOUT losing the loaded decks: a "restore-once"
// file dropped in the data folder makes the next launch restore the
// session, ONCE (the file is consumed)
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

// --- File explorer (classic tree view) ---
ipcMain.handle('fs-roots', async () => {
  const fs = require('fs');
  const roots = [];
  const add = (name, p) => {
    try { if (p && fs.existsSync(p)) roots.push({ name, path: p }); } catch { /* nothing */ }
  };
  // OpenMix's NATIVE folder: always first (the UI gives it its name)
  try {
    await fsp.mkdir(ytdlpOutDir(), { recursive: true });
    roots.push({ name: '📁 OpenMix', path: ytdlpOutDir(), native: true });
  } catch { /* location inaccessible */ }
  add('📁 Music', app.getPath('music'));
  add('📁 Downloads', app.getPath('downloads'));
  add('📁 Desktop', app.getPath('desktop'));
  add('📁 Documents', app.getPath('documents'));
  for (const l of ['C', 'D', 'E', 'F', 'G']) add(`Drive ${l}:`, `${l}:\\`);
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

// --- Export a playlist to a USB drive (universal format) ---
// Copied files + M3U8 playlist (readable by CDJs in folder browsing
// and by almost all hardware) + turbomix.json (grids, cues).
ipcMain.handle('export-playlist', async (_e, plName, items) => {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose the destination USB drive (or folder)',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const root = r.filePaths[0];
    const clean = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 120) || 'untitled';
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

// Save a mix recording ("Save as" dialog)
ipcMain.handle('save-recording', async (_e, data, defaultName) => {
  try {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save the mix',
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
// SoundCloud: the site's public v2 API + client_id extracted the way the web player does
// ---------------------------------------------------------------------------

const SC_API = 'https://api-v2.soundcloud.com';
let scClientId = null;

// `acct` is the account OBJECT from settings.scAccounts (not a bare token):
// that is what lets a 401 invalidate THE RIGHT account without touching the others
function scAuthHeaders(acct) {
  return acct && acct.token ? { 'Authorization': `OAuth ${acct.token}` } : {};
}

// Identity probe: the ONLY verdict allowed to clear a token.
// /me answers 200 with a valid OAuth EVEN WITHOUT a client_id — so an
// expired client_id can no longer make a live session look dead.
// Memoized for 30 s: a playlist failing in a loop must not trigger
// one probe per track.
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
      dead = r.status === 401; // 403 / 404 / 429 / 5xx: conclude NOTHING
    } catch {
      dead = false;            // network down: above all, don't log out
    }
    scProbe = { at: Date.now(), key, dead, pending: null };
    return dead;
  })();
  return scProbe.pending;
}

async function scGetJson(url, acct = null, opts = {}) {
  const get = () => fetch(url, { headers: { 'Accept': 'application/json', ...scAuthHeaders(acct) } });
  let r = await get();
  // 429 = too many requests (SoundCloud rate-limits): wait and retry
  // instead of showing the user a loading error
  for (let i = 0; i < 2 && r.status === 429; i++) {
    await new Promise((ok) => setTimeout(ok, 1200 * (i + 1)));
    r = await get();
  }
  // opts.keepToken: a 401 from A STREAM's URL proves NOTHING about the
  // session (most often track_authorization is missing) — invalidating the
  // token on that logged out a perfectly valid paid account, and made
  // every following track fail in cascade.
  if (r.status === 401 && acct && acct.token && !opts.keepToken) {
    // A 401 does NOT PROVE the session is dead: it may be the expired
    // public client_id, a track without rights, a malformed URL.
    // We log out ONLY if the /me probe confirms it — otherwise valid paid
    // accounts got kicked out, PERSISTENTLY (the null goes back into the
    // settings), and the rest of the night failed.
    if (await scTokenReallyDead(acct)) {
      // TARGETED invalidation: only THIS account is marked expired (the entry
      // stays in the list to offer reconnection) — in b2b, the buddy's
      // dead token must not log everyone out.
      acct.token = null;
      await saveSettings();
      throw new Error(`SoundCloud session for ${acct.name || 'your account'} expired — reconnect this account`);
    }
    // Live session: it's most likely the client_id. Let
    // "SoundCloud HTTP 401" bubble up so scTry re-extracts a fresh one.
    throw new Error('SoundCloud HTTP 401');
  }
  if (!r.ok) throw new Error(`SoundCloud HTTP ${r.status}`);
  return r.json();
}

// Gets a client_id: environment variable, saved settings, otherwise
// automatic discovery in the SoundCloud website's scripts.
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
    } catch { /* next script */ }
  }
  throw new Error('SoundCloud client_id not found');
}

// Retries once with a fresh client_id if SoundCloud returns 401/403
async function scTry(fn) {
  try {
    return await fn();
  } catch (e) {
    // ANCHORED on "SoundCloud HTTP": only API calls justify re-extracting
    // the client_id. A "Segment HTTP 403" (expiring signed CDN URL)
    // restarted the whole track download — while a new client_id
    // obviously doesn't re-sign a CDN URL.
    if (/SoundCloud HTTP (401|403)/.test(String(e))) {
      await scEnsureClientId(true);
      return fn();
    }
    throw e;
  }
}

// Adopts the token from the HISTORICAL browser session (pre-multi-account
// login, cookie in the default session). ONE-SHOT: the scCookieMigrated
// flag guarantees this cookie is NEVER read again — otherwise deleting
// the historical account would resurrect it at the next sc-status.
async function scAdoptCookieToken() {
  const accounts = scAccounts(); // also triggers the scToken migration along the way
  if (settings.scCookieMigrated) return;
  settings.scCookieMigrated = true; // even on failure: a single attempt
  try {
    const cookies = await session.defaultSession.cookies.get({ name: 'oauth_token' });
    const c = cookies.find(k => k.domain.includes('soundcloud.com') && k.value);
    // fromCookie: when this account is removed we'll know the cookie must
    // ALSO be removed from the default session
    if (c) accounts.push({ name: null, token: c.value, fromCookie: true });
  } catch { /* no cookie */ }
  await saveSettings();
}

// Official SoundCloud login window; the session token (oauth_token
// cookie) is retrieved once the user is logged in.
function scLoginWindow() {
  return new Promise((resolve) => {
    const lw = new BrowserWindow({
      width: 540,
      height: 760,
      parent: win,
      title: 'SoundCloud login',
      autoHideMenuBar: true,
      // EPHEMERAL partition (no "persist:" prefix = in-memory session,
      // discarded on close): every login starts from a BLANK page.
      // Without it, the 2nd account landed on the 1st one's logged-in session
      // (impossible to add the buddy's account without logging out your own).
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
      } catch { /* try again */ }
    }, 700);
    lw.on('closed', () => {
      clearInterval(timer);
      if (!done) resolve(null);
    });
  });
}

// Account login: the SAME handler serves the 1st login, adding the
// buddy's account (b2b) and reconnecting an expired account. No more
// "already connected" short-circuit: every call opens a blank window.
ipcMain.handle('sc-login', async () => {
  try {
    const accounts = scAccounts();
    const token = await scLoginWindow();
    if (!token) return { ok: false, error: 'Login canceled' };
    let cid = '';
    try { cid = await scEnsureClientId(); } catch { /* the token may be enough */ }
    const q = cid ? `?client_id=${cid}` : '';
    // /me with THIS token: identifies the account (display name + duplicate check).
    // Throwaway account object: a 401 here must not invalidate anyone else.
    const me = await scGetJson(`${SC_API}/me${q}`, { name: null, token });
    const name = me.username || null;
    // A migrated account (name still null) must be identified BEFORE the
    // duplicate check, otherwise reconnecting to your own account would duplicate it
    for (const a of accounts) {
      if (!a.name && a.token) {
        try {
          const m = await scGetJson(`${SC_API}/me${q}`, a);
          a.name = m.username || null;
        } catch { /* dead token: already invalidated by scGetJson */ }
      }
    }
    // IN-PLACE reconnection: same account already known → REUSE its index,
    // the acctIdx tagged on rows already displayed stay valid
    const existing = accounts.findIndex(a => name && a.name === name);
    if (existing >= 0) {
      if (accounts[existing].token) {
        await saveSettings(); // freshly learned names are worth keeping
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

// Removes an account from the list (right-click on its 👤 row in the UI)
ipcMain.handle('sc-remove-account', async (_e, idx) => {
  try {
    const accounts = scAccounts();
    const acct = accounts[idx];
    if (!acct) return { ok: false, error: 'Unknown account' };
    accounts.splice(idx, 1);
    // Account inherited from the historical browser session: ALSO remove the
    // cookie from the default session, otherwise the token would linger on disk
    if (acct.fromCookie) {
      try {
        await session.defaultSession.cookies.remove('https://soundcloud.com', 'oauth_token');
      } catch { /* already gone */ }
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

// Playlists OF THE REQUESTED ACCOUNT (accountIdx): the user's own +
// those in their library. No index → account 0, as before multi-account.
ipcMain.handle('sc-my-playlists', async (_e, accountIdx) => {
  try {
    await scAdoptCookieToken();
    const idx = accountIdx ?? 0;
    const acct = scAccounts()[idx];
    if (!acct || !acct.token) return { ok: false, needLogin: true, error: 'Not connected to SoundCloud' };
    return await scTry(async () => {
      let cid = '';
      try { cid = await scEnsureClientId(); } catch { /* the token may be enough */ }
      const q = cid ? `client_id=${cid}&` : '';
      const me = await scGetJson(`${SC_API}/me?${q}`.replace(/[?&]$/, ''), acct);
      // Account migrated from the old single-account setting: learn its name here
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
      } catch { /* endpoint sometimes unavailable */ }
      try {
        const own = await scGetJson(`${SC_API}/users/${me.id}/playlists?${q}limit=100`, acct);
        for (const p of (own.collection || [])) push(p);
      } catch { /* same */ }
      // LIKES first, like a playlist — "a likes playlist" (David)
      items.unshift({ scLikes: true, name: '❤ Likes', trackCount: null });
      return { ok: true, username: me.username, accountIdx: idx, playlists: items };
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// All LIKED tracks of the requested account (paginated) — no index: account 0
ipcMain.handle('sc-my-likes', async (_e, accountIdx) => {
  try {
    await scAdoptCookieToken();
    const idx = accountIdx ?? 0;
    const acct = scAccounts()[idx];
    if (!acct || !acct.token) return { ok: false, needLogin: true, error: 'Not connected to SoundCloud' };
    return await scTry(async () => {
      let cid = '';
      try { cid = await scEnsureClientId(); } catch { /* the token may be enough */ }
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

// An "encrypted-hls" stream is DRM-protected (FairPlay/Widevine): its key
// is only delivered to the site's player. We can neither play nor analyze it —
// we must SAY so, not show "loading error".
const scIsDrm = (c) => /encrypted/i.test((c.format && c.format.protocol) || '');

function scSimplifyTrack(t) {
  const codings = (t.media && t.media.transcodings) || [];
  const drm = codings.length > 0 && codings.every(scIsDrm);
  return {
    drm,
    scId: t.id,
    name: `${(t.user && t.user.username) || '?'} - ${t.title || t.id}`,
    duration: t.duration ? t.duration / 1000 : null,
    // TRACK LINK — without it, crowd requests coming from the SoundCloud
    // search arrived without an address and were ALL rejected
    permalink: t.permalink_url || null,
    // Rights: show them instead of making the row disappear
    policy: t.policy || null,             // ALLOW / MONETIZE / SNIP / BLOCK
    snipped: t.snipped === true || codings.some((c) => c.snipped === true),
    blocked: t.policy === 'BLOCK',
    streamable: t.streamable !== false && t.policy !== 'BLOCK',
    // SoundCloud artwork (t500 = large size) — cover art on the deck
    artwork: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : null,
    // Waveform published by SoundCloud: the preview in the list WITHOUT
    // downloading the audio
    waveform: t.waveform_url || null
  };
}

// SoundCloud waveform (wave.sndcdn.com): the .json version gives
// ~1800 heights 0-140. Reduced to 600 points for the list preview.
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

// Fills in "stub" tracks (playlists only return the first ones in full).
// The account is passed along: without it, a playlist's private/Go+
// tracks would remain invisible stubs.
async function scHydrateTracks(tracks, cid, acct = null) {
  const stubs = tracks.filter(t => !t.title).map(t => t.id);
  const byId = new Map();
  for (let i = 0; i < stubs.length; i += 30) {
    const ids = stubs.slice(i, i + 30).join(',');
    try {
      const full = await scGetJson(`${SC_API}/tracks?ids=${ids}&client_id=${cid}`, acct);
      for (const t of full) byId.set(t.id, t);
    } catch { /* unavailable tracks: ignored */ }
  }
  return tracks
    .map(t => (t.title ? t : byId.get(t.id)))
    .filter(Boolean);
}

// Resolves a SoundCloud URL: playlist -> tracks; profile -> list of playlists.
// accountIdx = account whose token goes with the requests (private / Go+
// playlists); failing that, the first valid account, otherwise anonymous.
ipcMain.handle('sc-resolve', async (_e, url, accountIdx) => {
  try {
    if (!/^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//.test(url.trim())) {
      return { ok: false, error: 'This is not a soundcloud.com link' };
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

// Search the WHOLE SoundCloud catalog (not just playlists).
// Shared function: used by the app (IPC) AND by the guest page
// (/scsearch) — guests search from their phone.
async function scSearchTracks(query, accountIdx) {
  try {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'Empty search' };
    const acct = scAcctOrDefault(accountIdx);
    return await scTry(async () => {
      const cid = await scEnsureClientId();
      const res = await scGetJson(
        `${SC_API}/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=50`, acct);
      const tracks = (res.collection || [])
        .filter(t => t && t.id && (t.kind === 'track' || !t.kind))
        .map(scSimplifyTrack)
        // "streamable" is a LEGACY field from the old API: it is false on
        // tracks that play just fine once authenticated — it SILENTLY
        // dropped results. Now only actual takedowns (BLOCK) are hidden,
        // which no subscription unlocks.
        .filter(t => !t.blocked);
      return { ok: true, tracks };
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
ipcMain.handle('sc-search', (_e, query, accountIdx) => scSearchTracks(query, accountIdx));

// Opens a link in the system BROWSER (clickable guest page)
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

// Downloads a SoundCloud track's audio stream to a file.
// The account (acct) opens access to private/Go+ tracks; the raw stream
// fetches further down stay unauthenticated: they are already-signed URLs.
// IN-PROGRESS SoundCloud downloads (scId → AbortController): loading
// another track on the deck CANCELS the first (a 3 h set started by mistake)
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
    // DRM-protected streams are DISCARDED: their key is reserved for the
    // site's player (FairPlay/Widevine). Downloading them would only give
    // encrypted bytes — a fake "success" with an unreadable file.
    const codings = allCodings.filter((c) => !scIsDrm(c));
    if (!codings.length) {
      // Encrypted stream: the key is only delivered to the site's player.
      // Nothing to "fix" in code, and nothing to bypass — we say so, that's all.
      throw new Error('Protected track (DRM): playback outside the service’s site isn’t allowed. Use a file you own, or another track.');
    }

    // Stream PREFERENCE ORDER — nothing is rejected up front anymore:
    // many tracks (Go+ ones included) only expose AAC or Opus, and the
    // old "mpeg|mp3" filter declared them unplayable.
    const score = (c) => {
      const p = (c.format && c.format.protocol) || '';
      const m = (c.format && c.format.mime_type) || '';
      if (p === 'progressive' && /mpeg/.test(m)) return 0; // direct mp3: ideal
      if (p === 'progressive') return 1;
      if (p === 'hls' && /mpeg/.test(m)) return 2;
      if (p === 'hls' && /(mp4|aac)/.test(m)) return 3;    // AAC: Chromium can play it
      return 4;                                            // opus & co: last resort
    };
    const ordered = [...codings].sort((a, b) => score(a) - score(b));
    // track_authorization: PER-TRACK token returned with the track — without
    // it the API answers 401/403 on most tracks. It was THE cause of the
    // repeated "loading errors", paid account included.
    const ta = track.track_authorization
      ? `&track_authorization=${encodeURIComponent(track.track_authorization)}`
      : '';

    const getBin = async (u, what) => {
      if (signal && signal.aborted) throw new Error('Loading cancelled');
      let r = await fetch(u, { signal });
      for (let i = 0; i < 2 && (r.status === 429 || r.status >= 500); i++) {
        await new Promise((ok) => setTimeout(ok, 900 * (i + 1)));
        r = await fetch(u, { signal });
      }
      if (!r.ok) throw new Error(`${what} HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    };

    // TRY EACH STREAM in order: a broken transcoding no longer dooms the
    // track as long as another one remains
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
        // "Preview" track: SoundCloud only serves 30 s when the account
        // lacks the rights. We FLAG it and record it in the cache —
        // otherwise the preview was replayed forever, even after
        // connecting the subscribed account.
        return {
          dest,
          bytes: buf.length,
          full: !track.snipped,
          warning: track.snipped
            ? '30s preview: connect the subscribed SoundCloud account for the full track'
            : null
        };
      } catch (e) {
        // cancelled: definitely don't try the next stream
        if (signal && signal.aborted) throw new Error('Loading cancelled');
        lastErr = e;
      }
    }
    throw new Error(track.snipped
      ? 'Track reserved for subscribers (Go+) — connect the subscribed account in ⚙'
      : `No playable stream: ${lastErr ? lastErr.message : 'unknown'}`);
}

// Downloads the track into the local cache (for playback) — the rest of
// the pipeline (decoding, BPM) is identical to local files.
// accountIdx: the account the track comes from (its own Go+/private tracks).
// Identity of the account that filled the cache: if the subscribed account
// is finally connected, a cached 30 s preview MUST be re-downloaded instead
// of being replayed forever.
function scAcctKey(acct) {
  return acct && acct.token ? `u:${acct.name || 'sans-nom'}` : 'anonyme';
}

// Path of a SoundCloud track already cached IN FULL (otherwise null) — to
// analyze its key in the background without downloading anything
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
    // The cache is reused only if it is PROVEN complete, or if it comes from
    // the SAME account. A file without a metadata file comes from a version
    // that couldn't detect previews: re-download it once — this is the
    // automatic purge of previews already on disk.
    try {
      const st = await fsp.stat(dest);
      const m = JSON.parse(await fsp.readFile(meta, 'utf8'));
      if (st.size > 0 && (m.full === true || m.acct === key)) {
        return { ok: true, path: dest, full: m.full !== false, warning: m.warning || null };
      }
    } catch { /* not cached, preview, or cache from an older version */ }
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
    } catch { /* metadata not written: will re-download, harmless */ }
    return { ok: true, path: dest, full: r.full, warning: r.warning || null };
  } catch (err) {
    const cancelled = /cancelled|abort/i.test(String(err && (err.name + err.message)));
    return { ok: false, cancelled, error: cancelled ? 'Loading cancelled' : String(err.message || err) };
  }
});

// Downloads a track PERMANENTLY into Music\TurboMix (for playlists) —
// accountIdx: account that owns the track (token for private/Go+ tracks)
ipcMain.handle('sc-download-to', async (_e, scId, baseName, accountIdx) => {
  try {
    const dir = path.join(app.getPath('music'), 'TurboMix');
    await fsp.mkdir(dir, { recursive: true });
    const clean = String(baseName || scId).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 120) || String(scId);
    const dest = path.join(dir, `${clean}.mp3`);
    try {
      const st = await fsp.stat(dest);
      if (st.size > 0) return { ok: true, path: dest };
    } catch { /* not downloaded yet */ }
    // Already in the playback cache? Copy it — BUT only if it is the
    // WHOLE track: we don't want to export a 30 s preview into the
    // user's music collection.
    const cdir = path.join(app.getPath('userData'), 'sc-cache');
    const cached = path.join(cdir, `${scId}.mp3`);
    try {
      const st = await fsp.stat(cached);
      const m = JSON.parse(await fsp.readFile(path.join(cdir, `${scId}.json`), 'utf8'));
      if (st.size > 0 && m.full === true) {
        await fsp.copyFile(cached, dest);
        return { ok: true, path: dest };
      }
    } catch { /* not cached, or a preview: download properly */ }
    const r = await scTry(() => scDownloadToFile(scId, dest, scAcctOrDefault(accountIdx)));
    return { ok: true, path: dest, full: r.full, warning: r.warning || null };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
