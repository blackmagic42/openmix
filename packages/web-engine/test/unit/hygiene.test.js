// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #3: license headers, forbidden strings, VERSION, LAT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, WSOLA_LATENCY_SAMPLES, PITCH_PROCESSOR_NAME } from '../../src/index.js';
import { loadWorklet, runProcessor } from '../helpers/worklet-host.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const HEADER = [
  '// SPDX-License-Identifier: MIT',
  '// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors',
  '// @openmix/web-engine — the Web Audio DJ engine of OpenMix',
  '// https://github.com/blackmagic42/openmix'
];

test('every file under src/, worklets/ and types/ starts with the SPDX MIT header', () => {
  const files = ['src', 'worklets', 'types'].flatMap((d) => filesUnder(join(ROOT, d)));
  assert.ok(files.length >= 20, 'the package sources are there');
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/).slice(0, 4);
    assert.deepEqual(lines, HEADER, `license header of ${f}`);
  }
});

test('the test helpers and unit tests carry the header too', () => {
  for (const f of ['test/helpers', 'test/unit'].flatMap((d) => filesUnder(join(ROOT, d)))) {
    assert.equal(readFileSync(f, 'utf8').split(/\r?\n/)[0], HEADER[0], f);
  }
});

test('no app coupling strings in src/ and worklets/', () => {
  const forbidden = ['localStorage', 'window.api', '[midi]', 'i18n', 'performance.now', 'console.log'];
  for (const f of ['src', 'worklets'].flatMap((d) => filesUnder(join(ROOT, d)))) {
    const text = readFileSync(f, 'utf8');
    for (const s of forbidden) assert.ok(!text.includes(s), `${s} found in ${f}`);
  }
});

test('VERSION equals the package.json version', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test("WSOLA_LATENCY_SAMPLES equals the worklet's LAT (announced on startup)", () => {
  const { registered } = loadWorklet();
  const Processor = registered.get(PITCH_PROCESSOR_NAME);
  const { node } = runProcessor(Processor, new Float32Array(128), 1);
  assert.equal(node.port.messages.length, 1);
  assert.equal(node.port.messages[0].lat, WSOLA_LATENCY_SAMPLES);
  assert.equal(WSOLA_LATENCY_SAMPLES, 2647);
  // and the formula in the file gives the same number
  const src = readFileSync(join(ROOT, 'worklets/pitch-processor.js'), 'utf8');
  assert.match(src, /const LAT = Math\.ceil\(\(N \* \(R_MAX \+ 1\)\) \/ 2 \+ SEARCH \+ 16\);/);
  assert.equal(Math.ceil((1536 * (1.8 + 1)) / 2 + 480 + 16), WSOLA_LATENCY_SAMPLES);
});

test('the worklet has no imports and its registration is guarded', () => {
  const src = readFileSync(join(ROOT, 'worklets/pitch-processor.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'no import statement');
  assert.match(src, /try \{\s*registerProcessor\(PROCESSOR_NAME, PitchProcessor\);\s*\} catch/);
  assert.match(src, /const PROCESSOR_NAME = 'openmix-pitch-shift';/);
});
