// Golden renders of the FX suite (owner: fx), made by Chromium itself
// (SPEC.md §11.7, §18.4): every beat-FX type and every Color FX type,
// rendered in an OfflineAudioContext by engine.js's own FxUnit (reverbs with
// a SEEDED impulse handed to the ConvolverNode, the same xorshift32 impulse
// as om::makeImpulse), except the feedback echoes: they are rendered by
// engine.js's graphs with Chromium's feedback-cycle latency compensated (each
// trip around a DelayNode cycle is one render quantum late in Chromium; the
// native echoes are drift-free on purpose, SPEC.md §20), measured by a probe
// render first. Output, per case: <case>.input.wav (float32 stereo),
// <case>.wav (Chromium's output, float32 stereo), <case>.json (unit kind,
// sample rate, impulse, parameter events in frames), plus manifest.json.
//
// Silent by construction: OfflineAudioContext only, hidden window, muted, no
// audio device, no network (every non-file request is blocked), its own
// temporary userData folder (never OpenMix's), no port. It exits on its own
// (hard time-out 300 s); never kill it by name or by path (electron.exe is the
// same file as OpenMix's through the node_modules junction).
//
//   (without ELECTRON_RUN_AS_NODE in the environment)
//   node_modules/electron/dist/electron.exe native/engine/tests/fx/goldens/make_fx_goldens.js
//       --out native/engine/goldens/fx
// Then run the fx tests with OM_GOLDEN_DIR=native/engine/goldens.
// The host's tools/make-goldens.js may absorb this script (same layout).
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const args = process.argv.slice(1);
const outIdx = args.indexOf('--out');
const onlyIdx = args.indexOf('--only');
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const outDir = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(repoRoot, 'native', 'engine', 'goldens', 'fx'));
const only = onlyIdx >= 0 && args[onlyIdx + 1] ? args[onlyIdx + 1] : '';
// Diagnostics: --probe-delay (DelayNode read precision per path, writes
// nothing), --probe-osc (Chromium's oscillator tables, as WAVs in --out),
// --probe-param (setTargetAtTime values, as WAVs in --out).
const probe = ['delay', 'osc', 'param'].find((p) => args.includes(`--probe-${p}`)) || '';

// Never touch OpenMix's profile, cache or single-instance lock.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'om-fx-goldens-'));
app.setPath('userData', tmp);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('mute-audio');

const hardStop = setTimeout(() => {
  console.error('make_fx_goldens: time-out, exiting');
  app.exit(3);
}, 300000);

let exitCode = 1;
ipcMain.on('log', (_e, msg) => console.log(msg));
ipcMain.on('done', (_e, res) => {
  if (res && res.ok) {
    console.log(`make_fx_goldens: ${res.cases} case(s) written to ${outDir}`);
    exitCode = 0;
  } else {
    console.error(`make_fx_goldens: FAILED: ${res && res.error}`);
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
  win.webContents.setAudioMuted(true);
  const page = pathToFileURL(path.join(__dirname, 'page.html'));
  page.searchParams.set('out', outDir);
  page.searchParams.set('root', repoRoot);
  if (only) page.searchParams.set('only', only);
  if (probe) page.searchParams.set('probe', probe);
  win.loadURL(page.href);
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error(`make_fx_goldens: renderer gone (${d.reason})`);
    app.exit(4);
  });
});

app.on('window-all-closed', () => app.exit(exitCode));
