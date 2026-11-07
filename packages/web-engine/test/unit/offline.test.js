// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #13: renderOffline() with the fake OfflineAudioContext.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAudioGlobals, makeContext, makeOfflineContext, FakeAudioBuffer } from '../helpers/fake-audio.js';
import { beatsFor, lazyBuffer } from '../helpers/fixtures.js';
import { createEngine, renderOffline } from '../../src/index.js';

let restore;
before(() => { restore = installFakeAudioGlobals(); });
after(() => restore());

test('ticks at k / tickRate rounded up to render quanta: increasing, deduplicated, below the end', async () => {
  const ctx = makeOfflineContext({ channels: 2, seconds: 0.25, sampleRate: 48000 });
  const engine = await createEngine({ context: ctx });
  const ticks = [];
  const engineTicks = [];
  engine.on('tick', (e) => engineTicks.push(e.time));
  const out = await renderOffline(engine, { tickRate: 60, onTick: (t) => ticks.push([t, ctx.currentTime]) });
  // k/60 s → frames 800, 1600, … rounded up to multiples of 128
  const want = [];
  for (let k = 1; ; k++) {
    const frame = Math.ceil((k / 60) * 48000 / 128) * 128;
    if (frame >= ctx.length) break;
    want.push(frame / 48000);
  }
  assert.deepEqual(ticks.map(([t]) => t), want);
  assert.ok(want.length === 14);
  for (const [t, now] of ticks) assert.equal(now, t, 'the context is suspended exactly there');
  assert.deepEqual(engineTicks, want, 'engine.tick() before each onTick');
  for (let i = 1; i < want.length; i++) assert.ok(want[i] > want[i - 1]);
  for (const t of want) assert.equal(Math.round(t * 48000) % 128, 0);
  assert.ok(out instanceof FakeAudioBuffer);
  assert.equal(out.length, ctx.length);
  assert.equal(ctx.state, 'closed');
  await engine.destroy();
});

test('high tick rates are deduplicated on the quantum grid', async () => {
  const ctx = makeOfflineContext({ seconds: 0.05, sampleRate: 8000 });
  const engine = await createEngine({ context: ctx });
  const ticks = [];
  await renderOffline(engine, { tickRate: 1000, onTick: (t) => ticks.push(t) });
  // quantum = 128 frames = 16 ms at 8 kHz: 1 ms ticks collapse onto 16, 32
  // and 48 ms (the render ends at 50 ms: frame 400)
  assert.deepEqual(ticks, [0.016, 0.032, 0.048]);
  await engine.destroy();
});

test('onTick is awaited; the next suspend is scheduled lazily from the handler', async () => {
  const ctx = makeOfflineContext({ seconds: 0.2 });
  const engine = await createEngine({ context: ctx });
  const order = [];
  let pendingMax = 0;
  await renderOffline(engine, {
    tickRate: 20,
    onTick: async (t) => {
      pendingMax = Math.max(pendingMax, ctx._suspends.length);
      order.push(['start', t]);
      await new Promise((r) => setTimeout(r, 5));
      order.push(['end', t, ctx.currentTime]);
    }
  });
  assert.deepEqual(order.map((o) => o[0]), ['start', 'end', 'start', 'end', 'start', 'end']);
  for (const o of order.filter((x) => x[0] === 'end')) assert.equal(o[2], o[1], 'still suspended while awaited');
  assert.equal(pendingMax, 0, 'one suspend at a time');
  assert.equal(ctx.suspendCalls.length, 3);
  await engine.destroy();
});

test('the engine works during the render: sync between two decks on the audio timeline', async () => {
  const ctx = makeOfflineContext({ seconds: 6 });
  const engine = await createEngine({ context: ctx, decks: 2 });
  const [a, b] = engine.decks;
  a.load(lazyBuffer({ seconds: 30 }), { bpm: 124, beats: beatsFor({ bpm: 124, seconds: 30, first: 0.1 }) });
  b.load(lazyBuffer({ seconds: 30 }), { bpm: 128, beats: beatsFor({ bpm: 128, seconds: 30, first: 0.1 }) });
  a.play();
  let result;
  await renderOffline(engine, {
    onTick: (t) => {
      if (result === undefined && t >= 2) {
        result = b.sync();
        b.play();
      }
    }
  });
  assert.equal(result, 'synced');
  assert.equal(engine.masterIndex, 0);
  assert.ok(Math.abs(b.effectiveBpm - 124) < 1e-6);
  let e = engine._beatPhase(a) - engine._beatPhase(b);
  e -= Math.round(e);
  assert.ok(Math.abs(e) < 1e-6, `phase error ${e}`);
  await engine.destroy();
});

test('errors: TypeError for a realtime or already rendered context; clear Error without suspend', async () => {
  const rt = await createEngine({ context: makeContext() });
  assert.throws(() => renderOffline(rt), TypeError);
  assert.throws(() => renderOffline({}), TypeError);
  await rt.destroy();
  const ctx = makeOfflineContext({ seconds: 0.1 });
  const engine = await createEngine({ context: ctx });
  await renderOffline(engine, { tickRate: 0 });
  assert.throws(() => renderOffline(engine), TypeError, 'already rendered');
  await engine.destroy();
  const noSuspend = makeOfflineContext({ seconds: 0.1, noSuspend: true });
  const e2 = await createEngine({ context: noSuspend });
  await assert.rejects(renderOffline(e2), /tickRate: 0/);
  await assert.rejects(renderOffline(e2, { tickRate: 30 }), /suspend/);
  const buf = await renderOffline(e2, { tickRate: 0 });
  assert.equal(buf.length, noSuspend.length, 'tickRate: 0 renders without suspend');
  await e2.destroy();
  const e3 = await createEngine({ context: makeOfflineContext({ seconds: 0.1 }) });
  assert.throws(() => renderOffline(e3, { tickRate: -1 }), RangeError);
  await e3.destroy();
});

test('a failing onTick rejects the render (the context is not left suspended)', async () => {
  const ctx = makeOfflineContext({ seconds: 0.2 });
  const engine = await createEngine({ context: ctx });
  await assert.rejects(renderOffline(engine, { tickRate: 20, onTick: () => { throw new Error('boom'); } }), /boom/);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.state, 'closed', 'the render went on to the end');
  await engine.destroy();
});
