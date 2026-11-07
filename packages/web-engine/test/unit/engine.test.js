// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #8: engine defaults, sizes, RangeError cases, worklet
// loading, lifecycle (fake context, silent).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  installFakeAudioGlobals, makeContext, makeOfflineContext, FakeAudioContext, FakeAudioWorkletNode
} from '../helpers/fake-audio.js';
import { silentBuffer } from '../helpers/fixtures.js';
import {
  createEngine, Engine, Deck, FxUnit, PITCH_PROCESSOR_NAME, WSOLA_LATENCY_SAMPLES
} from '../../src/index.js';
import { FEEDBACK_WAIT_MS } from '../../src/engine.js';

let restore;
before(() => { restore = installFakeAudioGlobals(); });
after(() => restore());

test('defaults: 4 decks, 4 units, 8 slots, sides A/B/A/B, unit u assigned to deck u', async () => {
  const ctx = makeContext();
  const engine = await createEngine({ context: ctx });
  assert.ok(engine instanceof Engine);
  assert.equal(engine.context, ctx);
  assert.equal(engine.isOffline, false);
  assert.equal(engine.decks.length, 4);
  assert.equal(engine.fx.length, 4);
  engine.decks.forEach((d, i) => {
    assert.ok(d instanceof Deck);
    assert.equal(d.index, i);
    assert.equal(d.engine, engine);
    assert.equal(d.hotCues.length, 8);
    assert.equal(d.crossfaderSide, i % 2 ? 'B' : 'A');
  });
  engine.fx.forEach((u, i) => {
    assert.ok(u instanceof FxUnit);
    assert.equal(u.type, 'echo');
    assert.equal(u.enabled, false);
    assert.equal(u.level, 0);
    assert.equal(u.beats, 0.5);
    assert.equal(u.beatDuration, 0.5);
    for (let d = 0; d < 4; d++) {
      assert.equal(engine.fxAssign[i][d], i === d);
      assert.equal(engine.isFxAssigned(i, d), i === d);
    }
  });
  assert.equal(engine.masterFx, null);
  assert.equal(engine.crossfader, 0.5);
  assert.equal(engine.masterVolume, 0.9);
  assert.equal(engine.masterFilter, 0);
  assert.equal(engine.headphoneVolume, 1);
  assert.equal(engine.colorFx, 'filter');
  assert.equal(engine.colorFxEnabled, true);
  assert.equal(engine.masterIndex, null);
  assert.equal(engine.manualMasterIndex, null);
  assert.equal(engine.masterDeck, null);
  assert.equal(engine.masterBpm, null);
  assert.equal(engine.syncHold, false);
  assert.equal(engine.gridOffset, 0);
  assert.equal(engine.pitchEngine, 'wsola');
  assert.equal(engine.pitchEngineError, null);
  assert.equal(engine.headphonesAvailable, false);
  assert.ok(engine.masterOut);
  assert.ok(engine.cueOut);
  // deck defaults
  const d = engine.decks[0];
  assert.equal(d.loaded, false);
  assert.equal(d.duration, 0);
  assert.equal(d.position, 0);
  assert.equal(d.playing, false);
  assert.equal(d.tempo, 1);
  assert.equal(d.baseTempo, 1);
  assert.equal(d.volume, 0.85);
  assert.equal(d.quantize, true);
  assert.equal(d.synced, false);
  assert.equal(d.keylock, false);
  assert.equal(d.keyShift, 0);
  assert.equal(d.musicKey, null);
  assert.equal(d.heardKey, null);
  assert.equal(d.bpm, null);
  assert.equal(d.effectiveBpm, null);
  assert.equal(d.beatDuration, null);
  assert.equal(d.latency, 0);
  assert.equal(d.isMaster, false);
  assert.deepEqual(d.loop, { active: false, start: 0, end: 0, beats: null, inPoint: null });
  assert.deepEqual({ ...d.eq }, { low: 0, mid: 0, high: 0 });
  assert.deepEqual({ ...d.kills }, { low: false, mid: false, high: false });
  assert.deepEqual({ ...d.stemStates }, { vocals: true, drums: true, bass: true, other: true });
  assert.equal(d.trimValue, 0);
  assert.equal(d.filterValue, 0);
  assert.equal(d.headphoneCue, false);
  assert.equal(d.stemsActive, false);
  assert.equal(d.insert, null);
  assert.equal(d.padFx, null);
  assert.equal(d.roll, null);
  assert.equal(d.spinning, false);
  assert.equal(d.scrubbing, false);
  assert.equal(d.nudging, false);
  // auto-tick: no requestAnimationFrame in Node → off
  assert.equal(engine._auto, null);
  // fader gain v², master 0.9, limiter as in OpenMix
  assert.equal(d.fader.gain.value, 0.85 * 0.85);
  assert.equal(engine.masterGain.gain.value, 0.9);
  assert.equal(engine.limiter.threshold.value, -3);
  assert.equal(engine.limiter.knee.value, 0);
  assert.equal(engine.limiter.ratio.value, 12);
  assert.equal(engine.limiter.attack.value, 0.002);
  assert.equal(engine.limiter.release.value, 0.15);
  assert.equal(d.analyser.fftSize, 512);
  await engine.destroy();
});

test('decks: 2 and decks: 6 size everything (units, sides, matrix, pads)', async () => {
  for (const n of [2, 6]) {
    const engine = await createEngine({ context: makeContext(), decks: n });
    assert.equal(engine.decks.length, n);
    assert.equal(engine.fx.length, n);
    assert.deepEqual(engine.decks.map((d) => d.crossfaderSide), Array.from({ length: n }, (_, i) => (i % 2 ? 'B' : 'A')));
    assert.equal(engine.fxAssign.length, n);
    engine.fxAssign.forEach((row, u) => assert.deepEqual([...row], Array.from({ length: n }, (_, i) => i === u)));
    assert.equal(engine._padFx.length, n);
    engine.decks.forEach((d) => assert.equal(d.fxSends.length, n));
    // the last deck works like the others
    const last = engine.decks[n - 1];
    last.load(silentBuffer({ seconds: 4 }), { bpm: 120, beatOffset: 0 });
    last.play();
    engine.tick();
    assert.equal(engine.masterIndex, n - 1);
    await engine.destroy();
  }
});

test('fxUnits and hotCues options', async () => {
  const engine = await createEngine({ context: makeContext(), decks: 3, fxUnits: 0, hotCues: 16 });
  assert.equal(engine.fx.length, 0);
  assert.deepEqual(engine.fxAssign, []);
  engine.decks.forEach((d) => assert.equal(d.hotCues.length, 16));
  engine.tick(); // no unit: the FX steps still run
  const e2 = await createEngine({ context: makeContext(), decks: 2, fxUnits: 4 });
  assert.equal(e2.fx.length, 4);
  assert.deepEqual(e2.fxAssign.map((r) => [...r]), [[true, false], [false, true], [false, false], [false, false]]);
  await engine.destroy();
  await e2.destroy();
});

test('RangeError cases', async () => {
  const ctx = makeContext();
  for (const bad of [{ decks: 0 }, { decks: 9 }, { decks: 2.5 }, { fxUnits: 9 }, { fxUnits: -1 }, { hotCues: 0 }, { hotCues: 17 }]) {
    assert.throws(() => new Engine({ context: ctx, ...bad }), RangeError, JSON.stringify(bad));
  }
  const engine = await createEngine({ context: ctx });
  const d = engine.decks[0];
  d.load(silentBuffer({ seconds: 8 }), { bpm: 120, beatOffset: 0 });
  const cases = [
    () => engine.setColorFx('wah'),
    () => engine.assignFx(4, 0),
    () => engine.assignFx(0, 4),
    () => engine.isFxAssigned(-1, 0),
    () => engine.setMaster(4),
    () => engine.setMaster(1.5),
    () => engine.reanchorSync(7),
    () => d.setEq('bass', 0),
    () => d.setKill('treble', true),
    () => d.setCrossfaderSide('C'),
    () => d.setHotCue(8),
    () => d.clearHotCue(-1),
    () => d.hotCue(1.5),
    () => d.setStem('voice', true),
    () => d.toggleStem('guitar'),
    () => d.scaleGrid(3),
    () => d.spinStart('scratch'),
    () => d.setPadFx({ type: 'wah', beats: 1 }),
    () => d.setPadFx({ type: 'echo', beats: 0 }),
    () => d.setMusicKey(24),
    () => d.loadStems({ voice: silentBuffer() }),
    () => engine.fx[0].setType('wah')
  ];
  cases.forEach((fn, i) => assert.throws(fn, RangeError, `case ${i}: ${fn}`));
  await engine.destroy();
});

test('TypeError cases and invalid numbers (no-op)', async () => {
  assert.throws(() => new Engine({ context: {} }), TypeError);
  assert.throws(() => new Engine({ context: makeContext(), output: 42 }), TypeError);
  const engine = await createEngine({ context: makeContext() });
  const d = engine.decks[0];
  assert.throws(() => d.load({}), TypeError);
  assert.throws(() => d.load(null), TypeError);
  assert.throws(() => d.setInsert({}), TypeError);
  // NaN or a non-number makes the call a no-op
  engine.setCrossfader(NaN);
  engine.setMasterVolume('loud');
  d.setVolume(undefined);
  d.setEq('low', NaN);
  d.setTempo(NaN);
  d.setKey('x');
  assert.equal(engine.crossfader, 0.5);
  assert.equal(engine.masterVolume, 0.9);
  assert.equal(d.volume, 0.85);
  assert.equal(d.eq.low, 0);
  assert.equal(d.tempo, 1);
  assert.equal(d.keyShift, 0);
  // out of range: clamped
  d.setVolume(3);
  d.setTempo(9);
  d.setKey(-12.4);
  assert.equal(d.volume, 1);
  assert.equal(d.tempo, 1.6);
  assert.equal(d.keyShift, -7);
  // impossible operations without a track: false / null / nothing, never a throw
  assert.equal(d.setHotCue(0), false);
  assert.equal(d.hotCue(0), false);
  assert.equal(d.beatLoop(4), false);
  assert.equal(d.beatJump(4), false);
  assert.equal(d.setLoop(0, 1), false);
  assert.equal(d.loopIn(), false);
  assert.equal(d.reloop(), false);
  assert.equal(d.startRoll(1), false);
  assert.equal(d.spinStart('brake'), false);
  assert.equal(d.setDownbeat(), false);
  assert.equal(d.sync(), null);
  assert.equal(d.nudge(0.05), false);
  assert.equal(d.snapToReference(), false);
  d.play();
  d.cue();
  d.seek(4);
  assert.equal(d.playing, false);
  await engine.destroy();
});

test('worklet: added once per context, nodes on every deck, latency compensation', async () => {
  const ctx = makeContext();
  const a = await createEngine({ context: ctx, decks: 2 });
  const b = await createEngine({ context: ctx, decks: 3 });
  assert.equal(ctx.workletCalls.length, 1, 'addModule called once for the context');
  assert.match(ctx.workletCalls[0], /worklets\/pitch-processor\.js$/);
  for (const e of [a, b]) {
    assert.equal(e.pitchEngine, 'wsola');
    for (const d of e.decks) {
      assert.ok(d.wsola instanceof FakeAudioWorkletNode);
      assert.equal(d.wsola.processorName, PITCH_PROCESSOR_NAME);
      assert.deepEqual(d.wsola.options.outputChannelCount, [2]);
      assert.ok(ctx.isConnected(d.preIn, d.wsola));
      assert.ok(ctx.isConnected(d.wsola, d.wsOut));
    }
  }
  const d = a.decks[0];
  d.setKeylock(true);
  assert.equal(d.latency, WSOLA_LATENCY_SAMPLES / ctx.sampleRate);
  assert.ok(Math.abs(d.wsola.parameters.get('ratio').value - 1) < 1e-12);
  d.setTempo(1.25);
  assert.ok(Math.abs(d.wsola.parameters.get('ratio').value - 0.8) < 1e-12, 'keylock compensation follows the tempo');
  d.setKeylock(false);
  d.setKey(3);
  assert.ok(Math.abs(d.wsola.parameters.get('ratio').value - Math.pow(2, 3 / 12)) < 1e-12);
  assert.equal(d.latency, WSOLA_LATENCY_SAMPLES / ctx.sampleRate, 'key ≠ 0 routes through the transposer');
  d.setKey(0);
  assert.equal(d.latency, 0, 'back to the direct path');
  // the worklet's { lat } message is honored
  d.setKey(1);
  d.wsola.port.onmessage({ data: { lat: 4800 } });
  assert.equal(d.latency, 0.1);
  await a.destroy();
  await b.destroy();
  assert.equal(ctx.closeCalls, 0, 'an injected context is never closed');
});

test('worklet failures: fallback engine with the cause; ready never rejects', async () => {
  const rejected = await createEngine({ context: makeContext({ worklet: 'reject' }) });
  assert.equal(rejected.pitchEngine, 'fallback');
  assert.match(rejected.pitchEngineError.message, /module could not be loaded/);
  const none = await createEngine({ context: makeContext({ worklet: 'none' }) });
  assert.equal(none.pitchEngine, 'fallback');
  assert.match(none.pitchEngineError.message, /AudioWorklet is unavailable/);
  const nodeFails = await createEngine({ context: makeContext({ workletNodeThrows: true }) });
  assert.equal(nodeFails.pitchEngine, 'fallback');
  assert.match(nodeFails.pitchEngineError.message, /could not be created/);
  assert.equal(nodeFails.decks[0].wsola, null);
  const ctx = makeContext();
  const off = await createEngine({ context: ctx, keylock: false });
  assert.equal(off.pitchEngine, 'fallback');
  assert.equal(off.pitchEngineError, null);
  assert.equal(ctx.workletCalls.length, 0);
  // the fallback shifter does the transposition
  const d = off.decks[0];
  d.setKey(2);
  assert.ok(ctx.isConnected(d.preIn, d.shifter.input));
  assert.equal(d.dirGain.gain.value, 0);
  assert.equal(d.latency, 0, 'no read-ahead with the fallback shifter');
  d.setKey(0);
  assert.ok(!ctx.isConnected(d.preIn, d.shifter.input));
  assert.equal(d.dirGain.gain.value, 1);
  for (const e of [rejected, none, nodeFails, off]) await e.destroy();
});

test('decks use the fallback shifter until the worklet is ready', async () => {
  const ctx = makeContext();
  const engine = new Engine({ context: ctx });
  assert.equal(engine.pitchEngine, 'loading');
  const d = engine.decks[0];
  d.setKey(4);
  assert.equal(d.wsola, null);
  assert.ok(ctx.isConnected(d.preIn, d.shifter.input), 'fallback engaged meanwhile');
  await engine.ready;
  assert.equal(engine.pitchEngine, 'wsola');
  assert.ok(!ctx.isConnected(d.preIn, d.shifter.input), 'the fallback is unplugged');
  assert.equal(d.wsOut.gain.value, 1);
  assert.equal(d.dirGain.gain.value, 0);
  assert.equal(d.latency, WSOLA_LATENCY_SAMPLES / ctx.sampleRate);
  await engine.destroy();
});

test('workletUrl option', async () => {
  const ctx = makeContext();
  const engine = await createEngine({ context: ctx, workletUrl: 'https://cdn.example/pitch-processor.js' });
  assert.deepEqual(ctx.workletCalls, ['https://cdn.example/pitch-processor.js']);
  await engine.destroy();
});

test('destroy() closes only an owned context; no context at all is an Error', async () => {
  const restoreAC = installFakeAudioGlobals({ audioContext: true });
  try {
    const owned = await createEngine({ contextOptions: { latencyHint: 'playback' } });
    const ctx = owned.context;
    assert.ok(ctx instanceof FakeAudioContext);
    assert.deepEqual(ctx.options, { latencyHint: 'playback' });
    await owned.destroy();
    assert.equal(ctx.closeCalls, 1);
    assert.equal(ctx.state, 'closed');
    const def = new Engine();
    assert.deepEqual(def.context.options, { latencyHint: 'interactive' });
    await def.destroy();
  } finally {
    restoreAC();
  }
  const saved = globalThis.AudioContext;
  delete globalThis.AudioContext;
  try {
    assert.throws(() => new Engine(), { message: 'No AudioContext available; pass options.context' });
  } finally {
    if (saved) globalThis.AudioContext = saved;
  }
  const injected = makeContext();
  const e = await createEngine({ context: injected });
  e.decks[0].load(silentBuffer({ seconds: 2 }));
  e.decks[0].play();
  await e.destroy();
  assert.equal(injected.closeCalls, 0);
  assert.equal(e.decks[0].playing, false);
  assert.equal(injected.targetsOf(e.limiter).length, 0, 'disconnected from the outputs');
  e.tick(); // later calls are unsupported but harmless
});

test("'statechange' proxies the context event; resume() never rejects", async () => {
  const ctx = makeContext({ state: 'suspended' });
  const engine = await createEngine({ context: ctx });
  const states = [];
  engine.on('statechange', (e) => states.push(e.state));
  await engine.resume();
  assert.equal(ctx.state, 'running');
  assert.deepEqual(states, ['running']);
  await ctx.close();
  await engine.resume(); // rejected by the context: swallowed
  assert.deepEqual(states, ['running', 'closed']);
  await engine.destroy();
});

test('a context that has not started yet: the permanent sources start on its first running state', async () => {
  // Chrome logs "The AudioContext was not allowed to start" for every start()
  // on a context that the autoplay policy keeps suspended
  const ctx = makeContext({ state: 'suspended' });
  const engine = await createEngine({ context: ctx });
  // the color-FX noise, 7 sources per FX unit, 4 ramps per fallback shifter
  const permanent = [...ctx._sources];
  assert.equal(permanent.length, 1 + 4 * 7 + 4 * 4);
  assert.ok(permanent.every((s) => s.startTime === null), 'no start() while the context is suspended');
  // a modulation re-aligned meanwhile: its pending oscillator is dropped
  const u = engine.fx[0];
  u.setType('trans');
  const old = u.trOsc;
  assert.equal(u.alignTo(1.25), true);
  assert.notEqual(u.trOsc, old);
  assert.equal(ctx.targetsOf(old).length, 0, 'the dropped oscillator is disconnected');
  engine.tick(); // still suspended: nothing starts
  assert.ok(permanent.every((s) => s.startTime === null));
  await engine.resume();
  assert.equal(ctx.state, 'running');
  assert.equal(old.startTime, null, 'the dropped oscillator never starts');
  assert.equal(u.trOsc.startTime, 1.25, 'its replacement starts on its beat time');
  assert.ok(permanent.filter((s) => s !== old).every((s) => s.startTime === 0), 'all started once running');
  // later sources (pad FX, master FX) start at once on a running context
  const mfx = engine.ensureMasterFx();
  assert.equal(mfx.trConst.startTime, 0);
  await engine.destroy();
  // an OfflineAudioContext stays 'suspended' until it renders: started at once
  const off = makeOfflineContext();
  const e2 = await createEngine({ context: off });
  assert.equal(off.state, 'suspended');
  assert.equal(e2.noiseSrc.startTime, 0);
  assert.ok(e2.fx.every((x) => x.flLfo.startTime === 0 && x.trConst.startTime === 0));
  assert.ok(e2.decks.every((d) => d.shifter._sources.every((s) => s.startTime === 0)));
  await e2.destroy();
});

test('destroy() before the context ever ran: the pending sources never start', async () => {
  const ctx = makeContext({ state: 'suspended' });
  const engine = await createEngine({ context: ctx });
  const permanent = [...ctx._sources];
  assert.ok(permanent.length > 0 && permanent.every((s) => s.startTime === null));
  await engine.destroy();
  assert.equal((ctx._listeners.get('statechange') || new Set()).size, 0, 'no listener left on the context');
  await ctx.resume();
  assert.ok(permanent.every((s) => s.startTime === null && s.stopTime === null), 'nothing starts after destroy()');
});

test(`ready waits for the FX feedback-latency measurement ${FEEDBACK_WAIT_MS} ms at most; a late result is applied`, { timeout: 10000 }, async () => {
  // an OfflineAudioContext whose render does not end until the test ends it
  let finish = null;
  class SlowOfflineAudioContext {
    constructor(channels, length, sampleRate) {
      this.length = length;
      this.sampleRate = sampleRate;
      this.destination = {};
    }

    createBuffer(c, length) {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }

    createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
    createDelay() { return { delayTime: { value: 0 }, connect() {} }; }
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    startRendering() { return new Promise((resolve) => { finish = resolve; }); }
  }
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'OfflineAudioContext');
  const saved = { oac: globalThis.OfflineAudioContext, setTimeout: globalThis.setTimeout };
  globalThis.OfflineAudioContext = SlowOfflineAudioContext;
  // the wait itself is shortened; every other timer is untouched
  globalThis.setTimeout = (fn, ms, ...rest) => saved.setTimeout(fn, ms === FEEDBACK_WAIT_MS ? 5 : ms, ...rest);
  const logs = [];
  let engine = null;
  try {
    // a sample rate measured nowhere else in this file (results are cached per rate)
    engine = await createEngine({ context: makeContext({ sampleRate: 32000 }), log: (m) => logs.push(m) });
  } finally {
    globalThis.setTimeout = saved.setTimeout;
  }
  try {
    assert.equal(typeof finish, 'function', 'the measurement render is still running');
    assert.ok(logs.some((m) => m.includes(`not measured after ${FEEDBACK_WAIT_MS} ms`)), logs.join('\n'));
    assert.equal(engine._fbLatency, null);
    const u = engine.fx[0];
    u.setBeats(1);
    assert.equal(u.echoDelay.delayTime.value, 0.5, 'no correction yet');
    // the render ends: first repeat on time (frame 256 = D), the second one a
    // render quantum late (640 = 2 × 256 + 128)
    const out = new Float32Array(1024);
    out[256] = 0.5;
    out[640] = 0.25;
    finish({ getChannelData: () => out });
    await new Promise((r) => setImmediate(r));
    assert.equal(engine._fbLatency.loop, 128 / 32000);
    assert.ok(Math.abs(u.echoDelay.delayTime.value - (0.5 - 128 / 32000)) < 1e-12, 'applied when it arrives');
  } finally {
    if (had) globalThis.OfflineAudioContext = saved.oac;
    else delete globalThis.OfflineAudioContext;
    if (engine) await engine.destroy();
  }
});

test('auto-tick timer cadence: 20 ms on average, late timers caught up, no burst, frames take over again', async () => {
  const engine = await createEngine({ context: makeContext(), autoTick: false });
  let ticks = 0;
  engine.on('tick', () => { ticks++; });
  const saved = {
    raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, doc: globalThis.document,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now
  };
  const frames = [];
  const timers = new Map();
  let nextTimer = 1;
  let now = 1e6;
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.setTimeout = (fn, ms) => { timers.set(nextTimer, { fn, ms }); return nextTimer++; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  Date.now = () => now;
  const pendingDelay = () => {
    assert.equal(timers.size, 1, 'exactly one timer pending');
    return [...timers.values()][0].ms;
  };
  // runs the pending timer `lateMs` after it was due (or at `at`)
  const fire = (lateMs = 0, at = null) => {
    const [[id, t]] = timers;
    timers.delete(id);
    now = at != null ? at : now + t.ms + lateMs;
    t.fn();
  };
  try {
    engine.startAutoTick();
    assert.equal(frames.length, 1);
    assert.equal(pendingDelay(), 100, 'frames are given 100 ms first');
    fire();
    assert.equal(engine._auto.stalled, true, 'no frame for 100 ms: stalled');
    assert.equal(ticks, 1);
    assert.equal(pendingDelay(), 20);
    fire(11); // 11 ms late (31 ms: a 15.6 ms system timer)
    assert.equal(pendingDelay(), 9, 'the next tick comes sooner');
    fire();
    assert.equal(pendingDelay(), 20);
    fire(500); // a frozen page: one tick at once, no burst
    assert.equal(pendingDelay(), 0);
    fire();
    assert.equal(pendingDelay(), 20);
    now -= 60000; // the clock jumps back: the cadence restarts
    fire();
    assert.equal(pendingDelay(), 20);
    // On Windows' default 15.625 ms system timer (each timer fires at the
    // first timer interrupt after it is due): 50 ticks per second on
    // average, where a plain 20 ms timeout gives 32
    const onQuantizedTimer = () => fire(0, Math.ceil((now + pendingDelay()) / 15.625) * 15.625);
    now = 15.625 * 1e5;
    for (let i = 0; i < 5; i++) onQuantizedTimer(); // (the clock jumped forward: one catch-up tick)
    const t0 = now;
    const n0 = ticks;
    while (now - t0 < 2000) onQuantizedTimer();
    const perSecond = ((ticks - n0) * 1000) / (now - t0);
    assert.ok(Math.abs(perSecond - 50) < 0.5, `ticks per second: ${perSecond}`);
    assert.equal(frames.length, 1, 'one frame request stays pending while stalled');
    // a frame comes back: the frame cadence takes over again, whatever the timer
    const n = ticks;
    frames[0]();
    assert.equal(ticks, n + 1);
    assert.equal(engine._auto.stalled, false);
    assert.equal(frames.length, 2, 'next frame requested');
    assert.equal(pendingDelay(), 100, 'backup timer re-armed');
    frames[1]();
    assert.equal(ticks, n + 2);
    engine.stopAutoTick();
    assert.equal(timers.size, 0, 'stopped');
  } finally {
    engine.stopAutoTick();
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    if (saved.doc === undefined) delete globalThis.document; else globalThis.document = saved.doc;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
    Date.now = saved.now;
    await engine.destroy();
  }
});

test('auto-tick: requestAnimationFrame when visible, a 20 ms timer when hidden, never dies', async () => {
  const frames = [];
  const saved = {
    raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, doc: globalThis.document
  };
  const listeners = {};
  const doc = {
    visibilityState: 'visible',
    addEventListener: (t, fn) => { listeners[t] = fn; },
    removeEventListener: (t) => { delete listeners[t]; }
  };
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = doc;
  const errors = [];
  try {
    const engine = await createEngine({ context: makeContext(), onError: (e) => errors.push(e) });
    assert.ok(engine._auto, 'auto-tick on for a realtime context with requestAnimationFrame');
    let ticks = 0;
    engine.on('tick', () => { ticks++; throw new Error('listener bug'); });
    frames.shift()();
    frames.shift()();
    assert.equal(ticks, 2);
    assert.equal(errors.length, 2, 'listener errors go to onError');
    assert.equal(frames.length, 1, 'still scheduled');
    // hidden tab: the timer takes over
    doc.visibilityState = 'hidden';
    listeners.visibilitychange();
    assert.ok(engine._auto.timer, 'timer scheduled');
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(ticks >= 3, 'ticks from the timer');
    engine.stopAutoTick();
    assert.equal(engine._auto, null);
    assert.equal(listeners.visibilitychange, undefined);
    const t = ticks;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ticks, t, 'stopped');
    // offline: off by default
    const offline = await createEngine({ context: makeOfflineContext() });
    assert.equal(offline._auto, null);
    await engine.destroy();
    await offline.destroy();
  } finally {
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    if (saved.doc === undefined) delete globalThis.document; else globalThis.document = saved.doc;
  }
});

test('auto-tick: a backup timer keeps ticking when a visible page gets no frames', async () => {
  // e.g. an Electron window that is not shown, minimized or occluded with
  // backgroundThrottling off: 'visible', but requestAnimationFrame never fires
  const frames = [];
  const saved = {
    raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, doc: globalThis.document
  };
  const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = doc;
  try {
    const engine = await createEngine({ context: makeContext() });
    let ticks = 0;
    engine.on('tick', () => { ticks++; });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(ticks, 0, 'frames are given 100 ms first');
    await new Promise((r) => setTimeout(r, 160));
    assert.ok(ticks >= 2, `the backup timer ticks (${ticks})`);
    assert.equal(engine._auto.stalled, true);
    // frames come back: the frame cadence takes over again
    const n = ticks;
    frames[frames.length - 1]();
    assert.equal(ticks, n + 1);
    assert.equal(engine._auto.stalled, false, 'back to the frame cadence');
    engine.stopAutoTick();
    await engine.destroy();
  } finally {
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    if (saved.doc === undefined) delete globalThis.document; else globalThis.document = saved.doc;
  }
});

test('types parity: every member declared for Engine, Deck and FxUnit exists at runtime', async () => {
  const { readFileSync } = await import('node:fs');
  const dts = readFileSync(new URL('../../types/index.d.ts', import.meta.url), 'utf8');
  const members = (name) => {
    const i = dts.indexOf(`export class ${name} {`);
    const body = dts.slice(i, dts.indexOf('\n}', i));
    return [...new Set([...body.matchAll(/^\s+(?:readonly\s+)?([a-zA-Z_]+)(?:<[^>]*>)?\s*[(:?]/gm)]
      .map((m) => m[1]).filter((n) => n !== 'constructor'))];
  };
  const engine = await createEngine({ context: makeContext() });
  const objects = { Engine: engine, Deck: engine.decks[0], FxUnit: engine.fx[0] };
  for (const [name, obj] of Object.entries(objects)) {
    const list = members(name);
    assert.ok(list.length >= 10, `${name} members parsed`);
    assert.deepEqual(list.filter((m) => !(m in obj)), [], `${name}: declared but missing at runtime`);
  }
  await engine.destroy();
});

test('events: on / once / off, unsubscribe function, unknown types', async () => {
  const engine = await createEngine({ context: makeContext() });
  const seen = [];
  const off = engine.on('tick', (e) => seen.push(['on', e.time]));
  engine.once('tick', (e) => seen.push(['once', e.time]));
  engine.tick();
  engine.tick();
  off();
  engine.tick();
  assert.deepEqual(seen.map((s) => s[0]), ['on', 'once', 'on']);
  const fn = () => seen.push('x');
  engine.on('master', fn);
  engine.off('master', fn);
  engine.setMaster(1);
  assert.equal(seen.includes('x'), false);
  assert.throws(() => engine.on('nope', () => {}), RangeError);
  assert.throws(() => engine.decks[0].on('load', 42), TypeError);
  await engine.destroy();
});
