// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #7: the WSOLA worklet DSP, run in Node with shims.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PITCH_PROCESSOR_NAME, WSOLA_LATENCY_SAMPLES } from '../../src/index.js';
import { loadWorklet, runProcessor, ShimAudioWorkletProcessor, WORKLET_URL } from '../helpers/worklet-host.js';
import { prng } from '../helpers/fixtures.js';

const SR = 48000;
const LAT = WSOLA_LATENCY_SAMPLES;

function noise(n, seed = 7) {
  const r = prng(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = r() * 2 - 1;
  return x;
}

function sine(freq, seconds, amp = 0.5) {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

// Frequency from the median period between rising zero crossings (interpolated)
function frequency(y, from = 0.5) {
  const cross = [];
  for (let i = Math.round(from * SR); i < y.length - 1; i++) {
    if (y[i] <= 0 && y[i + 1] > 0) cross.push(i + y[i] / (y[i] - y[i + 1]));
  }
  const periods = [];
  for (let i = 1; i < cross.length; i++) periods.push(cross[i] - cross[i - 1]);
  periods.sort((a, b) => a - b);
  const median = SR / periods[periods.length >> 1];
  const mean = SR / ((cross[cross.length - 1] - cross[0]) / (cross.length - 1));
  return { median, mean };
}

const cents = (f, ref) => 1200 * Math.log2(f / ref);

test(`registers under PITCH_PROCESSOR_NAME ('${PITCH_PROCESSOR_NAME}') and posts { lat } on startup`, () => {
  const { registered } = loadWorklet();
  assert.deepEqual([...registered.keys()], [PITCH_PROCESSOR_NAME]);
  const Processor = registered.get(PITCH_PROCESSOR_NAME);
  assert.ok(Processor.prototype instanceof ShimAudioWorkletProcessor);
  const ratio = Processor.parameterDescriptors.find((p) => p.name === 'ratio');
  assert.equal(ratio.defaultValue, 1);
  assert.equal(ratio.automationRate, 'k-rate');
  const node = new Processor({});
  // (objects from the worklet realm: compared by value)
  assert.equal(node.port.messages.length, 1);
  assert.equal(node.port.messages[0].lat, LAT);
});

test('a second evaluation in the same scope does not throw (guarded registerProcessor)', () => {
  const first = loadWorklet();
  assert.doesNotThrow(() => loadWorklet(first.scope));
  assert.equal(first.registered.size, 1);
});

test('the worklet module is loadable in Node with shims on globalThis', async () => {
  const saved = { p: globalThis.AudioWorkletProcessor, r: globalThis.registerProcessor };
  const seen = [];
  globalThis.AudioWorkletProcessor = ShimAudioWorkletProcessor;
  globalThis.registerProcessor = (name, cls) => seen.push([name, cls]);
  try {
    await import(`${WORKLET_URL.href}?shim=${Date.now()}`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], PITCH_PROCESSOR_NAME);
  } finally {
    if (saved.p) globalThis.AudioWorkletProcessor = saved.p; else delete globalThis.AudioWorkletProcessor;
    if (saved.r) globalThis.registerProcessor = saved.r; else delete globalThis.registerProcessor;
  }
});

test('at ratio 1, the output is the input delayed by exactly LAT samples', () => {
  const Processor = loadWorklet().registered.get(PITCH_PROCESSOR_NAME);
  const x = noise(SR * 1.5);
  const { left, right } = runProcessor(Processor, x, 1);
  let maxErr = 0;
  for (let i = 0; i < left.length; i++) {
    const want = i >= LAT ? x[i - LAT] : 0;
    maxErr = Math.max(maxErr, Math.abs(left[i] - want), Math.abs(right[i] - want));
  }
  assert.ok(maxErr < 1e-6, `max error ${maxErr}`);
});

test('at ratio 2^(3/12), a 440 Hz sine comes out at 523.25 Hz ± 5 cents', () => {
  const Processor = loadWorklet().registered.get(PITCH_PROCESSOR_NAME);
  const want = 440 * Math.pow(2, 3 / 12);
  const { left } = runProcessor(Processor, sine(440, 3), Math.pow(2, 3 / 12));
  const f = frequency(left);
  assert.ok(Math.abs(cents(f.median, want)) <= 5, `median ${f.median} Hz`);
  assert.ok(Math.abs(cents(f.mean, want)) <= 5, `mean ${f.mean} Hz`);
});

test('ratios are clamped to 0.5–1.8 (and a non-positive ratio means 1)', () => {
  const Processor = loadWorklet().registered.get(PITCH_PROCESSOR_NAME);
  const x = sine(330, 1);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  // (1.8 itself is not exact in a Float32Array parameter: compare two clamped values)
  assert.ok(same(runProcessor(Processor, x, 3).left, runProcessor(Processor, x, 4).left), '3 and 4 → 1.8');
  assert.ok(same(runProcessor(Processor, x, 0.2).left, runProcessor(Processor, x, 0.5).left), '0.2 → 0.5');
  assert.ok(same(runProcessor(Processor, x, 0).left, runProcessor(Processor, x, 1).left), '0 → 1');
  assert.ok(same(runProcessor(Processor, x, NaN).left, runProcessor(Processor, x, 1).left), 'NaN → 1');
  const hi = frequency(runProcessor(Processor, sine(330, 2), 3).left);
  assert.ok(Math.abs(cents(hi.median, 330 * 1.8)) <= 5, `3 → ${hi.median} Hz (1.8 × 330)`);
  const lo = frequency(runProcessor(Processor, sine(330, 2), 0.1).left);
  assert.ok(Math.abs(cents(lo.median, 330 * 0.5)) <= 5, `0.1 → ${lo.median} Hz (0.5 × 330)`);
});

test('process() and the grain code it calls do not allocate', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(WORKLET_URL, 'utf8');
  // everything after the constructor: _score, _grain, process
  const body = src.slice(src.indexOf('  _score('), src.indexOf('// web-engine: guarded registration'));
  assert.ok(body.includes('process(inputs, outputs, params)'));
  for (const s of ['new ', '.slice(', '.map(', '.concat(', 'Array(', '=> ']) {
    assert.ok(!body.includes(s), `allocation pattern ${JSON.stringify(s)} in the real-time code`);
  }
});

test('no NaN in the output, whatever the ratio schedule', () => {
  const Processor = loadWorklet().registered.get(PITCH_PROCESSOR_NAME);
  const x = noise(SR, 99);
  const schedule = (b) => [1, 1.18, 0.62, 1.8, 0.5, 1.003][b % 6];
  const { left, right } = runProcessor(Processor, x, schedule);
  for (let i = 0; i < left.length; i++) {
    assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), `sample ${i}`);
  }
  // silence and a missing input are fine too
  const node = new Processor({});
  const out = [new Float32Array(128), new Float32Array(128)];
  assert.equal(node.process([[]], [out], { ratio: new Float32Array([1.2]) }), true);
  assert.ok(out[0].every((v) => v === 0));
});
