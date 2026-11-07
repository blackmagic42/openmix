// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #4: grid helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gridIndexFracAt, gridTimeAtIndex, gridPeriodAt, barAlignedSeekTime, snapToBeat
} from '../../src/index.js';

const close = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≠ ${b}`);

// An irregular beat list: 120 BPM, then 125 BPM after beat 8
function irregular() {
  const beats = [];
  let t = 0.25;
  for (let k = 0; k < 24; k++) {
    beats.push(t);
    t += k < 8 ? 0.5 : 0.48;
  }
  return beats;
}

test('index <-> time round trip on a beat list (inside and on the beats)', () => {
  const g = { beats: irregular() };
  for (const f of [0, 0.25, 1, 3.5, 7.99, 8, 8.5, 15.25, 22.75, 23]) {
    const t = gridTimeAtIndex(g, f);
    close(gridIndexFracAt(g, t), f, 1e-9, `f=${f}`);
  }
  for (const t of [0.25, 0.3, 2, 4.4, 9.1, 11.0]) close(gridTimeAtIndex(g, gridIndexFracAt(g, t)), t, 1e-9);
  assert.equal(gridTimeAtIndex(g, 0), 0.25);
  close(gridTimeAtIndex(g, 8), 4.25);
  close(gridTimeAtIndex(g, 9), 4.73);
});

test('extrapolation before and after the beat list uses the edge periods', () => {
  const g = { beats: irregular() };
  close(gridIndexFracAt(g, 0), -0.5);            // 0.25 s before beat 0, period 0.5
  close(gridTimeAtIndex(g, -2), -0.75);
  const last = g.beats[g.beats.length - 1];
  close(gridIndexFracAt(g, last + 0.96), 25);    // 2 periods of 0.48 after beat 23
  close(gridTimeAtIndex(g, 26), last + 3 * 0.48);
  close(gridPeriodAt(g, -10), 0.5);
  close(gridPeriodAt(g, last + 10), 0.48);
  close(gridPeriodAt(g, 1.0), 0.5);
  close(gridPeriodAt(g, 6.0), 0.48);
});

test('gridShift + globalGridOffset shift beat lists', () => {
  const base = { beats: [0, 0.5, 1, 1.5, 2, 2.5] };
  const shifted = { ...base, gridShift: 0.01, globalGridOffset: 0.02 };
  close(gridTimeAtIndex(shifted, 2), 1.03);
  close(gridIndexFracAt(shifted, 1.03), 2);
  close(gridIndexFracAt(shifted, 1.28), 2.5);
  close(gridPeriodAt(shifted, 1.03), 0.5);
  close(snapToBeat(shifted, 1.2), 1.03);
});

test('beat-list helpers return null without a beat list of 2+ beats', () => {
  for (const g of [{}, { bpm: 120, beatOffset: 0 }, { beats: [1] }, { beats: null }]) {
    assert.equal(gridIndexFracAt(g, 1), null);
    assert.equal(gridTimeAtIndex(g, 1), null);
    assert.equal(gridPeriodAt(g, 1), null);
  }
});

test('fixed-grid paths use bpm + beatOffset and ignore the shifts', () => {
  const g = { bpm: 120, beatOffset: 0.1, gridShift: 5, globalGridOffset: 7 };
  close(snapToBeat(g, 1.32), 1.1);
  close(snapToBeat(g, 1.32, 4), 1.35);
  // bar-aligned seek on a fixed grid: bars of 2 s from 0.1; 1/4 into the bar
  // of 10.3 s (bar 5, from 10.1 s) = 10.6 s
  close(barAlignedSeekTime(g, 0.6, 10.3), 10.6);
  assert.equal(snapToBeat({ bpm: 120 }, 1.32), 1.32, 'no beatOffset: unchanged');
  assert.equal(barAlignedSeekTime({ bpm: 120 }, 1, 9), 9);
});

test('barAlignedSeekTime keeps the phase within the bar (beat list)', () => {
  const beats = Array.from({ length: 200 }, (_, k) => k * 0.5);
  const g = { bpm: 120, beats, barAnchor: 1 };
  // bars start on beats 1, 5, 9…: at 1.0 s = beat 2 → 1/4 into its bar
  const t = barAlignedSeekTime(g, 1.0, 40.3);
  // target bar contains beat 80.6 → bar from beat 77; 1/4 bar later = beat 78
  close(t, 39);
  const fFrom = (gridIndexFracAt(g, 1.0) - 1) / 4;
  const fTo = (gridIndexFracAt(g, t) - 1) / 4;
  close(fFrom - Math.floor(fFrom), fTo - Math.floor(fTo));
  assert.equal(barAlignedSeekTime({ beats }, 1, 3), 3, 'no BPM: target unchanged');
});

test('snapToBeat: divisions 1 and 4, never below 0, unchanged without a grid', () => {
  const g = { bpm: 120, beats: Array.from({ length: 40 }, (_, k) => k * 0.5) };
  close(snapToBeat(g, 1.13), 1.0);
  close(snapToBeat(g, 1.13, 4), 1.125);
  close(snapToBeat(g, 1.3, 4), 1.25);
  close(snapToBeat(g, 1.3), 1.5);
  assert.equal(snapToBeat(g, -0.4), 0);
  assert.equal(snapToBeat({}, 1.234), 1.234);
  assert.equal(snapToBeat(null, 1.234), 1.234);
});
