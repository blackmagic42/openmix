// Tests of the proxy's position model (owner: jsproxy, native/engine/SPEC.md §4.4, §4.5, §17.3):
// prediction then reconciliation with segments (the playhead stops exactly at
// the stop position and starts exactly at the cue), epochs, ack and `applied`
// gating, continuous fields adopted from every snapshot, slew / snap, loops,
// natural end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEngine } from '../../src/js/native-engine.js';
import { TransportModel, SNAP_SEC } from '../../src/js/native-engine/transport.js';
import { makeEngine, FakeAudioBuffer } from './helpers.mjs';

const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} != ${b} (±${eps})`);
const buf = (sec, rate = 48000) => new FakeAudioBuffer({ length: Math.round(sec * rate), sampleRate: rate });

/** A connected engine with a 60 s track on deck 0, its load acknowledged. */
async function loaded(opts = {}) {
  const t = await makeEngine(NativeEngine, opts);
  const d = t.engine.decks[0];
  d.loadTrack({ buffer: buf(60), bpm: 120, beatOffset: 0, track: { name: 'a' } });
  await t.clock.advance(5);
  t.host.state();
  await t.clock.advance(1);
  return { ...t, d };
}

test('play: the playhead holds at the cue until the engine anchor, then starts exactly there', async () => {
  const { d, host, clock, engine } = await loaded();
  d.seek(10);
  await clock.advance(1);
  host.seek(0, 10);
  host.state();
  await clock.advance(1);
  near(d.currentTime(), 10);
  d.play();
  assert.equal(d.playing, true);
  near(d.currentTime(), 10, 1e-12, 'held right after play()');
  await clock.advance(4);
  near(d.currentTime(), 10, 1e-12, 'still held before the engine answers');
  host.play(0);                          // heard at now + 30 ms
  const anchorT = host.decks[0].anchorT;
  host.state();
  await clock.advance(1);
  // before the anchor: still exactly the cue
  const until = (anchorT - engine.engineNow()) * 1000;
  await clock.advance(until - 1);
  near(d.currentTime(), 10, 1e-12, 'before anchorT');
  await clock.advance(1 + 100);
  near(d.currentTime(), 10 + (engine.engineNow() - anchorT), 1e-9, 'after anchorT');
});

test('pause: the playhead keeps moving for the output latency and stops exactly at the engine stop position', async () => {
  const { d, host, clock, engine } = await loaded();
  d.play();
  await clock.advance(1);
  host.play(0);
  host.state();
  await clock.advance(1000);
  host.state();
  await clock.advance(1);
  const before = d.currentTime();
  d.pause();
  assert.equal(d.playing, false);
  near(d.currentTime(), before, 1e-9, 'pause() keeps the position at once (engine.js offset = currentTime())');
  await clock.advance(2);
  host.pause(0);
  const { anchorT, anchorPos } = host.decks[0];
  host.state();
  await clock.advance(1);
  // until anchorT the shown position still advances (the audio plays out the latency)...
  const mid = engine.engineNow();
  assert.ok(mid < anchorT);
  assert.ok(d.currentTime() > before);
  // ...then stops EXACTLY at the engine's stop position
  await clock.advance((anchorT - mid) * 1000 + 5);
  near(d.currentTime(), anchorPos, 1e-9, 'stop position');
  await clock.advance(500);
  near(d.currentTime(), anchorPos, 1e-9, 'still there');
});

test('epoch: snapshots of another epoch are ignored', async () => {
  const { d, host, clock } = await loaded();
  host.decks[0].anchorPos = 33;
  host.decks[0].seg++;
  host.state({ epoch: host.epoch + 1 });
  await clock.advance(1);
  near(d.currentTime(), 0, 0, 'another epoch');
  host.state();
  await clock.advance(1);
  near(d.currentTime(), 33, 1e-9, 'same epoch adopted');
});

test('ack gating: a snapshot that does not cover a seek keeps the prediction', async () => {
  const { d, host, clock } = await loaded();
  d.seek(20);
  near(d.currentTime(), 20, 0, 'position = t at once');
  // a snapshot built before the seek was applied (ack below its seq)
  const ackBefore = host.ack;
  host.ackPending = ackBefore;
  host.state();
  await clock.advance(1);
  near(d.currentTime(), 20, 0, 'not pulled back to 0');
  // the engine applies it
  await clock.advance(1);
  host.ackPending = Math.max(...host.commands.map((c) => c.seq || 0));
  host.seek(0, 20);
  host.state();
  await clock.advance(1);
  near(d.currentTime(), 20, 1e-9, 'adopted');
  assert.equal(d._gates.transport.open(d._e._ack), true);
});

test('applied gating: a `when` command keeps the gate closed until its applied event', async () => {
  const { d, host, clock, engine } = await loaded();
  const when = engine.engineNow() + 0.5;
  const seq = d._send({ cmd: 'deck.seek', deck: 0, t: 5, when }, d._gates.transport);
  d._model.jumpStopped(5, engine.engineNow());
  await clock.advance(1);
  assert.ok(seq > 0);
  host.ackPending = seq + 10;   // ack beyond the seq: a `when` command is NOT covered by ack
  host.state();
  await clock.advance(1);
  near(d.currentTime(), 5, 0, 'kept until applied');
  host.emit({ ev: 'applied', seq, t: when, late: false });
  host.seek(0, 5);
  host.state();
  await clock.advance(1);
  assert.equal(d._gates.transport.open(engine._ack), true);
  near(d.currentTime(), 5, 1e-9);
});

test('continuous fields are adopted from every snapshot, even while the transport is gated', async () => {
  const { d, host, clock, engine } = await loaded();
  d.seek(12);                        // transport gated
  host.ackPending = host.ack;        // not applied yet
  host.decks[0].peak = 0.77;
  host.decks[0].tempo = 1.0123;      // the sync servo moved it
  host.state({ sync: { masterIdx: null, autoMasterIdx: 2, jogHold: false, synced: [false, false, false, false],
    calibrated: [false, false, false, false], syncBase: [null, null, null, null], syncRef: [null, null, null, null],
    pllCorr: [0, 0, 0, 0], beatDur: [null, null, null, null] }, mixer: { masterPeak: 0.66 } });
  await clock.advance(1);
  near(d.meterPeak(), 0.77, 1e-6);
  near(d.tempo, 1.0123, 1e-12);
  near(engine.masterPeak(), 0.66, 1e-6);
  assert.equal(engine.autoMasterIdx, 2);
  near(d.currentTime(), 12, 0, 'the transport prediction is kept');
});

test('a tempo command gates the tempo mirror until applied (no flicker back)', async () => {
  const { d, host, clock } = await loaded();
  d.setTempo(1.05);
  near(d.tempo, 1.05, 0);
  host.ackPending = host.ack;
  host.state();
  await clock.advance(1);
  near(d.tempo, 1.05, 0, 'not the stale 1.0');
  host.ackPending = Math.max(...host.commands.map((c) => c.seq || 0));
  host.decks[0].tempo = 1.0498;
  host.state();
  await clock.advance(1);
  near(d.tempo, 1.0498, 1e-12, 'engine value once applied');
});

test('slew: a difference below 3 ms is slewed over 100 ms, a bigger one snaps', () => {
  const m = new TransportModel();
  m.adopt({ seg: 1, anchorT: 0, anchorPos: 0, t: 10, pos: 10, rate: 1 }, 10);
  near(m.value(10), 10, 1e-12);
  // the engine says 2 ms behind
  m.adopt({ seg: 1, anchorT: 0, anchorPos: 0, t: 10, pos: 9.998, rate: 1 }, 10);
  near(m.value(10), 10, 1e-12, 'no jump');
  near(m.value(10.05), 10.05 - 0.001, 1e-9, 'half slewed at 50 ms');
  near(m.value(10.2), 10.2 - 0.002, 1e-9, 'fully slewed');
  // 10 ms: snaps
  m.adopt({ seg: 1, anchorT: 0, anchorPos: 0, t: 10.2, pos: 10.188, rate: 1 }, 10.2);
  near(m.value(10.2), 10.188, 1e-12, 'snapped');
  assert.ok(SNAP_SEC === 0.003);
});

test('a new segment is never extrapolated backwards: the previous one is shown until its anchor', () => {
  const m = new TransportModel();
  m.adopt({ seg: 4, anchorT: 0, anchorPos: 0, t: 5, pos: 5, rate: 1 }, 5);
  // engine: seek to 30 heard at 5.04; snapshot read at 5.01
  m.adopt({ seg: 5, anchorT: 5.04, anchorPos: 30, t: 5.04, pos: 30, rate: 1 }, 5.01);
  near(m.value(5.02), 5.02, 1e-12, 'previous segment');
  near(m.value(5.0399), 5.0399, 1e-12);
  near(m.value(5.05), 30.01, 1e-12, 'new segment after its anchor');
});

test('loops wrap like engine.js currentTime()', async () => {
  const { d, host, clock, engine } = await loaded();
  d.setLoop(4, 6);
  assert.equal(d.looping, true);
  d.seek(5);
  d.play();
  await clock.advance(1);
  host.decks[0].looping = true;
  host.decks[0].loopStart = 4;
  host.decks[0].loopEnd = 6;
  host.seek(0, 5);
  host.play(0);
  host.state();
  await clock.advance(1);
  const a = host.decks[0].anchorT;
  await clock.advance((a - engine.engineNow()) * 1000 + 1500);
  const expect = 4 + ((5 + (engine.engineNow() - a) - 4) % 2);
  near(d.currentTime(), expect, 1e-9, 'wrapped');
  assert.ok(d.currentTime() >= 4 && d.currentTime() < 6);
  d.exitLoop();
  assert.equal(d.looping, false);
  assert.equal(d._loopBeats, null);
});

test('loops: a snapshot stamped just after a wrap never shows the playhead before the loop start', async () => {
  // Found end to end (e2e-proxy): state.t is a presentTime ~20-45 ms ahead, and a loop wrap
  // starts no segment, so the wrapped pos extrapolated back to now fell below loopStart.
  const { d, host, clock, engine } = await loaded();
  d.setLoop(4, 6);
  d.seek(5.8);
  d.play();
  await clock.advance(1);
  Object.assign(host.decks[0], { looping: true, loopStart: 4, loopEnd: 6 });
  host.seek(0, 5.8);
  host.play(0);
  host.state();
  await clock.advance(1);
  const a = host.decks[0].anchorT;
  // engine time a + 0.18: heard 5.98 now; the snapshot is stamped t = now + 0.03, past the wrap (pos 4.01)
  await clock.advance((a + 0.18 - engine.engineNow()) * 1000);
  const s = host.state();
  near(s.decks[0].pos, 4.01, 1e-6, 'the engine reports the wrapped position');
  await clock.advance(0);
  const x = d.currentTime();
  assert.ok(x >= 4 && x < 6, `inside the loop: ${x}`);
  near(x, 5.8 + (engine.engineNow() - a), 1e-6, 'the position heard now (before the wrap)');
  await clock.advance(50);
  near(d.currentTime(), 4 + (5.8 + (engine.engineNow() - a) - 4) % 2, 1e-6, 'wrapped after it');
});

test('natural end: playing false, position = duration, onEnded once (event and snapshot deduplicated)', async () => {
  const { d, host, clock } = await loaded();
  let ended = 0;
  d.onEnded = () => { ended++; };
  d.play();
  await clock.advance(1);
  host.play(0);
  host.state();
  await clock.advance(1);
  // the engine reaches the end
  const endT = host.engineNow();
  Object.assign(host.decks[0], { playing: false, rate: 0, anchorPos: 60, anchorT: endT, seg: host.decks[0].seg + 1, endedCount: 1, endedAt: endT });
  host.emit({ ev: 'deck.ended', deck: 0, t: endT });
  host.state();
  await clock.advance(1);
  assert.equal(ended, 1);
  assert.equal(d.playing, false);
  near(d.currentTime(), 60, 1e-9);
  host.state();
  await clock.advance(1);
  assert.equal(ended, 1, 'not twice');
});

test('an end the user overtook (play after it, not yet applied) does not call onEnded', async () => {
  const { d, host, clock } = await loaded();
  let ended = 0;
  d.onEnded = () => { ended++; };
  d.seek(30);
  host.seek(0, 30);
  host.state();
  await clock.advance(1);
  d.play();                       // not applied yet
  host.ackPending = host.ack;
  const endT = host.engineNow();
  Object.assign(host.decks[0], { endedCount: 1, endedAt: endT });
  host.state();
  await clock.advance(1);
  assert.equal(ended, 0);
  assert.equal(d.playing, true);
});

test('a command the engine never applies (refused batch) cannot freeze the mirrors: the gate reopens after 1 s', async () => {
  const { d, host, clock } = await loaded();
  d.seek(40);
  await clock.advance(1);
  host.ackPending = host.ack;      // the seek is lost: never acknowledged
  for (let k = 0; k < 9; k++) {
    host.state();
    await clock.advance(100);
  }
  assert.equal(d.currentTime(), 40, 'still the prediction within 1 s');
  host.decks[0].seg++;
  host.decks[0].anchorPos = 3;
  host.state();
  await clock.advance(300);
  host.state();
  await clock.advance(1);
  near(d.currentTime(), 3, 1e-9, 'the engine truth after 1 s');
});
