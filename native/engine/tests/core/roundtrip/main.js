// Electron main of the engine host round trip (owner: host). Not OpenMix:
// a hidden window with the REAL preload.js and engine-main.js, a temp
// userData and data folder, every non-file request blocked, the save dialog
// and "show in folder" replaced by stubs. The page (page.js) drives
// window.omEngine like the JS proxy will; this script prepares the files
// (a WAV for the shadow decoder, fake recordings), checks what only main can
// see (the host process gone, recordings copied and removed) and writes the
// result JSON. Exits on its own. SPEC.md §6.4, §6.5, §14.
'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const path = require('path');

const argv = process.argv;
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const modulePath = opt('--module');
const resultPath = opt('--result');
const userData = opt('--user-data');
app.setPath('userData', userData);
app.disableHardwareAcceleration();

// The repository: the first parent folder holding engine-main.js (this
// script may run from a copy of the engine tree, e.g. an integrator's snapshot).
function findRepo(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'engine-main.js')) && fs.existsSync(path.join(d, 'package.json'))) return d;
    if (path.dirname(d) === d) return path.resolve(__dirname, '..', '..', '..', '..', '..');
  }
}
const repo = findRepo(__dirname);
const dataDir = path.join(userData, 'engine-data');
const recDir = path.join(dataDir, 'recordings');
const saveDir = path.join(userData, 'saved');
const revealed = [];
let win = null;

const engineMain = require(path.join(repo, 'engine-main.js'));
const IDLE_MS = 400;  // the idle shutdown grace for this test (15 s in the app)
const api = engineMain.install({
  getWindow: () => win,
  app,
  ipcMain,
  modulePath,
  dataDir,
  idleShutdownMs: IDLE_MS,
  maxPcmBytes: 4 * 1024 * 1024,  // the PCM memory limit step (the app: ~40 % of the RAM)
  // "Set one" is saved as if the destination were on another drive (EXDEV): the verified copy path
  fsOps: {
    rename: async (a, b) => {
      if (/Set one\.wav$/.test(a)) {
        const e = new Error('EXDEV: cross-device link not permitted (simulated)');
        e.code = 'EXDEV';
        throw e;
      }
      return fs.promises.rename(a, b);
    }
  },
  // Save dialog stub: "Cancel me" cancels, anything else goes to <userData>/saved.
  showSaveDialog: async (_w, o) =>
    /Cancel me/.test(o.defaultPath) ? { canceled: true } : { canceled: false, filePath: path.join(saveDir, path.basename(o.defaultPath)) },
  showItemInFolder: (p) => revealed.push(p)
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(20);
  return pred();
}

const result = { ok: false, steps: [] };
let finished = false;
function finish(ok, extra) {
  if (finished) return;
  finished = true;
  Object.assign(result, extra || {});
  result.ok = ok && result.steps.every((s) => s.ok);
  try {
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 1));
  } catch (e) {
    console.error('cannot write the result', e);
  }
  setTimeout(() => app.exit(result.ok ? 0 : 1), 50);
}
const step = (name, ok, info) => result.steps.push({ name, ok: !!ok, info });

function wav16(file, rate, seconds, freq) {
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.5 * 32767);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return frames;
}

setTimeout(() => finish(false, { error: 'time-out in the test main (100 s)' }), 100000);

app.whenReady().then(async () => {
  try {
    // Nothing leaves this machine: only local files.
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|devtools|data|blob|chrome-extension):/.test(d.url) }));
    fs.mkdirSync(recDir, { recursive: true });
    fs.mkdirSync(saveDir, { recursive: true });
    const tone = path.join(userData, 'tone 440.wav');
    const toneFrames = wav16(tone, 48000, 3, 440);
    // Two finished "recordings" (valid 16-bit WAVs of 6 MiB: the first and
    // last MiB are compared after the copy).
    const rec1 = path.join(recDir, 'Set one.wav');
    const rec2 = path.join(recDir, 'Set two.wav');
    const rec3 = path.join(recDir, 'Set three.wav');
    const big = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 44; i < big.length; i++) big[i] = (i * 31 + 7) & 255;
    big.write('RIFF', 0);
    big.writeUInt32LE(big.length - 8, 4);
    big.write('WAVEfmt ', 8);
    big.writeUInt32LE(16, 16);
    big.writeUInt16LE(1, 20);
    big.writeUInt16LE(2, 22);
    big.writeUInt32LE(48000, 24);
    big.writeUInt32LE(48000 * 4, 28);
    big.writeUInt16LE(4, 32);
    big.writeUInt16LE(16, 34);
    big.write('data', 36);
    big.writeUInt32LE(big.length - 44, 40);
    fs.writeFileSync(rec1, big);
    fs.writeFileSync(rec2, big);
    fs.writeFileSync(rec3, big);

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(repo, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    });
    await win.loadFile(path.join(__dirname, 'page.html'));
    const cfg = { tone, toneFrames, rec1, rec2, rec3 };
    const r = await win.webContents.executeJavaScript(`window.runRoundTrip(${JSON.stringify(cfg)})`, true);
    for (const s of r.steps || []) result.steps.push(s);
    if (r.error) result.error = r.error;
    result.metrics = r.metrics;
    // What only main can see.
    step('host process gone after engine-kill', api.hostPid() === null, { pid: api.hostPid() });
    const saved1 = path.join(saveDir, 'Saved set.wav');
    step('recording copied across drives, verified, original removed, no .part left',
      fs.existsSync(saved1) && fs.statSync(saved1).size === big.length && !fs.existsSync(rec1) && !fs.existsSync(`${saved1}.part`));
    const saved3 = path.join(saveDir, 'Moved set.wav');
    step('recording renamed on the same drive (original gone)',
      fs.existsSync(saved3) && fs.statSync(saved3).size === big.length && !fs.existsSync(rec3));
    step('cancelled save keeps the recording', fs.existsSync(rec2));
    step('reveal only for recordings', revealed.length === 1 && revealed[0] === rec2, revealed);

    // ---- a host no page uses is shut down; a reconnect within the grace keeps it; shutdown() ----
    const connect = () => win.webContents.executeJavaScript('window.omEngine.connect().then((c) => !!(c && c.ok))', true);
    await win.loadFile(path.join(__dirname, 'page.html'));
    const c1 = await connect();
    const pidA = api.hostPid();
    step('a page connects after the kill: a new host', c1 && !!pidA, { pid: pidA });
    await win.loadFile(path.join(__dirname, 'page.html'));  // a reload: the grace starts...
    const c2 = await connect();                             // ...and the reconnect cancels it
    await sleep(IDLE_MS + 400);
    step('a page that reconnects within the grace keeps the same host', c2 && api.hostPid() === pidA && alive(pidA),
      { pid: api.hostPid() });
    const tn = Date.now();
    await win.loadURL('data:text/html,<title>web engine page</title>');  // a page that never connects (Web engine)
    const goneA = await waitFor(() => !alive(pidA), 6000);
    const idleMs = Date.now() - tn;
    step('a host no page uses is shut down after the grace', goneA && api.hostPid() === null && idleMs >= IDLE_MS - 50,
      { afterMs: idleMs, graceMs: IDLE_MS });
    await win.loadFile(path.join(__dirname, 'page.html'));
    const c3 = await connect();
    const pidB = api.hostPid();
    const ts = Date.now();
    await engineMain.shutdown();  // what the restart paths with app.exit() must await
    step('engineMain.shutdown() resolves once the host is gone', c3 && !!pidB && pidB !== pidA && api.hostPid() === null &&
      (await waitFor(() => !alive(pidB), 1000)), { pid: pidB, ms: Date.now() - ts });
    finish(!r.error, {});
  } catch (e) {
    finish(false, { error: String((e && e.stack) || e) });
  }
});
