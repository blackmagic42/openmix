// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Grid editing on a deck (DESIGN §5.5): setGrid, scaleGrid, shiftGrid,
// setDownbeat, 'grid' events, leaving SYNC; global grid offset.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAudioGlobals, makeContext } from '../helpers/fake-audio.js';
import { beatList, lazyBuffer } from '../helpers/fixtures.js';
import { createEngine, gridTimeAtIndex } from '../../src/index.js';

let restore;
before(() => { restore = installFakeAudioGlobals(); });
after(() => restore());

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b}`);

async function rig() {
  const ctx = makeContext();
  const engine = await createEngine({ context: ctx, decks: 2 });
  const [A, B] = engine.decks;
  const grids = [];
  const syncs = [];
  B.on('grid', (e) => grids.push(e));
  B.on('sync', (e) => syncs.push(e.synced));
  const step = (s) => { for (let i = 0; i < Math.round(s * 60); i++) { ctx.advance(1 / 60); engine.tick(); } };
  return { ctx, engine, A, B, grids, syncs, step };
}

test('setGrid: BPM correction makes a fixed grid and leaves SYNC; partial updates', async () => {
  const { engine, A, B, grids, syncs, step } = await rig();
  A.load(lazyBuffer({ seconds: 60 }), { bpm: 120, beats: beatList({ bpm: 120, count: 100 }) });
  B.load(lazyBuffer({ seconds: 60 }), { bpm: 125, beats: beatList({ bpm: 125, count: 100 }) });
  A.play();
  step(0.2);
  B.sync();
  B.play();
  step(0.5);
  B.setGrid({ bpm: 126 });
  assert.equal(B.bpm, 126);
  assert.equal(B.beats, null, 'fixed grid');
  assert.equal(B.beatOffset, 0, 'the first beat of the old list');
  assert.equal(B.synced, false);
  assert.deepEqual(syncs, [true, false]);
  assert.equal(B._syncBase, null, 'calibration reset');
  const g = grids.at(-1);
  assert.deepEqual({ bpm: g.bpm, beats: g.beats, beatOffset: g.beatOffset, barAnchor: g.barAnchor, gridShift: g.gridShift },
    { bpm: 126, beats: null, beatOffset: 0, barAnchor: 0, gridShift: 0 });
  // a field alone: no SYNC change
  B.sync();
  B.setGrid({ barAnchor: 3 });
  assert.equal(B.barAnchor, 3);
  assert.equal(B.synced, true);
  // a beat list without a BPM: the BPM is the median interval
  B.setGrid({ beats: beatList({ bpm: 128, first: 0.05, count: 50 }) });
  assert.equal(B.bpm, 128);
  assert.equal(B.synced, false);
  // the same beats again: unchanged, SYNC kept
  B.sync();
  B.setGrid({ beats: beatList({ bpm: 128, first: 0.05, count: 50 }) });
  assert.equal(B.synced, true);
  // invalid input: no-op
  const n = grids.length;
  B.setGrid({ bpm: NaN });
  B.setGrid({ gridShift: 'x' });
  assert.equal(grids.length, n);
  await engine.destroy();
});

test('scaleGrid ×2 / ÷2 on a beat list and on a fixed grid (40–320 BPM)', async () => {
  const { engine, B, grids } = await rig();
  const beats = beatList({ bpm: 120, count: 9 }); // 0 … 4 s
  B.load(lazyBuffer({ seconds: 30 }), { bpm: 120, beats, barAnchor: 3 });
  assert.equal(B.scaleGrid(2), true);
  assert.equal(B.bpm, 240);
  assert.equal(B.beats.length, 17);
  assert.equal(B.beats[1], 0.25, 'midpoints inserted');
  assert.equal(B.barAnchor, 6);
  assert.equal(B.scaleGrid(2), false, '480 BPM is out of range');
  assert.equal(B.scaleGrid(0.5), true);
  assert.equal(B.bpm, 120);
  assert.deepEqual(B.beats, beats, 'every other beat, with the parity of barAnchor');
  assert.equal(B.barAnchor, 3);
  B.setGrid({ bpm: 70, beatOffset: 0.2 });
  assert.equal(B.scaleGrid(0.5), false, '35 BPM is out of range');
  assert.equal(B.scaleGrid(2), true);
  assert.equal(B.bpm, 140);
  assert.equal(B.beatOffset, 0.2);
  assert.equal(grids.at(-1).bpm, 140);
  B.eject();
  assert.equal(B.scaleGrid(2), false, 'no BPM');
  await engine.destroy();
});

test('shiftGrid and setDownbeat; the global grid offset', async () => {
  const { engine, B, grids } = await rig();
  B.load(lazyBuffer({ seconds: 30 }), { beats: beatList({ bpm: 120, count: 60 }) });
  B.shiftGrid(0.004);
  close(B.gridShift, 0.004);
  B.seek(3.13);
  assert.equal(B.setDownbeat(), true);
  // the nearest beat (6) becomes a bar start placed exactly at 3.13 s
  assert.equal(B.barAnchor, 6);
  close(gridTimeAtIndex(B, 6), 3.13);
  close(B.gridShift, 0.13);
  assert.equal(grids.length, 2);
  engine.setGridOffset(0.01);
  assert.equal(engine.gridOffset, 0.01);
  assert.equal(B.globalGridOffset, 0.01);
  close(gridTimeAtIndex(B, 6), 3.14, 1e-9, 'every beat list moves');
  engine.setGridOffset(NaN);
  assert.equal(engine.gridOffset, 0.01);
  // fixed grid: beatOffset moves, never below 0
  B.setGrid({ bpm: 120 });
  B.shiftGrid(-1);
  assert.equal(B.beatOffset, 0);
  B.setDownbeat(1.7);
  assert.equal(B.beatOffset, 1.7);
  B.eject();
  assert.equal(B.setDownbeat(1), false);
  await engine.destroy();
});

test('setPeaks / setMusicKey have no other effect', async () => {
  const { engine, B, grids } = await rig();
  B.load(lazyBuffer({ seconds: 10 }), { bpm: 120 });
  const p = { top: new Float32Array(2) };
  B.setPeaks(p);
  assert.equal(B.peaks, p);
  B.setMusicKey(4);
  assert.equal(B.musicKey, 4);
  assert.deepEqual(B.heardKey, { code: 4, cents: 0 });
  B.setMusicKey(null);
  assert.equal(B.heardKey, null);
  assert.equal(grids.length, 0);
  await engine.destroy();
});
