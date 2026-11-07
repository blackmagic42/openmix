// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// engine.decode() and deck.loadFrom() (DESIGN §5.4, §5.5): sources,
// analysis plan, AbortError semantics, synchronous resume.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAudioGlobals, makeContext, FakeAudioBuffer } from '../helpers/fake-audio.js';
import { beatList } from '../helpers/fixtures.js';
import { createEngine } from '../../src/index.js';

let restore;
// the fake OfflineAudioContext lets computePeaks run (silently) in Node
before(() => { restore = installFakeAudioGlobals({ offlineAudioContext: true }); });
after(() => restore());

const buffer = (seconds = 4, sampleRate = 8000) => new FakeAudioBuffer({ numberOfChannels: 2, length: seconds * sampleRate, sampleRate });

test('decode: AudioBuffer as is, ArrayBuffer, Blob, URL (fetch), errors', async () => {
  const ctx = makeContext();
  const engine = await createEngine({ context: ctx });
  const b = buffer();
  assert.equal(await engine.decode(b), b);
  const decoded = buffer(2);
  ctx.decodeResult = () => decoded;
  const ab = new ArrayBuffer(16);
  assert.equal(await engine.decode(ab), decoded);
  assert.equal(ctx.decodeCalls.at(-1), ab);
  assert.equal(await engine.decode(new Blob([new Uint8Array(8)])), decoded);
  const saved = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return url.endsWith('missing.mp3')
      ? { ok: false, status: 404 }
      : { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) };
  };
  try {
    assert.equal(await engine.decode('https://music.example/one.mp3'), decoded);
    assert.equal(await engine.decode(new URL('https://music.example/two.mp3')), decoded);
    assert.deepEqual(fetched, ['https://music.example/one.mp3', 'https://music.example/two.mp3']);
    await assert.rejects(engine.decode('https://music.example/missing.mp3'), /HTTP 404/);
  } finally {
    globalThis.fetch = saved;
  }
  await assert.rejects(engine.decode(42), TypeError);
  ctx.decodeResult = new Error('EncodingError: unable to decode');
  await assert.rejects(engine.decode(new ArrayBuffer(4)), /unable to decode/);
  await engine.destroy();
});

test('loadFrom: resumes synchronously, applies the given meta, analyzes nothing it was given', async () => {
  const ctx = makeContext({ state: 'suspended' });
  const engine = await createEngine({ context: ctx });
  const d = engine.decks[0];
  const b = buffer(30);
  const peaks = { top: new Float32Array(1), fake: true };
  const beats = beatList({ bpm: 124, first: 0.2, count: 40 });
  const loads = [];
  d.on('load', (e) => loads.push(e));
  const p = d.loadFrom(b, { beats, musicKey: 9, peaks, track: { id: 7 }, hotCues: [1.5], cuePoint: 0.25, gridShift: 0.01 });
  assert.equal(ctx.resumeCalls, 1, 'engine.resume() called synchronously');
  const res = await p;
  assert.deepEqual(res, {
    buffer: b, bpm: 124, beats: d.beats, beatOffset: 0.2, barAnchor: 0, rigid: false,
    musicKey: 9, keyConfidence: null, peaks
  });
  assert.deepEqual(d.beats, beats);
  assert.equal(d.buffer, b);
  assert.deepEqual(d.track, { id: 7 });
  assert.equal(d.hotCues[0], 1.5);
  assert.equal(d.cuePoint, 0.25);
  assert.equal(d.gridShift, 0.01);
  assert.equal(loads.length, 1);
  await engine.destroy();
});

test('loadFrom: analyzes what is missing (here the peaks), or nothing with analyze: false', async () => {
  const ctx = makeContext();
  const engine = await createEngine({ context: ctx });
  const d = engine.decks[0];
  const res = await d.loadFrom(buffer(3), { bpm: 120, musicKey: 21, analyze: { peaksPerSecond: 100, fine: false } });
  assert.equal(res.bpm, 120);
  assert.equal(res.musicKey, 21);
  assert.ok(res.peaks, 'peaks computed');
  assert.equal(res.peaks.perSecond, 100);
  assert.equal(res.peaks.top.length, 300);
  assert.equal(res.peaks.finePps, 0);
  assert.equal(d.peaks, res.peaks);
  const none = await d.loadFrom(buffer(3), { analyze: false });
  assert.equal(none.bpm, null);
  assert.equal(none.peaks, null);
  assert.equal(none.musicKey, null);
  assert.equal(d.loaded, true);
  await engine.destroy();
});

test('loadFrom: a newer call or an abort rejects with AbortError, without touching the deck', async () => {
  const ctx = makeContext();
  const engine = await createEngine({ context: ctx });
  const d = engine.decks[0];
  const first = buffer(5);
  const second = buffer(6);
  const p1 = d.loadFrom(first, { analyze: false });
  const p2 = d.loadFrom(second, { analyze: false });
  await assert.rejects(p1, (e) => e.name === 'AbortError');
  await p2;
  assert.equal(d.buffer, second);
  const ac = new AbortController();
  const p3 = d.loadFrom(buffer(7), { analyze: false, signal: ac.signal });
  ac.abort();
  await assert.rejects(p3, (e) => e.name === 'AbortError');
  assert.equal(d.buffer, second, 'the deck is untouched');
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(d.loadFrom(buffer(8), { signal: pre.signal }), (e) => e.name === 'AbortError');
  // eject() and load() also cancel a pending loadFrom()
  const p4 = d.loadFrom(buffer(9), { analyze: false });
  d.eject();
  await assert.rejects(p4, (e) => e.name === 'AbortError');
  assert.equal(d.loaded, false);
  // decode errors reject as they are
  ctx.decodeResult = new Error('EncodingError: bad data');
  await assert.rejects(d.loadFrom(new ArrayBuffer(8)), /bad data/);
  await engine.destroy();
});
