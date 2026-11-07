// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Headless runner for test/browser (DESIGN §10.3). Zero dependencies, Node ≥ 22
// (global WebSocket and fetch).
//
//   node scripts/test-browser.js [--browser <path>] [--dry-run] [--timeout <s>]
//
// 1. Starts the static server in-process on an ephemeral port.
// 2. Finds a Chromium-family browser: --browser, CHROME_PATH, then the usual
//    Chrome / Edge / Chromium install locations. Never an Electron binary, never
//    anything inside node_modules or an openmix checkout.
// 3. Launches it headless and MUTED, on a fresh temporary profile, with
//    --remote-debugging-port=0, and reads the port from DevToolsActivePort.
// 4. Drives the page over the DevTools protocol, polls window.__TEST_RESULTS__
//    (120 s timeout) and prints one line per test, then a summary.
// 5. Exit codes: 0 = all passed, 1 = failures or timeout, 2 = infrastructure
//    error (no browser, no server, no DevTools connection…).
// 6. Cleanup always runs: CDP closed, ONLY the spawned child is stopped (through
//    its own handle, never by name), temporary profile deleted, server closed.
//
// --dry-run prints the chosen browser and the suite URL, checks that the page
// is served, and exits without launching anything.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, RESERVED_PORTS } from './serve.js';

const DEFAULT_TIMEOUT_S = 120;
const POLL_MS = 500;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INFRA = 2;

class InfraError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------ arguments ----

function parseArgs(argv) {
  const out = { browser: null, dryRun: false, help: false, timeout: DEFAULT_TIMEOUT_S };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : null;
    const value = () => {
      if (inline != null) return inline;
      const v = argv[i + 1];
      if (v == null) throw new InfraError(`Missing value for ${name}`);
      i++;
      return v;
    };
    if (name === '--browser') out.browser = value();
    else if (name === '--dry-run') out.dryRun = true;
    else if (name === '--timeout') out.timeout = Number(value());
    else if (name === '--help' || name === '-h') out.help = true;
    else throw new InfraError(`Unknown option: ${arg}`);
  }
  if (!(out.timeout > 0)) throw new InfraError('--timeout must be a positive number of seconds');
  return out;
}

const USAGE = `Usage: node scripts/test-browser.js [--browser <path>] [--dry-run] [--timeout <seconds>]

Runs test/browser/ in a headless, muted Chromium-family browser.
  --browser   browser executable (default: CHROME_PATH, then Chrome / Edge / Chromium)
  --dry-run   print the chosen browser and the suite URL, launch nothing
  --timeout   suite timeout in seconds (default ${DEFAULT_TIMEOUT_S})
Exit codes: 0 all passed, 1 failures or timeout, 2 infrastructure error.`;

// ------------------------------------------------------- browser lookup ----

function browserCandidates() {
  const env = process.env;
  const list = [];
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const rel = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
      ['Google', 'Chrome Beta', 'Application', 'chrome.exe'],
      ['Google', 'Chrome SxS', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge Beta', 'Application', 'msedge.exe'],
      ['Microsoft', 'Edge Dev', 'Application', 'msedge.exe']
    ];
    for (const parts of rel) for (const root of roots) list.push(path.join(root, ...parts));
  } else if (process.platform === 'darwin') {
    const apps = ['/Applications', path.join(os.homedir(), 'Applications')];
    const rel = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Chromium.app/Contents/MacOS/Chromium',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
    ];
    for (const r of rel) for (const a of apps) list.push(path.join(a, r));
  } else {
    const names = [
      'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser',
      'microsoft-edge-stable', 'microsoft-edge'
    ];
    const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const n of names) for (const d of dirs) list.push(path.join(d, n));
    list.push('/snap/bin/chromium', '/opt/google/chrome/chrome', '/opt/microsoft/msedge/msedge');
  }
  return list;
}

/** Why a path must never be launched (null when it is acceptable). */
function refusalReason(file) {
  const segs = path.resolve(file).split(/[\\/]+/).map((s) => s.toLowerCase());
  const base = segs[segs.length - 1] || '';
  if (/^electron(\.exe|\.app)?$/.test(base) || base.startsWith('openmix')) {
    return 'it is an Electron / OpenMix binary';
  }
  if (segs.includes('node_modules')) return 'it lives inside node_modules';
  if (segs.includes('openmix')) return 'it lives inside an openmix checkout';
  return null;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Picks the browser to launch.
 * @returns {{ path: string, source: string }}
 */
function findBrowser(explicit) {
  const pick = (file, source) => {
    const reason = refusalReason(file);
    if (reason) throw new InfraError(`Refusing to launch ${file} (${source}): ${reason}. Pass a Chrome, Edge or Chromium executable.`);
    if (!isFile(file)) throw new InfraError(`Browser not found: ${file} (${source})`);
    return { path: path.resolve(file), source };
  };
  if (explicit) return pick(explicit, '--browser');
  if (process.env.CHROME_PATH) return pick(process.env.CHROME_PATH, 'CHROME_PATH');
  for (const file of browserCandidates()) {
    if (!refusalReason(file) && isFile(file)) return { path: file, source: 'standard location' };
  }
  throw new InfraError('No Chromium-family browser found (Chrome, Edge or Chromium). '
    + 'Pass --browser <path> or set CHROME_PATH, or open /test/browser/ manually from "npm run demo".');
}

function browserFlags(profile) {
  return [
    '--headless=new',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    // A fresh profile would otherwise phone home (updates, sync, field trials):
    // keep the run quiet and offline
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--no-pings',
    '--disable-domain-reliability',
    '--metrics-recording-only',
    'about:blank'
  ];
}

// ------------------------------------------------------------ CDP client ----

class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener('message', (ev) => this._onMessage(ev));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new InfraError('DevTools connection closed'));
      }
      this.pending.clear();
    });
  }

  static connect(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new InfraError('Timed out connecting to DevTools'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new InfraError(`Could not connect to DevTools at ${url}`));
      }, { once: true });
    });
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer, method } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result || {});
      return;
    }
    if (msg.method) for (const fn of this.listeners) fn(msg);
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new InfraError('DevTools connection closed'));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(message));
    });
  }

  onEvent(fn) {
    this.listeners.add(fn);
  }

  close() {
    if (this.closed) return;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// --------------------------------------------------------------- helpers ----

async function waitForDevToolsPort(profile, child, spawnError, timeoutMs = 20000) {
  const file = path.join(profile, 'DevToolsActivePort');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (spawnError()) throw new InfraError(`Could not start the browser: ${spawnError().message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new InfraError(`The browser exited during startup (code ${child.exitCode ?? child.signalCode})`);
    }
    try {
      const [portLine, wsPath] = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && wsPath) {
        if (RESERVED_PORTS.includes(port)) throw new InfraError(`DevTools picked reserved port ${port}`);
        return { port, wsPath: wsPath.trim() };
      }
    } catch (e) {
      if (e instanceof InfraError) throw e;
      // not written yet
    }
    await sleep(100);
  }
  throw new InfraError('Timed out waiting for the browser DevTools port (DevToolsActivePort)');
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function formatMetrics(metrics) {
  if (!metrics) return '';
  return Object.entries(metrics)
    .filter(([k]) => k !== 'testMs')
    .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
    .join(' ');
}

function printResult(r) {
  const status = r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
  const secs = r.metrics && r.metrics.testMs != null ? `${(r.metrics.testMs / 1000).toFixed(1)}s` : '';
  console.log(`${status}  ${r.name.padEnd(18)} ${secs.padStart(6)}  ${formatMetrics(r.metrics)}`);
  if (r.error) console.log(`      ${r.error}`);
}

// ------------------------------------------------------------------ main ----

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    return EXIT_INFRA;
  }
  if (args.help) {
    console.log(USAGE);
    return EXIT_PASS;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    console.error(`test-browser: Node ${process.versions.node} has no global WebSocket (Node ≥ 22 is required)`);
    return EXIT_INFRA;
  }

  let server = null;
  let child = null;
  let profile = null;
  let cdp = null;
  let stderrTail = [];
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (cdp) {
      // Graceful shutdown first: the browser closes all its own processes
      try { await cdp.send('Browser.close', {}, undefined, 3000); } catch { /* already gone */ }
      cdp.close();
    }
    if (child) {
      if (!(await waitForExit(child, 5000))) {
        child.kill(); // ONLY the process we spawned, through its handle
        if (!(await waitForExit(child, 5000))) child.kill('SIGKILL');
      }
    }
    if (profile) {
      try {
        await fsp.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (e) {
        console.error(`test-browser: could not delete the temporary profile ${profile}: ${e.message}`);
      }
    }
    if (server) await server.close();
  };

  const onSignal = () => {
    console.error('test-browser: interrupted, cleaning up…');
    cleanup().finally(() => process.exit(EXIT_INFRA));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    server = await startServer({ port: 0 });
    const url = `${server.url}/test/browser/`;

    if (args.dryRun) {
      const res = await fetch(url);
      const page = await res.text();
      const served = res.ok && page.includes('suite.js');
      console.log(`url      ${url}`);
      console.log(`page     ${served ? 'served' : `NOT served (HTTP ${res.status})`}`);
      const browser = findBrowser(args.browser); // no browser: InfraError, exit code 2
      console.log(`browser  ${browser.path}  (${browser.source})`);
      console.log(`flags    ${browserFlags('<temporary profile>').join(' ')}`);
      console.log('dry run: no browser launched');
      return served ? EXIT_PASS : EXIT_INFRA;
    }

    const browser = findBrowser(args.browser);

    profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'openmix-webengine-test-'));
    child = spawn(browser.path, browserFlags(profile), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let spawnError = null;
    child.on('error', (e) => { spawnError = e; }); // reported through waitForDevToolsPort
    child.stderr.on('data', (d) => {
      stderrTail.push(...String(d).split(/\r?\n/).filter(Boolean));
      if (stderrTail.length > 30) stderrTail = stderrTail.slice(-30);
    });

    const { port, wsPath } = await waitForDevToolsPort(profile, child, () => spawnError);
    cdp = await Cdp.connect(`ws://127.0.0.1:${port}${wsPath}`);
    const version = await cdp.send('Browser.getVersion').catch(() => ({}));
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    cdp.onEvent((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        console.log(`  [page exception] ${(d.exception && d.exception.description) || d.text || 'unknown'}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        console.log(`  [console.${msg.params.type}] ${text}`);
      }
    });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    console.log(`browser  ${version.product || path.basename(browser.path)} (headless, muted)`);
    console.log(`suite    ${url}`);
    const nav = await cdp.send('Page.navigate', { url }, sessionId);
    if (nav.errorText) throw new InfraError(`Navigation failed: ${nav.errorText}`);

    const t0 = Date.now();
    const deadline = t0 + args.timeout * 1000;
    let printed = 0;
    let state = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new InfraError('The browser exited during the run');
      let value = null;
      try {
        const res = await cdp.send('Runtime.evaluate', {
          expression: 'window.__TEST_RESULTS__ ? JSON.stringify(window.__TEST_RESULTS__) : null',
          returnByValue: true
        }, sessionId);
        value = res.result ? res.result.value : null;
      } catch (e) {
        if (e instanceof InfraError) throw e;
        // the page may be navigating: try again
      }
      if (value) {
        state = JSON.parse(value);
        const results = state.results || [];
        while (printed < results.length) printResult(results[printed++]);
        if (state.done) break;
      }
      await sleep(POLL_MS);
    }

    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    if (!state || !state.done) {
      console.log(`TIMEOUT after ${args.timeout} s (${state ? (state.results || []).length : 0} test(s) finished)`);
      return EXIT_FAIL;
    }
    console.log(`${state.passed} passed, ${state.failed} failed, ${state.skipped} skipped in ${seconds} s`);
    return state.failed === 0 && state.passed > 0 ? EXIT_PASS : EXIT_FAIL;
  } catch (e) {
    console.error(`test-browser: ${e.message}`);
    if (stderrTail.length) console.error(`browser stderr (last lines):\n  ${stderrTail.join('\n  ')}`);
    return e instanceof InfraError || !child ? EXIT_INFRA : EXIT_FAIL;
  } finally {
    await cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

main().then((code) => process.exit(code), (e) => {
  console.error(e);
  process.exit(EXIT_INFRA);
});
