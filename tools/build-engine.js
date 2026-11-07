// Builds libopenmix, the native audio engine (native/engine). SPEC.md §18.
//   npm run build:engine                      openmix_engine.node for the Electron in use (cmake-js, x64, Release)
//   node tools/build-engine.js --tests        every module test (Debug) in native/engine/build-tests + ctest
//   node tools/build-engine.js --module mixer ONE module: its own folder build-tests-mixer, only the
//                                             target om_test_mixer (and what it links), its test only
//   node tools/build-engine.js --portable [--module m]   the portable set only (no src/*/win/ library)
//   node tools/build-engine.js --sanitize address [--module m]   AddressSanitizer test build
//   node tools/build-engine.js --all          the .node and every test
// Options: --config Debug|Release (the .node), --rt-trap (count audio-thread
// allocations and frees in the .node), --jobs N (default 2: the PC is
// shared), --no-vst, --filter <name> (ctest -R), --no-wait (fail at once when
// another build holds the lock), --node-out <dir> (build folder of the .node,
// default native/engine/build: an engineer's private .node goes elsewhere),
// --clang-cl (portable test set with Visual Studio's clang-cl toolset:
// build-tests-clangcl[-<m>]), --source <dir> (build a private copy of
// native/engine, same lock / priority / lint).
// Needs: Visual Studio 2022 with the C++ workload (or clang / gcc outside
// Windows: portable set only), CMake >= 3.25.
// Downloads NOTHING: the VST3 SDK must already be in native/vst3sdk (else the
// engine is built without VST3), node-addon-api and cmake-js come from
// node_modules, the Electron headers from the cmake-js cache.
// Shared PC: the build runs at BELOW-NORMAL priority (child processes
// inherit it), with a few parallel projects, ONE engine build at a time on
// the PC (native/engine/.build.lock), after the RT lint (SPEC.md §18.6).
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const realEngineDir = path.join(root, 'native', 'engine');
const sdkDir = path.join(root, 'native', 'vst3sdk');
// ONE engine build at a time on the PC: the lock always lives in the real
// tree, also for builds of a private copy (--source).
const lockPath = path.join(realEngineDir, '.build.lock');
const MODULES = ['core', 'device', 'decoder', 'deck', 'mixer', 'fx', 'sync', 'vst'];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
// --source <dir>: build a private copy of native/engine (an integrator's
// snapshot while other modules are being edited); its build folders are
// created inside that copy. The VST3 SDK is still native/vst3sdk.
const engineDir = path.resolve(root, opt('--source', realEngineDir));
const jobs = String(Math.max(1, Number(opt('--jobs', 2)) || 2));
const config = opt('--config', 'Release');
const moduleName = opt('--module', null);
const sanitize = opt('--sanitize', '');
const clangCl = has('--clang-cl');
const portable = has('--portable') || clangCl || process.platform !== 'win32';
const nodeOut = path.resolve(root, opt('--node-out', path.join('native', 'engine', 'build')));
const wantTests = has('--tests') || has('--all') || !!moduleName || has('--portable') || clangCl || !!sanitize;
const wantNode = !wantTests || has('--all');

if (moduleName && !MODULES.includes(moduleName)) {
  console.error(`Unknown module "${moduleName}" (one of: ${MODULES.join(', ')})`);
  process.exit(2);
}
if (sanitize && !['address', 'thread', 'undefined', 'realtime'].includes(sanitize)) {
  console.error(`Unknown sanitizer "${sanitize}" (address | thread | undefined | realtime)`);
  process.exit(2);
}

const fwd = (p) => p.split(path.sep).join('/');  // CMake wants forward slashes

function run(cmd, cmdArgs, cwd) {
  console.log(`> ${cmd} ${cmdArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  // (no shell: the paths contain spaces — "Turbo mix", "Program Files")
  execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// One engine build at a time on the PC (8 engineers share one worktree).
// ---------------------------------------------------------------------------
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function takeLock() {
  const what = moduleName ? `--module ${moduleName}` : (wantTests ? '--tests' : 'node');
  const deadline = Date.now() + 30 * 60 * 1000;
  let announced = false;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, what, since: new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      /* being written: retry */
    }
    if (holder && !pidAlive(holder.pid)) {
      console.log(`Taking over a stale build lock (pid ${holder.pid} is gone).`);
      try { fs.unlinkSync(lockPath); } catch { /* raced */ }
      continue;
    }
    if (has('--no-wait')) {
      console.error(`Another engine build is running (${holder ? `pid ${holder.pid}, ${holder.what}, since ${holder.since}` : 'unknown'}).`);
      process.exit(3);
    }
    if (Date.now() > deadline) {
      console.error('Gave up waiting for the build lock after 30 minutes.');
      process.exit(3);
    }
    if (!announced) {
      console.log(`Waiting for another engine build (${holder ? `pid ${holder.pid}, ${holder.what}` : '?'})...`);
      announced = true;
    }
    sleepMs(5000);
  }
}
function releaseLock() {
  try {
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (holder.pid === process.pid) fs.unlinkSync(lockPath);
  } catch {
    /* nothing to release */
  }
}

// ---------------------------------------------------------------------------
// RT lint (SPEC.md §18.6): the allocation trap only sees operator new/delete.
// ---------------------------------------------------------------------------
function rtLint() {
  const banned = /\b(malloc|calloc|realloc|free|_aligned_malloc|_aligned_free|HeapAlloc|HeapFree|HeapReAlloc|VirtualAlloc|VirtualFree|LocalAlloc|GlobalAlloc|strdup|_strdup)\s*\(/;
  const exempt = new Set([path.join('src', 'node', 'rt_trap.cpp')]);
  const problems = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c|cc|cpp|h|hpp)$/.test(e.name)) {
        const rel = path.relative(engineDir, p);
        if (exempt.has(rel)) continue;
        fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '');
          if (banned.test(code) && !/rt-lint:\s*allow/.test(line)) problems.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
  };
  walk(path.join(engineDir, 'src'));
  walk(path.join(engineDir, 'include'));
  if (problems.length) {
    console.error('RT lint: direct heap calls are invisible to the allocation trap (SPEC.md §18.6).');
    console.error('Use new/delete or containers, or mark the line "// rt-lint: allow (<reason>)":');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(4);
  }
  console.log('RT lint: OK');
}

try {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  /* not allowed: keep the default priority */
}

const withVst = !has('--no-vst') && !portable && !sanitize &&
  fs.existsSync(path.join(sdkDir, 'public.sdk', 'source', 'vst', 'hosting', 'module.h'));
if (!withVst && !has('--no-vst') && !portable && !sanitize) {
  console.log('VST3 SDK not found in native/vst3sdk: building WITHOUT the VST3 host (run npm run build:vst once to fetch it).');
}

takeLock();
process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(130));
try {
  if (wantNode) {
    if (process.platform !== 'win32') {
      console.log('openmix_engine.node is Windows-only for now: skipped.');
    } else {
      const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
      const cmakeJs = path.join(root, 'node_modules', 'cmake-js', 'bin', 'cmake-js');
      const cmakeArgs = [
        cmakeJs,
        'compile',
        '--directory', engineDir,
        '--out', nodeOut,
        '--runtime', 'electron',
        '--runtime-version', electronVersion,
        '--arch', 'x64',
        '--config', config,
        '--parallel', jobs,
        `--CDOM_WITH_VST=${withVst ? 'ON' : 'OFF'}`,
        `--CDOM_RT_TRAP=${has('--rt-trap') ? 'ON' : 'OFF'}`,
        // explicit: the source tree may be a private copy (--source) outside the repository
        `--CDNODE_ADDON_API_DIR=${fwd(path.join(root, 'node_modules', 'node-addon-api'))}`,
        `--CDOM_VST3_SDK_ROOT=${fwd(sdkDir)}`
      ];
      run(process.execPath, cmakeArgs, root);
      const out = path.join(nodeOut, config, 'openmix_engine.node');
      if (!fs.existsSync(out)) {
        console.error(`Build finished but ${out} is missing.`);
        process.exit(1);
      }
      console.log(`Native engine built: ${path.relative(root, out)}`);
    }
  }

  if (wantTests) {
    rtLint();
    let dirName = 'build-tests';
    if (clangCl) dirName += '-clangcl';
    else if (portable && process.platform === 'win32') dirName += '-portable';
    if (moduleName) dirName += `-${moduleName}`;
    if (sanitize) dirName += `-${sanitize === 'address' ? 'asan' : sanitize}`;
    const testDir = path.join(engineDir, dirName);
    // The VST3 SDK is configured only where it is used (core, vst).
    const vstHere = withVst && (!moduleName || moduleName === 'core' || moduleName === 'vst');
    const configure = ['-S', engineDir, '-B', testDir];
    if (process.platform === 'win32') configure.push('-G', 'Visual Studio 17 2022', '-A', 'x64');
    if (clangCl) configure.push('-T', 'ClangCL');
    configure.push(
      '-DOM_BUILD_TESTS=ON',
      `-DOM_WITH_VST=${vstHere ? 'ON' : 'OFF'}`,
      `-DOM_PORTABLE_ONLY=${portable ? 'ON' : 'OFF'}`,
      `-DOM_SANITIZE=${sanitize}`,
      `-DOM_TEST_MODULES=${moduleName || MODULES.join(';')}`
    );
    if (process.platform !== 'win32') configure.push('-DCMAKE_BUILD_TYPE=Debug');
    if (engineDir !== realEngineDir) configure.push(`-DOM_VST3_SDK_ROOT=${sdkDir}`);
    run('cmake', configure, root);
    const build = ['--build', testDir, '--config', 'Debug', '--parallel', jobs];
    if (moduleName) build.push('--target', `om_test_${moduleName}`);
    run('cmake', build, root);
    const ctestArgs = ['--test-dir', testDir, '-C', 'Debug', '--output-on-failure'];
    const filter = moduleName ? `^${moduleName}$` : opt('--filter', null);
    if (filter) ctestArgs.push('-R', filter);
    run('ctest', ctestArgs, root);
    console.log('Engine module tests passed (TODO tests are listed in each executable\'s output; OM_TEST_STRICT=1 makes them fail).');
  }
} catch (e) {
  console.error(e && e.message ? e.message : String(e));
  process.exitCode = 1;
}
