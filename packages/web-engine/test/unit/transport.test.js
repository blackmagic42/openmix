// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #9: load / eject, play / pause and the heard position on the
// fake audio clock (30 ms scheduled start, seek compensation, keylock
// read-ahead), pre-roll, natural end.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAudioGlobals, makeContext } from '../helpers/fake-audio.js';
import { silentBuffer, beatList } from '../helpers/fixtures.js';
import { createEngine, WSOLA_LATENCY_SAMPLES, PRE_ROLL } from '../../src/index.js';

let restore;
before(() => { restore = installFakeAudioGlobals(); });
after(() => restore());

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b}`);

async function rig(options = {}) {
  const ctx = makeContext();
  const engine = await createEngine({ context: ctx, ...options });
  const d = engine.decks[0];
  const log = [];
  for (const t of ['load', 'eject', 'play', 'pause', 'ended', 'loop', 'hotcue', 'cuepoint', 'sync', 'grid']) {
    d.on(t, (e) => log.push({ type: t, ...e }));
  }
  return { ctx, engine, d, log, types: () => log.map((e) => e.type) };
}

test('load: state, metadata, BPM from beats, events; SYNC and keylock stay', async () => {
  const { engine, d, log } = await rig();
  const buffer = silentBuffer({ seconds: 30 });
  const track = { title: 'One' };
  const beats = beatList({ bpm: 125, first: 0.1, count: 40 });
  d.load(buffer, {
    beats, barAnchor: 2, gridShift: 0.004, cuePoint: 1.5, hotCues: [1, null, 3, 4, 5, 6, 7, 8, 9, 10],
    musicKey: 21, peaks: { fake: true }, track
  });
  assert.equal(d.loaded, true);
  assert.equal(d.buffer, buffer);
  assert.equal(d.duration, 30);
  assert.equal(d.bpm, 125, 'BPM from the median beat interval');
  assert.deepEqual(d.beats, beats);
  assert.notEqual(d.beats, beats, 'the beat list is copied');
  assert.equal(d.beatOffset, 0.1);
  assert.equal(d.barAnchor, 2);
  assert.equal(d.gridShift, 0.004);
  assert.equal(d.cuePoint, 1.5);
  assert.deepEqual(d.hotCues, [1, null, 3, 4, 5, 6, 7, 8], 'extra entries are ignored');
  assert.equal(d.musicKey, 21);
  assert.deepEqual(d.heardKey, { code: 21, cents: 0 });
  assert.deepEqual(d.peaks, { fake: true });
  assert.equal(d.track, track);
  assert.deepEqual(log.map((e) => e.type), ['load']);
  assert.equal(log[0].track, track);
  assert.equal(log[0].duration, 30);
  assert.equal(log[0].index, 0);
  assert.equal(log[0].deck, d);
  // a short beat list is not used; a bpm alone is a fixed grid without offset
  d.load(buffer, { bpm: 128, beats: [0, 0.5] });
  assert.equal(d.beats, null);
  assert.equal(d.bpm, 128);
  // the next load resets tempo, key, loop… but keeps SYNC and keylock
  d.setKeylock(true);
  d.sync(); // no reference: armed
  d.setKey(3);
  d.setTempo(1.1); // (a follower leaves SYNC: re-arm it)
  d.sync();
  d.setLoop(1, 2);
  d.load(buffer, { bpm: 120 });
  assert.equal(d.tempo, 1);
  assert.equal(d.keyShift, 0);
  assert.equal(d.loop.active, false);
  assert.equal(d.loop.end, 0);
  assert.equal(d.synced, true);
  assert.equal(d.keylock, true);
  assert.equal(d.musicKey, null);
  assert.equal(d.cuePoint, 0);
  await engine.destroy();
});

test('eject clears everything track-related; load while playing emits pause first', async () => {
  const { ctx, engine, d, types } = await rig();
  d.load(silentBuffer({ seconds: 20 }), { bpm: 120, beatOffset: 0, hotCues: [2], track: 'a' });
  d.play();
  ctx.advance(1);
  d.load(silentBuffer({ seconds: 10 }), { track: 'b' });
  assert.equal(d.playing, false);
  assert.deepEqual(types(), ['load', 'play', 'pause', 'load']);
  d.setLoop(1, 3);
  d.eject();
  assert.equal(d.loaded, false);
  assert.equal(d.buffer, null);
  assert.equal(d.track, null);
  assert.equal(d.bpm, null);
  assert.equal(d.peaks, null);
  assert.deepEqual(d.hotCues, new Array(8).fill(null));
  assert.equal(d.loop.active, false);
  assert.equal(d.position, 0);
  assert.equal(types().at(-1), 'eject');
  const n = types().length;
  d.eject(); // already empty: nothing
  assert.equal(types().length, n);
  await engine.destroy();
});

test('play / pause: 30 ms scheduled start, exact extrapolation, events', async () => {
  const { ctx, engine, d, log } = await rig();
  d.load(silentBuffer({ seconds: 60 }));
  d.play();
  const src = d.source;
  assert.deepEqual(src.startArgs, [0.03, 0]);
  close(d.position, -0.03, 1e-12, 'never floored during the 30 ms window');
  assert.equal(log.at(-1).type, 'play');
  ctx.advance(1.03);
  close(d.position, 1);
  close(d.currentTime(), d.position);
  d.pause();
  assert.equal(d.playing, false);
  close(d.position, 1);
  assert.equal(log.at(-1).type, 'pause');
  close(log.at(-1).position, 1);
  ctx.advance(5);
  close(d.position, 1, 1e-12, 'paused: frozen');
  d.play();
  close(d.source.startArgs[0], 6.06, 1e-12);
  assert.equal(d.source.startArgs[1], 1);
  ctx.advance(0.03);
  close(d.position, 1);
  ctx.advance(0.5);
  close(d.position, 1.5);
  d.togglePlay();
  assert.equal(d.playing, false);
  d.togglePlay();
  assert.equal(d.playing, true);
  // pause inside the 30 ms window: the position does not move
  const { d: d2, ctx: c2, engine: e2 } = await rig();
  d2.load(silentBuffer({ seconds: 10 }));
  d2.seek(2);
  d2.play();
  c2.advance(0.01);
  d2.pause();
  close(d2.position, 2);
  await engine.destroy();
  await e2.destroy();
});

test('seek while playing is compensated for the 30 ms start (also with a tempo)', async () => {
  const { ctx, engine, d } = await rig();
  d.load(silentBuffer({ seconds: 60 }));
  d.play();
  ctx.advance(2);
  d.seek(10);
  const t = ctx.currentTime;
  assert.deepEqual(d.source.startArgs, [t + 0.03, 10.03]);
  close(d.position, 10, 1e-9, 'the jump lands on time');
  ctx.advance(0.03);
  close(d.position, 10.03);
  d.setTempo(1.5);
  ctx.advance(1);
  close(d.position, 11.53);
  d.seek(20);
  close(d.source.startArgs[1], 20 + 0.03 * 1.5);
  close(d.position, 20);
  ctx.advance(0.5);
  close(d.position, 20.75);
  assert.equal(d.source.playbackRate.value, 1.5);
  // clamped to the track
  d.seek(1e9);
  assert.equal(d.position <= 60, true);
  d.pause();
  d.seek(-1e9);
  assert.equal(d.position, -PRE_ROLL);
  await engine.destroy();
});

test('keylock read-ahead: PLAY from stop keeps the attack, seeks land on time', async () => {
  const { ctx, engine, d } = await rig();
  const lat = WSOLA_LATENCY_SAMPLES / ctx.sampleRate;
  d.load(silentBuffer({ seconds: 60 }));
  d.setKeylock(true);
  assert.equal(d.latency, lat);
  d.seek(4);
  d.play();
  assert.deepEqual(d.source.startArgs, [0.03, 4], 'read from the heard position (no skip)');
  ctx.advance(0.03);
  close(d.position, 4 - lat, 1e-12, 'heard procLat later');
  ctx.advance(1);
  d.seek(10);
  close(d.source.startArgs[1], 10.03 + lat, 1e-12, 'read ahead by the latency');
  close(d.position, 10);
  // pause cuts the transposer's reserve, then reopens it
  const now = ctx.currentTime;
  d.pause();
  const ev = d.wsOut.gain.events.slice(-2);
  assert.deepEqual(ev[0], { type: 'linearRampToValueAtTime', value: 0, time: now + 0.005 });
  assert.equal(ev[1].type, 'setValueAtTime');
  assert.equal(ev[1].value, 1);
  close(ev[1].time, now + lat + 0.04);
  await engine.destroy();
});

test('pre-roll: negative positions are silence, the start is rescheduled on a tempo change', async () => {
  const { ctx, engine, d } = await rig();
  d.load(silentBuffer({ seconds: 30 }));
  d.seek(-2);
  assert.equal(d.position, -2);
  d.play();
  close(d.source.startArgs[0], 0.03 + 2, 1e-12);
  assert.equal(d.source.startArgs[1], 0);
  ctx.advance(1.03);
  close(d.position, -1);
  // tempo change during the pre-roll: the start is rescheduled
  d.setTempo(1.25);
  const first = d.source.startArgs;
  // heard position -1 at now: track start 1/1.25 s later (+ the compensation)
  close(d.position, -1, 1e-9);
  close(first[0], ctx.currentTime + 0.03 + (1 - 0.03 * 1.25) / 1.25, 1e-9);
  ctx.advance(0.8);
  close(d.position, 0, 1e-9);
  ctx.advance(0.4);
  close(d.position, 0.5, 1e-9);
  await engine.destroy();
});

test("natural end: 'ended', playing false, position at the end; play restarts at 0", async () => {
  const { ctx, engine, d, types } = await rig();
  d.load(silentBuffer({ seconds: 2 }));
  d.play();
  ctx.advance(1);
  assert.equal(d.playing, true);
  ctx.advance(1.1);
  assert.equal(d.playing, false);
  assert.equal(d.position, 2);
  assert.deepEqual(types().slice(-3), ['play', 'pause', 'ended']);
  assert.ok(d._endedAt != null && d._endedAt <= ctx.currentTime);
  d.play();
  assert.deepEqual(d.source.startArgs, [ctx.currentTime + 0.03, 0]);
  // a stopped source never fires 'ended'
  d.pause();
  ctx.advance(5);
  assert.equal(types().filter((t) => t === 'ended').length, 1);
  await engine.destroy();
});
