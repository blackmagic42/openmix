// The owner's decisions of 2026-11-09 on the renderer side (owner: jsproxy, native/engine/SPEC.md
// Appendix E.9): the proxy never sends sync.precision (the engine's default, precision ON, stays);
// the precise keylock setting reaches the engine at connect and when toggled (off by default);
// the VST "late" badge logic (LateBadge) shows a plugin that keeps missing its deadline, debounced,
// fed by the snapshot's insert counter, and never touches the plugin itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEngine, KEYLOCK_PRECISION_KEY, LateBadge, LATE_MIN_RISES, LATE_SHOW_WINDOW_MS, LATE_HIDE_AFTER_MS }
  from '../../src/js/native-engine.js';
import { makeEngine, drive } from './helpers.mjs';

test('sync precision: the proxy never sends sync.precision (connect, resync, sync use)', async () => {
  const t = await makeEngine(NativeEngine);
  const { engine, host, clock } = t;
  assert.equal(engine.status, 'native');
  engine.decks[1].bpm = 126;
  engine.decks[1].synced = true;
  engine.sync(1);
  engine.syncLock();
  await clock.advance(30);
  assert.equal(host.cmds('sync.precision').length, 0, 'sync.precision is never forced');
});

test('keylock precision: off by default, sent once at connect with the stored value, then on every change', async () => {
  const t = await makeEngine(NativeEngine);
  const { engine, host, clock } = t;
  assert.equal(KEYLOCK_PRECISION_KEY, 'keylockPrecision');
  assert.equal(engine.keylockPrecision, false);
  assert.deepEqual(host.cmds('keylock.precision').map((c) => c.on), [false], 'connect sends the default (off)');
  engine.setKeylockPrecision(true);
  await clock.advance(5);
  assert.equal(engine.keylockPrecision, true);
  assert.deepEqual(host.cmds('keylock.precision').map((c) => c.on), [false, true]);
  engine.setKeylockPrecision(false);
  await clock.advance(5);
  assert.deepEqual(host.cmds('keylock.precision').map((c) => c.on), [false, true, false]);
  // engine-wide: no deck field
  assert.ok(host.cmds('keylock.precision').every((c) => c.deck === undefined));
});

test('keylock precision: a stored "1" is sent at connect', async () => {
  const t = await makeEngine(NativeEngine, { storage: { [KEYLOCK_PRECISION_KEY]: '1' } });
  assert.equal(t.engine.keylockPrecision, true);
  assert.deepEqual(t.host.cmds('keylock.precision').map((c) => c.on), [true]);
});

test('keylock precision: on the Web engine (no native host) the setting is kept and nothing is sent', async () => {
  const t = await makeEngine(NativeEngine, { om: null });
  await t.clock.advance(50);
  assert.notEqual(t.engine.status, 'native');
  assert.equal(t.engine.setKeylockPrecision(true), 0);
  assert.equal(t.engine.keylockPrecision, true);
});

test('LateBadge: a single late burst shows nothing; repeated late blocks show the badge, hidden 3 s after the last one', () => {
  assert.deepEqual([LATE_MIN_RISES, LATE_SHOW_WINDOW_MS, LATE_HIDE_AFTER_MS], [2, 2000, 3000]);
  const b = new LateBadge();
  let now = 1000;
  const poll = (count, loaded = true) => { const v = b.update(now, count, loaded); now += 250; return v; };
  assert.equal(poll(7), false, 'first reading = baseline (blocks late while the plugin loaded do not count)');
  assert.equal(poll(7), false);
  assert.equal(poll(9), false, 'one rise: a hiccup');
  for (let i = 0; i < 12; i++) assert.equal(poll(9), false);   // 3 s later: the window forgot it
  assert.equal(poll(10), false);
  assert.equal(poll(10), false);
  assert.equal(poll(11), true, 'two rises within 2 s: shown');
  // late every ~2 s: stays shown (no flicker between the late blocks)
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < 7; i++) assert.equal(poll(11 + k), true);
    assert.equal(poll(12 + k), true);
  }
  // then nothing late: hidden once 3 s have passed since the last rise, not before
  let shown = 0;
  while (poll(14)) shown++;
  assert.ok(shown >= 10 && shown <= 12, `kept ${shown} polls (3 s at 250 ms)`);
  assert.equal(poll(14), false);
});

test('LateBadge: a new plugin (counter back down), an empty slot or no counter hide the badge at once', () => {
  const b = new LateBadge();
  let now = 0;
  const poll = (count, loaded = true) => { const v = b.update(now, count, loaded); now += 250; return v; };
  poll(0); poll(5); assert.equal(poll(10), true);
  assert.equal(poll(2), false, 'new instance: its counter restarted -> new baseline, hidden');
  assert.equal(poll(3), false);
  assert.equal(poll(4), true);
  assert.equal(poll(4, false), false, 'plugin removed');
  assert.equal(poll(8), false, 'baseline again after a new load');
  poll(9); assert.equal(poll(10), true);
  assert.equal(poll(NaN), false, 'no counter (host without underruns)');
});

test('LateBadge fed by the native snapshot (insert LATE + counter), the plugin never touched by it', async () => {
  const t = await makeEngine(NativeEngine);
  const { engine, host, clock } = t;
  const vh = engine.createVstHost();
  await drive(clock, vh.init());
  assert.equal((await drive(clock, vh.load(2, { path: 'C:/VST3/Slow.vst3', uid: 's', name: 'Slow' }))).ok, true);
  const before = host.commands.length;
  const badge = new LateBadge();
  let late = 0;
  let shown = false;
  const tick = async (moreLate) => {
    late += moreLate;
    host.decks[2].insert = { state: moreLate ? 3 : 1, late };   // 3 = LATE (the last block played the dry), 1 = ACTIVE
    host.state();
    await clock.advance(250);
    shown = badge.update(clock.now(), vh.underruns(2), !!vh.slots[2]);
  };
  await tick(0);
  assert.equal(shown, false);
  await tick(4);
  assert.equal(shown, false);
  await tick(3);
  assert.equal(shown, true);
  for (let i = 0; i < 13; i++) await tick(0);
  assert.equal(shown, false, 'hidden after 3 s on time');
  // the badge logic reads only: no command reached the engine because of the late blocks
  const sent = host.commands.slice(before).map((c) => c.cmd).filter((c) => c !== 'clock.ping');
  assert.ok(!sent.includes('vst.mix') && !sent.includes('vst.unload'), sent.join(','));
  assert.ok(vh.slots[2] && vh.slots[2].mix !== 0, 'still loaded and not bypassed');
});
