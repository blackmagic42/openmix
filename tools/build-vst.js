// Builds the native VST3 host (native/vsthost) for the Electron in use.
//   npm run build:vst
// Needs: Windows, Visual Studio 2022 with the C++ workload, CMake, git.
// The Steinberg VST3 SDK (MIT license) is fetched into native/vst3sdk the
// first time (only the parts needed for hosting).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sdk = path.join(root, 'native', 'vst3sdk');
const SDK_TAG = 'v3.8.1_build_84';

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  // (no shell: the paths contain spaces — "Program Files", "Turbo mix")
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

if (process.platform !== 'win32') {
  console.log('The VST3 host is Windows-only for now: nothing to build.');
  process.exit(0);
}

if (!fs.existsSync(path.join(sdk, 'public.sdk', 'source', 'vst', 'hosting', 'module.h'))) {
  if (!fs.existsSync(sdk)) {
    run('git', ['clone', '--depth', '1', '--branch', SDK_TAG, 'https://github.com/steinbergmedia/vst3sdk.git', sdk], root);
  }
  run('git', ['submodule', 'update', '--init', '--depth', '1', 'base', 'pluginterfaces', 'public.sdk', 'cmake'], sdk);
}

const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
run(process.execPath, [
  path.join(root, 'node_modules', 'cmake-js', 'bin', 'cmake-js'),
  'compile',
  '--directory', path.join(root, 'native', 'vsthost'),
  '--runtime', 'electron',
  '--runtime-version', electronVersion,
  '--arch', 'x64',
  '--config', 'Release'
], root);
console.log('VST3 host built: native/vsthost/build/Release/openmix_vsthost.node');
