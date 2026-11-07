// Golden renders of the DECK suite (owner: deck), made by Chromium itself
// (SPEC.md §18.4): AudioBufferSourceNode read-pointer cases (rates != 1,
// buffer rate != context rate, loop seams, end of buffer, rate steps) and
// the REAL src/js/pitch-worklet.js inside an AudioWorklet (ratio steps,
// ramps and engine.js-style setTargetAtTime), plus the exact k-rate values
// its "ratio" AudioParam took in every render quantum (a recorder worklet
// with the same parameter descriptor and the same automation).
//
// Silent by construction: OfflineAudioContext only, hidden window, no audio
// device, no network (every non-file request is blocked), its own temporary
// userData folder (never OpenMix's), no port. It exits on its own (hard
// time-out 180 s); never kill it by name or by path (electron.exe is the
// same file as OpenMix's through the node_modules junction).
//
//   (without ELECTRON_RUN_AS_NODE in the environment)
//   node_modules/electron/dist/electron.exe native/engine/tests/deck/goldens/make_deck_goldens.js
//       --out native/engine/goldens/deck
// Then run the deck tests with OM_GOLDEN_DIR=native/engine/goldens.
// The host's tools/make-goldens.js may absorb this script (same output layout:
// <suite>/<case>.wav, <case>.input.wav or a shared input, <case>.json).
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const args = process.argv.slice(1);
const outIdx = args.indexOf('--out');
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const outDir = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(repoRoot, 'native', 'engine', 'goldens', 'deck'));

// Never touch OpenMix's profile, cache or single-instance lock.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'om-deck-goldens-'));
app.setPath('userData', tmp);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('mute-audio');

const hardStop = setTimeout(() => {
  console.error('make_deck_goldens: time-out, exiting');
  app.exit(3);
}, 180000);

let exitCode = 1;
ipcMain.on('log', (_e, msg) => console.log(msg));
ipcMain.on('done', (_e, res) => {
  if (res && res.ok) {
    console.log(`make_deck_goldens: ${res.cases} case(s) written to ${outDir}`);
    exitCode = 0;
  } else {
    console.error(`make_deck_goldens: FAILED: ${res && res.error}`);
  }
  clearTimeout(hardStop);
  app.exit(exitCode);
});

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
    cb({ cancel: !(d.url.startsWith('file:') || d.url.startsWith('devtools:')) });
  });
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  });
  const page = pathToFileURL(path.join(__dirname, 'page.html'));
  page.searchParams.set('out', outDir);
  page.searchParams.set('root', repoRoot);
  win.loadURL(page.href);
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error(`make_deck_goldens: renderer gone (${d.reason})`);
    app.exit(4);
  });
});

app.on('window-all-closed', () => app.exit(exitCode));
