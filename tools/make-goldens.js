// Golden references of the native engine (owner: host; native/engine/SPEC.md
// §18.4): renders produced by CHROMIUM ITSELF with the Web engine's own code
// (src/js/engine.js Deck / FxUnit / AudioEngine, src/js/pitch-worklet.js),
// so the native ports are proven against the real thing, never against a
// reference written from the same memory.
//
//   node tools/make-goldens.js [--out native/engine/goldens] [--suite fx[,color...]] [--quick]
//   (or: electron tools/make-goldens.js ..., with ELECTRON_RUN_AS_NODE unset)
//
// Started with Node, it re-launches itself with the Electron of node_modules
// (ELECTRON_RUN_AS_NODE removed: the local shell sets it) and waits for it.
// Inside Electron: a hidden BrowserWindow (show: false, temp userData, GPU
// off, every non-file request blocked) on tools/goldens/render.html, which
// renders with OfflineAudioContext ONLY — silent, no device, not OpenMix, no
// port — and hands each case back through the preload bridge. The process
// exits on its own; it is never killed by path or by name (same electron.exe
// as OpenMix through the node_modules junction): only our own child handle
// is ended, after a time-out.
//
// Output, per case: <out>/<suite>/<case>.wav (float32, the render), in the
// generator's own suite folders (strip, master, limiter, source, fxunit,
// color, wsola, decode: cleared before they are rendered again; every other
// folder belongs to a module's own generator and is left alone:
// native/engine/tests/deck/goldens/make_deck_goldens.js -> deck/,
// tests/fx/goldens/make_fx_goldens.js -> fx/ (every FX and Color type at 48
// and 44.1 kHz, families rate96 and timing), tests/mixer/goldens/
// make_mixer_goldens.js -> mixer/ (needed by the mixer parity tests, which
// fail without it when OM_GOLDEN_DIR is set); SPEC.md §18.4),
// <case>.input.wav (what it was fed), <case>.json (the setup, the engine.js
// calls with their exact frames, the constants), plus <suite>/<extra>.wav
// files a case refers to (seeded reverb impulses, the noise buffer) and
// <out>/index.json. The folder is git-ignored. Tests read it through
// OM_GOLDEN_DIR (omtest::goldenPath / readWav).
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const outDir = path.resolve(root, opt('--out', path.join('native', 'engine', 'goldens')));
const suites = opt('--suite', '');
// The folders this generator owns (SPEC.md §18.4). A module's own generator
// writes only goldens/<module>/ (deck, fx, mixer...): never touched here.
const MY_SUITES = ['strip', 'master', 'limiter', 'source', 'fxunit', 'color', 'wsola', 'decode'];
const selected = suites ? suites.split(',').map((x) => x.trim()).filter((x) => MY_SUITES.includes(x)) : MY_SUITES;
const quick = args.includes('--quick');

const inElectron = !!process.versions.electron && process.type === 'browser';

if (!inElectron) {
  // ---- Node: re-launch under Electron and wait ------------------------------------
  const { spawn } = require('child_process');
  let electron;
  try {
    electron = require(path.join(root, 'node_modules', 'electron'));  // the path of electron.exe
  } catch {
    console.error('make-goldens: Electron not found in node_modules');
    process.exit(2);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now();
  const child = spawn(electron, [__filename, ...args], { env, stdio: ['ignore', 'inherit', 'pipe'], windowsHide: true });
  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (!/(gpu|cache|Fontconfig|DevTools|ERROR:.*(dxgi|angle))/i.test(s)) process.stderr.write(s);
  });
  const timer = setTimeout(() => {
    console.error(`make-goldens: time-out after 20 min, ending our own Electron (pid ${child.pid})`);
    child.kill();
  }, 20 * 60 * 1000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    console.log(`make-goldens: done in ${((Date.now() - t0) / 1000).toFixed(1)} s (exit ${code})`);
    process.exit(code === null ? 1 : code);
  });
  return;
}

// ---- Electron main ---------------------------------------------------------------------
const { app, BrowserWindow, ipcMain, session } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'om-goldens-'));
app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let written = 0;
let bytes = 0;
const index = { generator: 'tools/make-goldens.js', created: new Date().toISOString(), cases: [] };

function safeRel(rel) {
  const norm = path.normalize(String(rel));
  if (path.isAbsolute(norm) || norm.split(/[\\/]/).includes('..')) throw new Error(`bad golden path ${rel}`);
  return norm;
}

ipcMain.handle('golden-write', async (_e, rel, data) => {
  const file = path.join(outDir, safeRel(rel));
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength);
  await fs.promises.writeFile(file, buf);
  written++;
  bytes += buf.length;
  return true;
});
ipcMain.handle('golden-case', (_e, entry) => {
  index.cases.push(entry);
  console.log(`  ${entry.suite}/${entry.case}  (${entry.frames} frames${entry.note ? ', ' + entry.note : ''})`);
  return true;
});
let started = false;  // the page reached its first suite
ipcMain.handle('golden-log', (_e, line) => {
  started = true;
  console.log(line);
  return true;
});

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    // keep the cases of the suites that were not rendered this time
    try {
      const prev = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
      const kept = (prev.cases || []).filter((c) => MY_SUITES.includes(c.suite) && !selected.includes(c.suite));
      index.cases = [...kept, ...index.cases];
    } catch {
      /* first run */
    }
    index.files = written;
    index.bytes = bytes;
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1));
  } catch (e) {
    console.error('make-goldens: index not written', e);
  }
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* in use */ }
  setTimeout(() => app.exit(code), 50);
}
ipcMain.handle('golden-done', (_e, r) => {
  index.chrome = process.versions.chrome;
  index.electron = process.versions.electron;
  index.summary = r;
  console.log(`make-goldens: ${index.cases.length} cases, ${written} files, ${(bytes / 1048576).toFixed(1)} MiB -> ${outDir}`);
  if (r && r.errors && r.errors.length) for (const e of r.errors) console.error(`  ERROR ${e}`);
  finish(r && r.errors && r.errors.length ? 1 : 0);
  return true;
});

setTimeout(() => {
  console.error('make-goldens: time-out inside Electron (15 min)');
  finish(3);
}, 15 * 60 * 1000);

app.whenReady().then(async () => {
  // Nothing leaves this machine: local files only.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|devtools|data|blob):/.test(d.url) }));
  fs.mkdirSync(outDir, { recursive: true });
  for (const sname of selected) fs.rmSync(path.join(outDir, sname), { recursive: true, force: true });  // no stale case
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'goldens', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  win.webContents.on('console-message', (...a) => {
    const e = a[0];
    const msg = e && typeof e.message === 'string' ? e.message : a[2];
    const level = e && e.level !== undefined ? e.level : a[1];
    if (level === 'error' || level === 3) {
      console.error(`  [page] ${msg}`);
      // a page that cannot even start never calls done(): do not wait 15 minutes
      if (!started && /Uncaught|SyntaxError|Failed to load/.test(String(msg))) finish(5);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('make-goldens: renderer gone', d && d.reason);
    finish(4);
  });
  const q = new URLSearchParams({ suites: selected.join(','), quick: quick ? '1' : '0' }).toString();
  await win.loadFile(path.join(__dirname, 'goldens', 'render.html'), { search: q });
  setTimeout(() => {
    if (!started) {
      console.error('make-goldens: the render page did not start within 30 s');
      finish(6);
    }
  }, 30000);
});
