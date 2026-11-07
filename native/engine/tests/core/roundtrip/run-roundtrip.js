// Launcher of the engine host round trip (owner: host; run by the core test
// core_engine_host_round_trip_in_electron, or by hand:
//   node native/engine/tests/core/roundtrip/run-roundtrip.js --module <openmix_engine.node> [--result <file.json>]
// Starts the Electron of node_modules on roundtrip/main.js with
// ELECTRON_RUN_AS_NODE removed and a temporary userData folder: a hidden
// test window, NOT OpenMix (same electron.exe path through the node_modules
// junction: this child is only ever killed through its own handle, on a
// time-out, never by path or by name). Prints the steps and exits 0 when
// every step passed. SPEC.md §6.4, §6.5.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
// The repository: the first parent folder holding engine-main.js (this
// script may run from a copy of the engine tree, e.g. an integrator's snapshot).
function findRepo(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'engine-main.js')) && fs.existsSync(path.join(d, 'package.json'))) return d;
    if (path.dirname(d) === d) return path.resolve(__dirname, '..', '..', '..', '..', '..');
  }
}
const repo = findRepo(__dirname);
const modulePath = path.resolve(opt('--module', path.join(repo, 'native', 'engine', 'build', 'Release', 'openmix_engine.node')));
const resultPath = path.resolve(opt('--result', path.join(os.tmpdir(), 'om-roundtrip-result.json')));

if (!fs.existsSync(modulePath)) {
  console.error(`round trip: no module at ${modulePath}`);
  process.exit(2);
}
let electron;
try {
  electron = require(path.join(repo, 'node_modules', 'electron'));  // from Node: the path of electron.exe
} catch (e) {
  console.error('round trip: Electron not found in node_modules');
  process.exit(2);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;  // the local shell sets it (VS Code): Electron would start as plain Node
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'om-roundtrip-'));
try { fs.unlinkSync(resultPath); } catch { /* none */ }

const t0 = Date.now();
const child = spawn(electron, [path.join(__dirname, 'main.js'), '--module', modulePath, '--result', resultPath, '--user-data', userData], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => {
  const s = d.toString();
  // Chromium's own noise (GPU, cache) is not ours
  if (!/(gpu|cache|Fontconfig|DevTools)/i.test(s)) process.stderr.write(s);
});
const timer = setTimeout(() => {
  console.error(`round trip: time-out after 120 s, ending our own Electron (pid ${child.pid})`);
  child.kill();
}, 120000);

child.on('exit', (code) => {
  clearTimeout(timer);
  let res = null;
  try {
    res = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch {
    /* no result */
  }
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* still in use */ }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!res) {
    console.error(`round trip: Electron exited with ${code} without a result (${secs} s)`);
    process.exit(1);
  }
  for (const s of res.steps || []) console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.info !== undefined ? ' ' + JSON.stringify(s.info) : ''}`);
  if (res.error) console.log(`  error: ${res.error}`);
  console.log(`round trip: ${res.ok ? 'PASSED' : 'FAILED'} in ${secs} s (electron exit ${code})`);
  process.exit(res.ok && code === 0 ? 0 : 1);
});
