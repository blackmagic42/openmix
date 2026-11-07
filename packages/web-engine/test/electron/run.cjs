// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

'use strict';

// Electron runner for the silent browser suite (test/browser/) and a smoke
// test of the demo (example/). Use it on machines that have Electron but
// should not launch a desktop browser; scripts/test-browser.js is the
// headless-Chrome equivalent for the suite.
//
//   electron test/electron/run.cjs [--suite-only | --demo-only] [--only a,b]
//                                  [--json <file>] [--timeout <seconds>]
//
// or from a throwaway Electron app:
//
//   require('<package>/test/electron/run.cjs').main({ json: 'report.json' });
//
// Remove ELECTRON_RUN_AS_NODE from the environment first, or Electron starts
// as plain Node and `app` is undefined.
//
// Never with the OpenMix app's own Electron (DESIGN §2.3: its path matches
// the owner's kill-by-path rule), nor through a junction or a symbolic link
// to it — a worktree's node_modules can be a junction to the app's. The runner
// refuses (exit code 2) when the real path of its Electron binary goes
// through an `openmix` folder. Use `npm run test:browser`, or an Electron
// copied outside the OpenMix tree.
//
// Safety and silence, by construction:
// - the window is never shown, audio output is muted (--mute-audio and
//   webContents.setAudioMuted), and the GPU is not used;
// - the suite renders into OfflineAudioContexts only (test/browser/suite.js
//   forbids realtime contexts);
// - the demo runs with ?silent=1 (master and headphone volumes at 0) and a
//   Chrome-like autoplay policy, so its AudioContext only starts after the
//   synthetic click on "Start audio";
// - the package is served by scripts/serve.js on an ephemeral 127.0.0.1 port
//   (ports 8722 and 9333 are refused), in an in-memory session, with a
//   temporary profile deleted at the end.
//
// Exit codes: 0 = everything passed, 1 = failures, 2 = infrastructure error.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const RESERVED_PORTS = [8722, 9333];

let electron = null;
try {
  electron = require('electron');
} catch {
  electron = null;
}
const app = electron && typeof electron === 'object' ? electron.app : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Why this Electron must not run the tests (null when it may): its binary is
 * the OpenMix app's, reached directly or through a junction / symbolic link.
 * The real path is needed: a worktree's node_modules can be a junction to the
 * app's node_modules.
 * @param {string} [execPath] default: process.execPath
 * @returns {string | null}
 */
function refusalReason(execPath = process.execPath) {
  const paths = [execPath];
  for (const resolve of [fs.realpathSync, fs.realpathSync.native]) {
    try {
      if (typeof resolve === 'function') paths.push(resolve(execPath));
    } catch {
      // unreadable: the given path is still checked
    }
  }
  const bad = paths.find((p) => String(p).split(/[\\/]+/).some((s) => s.toLowerCase() === 'openmix'));
  if (!bad) return null;
  return `Refusing to run the OpenMix app's Electron (${bad}): use npm run test:browser, `
    + 'or an Electron copied outside the OpenMix tree';
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--suite-only') out.suiteOnly = true;
    else if (a === '--demo-only') out.demoOnly = true;
    else if (a === '--only') out.only = next();
    else if (a === '--json') out.json = next();
    else if (a === '--timeout') out.timeout = Number(next());
    else if (a === '--profile') out.profileDir = next();
    else if (a === '--eval') out.evalFile = next();
    else if (a === '--eval-page') out.evalPage = next();
  }
  return out;
}

// Pre-ready settings: must run synchronously when the module loads.
// profileDir: where Electron keeps its (throwaway) profile; default: a fresh
// temporary folder. The browser process holds files in it until it exits, so
// the caller deletes it afterwards (its path is printed and put in the report).
let prepared = null;
function prepare(profileDir) {
  if (prepared) return prepared;
  // refused (see refusalReason): no switch, no profile; main() says why
  if (!app || refusalReason()) return null;
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  app.commandLine.appendSwitch('mute-audio');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.disableHardwareAcceleration();
  let profile = profileDir ? path.resolve(profileDir) : null;
  if (profile) fs.mkdirSync(profile, { recursive: true });
  else profile = fs.mkdtempSync(path.join(os.tmpdir(), 'openmix-webengine-electron-'));
  app.setPath('userData', profile);
  try { app.setPath('sessionData', profile); } catch { /* older Electron */ }
  // windows are closed by the runner; quitting is explicit
  app.on('window-all-closed', () => {});
  prepared = { profile };
  return prepared;
}

/**
 * Runs the suite and the demo smoke test, prints a report, then exits the app.
 * @param {{ suiteOnly?: boolean, demoOnly?: boolean, only?: string, json?: string,
 *   timeout?: number }} [options] timeout = global limit in seconds (default 300)
 */
async function main(options = {}) {
  const o = { ...parseArgs(process.argv.slice(1)), ...options };
  if (!app) {
    console.error('test/electron/run.cjs must run inside Electron (and without ELECTRON_RUN_AS_NODE).');
    process.exitCode = 2;
    return;
  }
  // Before anything else (no profile, no server, no window): never the
  // OpenMix app's Electron, even through a junction (DESIGN §2.3)
  const refusal = refusalReason();
  if (refusal) {
    console.error(refusal);
    process.exitCode = 2;
    app.exit(2);
    return;
  }
  const state = prepare(o.profileDir);
  const out = (line) => process.stdout.write(`${line}\n`);
  const report = {
    startedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    profile: state.profile,
    suite: null,
    demo: null,
    infraError: null
  };
  let server = null;
  let win = null;
  let exitCode = 2;
  const limit = Number.isFinite(o.timeout) && o.timeout > 0 ? o.timeout : 300;
  const watchdog = setTimeout(() => {
    out(`[runner] global timeout after ${limit} s`);
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* nothing */ }
    app.exit(2);
  }, limit * 1000);

  try {
    await app.whenReady();
    const { startServer } = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'scripts', 'serve.js')).href);
    server = await startServer({ root: PACKAGE_ROOT, host: '127.0.0.1', port: 0 });
    if (RESERVED_PORTS.includes(server.port)) throw new Error(`refusing reserved port ${server.port}`);
    out(`[runner] Electron ${process.versions.electron} (Chrome ${process.versions.chrome}), serving ${server.root} at ${server.url}`);

    const { BrowserWindow, session } = electron;
    const ses = session.fromPartition(`webengine-test-${process.pid}-${Date.now()}`); // in memory
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
        // like a desktop browser: audio only starts after a user gesture
        autoplayPolicy: 'document-user-activation-required'
      }
    });
    win.webContents.setAudioMuted(true);

    const consoleLog = [];
    let phase = 'boot';
    win.webContents.on('console-message', (...args) => {
      const e = args[0];
      let level;
      let message;
      let line;
      let source;
      if (e && typeof e === 'object' && typeof e.message === 'string' && e.level !== undefined) {
        ({ level, message, lineNumber: line, sourceId: source } = e);
      } else {
        level = ['verbose', 'info', 'warning', 'error'][args[1]] || String(args[1]);
        message = args[2];
        line = args[3];
        source = args[4];
      }
      consoleLog.push({ phase, level: String(level), message: String(message), source: source || '', line: line || 0 });
    });
    let crashed = null;
    win.webContents.on('render-process-gone', (_e, details) => {
      crashed = details && details.reason ? details.reason : 'gone';
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      consoleLog.push({ phase, level: 'error', message: `did-fail-load ${code} ${desc} ${url}`, source: url, line: 0 });
    });

    const js = (code, userGesture = false) => win.webContents.executeJavaScript(code, userGesture);
    const waitFor = async (code, timeoutMs, intervalMs = 250) => {
      const t0 = Date.now();
      for (;;) {
        if (crashed) throw new Error(`renderer crashed (${crashed})`);
        let v = null;
        try {
          v = await js(code);
        } catch {
          v = null; // page navigating
        }
        if (v) return v;
        if (Date.now() - t0 > timeoutMs) return null;
        await sleep(intervalMs);
      }
    };
    const messagesOf = (p, levels) => consoleLog.filter((m) => m.phase === p && levels.includes(m.level));

    // -------------------------------------------------------------- eval ----
    // --eval <file>: the body of an async function, run in the suite page
    // (with no test running); it can import '/src/index.js' and the test
    // helpers ('/test/browser/signals.js', '/test/browser/measure.js'). Its
    // return value is printed as JSON. For investigations.
    // --eval-page <path>: run it in another page of the package instead
    // (e.g. '/example/?silent=1', once the demo is ready). It runs as a user
    // gesture, so it may start audio.
    if (o.evalFile) {
      phase = 'eval';
      const body = fs.readFileSync(path.resolve(o.evalFile), 'utf8');
      await win.loadURL(`${server.url}${o.evalPage || '/test/browser/?only=none'}`);
      await waitFor(o.evalPage
        ? `document.readyState === 'complete' && (window.__demoReady || !document.getElementById('btn-start')) ? 1 : null`
        : 'window.__TEST_RESULTS__ && window.__TEST_RESULTS__.done ? 1 : null', 20000);
      let result;
      try {
        result = await js(`(async () => { ${body}\n })().then((v) => JSON.stringify(v), (e) => JSON.stringify({ evalError: String(e && e.stack || e) }))`, true);
      } catch (e) {
        result = JSON.stringify({ evalError: String(e) });
      }
      report.eval = JSON.parse(result || 'null');
      out(`[eval] ${result}`);
      for (const m of messagesOf('eval', ['error', 'warning'])) out(`[eval console.${m.level}] ${m.message}`);
      exitCode = report.eval && report.eval.evalError ? 1 : 0;
      return;
    }

    // ------------------------------------------------------------- suite ----
    if (!o.demoOnly) {
      phase = 'suite';
      const query = o.only ? `?only=${encodeURIComponent(o.only)}` : '';
      const t0 = Date.now();
      await win.loadURL(`${server.url}/test/browser/${query}`);
      let lastTitle = '';
      const results = await (async () => {
        for (;;) {
          if (crashed) throw new Error(`renderer crashed during the suite (${crashed})`);
          const title = win.webContents.getTitle();
          if (title !== lastTitle) {
            lastTitle = title;
            out(`[suite] ${title}`);
          }
          const raw = await js('(() => { const r = window.__TEST_RESULTS__; return r && r.done ? JSON.stringify(r) : null; })()')
            .catch(() => null);
          if (raw) return JSON.parse(raw);
          if (Date.now() - t0 > (limit - 30) * 1000) return null;
          await sleep(500);
        }
      })();
      const wallMs = Date.now() - t0;
      if (!results) {
        report.suite = { done: false, wallMs, error: 'the suite did not finish in time', console: messagesOf('suite', ['error', 'warning']) };
        out('[suite] TIMEOUT');
      } else {
        report.suite = { ...results, wallMs, console: messagesOf('suite', ['error', 'warning']) };
        for (const r of results.results) {
          const status = r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
          const metrics = Object.entries(r.metrics || {})
            .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`).join(' ');
          out(`[suite] ${status} ${r.name}${r.error ? ` -- ${r.error}` : ''}`);
          if (metrics) out(`        ${metrics}`);
        }
        out(`[suite] ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped in ${(wallMs / 1000).toFixed(1)} s`);
      }
      for (const m of messagesOf('suite', ['error'])) out(`[suite console.error] ${m.message}`);
    }

    // -------------------------------------------------------------- demo ----
    if (!o.suiteOnly) {
      phase = 'demo-load';
      const demo = { checks: {}, metrics: {} };
      report.demo = demo;
      await win.loadURL(`${server.url}/example/?silent=1`);
      const booted = await waitFor(
        `(() => { if (window.__demoReady) return 'ready';
          const n = document.getElementById('notice');
          return n && !n.hidden ? 'notice: ' + n.textContent : null; })()`, 20000);
      demo.boot = booted || 'timeout';
      await sleep(1500); // first frames, and any late error
      demo.checks.boots = booted === 'ready';
      const silentState = booted === 'ready' ? JSON.parse(await js(`JSON.stringify({
          state: engine.context.state, masterVolume: engine.masterVolume, headphoneVolume: engine.headphoneVolume,
          pitchEngine: engine.pitchEngine, pitchEngineError: engine.pitchEngineError && String(engine.pitchEngineError.message),
          sampleRate: engine.context.sampleRate, decks: engine.decks.length,
          silentBadge: !document.getElementById('silent-badge').hidden })`)) : null;
      demo.atLoad = silentState;
      demo.checks.silentMode = !!silentState && silentState.masterVolume === 0 && silentState.headphoneVolume === 0;
      demo.checks.noConsoleErrorsAtLoad = messagesOf('demo-load', ['error']).length === 0;

      if (booted === 'ready') {
        phase = 'demo-play';
        // "Start audio", then "Load demo set", as a user would (synthetic user gestures)
        await js(`document.getElementById('btn-start').click()`, true);
        demo.metrics.contextAfterStart = await waitFor(`engine.context.state === 'running' ? 'running' : null`, 5000) || 'not running';
        await js(`document.getElementById('btn-demo-set').click()`, true);
        const t0 = Date.now();
        const loaded = await waitFor(
          `(() => { const [a, b] = engine.decks; return a.loaded && b.loaded && !document.getElementById('btn-demo-set').disabled ? 'yes' : null; })()`,
          120000, 500);
        demo.metrics.demoSetMs = Date.now() - t0;
        demo.checks.demoSetLoads = loaded === 'yes';
        if (loaded === 'yes') {
          await js(`document.querySelector('#deck-slot-0 .btn.play').click()`, true);
          await sleep(1200);
          await js(`document.querySelector('#deck-slot-1 .btn.sync').click(); document.querySelector('#deck-slot-1 .btn.play').click();`, true);
          await sleep(5000);
          const play = JSON.parse(await js(`(async () => {
            const m = await import('/src/index.js');
            const [a, b] = engine.decks;
            const phase = [];
            for (let k = 0; k < 8; k++) {
              const fa = m.gridIndexFracAt(a, a.position);
              const fb = m.gridIndexFracAt(b, b.position);
              if (fa != null && fb != null) {
                let d = (fb - Math.floor(fb)) - (fa - Math.floor(fa));
                d -= Math.round(d);
                phase.push(d * (b.beatDuration || 0.5) * 1000);
              }
              await new Promise((r) => setTimeout(r, 120));
            }
            const deckState = (d) => ({ loaded: d.loaded, playing: d.playing, synced: d.synced, bpm: d.bpm,
              effectiveBpm: d.effectiveBpm && Math.round(d.effectiveBpm * 1000) / 1000,
              baseTempo: Math.round(d.baseTempo * 1e6) / 1e6, key: m.keyName(d.musicKey), camelot: m.camelotLabel(d.musicKey),
              position: Math.round(d.position * 1000) / 1000, beats: d.beats ? d.beats.length : 0,
              meter: Math.round(d.meterPeak() * 1000) / 1000 });
            const zoom = document.querySelector('#waves canvas.zoom');
            let drawn = false;
            try {
              const c = zoom.getContext('2d');
              const img = c.getImageData(0, 0, zoom.width, zoom.height).data;
              for (let i = 3; i < img.length; i += 16) if (img[i]) { drawn = true; break; }
            } catch (e) { drawn = 'error: ' + e.message; }
            return JSON.stringify({ state: engine.context.state, masterIndex: engine.masterIndex,
              masterBpm: engine.masterBpm && Math.round(engine.masterBpm * 1000) / 1000,
              masterPeak: engine.masterPeak(), decks: [deckState(a), deckState(b)], phaseMs: phase.map((x) => Math.round(x * 100) / 100),
              zoomCanvas: { width: zoom.width, height: zoom.height, drawn },
              status: [...document.querySelectorAll('.deck-status')].slice(0, 2).map((e) => e.textContent) });
          })()`, true));
          demo.afterPlay = play;
          const [a, b] = play.decks;
          demo.checks.decksPlay = a.playing && b.playing;
          demo.checks.followerSynced = b.synced === true && play.masterIndex === 0;
          demo.checks.sameEffectiveBpm = a.effectiveBpm != null && Math.abs(a.effectiveBpm - b.effectiveBpm) < 0.01;
          demo.checks.phaseLockedSmoke = play.phaseMs.length > 0 && play.phaseMs.every((x) => Math.abs(x) < 5);
          demo.checks.zoomDrawn = play.zoomCanvas.drawn === true && play.zoomCanvas.width > 0;
          demo.checks.silentMaster = play.masterPeak === 0;

          // The UI handlers a user touches first (still silent): FX ON, a
          // 4-beat loop and EXIT, a hot cue set then jump, KEYLOCK on the
          // synced deck, pad FX held (roll, echo, brake), a color-FX mode,
          // the recording stream
          phase = 'demo-ui';
          const ui = JSON.parse(await js(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const q = (sel) => { const el = document.querySelector(sel); if (!el) throw new Error('missing ' + sel); return el; };
            const press = async (el, ms) => {
              el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 7, bubbles: true }));
              await wait(ms);
              el.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 7, bubbles: true }));
            };
            const [a, b] = engine.decks;
            const out = {};
            let ticks = 0;
            const off = engine.on('tick', () => { ticks++; });
            await wait(1000);
            off();
            out.ticksPerSecond = ticks;
            q('#fx .fx-unit .fx-on').click();
            out.fx1 = { enabled: engine.fx[0].enabled, level: engine.fx[0].level, type: engine.fx[0].type };
            q('#deck-slot-0 [aria-label="4 beat loop"]').click();
            out.loop = { active: a.loop.active, beats: a.loop.beats };
            await wait(600);
            [...document.querySelectorAll('#deck-slot-0 .btn')].find((x) => x.textContent === 'EXIT').click();
            out.loopAfterExit = a.loop.active;
            const hc = q('#deck-slot-1 .hotcue');
            hc.click();
            out.hotCue = b.hotCues[0];
            await wait(300);
            hc.click();
            q('#deck-slot-1 .btn.keylock').click();
            out.keylock = b.keylock;
            const pads = [...document.querySelectorAll('.pad-bank .btn.pad')];
            const pad = (label) => pads.find((p) => p.textContent === label);
            await press(pad('ROLL ½'), 700);
            out.rollAfter = a.roll;
            await press(pad('ECHO ½'), 700);
            out.padFxAfter = a.padFx;
            await press(pad('V.BRAKE'), 900);
            out.spinningAfter = a.spinning;
            const color = q('#mixer .color-fx select');
            color.value = 'dubecho';
            color.dispatchEvent(new Event('change'));
            out.colorFx = engine.colorFx;
            out.recordingTracks = engine.getRecordingStream().getAudioTracks().length;
            await wait(1000);
            out.playing = [a.playing, b.playing];
            out.synced = b.synced;
            out.masterPeak = engine.masterPeak();
            return JSON.stringify(out);
          })()`, true));
          demo.ui = ui;
          demo.checks.autoTickRuns = ui.ticksPerSecond >= 20;
          demo.checks.uiControls = ui.fx1.enabled === true && ui.fx1.level === 0.5 && ui.loop.active === true
            && ui.loop.beats === 4 && ui.loopAfterExit === false && typeof ui.hotCue === 'number' && ui.keylock === true
            && ui.rollAfter === null && ui.padFxAfter === null && ui.spinningAfter === false && ui.colorFx === 'dubecho'
            && ui.recordingTracks === 1 && ui.playing.every(Boolean) && ui.synced === true && ui.masterPeak === 0;
          await js(`engine.decks.forEach((d) => d.pause())`, true);
          await sleep(300);
        }
      }
      demo.console = consoleLog.filter((m) => m.phase.startsWith('demo') && ['error', 'warning'].includes(m.level));
      demo.checks.noConsoleErrors = consoleLog.filter((m) => m.phase.startsWith('demo') && m.level === 'error').length === 0;
      for (const [k, v] of Object.entries(demo.checks)) out(`[demo] ${v ? 'PASS' : 'FAIL'} ${k}`);
      out(`[demo] boot=${demo.boot} ${JSON.stringify(demo.metrics)}`);
      if (demo.atLoad) out(`[demo] at load: ${JSON.stringify(demo.atLoad)}`);
      if (demo.afterPlay) out(`[demo] after play: ${JSON.stringify(demo.afterPlay)}`);
      if (demo.ui) out(`[demo] ui: ${JSON.stringify(demo.ui)}`);
      for (const m of demo.console) out(`[demo console.${m.level}] (${m.phase}) ${m.message} ${m.source ? `@ ${m.source}:${m.line}` : ''}`);
    }

    const suiteOk = !report.suite || (report.suite.done && report.suite.failed === 0 && report.suite.passed > 0);
    const demoOk = !report.demo || Object.values(report.demo.checks).every(Boolean);
    exitCode = suiteOk && demoOk ? 0 : 1;
  } catch (e) {
    report.infraError = String((e && e.stack) || e);
    out(`[runner] infrastructure error: ${report.infraError}`);
    exitCode = 2;
  } finally {
    clearTimeout(watchdog);
    report.exitCode = exitCode;
    report.finishedAt = new Date().toISOString();
    if (o.json) {
      try {
        fs.writeFileSync(path.resolve(o.json), JSON.stringify(report, null, 2));
      } catch (e) {
        out(`[runner] could not write ${o.json}: ${e.message}`);
      }
    }
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* nothing */ }
    try { if (server) await server.close(); } catch { /* nothing */ }
    out(`[runner] profile ${state.profile} (delete it once Electron has exited)`);
    out(`[runner] exit ${exitCode}`);
    app.exit(exitCode);
  }
}

module.exports = { main, prepare, refusalReason, PACKAGE_ROOT };

// Run directly (`electron test/electron/run.cjs`): pre-ready switches now
if (require.main === module) {
  prepare(parseArgs(process.argv.slice(1)).profileDir);
  main();
}
