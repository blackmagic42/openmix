// Tests of the liveness rule (owner: jsproxy, native/engine/SPEC.md §17.6, App. B): no state
// and no hb for >= 3 s counted on 100 ms ticks that are < 50 ms late, plus a
// clock.ping unanswered for 1 s. UI jank never triggers it; silence plus a
// ping timeout does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LivenessMonitor } from '../../src/js/native-engine/liveness.js';
import { NativeEngine } from '../../src/js/native-engine.js';
import { FakeClock, makeEngine } from './helpers.mjs';

function monitor(clock) {
  const pings = [];
  const dead = [];
  const m = new LivenessMonitor({
    env: { now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval },
    sendPing: () => pings.push(clock.now()),
    onDead: (why) => dead.push(why)
  });
  m.start();
  return { m, pings, dead };
}

/**
 * Advances in 100 ms ticks. With `jankMs`, the renderer is busy across every
 * due time (a long task), so each timer tick fires `jankMs` late.
 */
async function run(clock, ms, { jankMs = 0, heard = null } = {}) {
  const end = clock.now() + ms;
  while (clock.now() < end) {
    if (jankMs) {
      clock.t += 100 + jankMs;
      await clock.advance(0);
    } else {
      await clock.advance(100);
    }
    if (heard) heard();
  }
}

test('UI jank never triggers it: late ticks do not count, even with total silence', async () => {
  const clock = new FakeClock();
  const { pings, dead } = monitor(clock);
  // every tick arrives 60 ms late (detectBPM, computeBandPeaks, alignStems...): 30 s of "silence"
  await run(clock, 30000, { jankMs: 60 });
  assert.equal(pings.length, 0);
  assert.deepEqual(dead, []);
});

test('state / hb arriving keeps it quiet', async () => {
  const clock = new FakeClock();
  const { m, pings, dead } = monitor(clock);
  await run(clock, 20000, { heard: () => m.heard() });
  assert.equal(pings.length, 0);
  assert.deepEqual(dead, []);
});

test('3 s of responsive silence sends a ping; an answer within 1 s keeps the engine', async () => {
  const clock = new FakeClock();
  const { m, pings, dead } = monitor(clock);
  await run(clock, 3000);
  assert.equal(pings.length, 1, 'ping after 3 s');
  await run(clock, 500);
  m.pong();
  await run(clock, 900);
  assert.deepEqual(dead, []);
  await run(clock, 300);
  assert.equal(pings.length, 2, 'next ping 1 s after the answer');
});

test('silence + an unanswered ping for 1 s: dead', async () => {
  const clock = new FakeClock();
  const { pings, dead } = monitor(clock);
  await run(clock, 3000);
  assert.equal(pings.length, 1);
  await run(clock, 900);
  assert.deepEqual(dead, []);
  await run(clock, 100);
  assert.equal(dead.length, 1);
});

test('jank during the ping wait does not count either', async () => {
  const clock = new FakeClock();
  const { pings, dead } = monitor(clock);
  await run(clock, 3000);
  assert.equal(pings.length, 1);
  await run(clock, 5000, { jankMs: 80 });
  assert.deepEqual(dead, [], 'a busy renderer cannot tell');
});

test('the facade falls back when the host goes silent (no state, no hb, no pong)', async () => {
  const t = await makeEngine(NativeEngine);
  t.host.silent = true;          // hung host: nothing comes back
  await run(t.clock, 3000);
  assert.equal(t.engine.status, 'native');
  await run(t.clock, 1200);
  await t.clock.advance(100);
  assert.equal(t.engine.status, 'web');
  assert.match(t.fallbacks[0], /not responding/);
  assert.equal(t.om.calls.filter((c) => c === 'kill').length, 1, 'the host is killed');
});

test('a busy renderer with a live host never falls back', async () => {
  const t = await makeEngine(NativeEngine);
  for (let k = 0; k < 100; k++) {
    if (k % 3 === 0) t.host.hb();
    t.clock.t += 170;            // janky frames: every tick 70 ms late
    await t.clock.advance(0);
  }
  assert.equal(t.engine.status, 'native');
});
