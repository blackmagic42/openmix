// Tests of the FX assignment matrix (owner: jsproxy, native/engine/SPEC.md §10.3, §16.1):
// engine.fxAssign is a plain 4x4 array owned by the facade; app.js mutates it
// in place AND reassigns it whole; fx.assign is sent when the per-frame
// comparison sees a change, fx.sends on updateFxSends().
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEngine } from '../../src/js/native-engine.js';
import { makeEngine } from './helpers.mjs';

const assigns = (host) => host.cmds('fx.assign');

test('default matrix: unit u on deck u, sent once at connect', async () => {
  const { engine, host } = await makeEngine(NativeEngine);
  assert.deepEqual(engine.fxAssign, [[true, false, false, false], [false, true, false, false], [false, false, true, false], [false, false, false, true]]);
  assert.equal(assigns(host).length, 1);
  assert.deepEqual(assigns(host)[0].assign, engine.fxAssign);
});

test('an in-place mutation is detected by the per-frame comparison (syncLock)', async () => {
  const { engine, host, clock } = await makeEngine(NativeEngine);
  engine.fxAssign[0][2] = true;          // app.js style
  await clock.advance(1);
  assert.equal(assigns(host).length, 1, 'nothing until the frame hook');
  engine.syncLock();
  await clock.advance(1);
  assert.equal(assigns(host).length, 2);
  assert.equal(assigns(host)[1].assign[0][2], true);
  engine.syncLock();
  engine.syncLock();
  await clock.advance(1);
  assert.equal(assigns(host).length, 2, 'not resent while unchanged');
});

test('a whole reassignment (session restore) is detected too, then updateFxSends sends fx.sends after it', async () => {
  const { engine, host, clock } = await makeEngine(NativeEngine);
  engine.fxAssign = [[1, 1, 0, 0], [0, 1, 0, 0], [0, 0, 1, 1], [0, 0, 0, 1]].map((r) => r.map(Boolean));
  engine.updateFxSends();
  await clock.advance(1);
  const all = host.commands.map((c) => c.cmd);
  const iA = all.lastIndexOf('fx.assign');
  const iS = all.lastIndexOf('fx.sends');
  assert.ok(iA >= 0 && iA < iS, 'fx.assign before fx.sends');
  assert.deepEqual(host.commands[iA].assign[0], [true, true, false, false]);
  engine.updateFxSends();
  await clock.advance(1);
  assert.equal(assigns(host).length, 2, 'unchanged matrix: only fx.sends again');
  assert.equal(host.cmds('fx.sends').length, 3);
});

test('fxRefDeck uses the live matrix with engine.js rules', async () => {
  const { engine, host, clock } = await makeEngine(NativeEngine);
  const [, d1, d2] = engine.decks;
  const { FakeAudioBuffer } = await import('./helpers.mjs');
  for (const d of [d1, d2]) d.loadTrack({ buffer: new FakeAudioBuffer({ length: 48000 * 10 }), bpm: 120, track: {} });
  d2.play();
  await clock.advance(1);
  engine.fxAssign[0] = [false, true, true, false];
  assert.equal(engine.fxRefDeck(0), d2, 'the first assigned deck that plays');
  host.state();
});

test('unknown FX / Color type names never make the engine refuse a whole message (review round, parity #5)', async () => {
  // A session stored by another build may hold names the engine does not
  // know; one such name made parseCommands refuse every command of the task.
  const { engine, host, clock, log } = await makeEngine(NativeEngine);
  host.commands.length = 0;
  engine.decks[0].setVolume(0.42);
  engine.fx[1].setType('warp');                                  // unknown FX: sent as engine.js's default chain
  engine.setPadFx(2, { type: 'tapestop', beats: 1, level: 0.5 });
  engine.setColorType('shimmer');                                // unknown Color: not sent at all
  engine.setDeckColor(0, 0.3);
  await clock.advance(1);
  const fxSet = host.cmds('fx.set').filter((c) => c.unit === 'fx1' && c.type);
  assert.deepEqual(fxSet.map((c) => c.type), ['echo']);
  assert.equal(engine.fx[1].type, 'warp', 'the mirror keeps the name, like engine.js');
  assert.equal(host.cmds('fx.pad').at(-1).preset.type, 'echo');
  assert.equal(host.cmds('color.type').length, 0, 'no color.type for an unknown name');
  assert.equal(engine.colorType, 'shimmer');
  assert.ok(host.cmds('deck.volume').some((c) => c.v === 0.42), 'the rest of the task still reaches the engine');
  assert.ok(host.cmds('deck.color').length >= 1);
  const warns = () => log.lines.filter((l) => /unknown Color FX type/.test(l)).length;
  assert.equal(warns(), 1);
  engine.setColorType('also-unknown');
  engine.setColorType('noise');                                  // a known name is sent again
  await clock.advance(1);
  assert.equal(warns(), 1, 'said once');
  assert.deepEqual(host.cmds('color.type').map((c) => c.type), ['noise']);
  // every known name passes unchanged
  for (const t of ['delay', 'mtdelay', 'pingpong', 'robot', 'helix', 'crush']) engine.fx[0].setType(t);
  await clock.advance(1);
  assert.deepEqual(host.cmds('fx.set').filter((c) => c.unit === 'fx0' && c.type).map((c) => c.type).slice(-6),
    ['delay', 'mtdelay', 'pingpong', 'robot', 'helix', 'crush']);
});
