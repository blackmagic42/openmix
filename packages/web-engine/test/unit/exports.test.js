// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #1 (imports and exact export lists) and #2 (types parity).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ANALYSIS = [
  'analyzeBpm', 'analyzeKey', 'analyzeTrack', 'alignImportedGrid',
  'keyFromMono', 'keyFromChroma',
  'camelot', 'camelotLabel', 'keyName', 'shiftKey', 'keyDistance', 'heardKey'
];
const WAVEFORM = ['computePeaks', 'drawZoom', 'drawOverview', 'fitCanvas', 'WAVE_PALETTES'];
const INDEX = [
  ...ANALYSIS, ...WAVEFORM,
  'createEngine', 'Engine', 'Deck', 'FxUnit', 'renderOffline',
  'gridIndexFracAt', 'gridTimeAtIndex', 'gridPeriodAt', 'barAlignedSeekTime', 'snapToBeat',
  'VERSION',
  'FX_TYPES', 'COLOR_FX_TYPES', 'FX_BEATS', 'FX_DRY_CUT', 'fxDryCut', 'PAD_FX_DRY', 'DEFAULT_PAD_FX', 'HOT_CUE_COLORS',
  'TEMPO_MIN', 'TEMPO_MAX', 'KEY_SHIFT_MIN', 'KEY_SHIFT_MAX', 'PRE_ROLL',
  'WSOLA_LATENCY_SAMPLES', 'PITCH_PROCESSOR_NAME'
];

const ENTRIES = [
  { file: '../../src/index.js', types: '../../types/index.d.ts', names: INDEX },
  { file: '../../src/analysis/index.js', types: '../../types/analysis.d.ts', names: ANALYSIS },
  { file: '../../src/waveform/index.js', types: '../../types/waveform.d.ts', names: WAVEFORM }
];

const sorted = (a) => [...a].sort();

for (const entry of ENTRIES) {
  test(`${entry.file} imports in Node and exports exactly the DESIGN §5.1 list`, async () => {
    const mod = await import(entry.file);
    assert.deepEqual(sorted(Object.keys(mod)), sorted(entry.names));
    assert.equal(mod.default, undefined, 'no default export');
  });
}

test('every module of src/ imports cleanly in Node (no top-level browser globals)', async () => {
  const files = [
    'constants', 'util', 'emitter', 'fx', 'grid', 'pitch-fallback', 'deck', 'sync', 'engine', 'offline', 'index',
    'analysis/bpm', 'analysis/key', 'analysis/track', 'analysis/index',
    'waveform/peaks', 'waveform/draw', 'waveform/index'
  ];
  for (const f of files) await import(`../../src/${f}.js`);
});

test('the package.json exports map points at these entry files', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['.'].default, './src/index.js');
  assert.equal(pkg.exports['./analysis'].default, './src/analysis/index.js');
  assert.equal(pkg.exports['./waveform'].default, './src/waveform/index.js');
  assert.equal(pkg.exports['./worklets/pitch-processor.js'], './worklets/pitch-processor.js');
  assert.equal(pkg.exports['.'].types, './types/index.d.ts');
});

// ---------------------------------------------------------------- types ---

// Names declared by a .d.ts file, following `export * from './x.js'`
function declaredNames(url, seen = new Set()) {
  const key = String(url);
  if (seen.has(key)) return new Set();
  seen.add(key);
  const text = readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const names = new Set();
  const decl = /export\s+(?:declare\s+)?(?:abstract\s+)?(?:function|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (let m; (m = decl.exec(text));) names.add(m[1]);
  const list = /export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g;
  for (let m; (m = list.exec(text));) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name.trim());
    }
  }
  const star = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  for (let m; (m = star.exec(text));) {
    const target = new URL(m[1].replace(/\.js$/, '.d.ts'), url);
    for (const n of declaredNames(target, seen)) names.add(n);
  }
  return names;
}

for (const entry of ENTRIES) {
  test(`types parity: every runtime export of ${entry.file} is declared in ${entry.types}`, async () => {
    const mod = await import(entry.file);
    const declared = declaredNames(new URL(entry.types, import.meta.url));
    const missing = Object.keys(mod).filter((n) => !declared.has(n));
    assert.deepEqual(missing, [], `missing declarations: ${missing.join(', ')}`);
  });
}

test('types: index.d.ts re-exports analysis.d.ts and waveform.d.ts', () => {
  const text = readFileSync(new URL('../../types/index.d.ts', import.meta.url), 'utf8');
  assert.match(text, /export \* from '\.\/analysis\.js'/);
  assert.match(text, /export \* from '\.\/waveform\.js'/);
});
