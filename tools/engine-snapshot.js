// Per-module patch snapshots of the native engine work (owner: host).
// Eight engineers share one git worktree in which nothing is committed, so a
// destructive git command by one of them (stash, checkout, reset, clean...)
// would wipe everyone's work: those commands are banned there (SPEC.md §1,
// §19.3), and each owner snapshots their module regularly with this script.
//   node tools/engine-snapshot.js --module mixer   -> native/engine/patches/mixer/<timestamp>.patch
//   node tools/engine-snapshot.js --all            -> one patch per module
// A patch holds the module's changes against HEAD (tracked files) plus its
// untracked files as new-file diffs; `git apply` restores it. READ-ONLY for
// git: it never touches the index, the stash or the working tree.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const E = 'native/engine';
// Ownership, as in SPEC.md §19.1 (paths relative to the repository root).
const OWNERS = {
  host: [
    `${E}/include/om/common.h`, `${E}/include/om/om_state.h`, `${E}/include/om/rt.h`, `${E}/include/om/spsc_queue.h`,
    `${E}/include/om/triple_buffer.h`, `${E}/include/om/dsp.h`, `${E}/include/om/grid.h`, `${E}/include/om/media.h`,
    `${E}/include/om/deck_control.h`, `${E}/include/om/commands.h`, `${E}/include/om/protocol.h`, `${E}/include/om/json.h`,
    `${E}/include/om/engine.h`, `${E}/include/om/om_engine.h`, `${E}/src/core`, `${E}/src/json`, `${E}/src/node`,
    `${E}/tests/om_test.h`, `${E}/tests/om_test_main.cpp`, `${E}/tests/core`, `${E}/CMakeLists.txt`, `${E}/SPEC.md`,
    'tools/build-engine.js', 'tools/engine-snapshot.js', 'tools/make-goldens.js', 'tools/goldens', 'package.json',
    'engine-host.js', 'engine-main.js', 'main.js', 'preload.js', '.gitignore'
  ],
  device: [`${E}/include/om/device.h`, `${E}/include/om/recorder.h`, `${E}/src/device`, `${E}/tests/device`],
  decoder: [
    `${E}/include/om/pcm.h`, `${E}/include/om/shadow.h`, `${E}/include/om/resampler.h`, `${E}/include/om/vst_insert.h`,
    `${E}/src/decoder`, `${E}/src/vst`, `${E}/tests/decoder`, `${E}/tests/vst`
  ],
  deck: [`${E}/include/om/deck.h`, `${E}/include/om/interpolator.h`, `${E}/include/om/wsola.h`, `${E}/src/deck`, `${E}/tests/deck`],
  mixer: [
    `${E}/include/om/mixer.h`, `${E}/include/om/limiter.h`, `${E}/include/om/meter.h`, `${E}/include/om/sampler.h`,
    `${E}/src/mixer`, `${E}/tests/mixer`
  ],
  fx: [`${E}/include/om/fx.h`, `${E}/include/om/color_fx.h`, `${E}/include/om/convolver.h`, `${E}/src/fx`, `${E}/tests/fx`],
  sync: [`${E}/include/om/sync.h`, `${E}/src/sync`, `${E}/tests/sync`],
  jsproxy: [
    'src/js/native-engine.js', 'src/js/native-engine', 'src/js/stems.js', 'src/js/app.js', 'src/js/waveform.js',
    'src/js/library.js', 'src/index.html', 'src/js/i18n.js', 'test/native-engine'
  ]
};

const args = process.argv.slice(2);
const pick = args.includes('--all') ? Object.keys(OWNERS) : [args[args.indexOf('--module') + 1]];
if (!pick[0] || !OWNERS[pick[0]]) {
  console.error(`Usage: node tools/engine-snapshot.js --module <${Object.keys(OWNERS).join('|')}> | --all`);
  process.exit(2);
}

// stderr piped (not shown): git's LF/CRLF notices are noise here
const git = (gitArgs) =>
  execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
  `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;  // local time

for (const key of pick) {
  const paths = OWNERS[key].filter((p) => fs.existsSync(path.join(root, p)) || git(['ls-files', '--', p]).trim());
  if (!paths.length) continue;
  let patch = git(['diff', '--binary', 'HEAD', '--', ...paths]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...paths]).split('\n').filter(Boolean);
  for (const f of untracked) {
    // A new-file diff without touching the index (exit code 1 = "differences found").
    const r = spawnSync('git', ['diff', '--binary', '--no-index', '--', '/dev/null', f], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff --no-index failed for ${f}: ${r.stderr}`);
    patch += r.stdout;
  }
  const outDir = path.join(root, E, 'patches', key);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${stamp}.patch`);
  fs.writeFileSync(out, patch);
  console.log(`${key}: ${path.relative(root, out)} (${untracked.length} new file(s), ${patch.length} bytes)`);
}
