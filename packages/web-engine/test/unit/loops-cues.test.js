// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #10: loops, beat jumps, hot cues and the CDJ cue.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAudioGlobals, makeContext } from '../helpers/fake-audio.js';
import { silentBuffer, beatList } from '../helpers/fixtures.js';
import { createEngine } from '../../src/index.js';

let restore;
before(() => { restore = installFakeAudioGlobals(); });
after(() => restore());

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b}`);

// 120 BPM beat list (0, 0.5, 1.0, …) on a 60 s track, or a fixed grid
async function rig({ grid = 'list', seconds = 60 } = {}) {
  const ctx = makeContext();
  const engine = await createEngine({ context: ctx });
  const d = engine.decks[0];
  const meta = grid === 'list'
    ? { bpm: 120, beats: beatList({ bpm: 120, first: 0, count: seconds * 2 }) }
    : grid === 'fixed' ? { bpm: 120, beatOffset: 0.1 } : {};
  d.load(silentBuffer({ seconds }), meta);
  const events = [];
  for (const t of ['loop', 'hotcue', 'cuepoint', 'play', 'pause']) d.on(t, (e) => events.push({ type: t, ...e }));
  return { ctx, engine, d, events };
}

test('setLoop / exitLoop / reloop: native loop, wrap, events', async () => {
  const { ctx, engine, d, events } = await rig();
  d.play();
  ctx.advance(0.53);
  assert.equal(d.setLoop(1.0, 1.5), true);
  assert.equal(d.source.loop, true);
  assert.equal(d.source.loopStart, 1.0);
  assert.equal(d.source.loopEnd, 1.5);
  const ev = events.at(-1);
  assert.equal(ev.type, 'loop');
  assert.deepEqual({ active: ev.active, start: ev.start, end: ev.end, beats: ev.beats, inPoint: ev.inPoint },
    { active: true, start: 1, end: 1.5, beats: 1, inPoint: null });
  ctx.advance(1.2); // heard 1.7 → wrapped
  close(d.position, 1.2);
  assert.equal(d.setLoop(2, 2.005), false, 'at least 10 ms');
  assert.equal(d.setLoop(NaN, 3), false);
  d.exitLoop();
  assert.equal(d.loop.active, false);
  assert.equal(d.source.loop, false);
  assert.deepEqual([d.loop.start, d.loop.end], [1, 1.5], 'kept for reloop');
  close(d.position, 1.2, 1e-9, 'no jump on exit');
  ctx.advance(0.5);
  close(d.position, 1.7, 1e-9, 'continues linearly');
  assert.equal(d.reloop(), true);
  assert.equal(d.loop.active, true);
  close(d.position, 1.2, 1e-9, 'past the end: the playhead wraps');
  assert.equal(events.filter((e) => e.type === 'loop').length, 3);
  // clamped to the track
  assert.equal(d.setLoop(-5, 1000), true);
  assert.deepEqual([d.loop.start, d.loop.end], [0, 60]);
  // a seek outside the loop disables it
  d.setLoop(10, 12);
  d.seek(20);
  assert.equal(d.loop.active, false);
  assert.equal(events.at(-1).type, 'loop');
  assert.equal(events.at(-1).active, false);
  await engine.destroy();
});

test('beatLoop: quantized start (nearest ¼ beat), grid length, resize; quantize off', async () => {
  const { engine, d } = await rig();
  d.seek(1.13);
  assert.equal(d.beatLoop(4), true);
  close(d.loop.start, 1.125);
  close(d.loop.end, 3.125);
  assert.equal(d.loop.beats, 4);
  assert.equal(d.beatLoop(2), true, 'resize from the start');
  close(d.loop.start, 1.125);
  close(d.loop.end, 2.125);
  assert.equal(d.loop.beats, 2);
  d.exitLoop();
  d.quantize = false;
  d.seek(1.13);
  d.beatLoop(1);
  close(d.loop.start, 1.13);
  close(d.loop.end, 1.63);
  assert.equal(d.beatLoop(0), false);
  assert.equal(d.beatLoop(-1), false);
  await engine.destroy();
  // fixed grid: ¼-beat snapping from beatOffset
  const f = await rig({ grid: 'fixed' });
  f.d.seek(1.13);
  f.d.beatLoop(4);
  close(f.d.loop.start, 1.1);
  close(f.d.loop.end, 3.1);
  assert.equal(f.d.loop.beats, 4);
  await f.engine.destroy();
  // no BPM: impossible
  const n = await rig({ grid: 'none' });
  assert.equal(n.d.beatLoop(4), false);
  assert.equal(n.d.loop.beats, null);
  await n.engine.destroy();
});

test('loop.beats follows the real beats of a beat list, rounded to 1/32 beat', async () => {
  const ctx = makeContext();
  const engine = await createEngine({ context: ctx });
  const d = engine.decks[0];
  // tempo change at beat 8: 0.5 s beats then 0.4 s beats
  const beats = [];
  for (let k = 0, t = 0; k < 40; k++) { beats.push(t); t += k < 8 ? 0.5 : 0.4; }
  d.load(silentBuffer({ seconds: 30 }), { beats });
  d.setLoop(3.5, 4.8);   // beat 7 → beat 7 + 1 + 0.8/0.4 = 10
  assert.equal(d.loop.beats, 3);
  d.setLoop(3.5, 3.5 + 0.5 / 3);
  assert.equal(d.loop.beats, 0.34375, '1/3 beat rounded to 1/32');
  d.seek(3.6);
  d.exitLoop();
  d.beatLoop(4); // nearest ¼ beat of 3.6 = beat 7.25; 4 real beats later = beat 11.25
  close(d.loop.start, 3.625);
  close(d.loop.end, 4.0 + 3 * 0.4 + 0.1);
  await engine.destroy();
});

test('loopIn / loopOut rules; halve / double limits', async () => {
  const { engine, d, events } = await rig({ seconds: 8 });
  assert.equal(d.loopOut(), false, 'no IN point yet');
  d.seek(1.13);
  assert.equal(d.loopIn(), true);
  close(d.loop.inPoint, 1.0, 1e-12, 'snapped to the nearest beat');
  assert.equal(d.loop.active, false);
  assert.equal(events.at(-1).type, 'loop');
  d.seek(1.2);
  assert.equal(d.loopOut(), false, 'OUT must be more than 50 ms after IN');
  d.seek(2.8);
  assert.equal(d.loopOut(), true);
  assert.deepEqual([d.loop.start, d.loop.end, d.loop.beats], [1, 3, 4]);
  // halve down to 1/8 beat
  const lens = [];
  while (d.loopHalve()) lens.push(d.loop.end - d.loop.start);
  assert.deepEqual(lens, [1, 0.5, 0.25, 0.125, 0.0625]);
  assert.equal(d.loop.beats, 0.125);
  // double while it stays inside the track (8 s)
  const ends = [];
  while (d.loopDouble()) ends.push(d.loop.end);
  assert.deepEqual(ends, [1.125, 1.25, 1.5, 2, 3, 5]);
  d.exitLoop();
  assert.equal(d.loopHalve(), false, 'active loop only');
  assert.equal(d.loopDouble(), false);
  // without a BPM, halving stops at 50 ms
  const n = await rig({ grid: 'none' });
  n.d.setLoop(1, 1.4);
  const hl = [];
  while (n.d.loopHalve()) hl.push(+(n.d.loop.end - n.d.loop.start).toFixed(6));
  assert.deepEqual(hl, [0.2, 0.1, 0.05]);
  // quantize off: IN/OUT where the playhead is
  n.d.quantize = false;
  n.d.exitLoop();
  n.d.seek(2.123);
  n.d.loopIn();
  close(n.d.loop.inPoint, 2.123);
  await engine.destroy();
  await n.engine.destroy();
});

test('beatJump: beat lists follow the real beats, an active loop moves too', async () => {
  const { ctx, engine, d, events } = await rig({ seconds: 30 });
  d.seek(5.2);
  assert.equal(d.beatJump(4), true);
  close(d.position, 7.2);
  d.beatJump(-16);
  close(d.position, -0.8, 1e-9, 'into the pre-roll (extrapolated grid)');
  d.seek(1.2);
  d.play();
  ctx.advance(0.03);
  d.setLoop(1, 3);
  const n = events.length;
  assert.equal(d.beatJump(8), true);
  assert.deepEqual([d.loop.start, d.loop.end], [5, 7]);
  assert.equal(d.loop.active, true);
  close(d.position, 5.2, 1e-9);
  assert.equal(events.slice(n).filter((e) => e.type === 'loop').length, 1);
  // clamped to the track
  d.beatJump(1000);
  assert.deepEqual([d.loop.start, d.loop.end], [28, 30]);
  assert.equal(d.beatJump(1000), false, 'nothing moved');
  await engine.destroy();
  const f = await rig({ grid: 'fixed' });
  f.d.seek(2);
  f.d.beatJump(-2);
  close(f.d.position, 1);
  await f.engine.destroy();
  const z = await rig({ grid: 'none' });
  assert.equal(z.d.beatJump(4), false, 'false without a BPM');
  await z.engine.destroy();
});

test('hot cues: quantized set, explicit times, pad press, clear, events', async () => {
  const { ctx, engine, d, events } = await rig();
  d.seek(1.13);
  assert.equal(d.setHotCue(0), true);
  close(d.hotCues[0], 1.0, 1e-12, 'nearest beat');
  assert.deepEqual(events.at(-1), { type: 'hotcue', deck: d, index: 0, slot: 0, time: d.hotCues[0] });
  d.quantize = false;
  d.setHotCue(1);
  close(d.hotCues[1], 1.13);
  d.quantize = true;
  d.setHotCue(2, 7.777);
  assert.equal(d.hotCues[2], 7.777, 'explicit time stored as is');
  // pad press: empty slot → set; set slot → jump, play state unchanged
  d.seek(4.26);
  assert.equal(d.hotCue(3), true);
  close(d.hotCues[3], 4.5);
  assert.equal(d.hotCue(2), true);
  close(d.position, 7.777);
  assert.equal(d.playing, false);
  d.play();
  ctx.advance(1);
  d.hotCue(0);
  assert.equal(d.playing, true);
  close(d.position, 1.0);
  d.clearHotCue(0);
  assert.equal(d.hotCues[0], null);
  assert.deepEqual(events.at(-1), { type: 'hotcue', deck: d, index: 0, slot: 0, time: null });
  await engine.destroy();
});

test('cue(): CDJ semantics (never quantized)', async () => {
  const { ctx, engine, d, events } = await rig();
  d.seek(5.13);
  d.cue(); // paused elsewhere: set the cue point here
  close(d.cuePoint, 5.13, 1e-12, 'not quantized');
  assert.equal(events.at(-1).type, 'cuepoint');
  close(events.at(-1).time, 5.13);
  d.seek(5.14); // within 20 ms: re-seek to the cue point
  d.cue();
  close(d.position, 5.13);
  d.play();
  ctx.advance(2);
  d.cue(); // playing: back to the cue point and pause
  assert.equal(d.playing, false);
  close(d.position, 5.13);
  assert.ok(events.some((e) => e.type === 'pause'));
  d.setCuePoint(3);
  assert.equal(d.cuePoint, 3);
  assert.equal(events.at(-1).type, 'cuepoint');
  await engine.destroy();
});

test('cueDown / cueUp: hold to preview', async () => {
  const { ctx, engine, d, events } = await rig();
  d.seek(2);
  d.cueDown(); // paused away from the cue point (0): set it
  assert.equal(d.cuePoint, 2);
  assert.equal(d.playing, false);
  d.cueUp(); // no preview: nothing
  assert.equal(d.playing, false);
  d.cueDown(); // at the cue point: plays while held
  assert.equal(d.playing, true);
  assert.equal(events.at(-1).type, 'play');
  ctx.advance(1.5);
  d.cueUp(); // back to the cue point and pause
  assert.equal(d.playing, false);
  assert.equal(d.position, 2);
  d.play();
  ctx.advance(1);
  d.cueDown(); // while playing = cue(): back + pause
  assert.equal(d.playing, false);
  assert.equal(d.position, 2);
  d.cueUp();
  assert.equal(d.playing, false);
  await engine.destroy();
});
