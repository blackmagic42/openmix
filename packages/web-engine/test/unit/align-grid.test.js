// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #6: alignImportedGrid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignImportedGrid } from '../../src/analysis/index.js';
import { beatList, clickBuffer } from '../helpers/fixtures.js';

test('clicks offset by +26 ms are found with a shift of 0.026 ± 0.002 s', () => {
  for (const sampleRate of [44100, 48000]) {
    const beats = beatList({ bpm: 120, first: 0.5, count: 60 });
    const buffer = clickBuffer({ times: beats, seconds: 32, sampleRate, delay: 0.026 });
    const res = alignImportedGrid(buffer, beats);
    assert.ok(Math.abs(res.shift - 0.026) <= 0.002, `shift ${res.shift} at ${sampleRate} Hz`);
    assert.equal(res.beats.length, beats.length);
    res.beats.forEach((b, i) => assert.ok(Math.abs(b - (beats[i] + res.shift)) < 1e-4));
  }
});

test('an aligned grid, a short list or an implausible offset is left alone', () => {
  const beats = beatList({ bpm: 120, first: 0.5, count: 60 });
  const aligned = alignImportedGrid(clickBuffer({ times: beats, seconds: 32 }), beats);
  assert.equal(aligned.shift, 0);
  assert.equal(aligned.beats, beats);
  const short = alignImportedGrid(clickBuffer({ times: beats, seconds: 32 }), beats.slice(0, 5));
  assert.equal(short.shift, 0);
  const far = alignImportedGrid(clickBuffer({ times: beats, seconds: 32, delay: 0.2 }), beats);
  assert.equal(far.shift, 0);
  assert.throws(() => alignImportedGrid({}, beats), TypeError);
});
