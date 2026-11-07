// Golden renders of the mixer's parity suite (owner: mixer; dsp-parity
// campaign), made by Chromium itself with engine.js's own Deck and
// AudioEngine (SPEC.md §10, §18.4). They close the paths the host's suites
// (strip, master, limiter at 48 kHz) do not cover:
//  - the strip, the master chain and the limiter at 44.1 kHz (the DDJ-FLX6's
//    rate) and 96 kHz;
//  - the limiter's static curve (a level staircase), attack and release
//    (level steps) and look-ahead at 44.1 / 48 / 96 kHz;
//  - the whole engine.js graph driven through AudioEngine's own API: four
//    decks -> EQ / trim / Color filter knob / fader -> crossfader (sides) ->
//    master volume -> master filter -> limiter, loud enough to compress;
//  - the FX sends, returns, pad sends, master FX send and the dry cut /
//    master dry compensation (syncLock), with every FX unit made an
//    identity (input -> wet gain), so the mixer's part of each path is
//    compared alone (the units themselves have the fx suite);
//  - the Color FX sends (|knob| x colorWet 0.85 -> fxReturn) with an
//    identity Color bus, colour type switches and the global on / off.
// Output, per case, in <out> (default native/engine/goldens/mixer):
// <case>.input.wav (float32; 2 channels per deck that receives a signal),
// <case>.wav (Chromium's stereo output, float32), <case>.json (kind, rate,
// frames, decks fed, the engine.js calls with their exact frames), and
// manifest.json.
//
// Silent by construction: OfflineAudioContext only, hidden window, muted, no
// audio device, no network (every non-file request is blocked), its own
// temporary userData folder (never OpenMix's), no port. It exits on its own
// (hard time-out 300 s); never kill it by name or by path (electron.exe is the
// same file as OpenMix's through the node_modules junction).
//
//   (without ELECTRON_RUN_AS_NODE in the environment)
//   node_modules/electron/dist/electron.exe native/engine/tests/mixer/goldens/make_mixer_goldens.js
//       [--out native/engine/goldens/mixer] [--only <substring>]
// Then run the mixer tests with OM_GOLDEN_DIR=native/engine/goldens.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const args = process.argv.slice(1);
const outIdx = args.indexOf('--out');
const onlyIdx = args.indexOf('--only');
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const outDir = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(repoRoot, 'native', 'engine', 'goldens', 'mixer'));
const only = onlyIdx >= 0 && args[onlyIdx + 1] ? args[onlyIdx + 1] : '';

// Never touch OpenMix's profile, cache or single-instance lock.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'om-mixer-goldens-'));
app.setPath('userData', tmp);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('mute-audio');

let exitCode = 1;
function finish(code) {
  exitCode = code;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* in use */ }
  app.exit(code);
}
const hardStop = setTimeout(() => {
  console.error('make_mixer_goldens: time-out, exiting');
  finish(3);
}, 300000);

ipcMain.on('log', (_e, msg) => console.log(msg));
ipcMain.on('done', (_e, res) => {
  clearTimeout(hardStop);
  if (res && res.ok) {
    console.log(`make_mixer_goldens: ${res.cases} case(s) written to ${outDir}`);
    finish(0);
  } else {
    console.error(`make_mixer_goldens: FAILED: ${res && res.error}`);
    finish(1);
  }
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
  win.loadURL(page.href);
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error(`make_mixer_goldens: renderer gone (${d.reason})`);
    finish(4);
  });
});

app.on('window-all-closed', () => app.exit(exitCode));
