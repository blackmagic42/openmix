// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #12: mixer curves, color FX, beat FX sends and dry
// compensation, pad FX, master FX, outputs (§6.6), listener isolation.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  installFakeAudioGlobals, makeContext, makeOfflineContext, FakeAudioContext,
  FakeDelayNode, FakeChannelMergerNode
} from '../helpers/fake-audio.js';
import { beatsFor, lazyBuffer } from '../helpers/fixtures.js';
import { createEngine, PAD_FX_DRY, fxDryCut, FX_DRY_CUT } from '../../src/index.js';
import { measureFeedbackLatency } from '../../src/fx.js';

let restore;
before(() => { restore = installFakeAudioGlobals(); });
after(() => restore());

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b}`);

async function rig(options = {}) {
  const ctx = options.context || makeContext();
  const engine = await createEngine({ ...options, context: ctx });
  const step = (seconds) => {
    const n = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < n; i++) {
      ctx.advance(1 / 60);
      engine.tick();
    }
  };
  return { ctx, engine, decks: engine.decks, step };
}

const gridded = (d, bpm, seconds = 120) => d.load(lazyBuffer({ seconds }), { bpm, beats: beatsFor({ bpm, seconds }) });

test('crossfader gains for A / B / thru at 0, 0.5 and 1 ("mix" curve)', async () => {
  const { engine, decks: [A, B, T] } = await rig({ decks: 3 });
  T.setCrossfaderSide('thru');
  const gains = () => [A, B, T].map((d) => d.xf.gain.value);
  engine.setCrossfader(0);
  assert.deepEqual(gains(), [1, 0, 1]);
  engine.setCrossfader(0.5);
  assert.deepEqual(gains(), [1, 1, 1]);
  engine.setCrossfader(1);
  assert.deepEqual(gains(), [0, 1, 1]);
  engine.setCrossfader(0.75);
  assert.deepEqual(gains(), [0.5, 1, 1]);
  engine.setCrossfader(-3);
  assert.equal(engine.crossfader, 0, 'clamped');
  B.setCrossfaderSide('A');
  assert.deepEqual(gains(), [1, 1, 1]);
  engine.setCrossfader(1);
  assert.deepEqual(gains(), [0, 0, 1]);
  await engine.destroy();
});

test('EQ dB, trim, fader curves; kill on any band', async () => {
  const { engine, decks: [d] } = await rig();
  d.setEq('low', -1);
  d.setEq('mid', 0.5);
  d.setEq('high', 1);
  assert.equal(d.eqLow.gain.value, -40);
  assert.equal(d.eqMid.gain.value, 3);
  assert.equal(d.eqHigh.gain.value, 6);
  d.setEq('low', -0.25);
  assert.equal(d.eqLow.gain.value, -10);
  d.setEq('mid', 7);
  assert.equal(d.eq.mid, 1, 'clamped');
  assert.equal(d.eqLow.type, 'lowshelf');
  assert.equal(d.eqLow.frequency.value, 200);
  assert.equal(d.eqMid.type, 'peaking');
  assert.equal(d.eqMid.frequency.value, 1000);
  assert.equal(d.eqMid.Q.value, 0.9);
  assert.equal(d.eqHigh.type, 'highshelf');
  assert.equal(d.eqHigh.frequency.value, 8000);
  d.setTrim(1);
  assert.equal(d.trim.gain.value, 4);
  d.setTrim(-1);
  assert.equal(d.trim.gain.value, 0.25);
  d.setTrim(0.5);
  assert.equal(d.trim.gain.value, 2);
  assert.equal(d.trimValue, 0.5);
  d.setVolume(0.5);
  assert.equal(d.fader.gain.value, 0.25);
  // kill: remembers the knob, −40 dB, restores on release
  d.setEq('high', 0.3);
  d.setKill('high', true);
  assert.equal(d.eqHigh.gain.value, -40);
  assert.equal(d.eq.high, -1);
  assert.equal(d.kills.high, true);
  d.setEq('high', 0.6); // moved while killed: remembered
  assert.equal(d.eqHigh.gain.value, -40);
  d.setKill('high', false);
  close(d.eqHigh.gain.value, 3.6);
  assert.equal(d.kills.high, false);
  assert.equal(d.eqHigh.gain.last('setTargetAtTime').timeConstant, 0.01, 'short setTargetAtTime ramps');
  await engine.destroy();
});

test("setFilter in 'filter' mode versus an echo mode (send gain); noise; color FX off", async () => {
  const { ctx, engine, decks: [d] } = await rig();
  d.setFilter(0.5);
  assert.equal(d.filter.type, 'highpass');
  close(d.filter.frequency.value, 400);
  assert.equal(d.filter.Q.value, 0.9);
  assert.equal(d.colorSend.gain.value, 0);
  d.setFilter(-0.5);
  assert.equal(d.filter.type, 'lowpass');
  close(d.filter.frequency.value, 20000 * Math.pow(80 / 20000, 0.5));
  d.setFilter(0.03);
  assert.equal(d.filter.type, 'peaking', 'dead zone |v| < 0.04');
  assert.equal(d.filter.gain.value, 0);
  d.setFilter(-0.6);
  engine.setColorFx('dubecho');
  assert.equal(engine.colorFx, 'dubecho');
  assert.equal(d.filterValue, -0.6);
  assert.equal(d.filter.type, 'peaking', 'the biquad is neutral in a send mode');
  close(d.colorSend.gain.value, 0.6, 1e-12, 'send gain = |v|');
  assert.equal(d.noiseGain.gain.value, 0);
  const chain = engine.colorChains.dubecho;
  assert.ok(ctx.isConnected(engine.colorBus, chain.in));
  assert.ok(ctx.isConnected(chain.out, engine.colorWet));
  assert.equal(engine.colorWet.gain.value, 0.85);
  engine.setColorFx('reverb');
  assert.ok(ctx.isConnected(engine.colorBus, engine.cReverb));
  assert.ok(!ctx.isConnected(engine.colorBus, chain.in));
  engine.setColorFx('noise');
  close(d.noiseGain.gain.value, 0.36 * 0.4, 1e-12, 'noise = v² × 0.4');
  assert.equal(d.colorSend.gain.value, 0);
  engine.setColorFxEnabled(false);
  assert.equal(engine.colorFxEnabled, false);
  assert.equal(d.noiseGain.gain.value, 0);
  assert.equal(d.colorSend.gain.value, 0);
  assert.equal(d.filter.type, 'peaking');
  d.setFilter(0.9);
  assert.equal(d.filter.type, 'peaking', 'off: the knobs do nothing');
  assert.equal(d.filterValue, 0.9, 'but the value is kept');
  engine.setColorFxEnabled(true);
  engine.setColorFx('filter');
  assert.equal(d.filter.type, 'highpass', 're-applied');
  await engine.destroy();
});

test('master volume (scales the FX returns), master filter, headphone cue and volume', async () => {
  const { ctx, engine, decks: [d] } = await rig();
  engine.setMasterVolume(0.5);
  assert.equal(engine.masterGain.gain.value, 0.5);
  assert.equal(engine.fxReturn.gain.value, 0.5);
  engine.setMasterFilter(-1);
  assert.equal(engine.mFilter.type, 'lowpass');
  close(engine.mFilter.frequency.value, 80);
  engine.setMasterFilter(1);
  assert.equal(engine.mFilter.type, 'highpass');
  close(engine.mFilter.frequency.value, 8000);
  engine.setMasterFilter(0.01);
  assert.equal(engine.mFilter.type, 'peaking');
  assert.equal(engine.masterFilter, 0.01);
  d.setHeadphoneCue(true);
  assert.equal(d.headphoneCue, true);
  assert.equal(d.cueSend.gain.value, 1);
  assert.ok(ctx.isConnected(d.post, d.cueSend), 'PFL taps post (pre-fader)');
  assert.ok(ctx.isConnected(d.cueSend, engine.cueOut));
  engine.setHeadphoneVolume(0.4);
  assert.equal(engine.cueOut.gain.value, 0.4);
  assert.equal(engine.headphoneVolume, 0.4);
  assert.equal(engine.masterPeak(), 0);
  assert.equal(d.meterPeak(), 0);
  await engine.destroy();
});

test('assignFx / setEnabled → send gains; level drives the effect; delay times', async () => {
  const { ctx, engine, decks } = await rig();
  const u = engine.fx[0];
  const sends = (unit) => decks.map((d) => d.fxSends[unit].gain.value);
  assert.deepEqual(sends(0), [0, 0, 0, 0], 'disabled: no send');
  u.setEnabled(true);
  assert.deepEqual(sends(0), [1, 0, 0, 0]);
  engine.assignFx(0, 2);
  assert.deepEqual(sends(0), [1, 0, 1, 0]);
  engine.assignFx(0, 0, false);
  assert.deepEqual(sends(0), [0, 0, 1, 0]);
  assert.equal(engine.isFxAssigned(0, 2), true);
  u.setEnabled(false);
  assert.deepEqual(sends(0), [0, 0, 0, 0]);
  assert.ok(ctx.isConnected(decks[2].xf, decks[2].fxSends[0]), 'sends tap the post-crossfader signal');
  // level: wet gain and feedback inside the effect
  u.setLevel(1);
  assert.equal(u.wet.gain.value, 1);
  close(u.echoFb.gain.value, 0.45);
  u.setLevel(0);
  close(u.echoFb.gain.value, 0.45 * 0.55);
  close(u.fxbpLfoGain.gain.value, 650 * 0.35);
  close(u.flFb.gain.value, 0.15);
  u.setLevel(2);
  assert.equal(u.level, 1, 'clamped');
  // delay times = beatDuration × beats, clamped to 0.02–3.9 s
  u.setBeatDuration(0.5);
  u.setBeats(0.5);
  close(u.echoDelay.delayTime.value, 0.25);
  u.setBeats(16);
  close(u.echoDelay.delayTime.value, 3.9);
  u.setBeats(0.01);
  close(u.echoDelay.delayTime.value, 0.02);
  u.setBeats(1);
  const n = u.echoDelay.delayTime.events.length;
  u.setBeatDuration(0.50001); // below the 0.05 % threshold: ignored
  assert.equal(u.echoDelay.delayTime.events.length, n);
  u.setBeats(0);
  assert.equal(u.beats, 1, 'beats must be > 0');
  // lazy chains are born in time
  u.setBeatDuration(0.4);
  u.setBeats(0.5);
  u.setType('pingpong');
  u.setEnabled(true);
  const first = ctx.targetsOf(u.input)[0];
  assert.ok(first instanceof FakeDelayNode);
  close(first.delayTime.value, 0.2);
  await engine.destroy();
});

test('feedback-loop latency compensation: loop delays shortened, post-delay outside the cycle', async () => {
  // In Node there is no OfflineAudioContext: nothing is measured, nothing changes
  assert.deepEqual({ ...(await measureFeedbackLatency(48000)) }, { loop: 0, loopPost: 0 });
  const { ctx, engine } = await rig();
  const u = engine.fx[0];
  u.setBeatDuration(0.5);
  u.setBeats(0.5);
  u.setEnabled(true);
  close(u.echoDelay.delayTime.value, 0.25);
  assert.ok(ctx.targetsOf(u.echoDelay).includes(u.wet), 'no latency: the loop taps straight into wet');
  // The Chromium case, as measured in the browser: +128 frames per trip
  // around a loop, the first pass exact
  const q = 128 / 48000;
  const fb = Object.freeze({ loop: q, loopPost: q });
  u._setFeedbackLatency(fb);
  close(u.echoDelay.delayTime.value, 0.25 - q, 1e-12, 'loop delay = D − q');
  const post = ctx.targetsOf(u.echoDelay).find((n) => n instanceof FakeDelayNode && n !== u.echoDelay);
  assert.ok(post, 'the loop output goes through a post-delay');
  close(post.delayTime.value, q, 1e-12, 'post-delay = q');
  assert.ok(ctx.targetsOf(post).includes(u.wet));
  assert.ok(!ctx.targetsOf(u.echoDelay).includes(u.wet), 'not straight into wet any more');
  // chains born later are compensated too; mtdelay (no cycle) is not.
  // The ping-pong cycle holds ONE delay (2 × D − q); L and R are exact taps
  u.setType('pingpong');
  const L = ctx.targetsOf(u.input)[0];
  close(L.delayTime.value, 0.25, 1e-12, 'ping-pong L tap');
  const X = ctx.targetsOf(L)[0];
  const delaysOfX = ctx.targetsOf(X).filter((n) => n instanceof FakeDelayNode);
  assert.equal(delaysOfX.length, 2, 'X feeds the R tap and the loop');
  const [R, loop] = delaysOfX.sort((a, b) => a.delayTime.value - b.delayTime.value);
  close(R.delayTime.value, 0.25, 1e-12, 'ping-pong R tap');
  close(loop.delayTime.value, 0.5 - q, 1e-12, 'ping-pong loop = 2D − q');
  assert.ok(ctx.isConnected(ctx.targetsOf(loop)[0], X), 'the feedback returns to X');
  u.setType('mtdelay');
  const d1 = ctx.targetsOf(u.input)[0];
  close(d1.delayTime.value, 0.25, 1e-12, 'mtdelay taps are exact already');
  // non-echo effects keep their plain routing
  u.setType('reverb');
  assert.ok(ctx.targetsOf(u.convolver).includes(u.wet));
  // the delay times follow the beat with the compensation applied
  u.setType('helix');
  u.setBeats(1);
  const helix = ctx.targetsOf(u.input)[0];
  close(helix.delayTime.value, 0.5 - q, 1e-12, 'helix loop');
  // units created later (pad FX, master FX) get the measured latency
  engine._fbLatency = fb;
  const m = engine.ensureMasterFx();
  close(m.echoDelay.delayTime.value, 0.25 - q, 1e-12, 'master FX');
  await engine.destroy();
});

test('dry compensation per deck: fxDryCut × level; master FX doses the whole mix', async () => {
  const { engine, decks: [d0, d1], step } = await rig();
  assert.equal(fxDryCut('filter'), 1);
  assert.equal(fxDryCut('echo'), 0.45);
  assert.equal(FX_DRY_CUT.reverb, 0.3);
  const u = engine.fx[0];
  u.setType('filter');
  u.setLevel(0.5);
  u.setEnabled(true);
  step(0.05);
  close(d0.dryOut.gain.value, 0.5, 1e-12, 'insert-like effect: replaces the sound');
  assert.equal(d1.dryOut.gain.value, 1, 'an FX on deck 1 never touches deck 2');
  u.setType('echo');
  step(0.05);
  close(d0.dryOut.gain.value, 1 - 0.45 * 0.5);
  u.setEnabled(false);
  step(0.05);
  assert.equal(d0.dryOut.gain.value, 1);
  const m = engine.ensureMasterFx();
  assert.equal(engine.ensureMasterFx(), m, 'idempotent');
  assert.equal(engine.masterFx, m);
  m.setType('reverb');
  m.setLevel(1);
  m.setEnabled(true);
  step(0.05);
  close(engine.dryComp.gain.value, 0.7);
  m.setEnabled(false);
  step(0.05);
  assert.equal(engine.dryComp.gain.value, 1);
  await engine.destroy();
});

test('pad FX: own unit, dry hold, roll; it never touches the panel units', async () => {
  const { engine, decks: [d], step } = await rig();
  gridded(d, 120);
  d.play();
  step(0.5);
  const panel = engine.fx.map((u) => [u.type, u.enabled, u.level, u.beats]);
  d.setPadFx({ type: 'echo', beats: 0.25, level: 0.7, label: 'ECHO ¼' });
  assert.deepEqual(d.padFx, { type: 'echo', beats: 0.25, level: 0.7, label: 'ECHO ¼' });
  const pu = engine._padFx[0];
  assert.ok(pu && pu.enabled);
  assert.equal(pu.beats, 0.25);
  assert.equal(d.padFxSend.gain.value, 1);
  step(0.05);
  assert.equal(d.dryOut.gain.value, PAD_FX_DRY.echo, 'dry hold');
  close(pu.beatDuration, 0.5, 1e-9, 'follows its deck');
  assert.deepEqual(engine.fx.map((u) => [u.type, u.enabled, u.level, u.beats]), panel);
  d.setPadFx({ type: 'reverb', beats: 1, dry: 0.6 });
  step(0.05);
  close(d.dryOut.gain.value, 0.6);
  d.setPadFx(null);
  assert.equal(d.padFx, null);
  assert.equal(pu.enabled, false);
  assert.equal(d.padFxSend.gain.value, 0);
  step(0.05);
  assert.equal(d.dryOut.gain.value, 1);
  // pad roll: slip roll held by the tick, released on null
  d.setPadFx({ type: 'roll', beats: 0.5 });
  assert.deepEqual(d.roll, { beats: 0.5, mix: 1 });
  step(0.3);
  assert.deepEqual(d.roll, { beats: 0.5, mix: 1 });
  assert.equal(d.srcGain.gain.value, 0);
  assert.equal(d.rollGain.gain.value, 1);
  d.setPadFx(null);
  assert.equal(d.roll, null);
  assert.equal(d.srcGain.gain.value, 1);
  step(0.1);
  assert.equal(d.roll, null);
  await engine.destroy();
});

test('roll: FX-unit roll driven by tick(), startRoll / stopRoll, aligned slices', async () => {
  const { ctx, engine, decks: [d], step } = await rig();
  assert.equal(d.startRoll(1), false, 'no track');
  gridded(d, 120);
  assert.equal(d.startRoll(1), false, 'not playing');
  d.play();
  ctx.advance(1.33); // heard at 1.3 s
  assert.equal(d.startRoll(1), true);
  assert.deepEqual([d._roll.start, d._roll.end], [1, 1.5], 'the grid slice we are in');
  step(0.5);
  assert.deepEqual(d.roll, { beats: 1, mix: 1 }, 'kept by the tick');
  d.setRollMix(0.4);
  step(0.1);
  close(d.roll.mix, 0.4);
  d.stopRoll();
  assert.equal(d.roll, null);
  step(0.1);
  assert.equal(d.roll, null);
  // an FX unit in ROLL plays it through the deck (mix = unit level)
  const u = engine.fx[0];
  u.setType('roll');
  u.setBeats(0.25);
  u.setLevel(0.7);
  u.setEnabled(true);
  step(0.05);
  assert.deepEqual(d.roll, { beats: 0.25, mix: 0.7 });
  close(d.srcGain.gain.value, 0.3);
  u.setEnabled(false);
  step(0.05);
  assert.equal(d.roll, null);
  // pause stops any roll
  d.startRoll(2);
  d.pause();
  assert.equal(d.roll, null);
  step(0.1);
  assert.equal(d.roll, null);
  await engine.destroy();
});

test('FX units follow their reference deck in tick(); a manual beat duration holds without one', async () => {
  const { engine, decks: [d0, d1], step } = await rig();
  const [u0, u1] = engine.fx;
  u0.setEnabled(true);
  u0.setBeatDuration(0.3);
  step(0.1);
  close(u0.beatDuration, 0.3, 1e-12, 'no reference deck: the manual value holds');
  gridded(d0, 120);
  gridded(d1, 100);
  d0.setTempo(1.1);
  d0.play();
  step(0.1);
  close(u0.beatDuration, 0.5 / 1.1, 1e-9, 'its assigned playing deck');
  u1.setEnabled(true);
  step(0.05);
  close(u1.beatDuration, 0.5 / 1.1, 1e-9, 'deck 2 stopped: the master');
  d1.play();
  step(0.05);
  close(u1.beatDuration, 0.6, 1e-9, 'its own deck once it plays');
  const m = engine.ensureMasterFx();
  m.setEnabled(true);
  step(0.05);
  close(m.beatDuration, 0.5 / 1.1, 1e-9, 'the master FX follows the master');
  // a disabled unit follows too: switched on, its chain is born in time
  const u2 = engine.fx[2];
  assert.equal(u2.enabled, false);
  close(u2.beatDuration, 0.5 / 1.1, 1e-9);
  u2.setType('delay');
  u2.setBeats(1);
  u2.setEnabled(true);
  const delay = engine.context.targetsOf(u2.input)[0];
  close(delay.delayTime.value, 0.5 / 1.1, 1e-9);
  await engine.destroy();
});

test('modulations restart exactly on a beat boundary (alignTo)', async () => {
  const { ctx, engine, decks: [d] } = await rig();
  gridded(d, 120);
  d.play();
  ctx.advance(1.13); // heard 1.1 s
  const u = engine.fx[0];
  u.setType('trans');
  u.setBeats(0.5);
  u.setEnabled(true);
  engine.tick();
  // next ½-beat boundary after 1.1 s heard = 1.25 s → audio time + 0.15 s
  const osc = u.trOsc;
  close(osc.startArgs[0], ctx.currentTime + 0.15, 1e-9);
  close(osc.frequency.value, 1 / 0.25, 1e-9, 'one gate per ½ beat');
  engine.tick();
  assert.equal(u.trOsc, osc, 'aligned once, not on every tick');
  u.setBeats(1);
  engine.tick();
  assert.notEqual(u.trOsc, osc, 're-aligned after a beats change');
  await engine.destroy();
});

test('a throwing listener breaks neither tick() nor the lock', async () => {
  const errors = [];
  const { engine, decks: [A, B], step } = await rig({ onError: (e) => errors.push(e.message) });
  gridded(A, 120);
  gridded(B, 125);
  engine.on('tick', () => { throw new Error('tick listener'); });
  engine.on('master', () => { throw new Error('master listener'); });
  const after = [];
  engine.on('tick', () => after.push(1));
  B.on('play', () => { throw new Error('deck listener'); });
  A.play();
  step(0.2);
  assert.equal(engine.masterIndex, 0, 'the election ran');
  B.sync();
  B.play();
  step(1);
  assert.ok(Math.abs(B.tempo - 0.96) < 1e-9, 'the lock ran');
  assert.ok(after.length >= 60, 'later listeners still called');
  assert.ok(errors.includes('tick listener') && errors.includes('master listener') && errors.includes('deck listener'));
  await engine.destroy();
});

// ------------------------------------------------------------- outputs ---

const has = (ctx, from, to, o, i) => ctx.isConnected(from, to, o, i);

test('outputs §6.6 rule 5 (stereo) and rule 4 (4 channels: cue on 3/4)', async () => {
  const { ctx, engine } = await rig();
  assert.ok(has(ctx, engine.masterOut, ctx.destination));
  assert.equal(engine.headphonesAvailable, false);
  await engine.destroy();
  const ctx4 = makeContext({ maxChannelCount: 4 });
  const logs = [];
  const e4 = await createEngine({ context: ctx4, log: (m) => logs.push(m) });
  assert.equal(e4.headphonesAvailable, true);
  assert.equal(ctx4.destination.channelCount, 4);
  assert.equal(ctx4.destination.channelInterpretation, 'discrete');
  const merger = ctx4.targetsOf(e4.masterOut)[0] && ctx4.edges.find((e) => e.from instanceof FakeChannelMergerNode).from;
  assert.ok(merger, 'a 4-input merger');
  assert.ok(has(ctx4, merger, ctx4.destination));
  const [ms] = ctx4.targetsOf(e4.masterOut);
  assert.ok(has(ctx4, ms, merger, 0, 0) && has(ctx4, ms, merger, 1, 1), 'master on 1/2');
  const [cs] = ctx4.targetsOf(e4.cueOut);
  assert.ok(has(ctx4, cs, merger, 0, 2) && has(ctx4, cs, merger, 1, 3), 'cue on 3/4');
  assert.ok(logs.some((m) => /4-channel output/.test(m)));
  await e4.destroy();
});

test('a 4-channel OfflineAudioContext still produces rule 4 (channel settings in try/catch)', async () => {
  const ctx = makeOfflineContext({ channels: 4, seconds: 1 });
  const engine = await createEngine({ context: ctx });
  assert.equal(engine.headphonesAvailable, true);
  assert.ok(ctx.destination.settingsLog.some(([k]) => k === 'channelCount'), 'tried, and survived the rejection');
  const merger = ctx.edges.find((e) => e.from instanceof FakeChannelMergerNode).from;
  assert.ok(has(ctx, merger, ctx.destination));
  await engine.destroy();
});

test('outputs rule 3 (output node) and rule 2 (cueOutput)', async () => {
  const ctx = makeContext({ maxChannelCount: 4 });
  const out = ctx.createGain();
  const e3 = await createEngine({ context: ctx, output: out });
  assert.deepEqual(ctx.targetsOf(e3.masterOut), [out]);
  assert.deepEqual(ctx.targetsOf(e3.cueOut), []);
  assert.equal(e3.headphonesAvailable, false);
  await e3.destroy();
  const ctx2 = makeContext();
  const cue = ctx2.createGain();
  const e2 = await createEngine({ context: ctx2, cueOutput: cue });
  assert.deepEqual(ctx2.targetsOf(e2.cueOut), [cue]);
  assert.ok(has(ctx2, e2.masterOut, ctx2.destination));
  assert.equal(e2.headphonesAvailable, true);
  await e2.destroy();
});

test('setOutputDevice / setHeadphoneDevice (rule 1) / getRecordingStream; taps survive re-wiring', async () => {
  const restoreAC = installFakeAudioGlobals({ audioContext: true });
  try {
    const ctx = makeContext();
    const engine = await createEngine({ context: ctx });
    const tap = ctx.createGain();
    engine.masterOut.connect(tap);
    const stream = engine.getRecordingStream();
    assert.equal(engine.getRecordingStream(), stream, 'lazy, then kept');
    const rec = ctx.targetsOf(engine.masterOut).find((n) => n.stream === stream);
    assert.ok(rec);
    // the master moves to a 4-channel device: re-wired, cue on 3/4
    assert.equal(await engine.setOutputDevice('controller'), true);
    assert.equal(ctx.sinkId, 'controller');
    assert.equal(engine.headphonesAvailable, true);
    assert.ok(has(ctx, engine.masterOut, tap), 'app taps stay connected');
    assert.ok(has(ctx, engine.masterOut, rec), 'the recorder stays connected');
    assert.equal(await engine.setOutputDevice('nope'), false);
    // headphones on another device: a second context through a MediaStream bridge
    assert.equal(await engine.setOutputDevice('speakers'), true);
    assert.equal(engine.headphonesAvailable, false);
    assert.equal(await engine.setHeadphoneDevice('controller'), true);
    const pc = engine._phonesCtx;
    assert.ok(pc instanceof FakeAudioContext && pc !== ctx);
    assert.equal(pc.sinkId, 'controller');
    assert.equal(engine.headphonesAvailable, true);
    assert.ok(has(ctx, engine.cueOut, engine._phonesStream));
    const phonesMerger = pc.edges.find((e) => e.from instanceof FakeChannelMergerNode).from;
    assert.ok(pc.edges.some((e) => e.to === phonesMerger && e.input === 2));
    assert.ok(pc.edges.some((e) => e.to === phonesMerger && e.input === 3));
    assert.ok(has(ctx, engine.masterOut, ctx.destination), 'the master stays on the main device');
    assert.equal(await engine.setHeadphoneDevice('controller'), true, 'same device: nothing to do');
    assert.equal(await engine.setHeadphoneDevice(null), true);
    assert.equal(engine._phonesCtx, null);
    assert.equal(engine.headphonesAvailable, false);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(pc.state, 'closed');
    assert.equal(await engine.setHeadphoneDevice('missing'), false);
    assert.equal(engine.headphonesAvailable, false);
    await engine.destroy();
  } finally {
    restoreAC();
  }
  // offline: no devices, no recording stream
  const off = await createEngine({ context: makeOfflineContext() });
  assert.equal(await off.setOutputDevice('controller'), false);
  assert.equal(await off.setHeadphoneDevice('controller'), false);
  assert.throws(() => off.getRecordingStream(), TypeError);
  await off.destroy();
  // a realtime context without setSinkId
  const ctx = makeContext();
  ctx.setSinkId = undefined;
  const e = await createEngine({ context: ctx });
  assert.equal(await e.setOutputDevice('controller'), false);
  await e.destroy();
});

test('setInsert: between FILTER and post, latency compensated, failure leaves the channel intact', async () => {
  const { ctx, engine, decks: [d] } = await rig();
  const ins = ctx.createGain();
  d.setInsert(ins, 0.01);
  assert.equal(d.insert, ins);
  assert.ok(has(ctx, d.filter, ins) && has(ctx, ins, d.post));
  assert.ok(!has(ctx, d.filter, d.post));
  assert.equal(d.latency, 0.01);
  d.load(lazyBuffer({ seconds: 30 }));
  d.play();
  ctx.advance(1.03);
  d.setInsert(null);
  assert.ok(has(ctx, d.filter, d.post));
  assert.equal(d.latency, 0);
  close(d.position, 0.99, 1e-9, 'one brief restart at the heard position (it was heard 10 ms late)');
  const other = makeContext().createGain();
  assert.throws(() => d.setInsert(other));
  assert.ok(has(ctx, d.filter, d.post), 'still wired');
  assert.equal(d.insert, null);
  await engine.destroy();
});

test('stems play instead of the mix; toggles; clearStems', async () => {
  const { ctx, engine, decks: [d] } = await rig();
  d.load(lazyBuffer({ seconds: 30 }));
  d.play();
  ctx.advance(1);
  const stems = { vocals: lazyBuffer({ seconds: 30 }), drums: lazyBuffer({ seconds: 30 }), bass: lazyBuffer({ seconds: 30 }) };
  d.loadStems(stems);
  assert.equal(d.stemsActive, true);
  assert.equal(d.source.buffer, stems.drums);
  assert.equal(d._extraSources.length, 2);
  assert.equal(d.toggleStem('vocals'), false);
  assert.equal(d.stemGains.vocals.gain.value, 0);
  assert.deepEqual({ ...d.stemStates }, { vocals: false, drums: true, bass: true, other: true });
  d.setStem('vocals', true);
  assert.equal(d.toggleStem('vocals'), false);
  d.setTempo(1.1);
  assert.ok(d._extraSources.every((s) => s.playbackRate.value === 1.1));
  d.clearStems();
  assert.equal(d.stemsActive, false);
  assert.equal(d.source.buffer, d.buffer);
  assert.equal(d._extraSources.length, 0);
  assert.equal(d.stemStates.vocals, true);
  await engine.destroy();
});
