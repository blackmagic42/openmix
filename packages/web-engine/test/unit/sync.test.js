// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #11: SYNC, master election and the phase lock, on the fake
// AUDIO clock (deterministic).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAudioGlobals, makeContext } from '../helpers/fake-audio.js';
import { beatsFor, lazyBuffer } from '../helpers/fixtures.js';
import { createEngine } from '../../src/index.js';

let restore;
before(() => { restore = installFakeAudioGlobals(); });
after(() => restore());

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≠ ${b}`);

async function rig(n = 2) {
  const ctx = makeContext();
  const engine = await createEngine({ context: ctx, decks: n });
  const masters = [];
  engine.on('master', (e) => masters.push({ index: e.index, manual: e.manual, deck: e.deck }));
  // ticks at 60 Hz on the audio clock
  const step = (seconds) => {
    const n2 = Math.round(seconds * 60);
    for (let i = 0; i < n2; i++) {
      ctx.advance(1 / 60);
      engine.tick();
    }
  };
  return { ctx, engine, decks: engine.decks, masters, step };
}

const gridded = (d, bpm, { seconds = 200, first = 0, barAnchor = 0, meta = {} } = {}) => d.load(
  lazyBuffer({ seconds }),
  { bpm, beats: beatsFor({ bpm, first, seconds }), barAnchor, ...meta }
);

// beat-phase difference master − deck, in (−0.5, 0.5]
function phaseErr(engine, m, d) {
  let e = engine._beatPhase(m) - engine._beatPhase(d);
  e -= Math.round(e);
  return e;
}

test("sync(): 'master', 'synced', 'armed' and null; 'sync' events on flips only", async () => {
  const { engine, decks: [A, B, C], step } = await rig(3);
  const flips = [];
  for (const d of [A, B, C]) d.on('sync', (e) => flips.push([e.index, e.synced]));
  C.load(lazyBuffer({ seconds: 30 }));
  assert.equal(C.sync(), null, 'no BPM');
  gridded(A, 120);
  gridded(B, 125);
  assert.equal(B.sync(), 'armed', 'no reference plays yet');
  assert.equal(B.synced, true);
  assert.equal(B.tempo, 1, 'armed: tempo untouched');
  A.play();
  step(0.5);
  assert.equal(engine.masterIndex, 0);
  // the armed, stopped follower already takes the master's BPM
  close(B.tempo, 0.96);
  close(B.effectiveBpm, 120);
  assert.equal(A.sync(), 'master');
  assert.equal(A.synced, true);
  assert.equal(A.tempo, 1, 'the master keeps its tempo');
  B.unsync();
  assert.equal(B.sync(), 'synced');
  B.sync();
  assert.deepEqual(flips, [[1, true], [0, true], [1, false], [1, true]]);
  await engine.destroy();
});

test('the ratio comes from LOCAL beat periods, octave-folded into [0.5, 1.6]', async () => {
  const { engine, decks: [A, B], step } = await rig();
  gridded(A, 120);
  A.play();
  step(0.2);
  // B's global BPM says 124 but its beats are at 125 BPM: the local periods win
  gridded(B, 125, { meta: { bpm: 124 } });
  B.sync();
  close(B.tempo, 0.96, 1e-12);
  for (const [bpm, want] of [[70, 120 / 140], [250, 0.96], [60, 1], [190, 120 / 190], [75, 1.6]]) {
    B.unsync();
    gridded(B, bpm);
    assert.equal(B.sync(), 'synced');
    close(B.tempo, want, 1e-9, `${bpm} BPM`);
    assert.ok(B.tempo >= 0.5 && B.tempo <= 1.6);
  }
  // fixed grids: the global BPMs
  B.unsync();
  B.load(lazyBuffer({ seconds: 60 }), { bpm: 100, beatOffset: 0 });
  B.sync();
  close(B.tempo, 1.2);
  await engine.destroy();
});

test('bar alignment: the deck seeks so that its bar phase equals the master’s', async () => {
  const { ctx, engine, decks: [A, B], step } = await rig();
  gridded(A, 120);
  A.play();
  ctx.advance(1.28); // A heard at 1.25 s = beat 2.5 → bar phase 0.625
  engine.tick();
  gridded(B, 125);
  assert.equal(B.sync(), 'synced');
  // err = 0.625 − 0 → −0.375 bar → beat index −1.5 → −0.72 s (pre-roll)
  close(B.position, -0.72, 1e-9);
  const barPhase = (d) => { const f = engine._barPhase(d); return f - Math.floor(f); };
  close(barPhase(B), barPhase(A), 1e-9);
  // with a bar anchor on beat 1
  B.unsync();
  gridded(B, 125, { barAnchor: 1 });
  B.sync();
  close(barPhase(B), barPhase(A), 1e-9);
  // play(): a synced deck that starts is aligned again, then held
  B.play();
  step(2);
  assert.ok(Math.abs(phaseErr(engine, A, B)) < 1e-6);
  close(barPhase(B), barPhase(A), 1e-6);
  await engine.destroy();
});

test("auto master = first started; manual master set and clear ('master' events)", async () => {
  const { engine, decks: [A, B], masters, step } = await rig();
  gridded(A, 120);
  gridded(B, 125);
  assert.equal(masters.length, 0, 'nothing at creation');
  B.play();
  step(0.1);
  A.play();
  step(0.5);
  assert.equal(engine.masterIndex, 1, 'the first deck started');
  assert.equal(engine.masterDeck, B);
  assert.equal(B.isMaster, true);
  close(engine.masterBpm, 125);
  assert.deepEqual(masters.map((m) => [m.index, m.manual]), [[1, false]]);
  engine.setMaster(0);
  assert.deepEqual(masters.at(-1), { index: 0, manual: true, deck: A }, 'synchronous event');
  assert.equal(engine.manualMasterIndex, 0);
  assert.equal(engine.masterIndex, 0);
  engine.setMaster(0); // sets (not a toggle): no change, no event
  assert.equal(engine.manualMasterIndex, 0);
  assert.equal(masters.length, 2);
  engine.setMaster(null);
  assert.deepEqual(masters.at(-1), { index: 1, manual: false, deck: B });
  step(0.2);
  assert.equal(masters.length, 3);
  await engine.destroy();
});

test('handover after 1.2 s of AUDIO time, and immediately at a natural end', async () => {
  const { ctx, engine, decks: [A, B], masters, step } = await rig();
  gridded(A, 120);
  gridded(B, 125);
  A.play();
  step(0.2);
  B.play();
  step(0.2);
  assert.equal(engine.masterIndex, 0);
  A.pause();
  step(1.0);
  assert.equal(engine.masterIndex, 0, 'a cut shorter than 1.2 s keeps the crown');
  // the audio clock decides: no tick, no handover
  ctx.advance(10);
  assert.equal(engine.masterIndex, 0);
  step(1 / 60);
  assert.equal(engine.masterIndex, 1, 'handed over once 1.2 s of audio time passed');
  A.play();
  step(2);
  assert.equal(engine.masterIndex, 1, 'the new master stays master while it plays');
  // natural end: immediate handover
  const { ctx: c2, engine: e2, decks: [C, D], step: step2 } = await rig();
  C.load(lazyBuffer({ seconds: 3 }), { bpm: 120, beats: beatsFor({ bpm: 120, seconds: 3 }) });
  gridded(D, 125);
  C.play();
  step2(0.5);
  D.play();
  step2(2.4);
  assert.equal(e2.masterIndex, 0);
  step2(0.2); // C ends at 3.03 s
  assert.equal(C.playing, false);
  assert.equal(e2.masterIndex, 1, 'no grace period after a natural end');
  assert.ok(c2.currentTime < 3.3);
  // a manual master that stops hands over too
  const { engine: e3, decks: [E, F], step: step3 } = await rig();
  gridded(E, 120);
  gridded(F, 125);
  e3.setMaster(0);
  E.play();
  F.play();
  step3(0.5);
  E.pause();
  step3(1.0);
  assert.equal(e3.manualMasterIndex, 0);
  step3(0.3);
  assert.equal(e3.manualMasterIndex, 1, 'the MASTER button moves to the deck with the bass');
  assert.ok(masters.length >= 2);
  for (const e of [engine, e2, e3]) await e.destroy();
});

test('master election: open bass and audibility; a thru deck ignores the crossfader', async () => {
  const { engine, decks: [A, B, C], step } = await rig(3);
  for (const [d, bpm] of [[A, 120], [B, 122], [C, 124]]) gridded(d, bpm);
  A.play();
  B.play();
  C.play();
  A.setEq('low', -1); // bass cut
  B.setVolume(0.3);
  engine.setCrossfader(1); // side A (decks 0 and 2) silent
  assert.equal(engine._pickBassDeck(-1), 1, 'B: open bass and heard');
  C.setCrossfaderSide('thru');
  C.setVolume(1);
  assert.equal(engine._pickBassDeck(-1), 2, 'C thru: heard at full volume');
  A.setKill('low', false);
  step(0.1);
  await engine.destroy();
});

test('setTempo on a follower unsyncs; on the master, the followers follow in the same call', async () => {
  const { engine, decks: [A, B], step } = await rig();
  gridded(A, 120);
  gridded(B, 125);
  A.play();
  step(0.2);
  B.sync();
  B.play();
  step(0.5);
  const flips = [];
  B.on('sync', (e) => flips.push(e.synced));
  A.setTempo(1.05);
  close(B.tempo, 0.96 * 1.05, 1e-9, 'scaled in the same call');
  assert.equal(B.synced, true);
  B.setTempo(1.02);
  assert.equal(B.synced, false);
  assert.deepEqual(flips, [false]);
  close(B.tempo, 1.02);
  A.setTempo(1);
  close(B.tempo, 1.02, 1e-12, 'no longer follows');
  await engine.destroy();
});

test('setMasterBpm / setMasterTempo scale the followers in the same call', async () => {
  const { engine, decks: [A, B, C], step } = await rig(3);
  assert.equal(engine.setMasterBpm(126), false, 'no master');
  assert.equal(engine.setMasterTempo(1.1), false);
  gridded(A, 120);
  gridded(B, 125);
  gridded(C, 100);
  A.play();
  step(0.2);
  B.sync();
  B.play();
  C.sync();
  C.play();
  step(0.5);
  assert.equal(engine.setMasterBpm(126), true);
  close(A.tempo, 1.05);
  close(B.tempo, 0.96 * 1.05, 1e-9);
  close(C.tempo, 1.2 * 1.05, 1e-9);
  close(engine.masterBpm, 126);
  close(B.effectiveBpm, 126, 1e-6);
  close(C.effectiveBpm, 126, 1e-6);
  assert.equal(engine.setMasterTempo(1), true);
  close(B.effectiveBpm, 120, 1e-6);
  assert.equal(engine.setMasterBpm(NaN), false);
  step(3);
  assert.ok(Math.abs(phaseErr(engine, A, B)) < 0.002, 'the phase is held through the changes');
  await engine.destroy();
});

test('setBpm: setTempo(bpm / deck.bpm)', async () => {
  const { engine, decks: [A] } = await rig();
  assert.equal(A.setBpm(130), false, 'no BPM');
  gridded(A, 120);
  assert.equal(A.setBpm(126), true);
  close(A.tempo, 1.05);
  A.setBpm(1000);
  assert.equal(A.tempo, 1.6, 'clamped');
  await engine.destroy();
});

test('nudge / endNudge: hold, relative shift, then the new alignment is adopted', async () => {
  const { engine, decks: [A, B], step } = await rig();
  gridded(A, 120);
  gridded(B, 125);
  A.play();
  step(0.2);
  B.sync();
  B.play();
  step(1);
  assert.ok(Math.abs(phaseErr(engine, A, B)) < 1e-6);
  const base = B._syncBase;
  assert.equal(B.nudge(0.06), true);
  assert.equal(B.nudging, true);
  assert.equal(engine.syncHold, true);
  close(B.tempo, base * 1.06);
  assert.equal(B.synced, true, 'the synced flag is not touched');
  close(A.tempo, 1, 1e-12);
  step(0.5);
  close(B.tempo, base * 1.06, 1e-12, 'no correction while held');
  const shifted = phaseErr(engine, A, B);
  assert.ok(Math.abs(shifted) > 0.05, `the deck moved relative to the master (${shifted})`);
  B.endNudge();
  assert.equal(B.nudging, false);
  assert.equal(engine.syncHold, false);
  close(B.tempo, base);
  close(B._syncPhaseOff, shifted, 1e-9, 'reanchored on the present alignment');
  step(3);
  close(phaseErr(engine, A, B), shifted, 0.002, 'the lock holds the new offset (no pull back)');
  // nudging the master: the followers do NOT follow (relative shift)
  const before = B.tempo;
  A.nudge(-0.05);
  close(B.tempo, before, 1e-12);
  A.endNudge();
  // clamps, and not while paused
  B.nudge(9);
  close(B.tempo, Math.min(1.6, base * 1.5));
  B.endNudge();
  B.pause();
  assert.equal(B.nudge(0.05), false);
  await engine.destroy();
});

test('setSyncHold and reanchorSync; deliberate offsets are adopted, not chased', async () => {
  const { engine, decks: [A, B], step } = await rig();
  gridded(A, 120);
  gridded(B, 125);
  A.play();
  step(0.2);
  B.sync();
  B.play();
  step(1);
  // a deliberate offset (> 0.08 beat) is ADOPTED by the lock
  B.seek(B.position + 0.2 * 0.48);
  step(2);
  close(phaseErr(engine, A, B), -0.2, 0.003, 'kept where the DJ put it');
  // the visual magnet: a residue < 0.03 beat counts as aligned on reanchor
  engine.setSyncHold(true);
  assert.equal(engine.syncHold, true);
  B.seek(B.position - 0.18 * 0.48); // now 0.02 beat off
  engine.setSyncHold(false); // release = reanchorSync()
  assert.equal(B._syncPhaseOff, 0);
  // the servo pulls it back gently (gain 0.08, capped at ±0.2 %: inaudible)
  step(20);
  assert.ok(Math.abs(phaseErr(engine, A, B)) < 0.003, 'pulled to the exact alignment');
  // the master is never re-aligned
  const posA = A.position;
  engine.reanchorSync(0);
  step(1);
  close(A.position, posA + 1, 1e-6);
  assert.throws(() => engine.reanchorSync(5), RangeError);
  await engine.destroy();
});

test('the continuous lock: calibration fixes a ratio error, corrections stay within ±0.2 %', async () => {
  const { engine, decks: [A, B], step } = await rig();
  gridded(A, 120);
  gridded(B, 125, { first: 0.1 });
  A.play();
  step(0.2);
  B.sync();
  B.play();
  step(0.5);
  // inject a +0.15 % ratio error (detected BPMs are never perfect)
  B._syncBase *= 1.0015;
  B._setRate(B._syncBase);
  let maxCorr = 0;
  let maxErr = 0;
  for (let s = 0; s < 45; s++) {
    for (let i = 0; i < 60; i++) {
      step(1 / 60);
      maxCorr = Math.max(maxCorr, Math.abs(B.tempo / B._syncBase - 1));
    }
    if (s >= 30) maxErr = Math.max(maxErr, Math.abs(phaseErr(engine, A, B)));
  }
  assert.ok(maxCorr <= 0.002 + 1e-12, `servo correction ${maxCorr}`);
  assert.equal(B._ratioCal, true, 'calibration done');
  close(B._syncBase, 0.96, 0.96 * 1e-6, 'the base ratio is calibrated');
  assert.ok(maxErr < 0.003, `phase held (${maxErr} beat)`);
  close(B.baseTempo, B._syncBase, 1e-9);
  close(B.effectiveBpm, 120, 1e-3);
  await engine.destroy();
});

test('snapToReference: the discreet magnet', async () => {
  const { engine, decks: [A, B], step } = await rig();
  gridded(A, 120);
  gridded(B, 120);
  assert.equal(B.snapToReference(), false, 'no other deck plays');
  A.play();
  step(1);
  B.seek(A.position + 0.02); // 0.04 beat off
  assert.equal(B.snapToReference(), true);
  close(phaseErr(engine, A, B), 0, 1e-9);
  B.seek(A.position + 0.1); // 0.2 beat off: a deliberate placement
  assert.equal(B.snapToReference(), false);
  assert.equal(B.snapToReference(0.25), true);
  await engine.destroy();
});

test('scrub: pause, grains on the zero-latency path, resume, magnet, reanchor', async () => {
  const { ctx, engine, decks: [A, B], step } = await rig();
  gridded(A, 120);
  gridded(B, 120);
  A.play();
  B.sync();
  B.play();
  step(1);
  B.scrubStart();
  assert.equal(B.scrubbing, true);
  assert.equal(B.playing, false);
  const nodes = ctx.edges.length;
  ctx.advance(0.02);
  B.scrubMove(B.position + 0.05);
  assert.ok(ctx.edges.length > nodes, 'a grain was scheduled');
  const grain = ctx.edges.filter((e) => e.to === B.scrubIn).at(-1).from;
  assert.ok(grain, 'grains go to scrubIn (zero latency)');
  ctx.advance(0.5);
  B.scrubMove(A.position + 0.01); // released almost aligned (0.02 beat)
  B.scrubEnd();
  assert.equal(B.scrubbing, false);
  assert.equal(B.playing, true, 'resumed');
  assert.ok(Math.abs(phaseErr(engine, A, B)) < 1e-6, 'magnet + reanchor');
  // silent scrub = seek; resume: false keeps the deck paused
  B.scrubStart({ audible: false });
  B.scrubMove(10);
  assert.equal(B.position, 10);
  B.scrubEnd({ resume: false });
  assert.equal(B.playing, false);
  await engine.destroy();
});

test('spin: the track virtually keeps running, then resumes exactly there', async () => {
  const { ctx, engine, decks: [A] } = await rig();
  gridded(A, 120);
  A.play();
  ctx.advance(2.03);
  assert.equal(A.spinStart('vbrake'), true);
  assert.equal(A.spinning, true);
  assert.equal(A.playing, false);
  assert.equal(A.spinStart('backspin'), false, 'one at a time');
  ctx.advance(1);
  close(A.displayPosition, 3, 1e-9);
  close(A.position, 2, 1e-9);
  A.spinEnd();
  assert.equal(A.playing, true);
  close(A.position, 3, 1e-9, 'resumed where the track would be');
  // paused deck: back to the starting point
  A.pause();
  A.seek(5);
  A.spinStart('backspin');
  ctx.advance(0.7);
  A.spinEnd();
  assert.equal(A.playing, false);
  assert.equal(A.position, 5);
  await engine.destroy();
});
