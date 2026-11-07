// Tests of the proxy's clock synchronisation (owner: jsproxy, native/engine/SPEC.md §4.5):
// min-rtt of the last 8 samples, with a jittery round trip; 5 pings at
// connect, then one every 2 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockSync, CLOCK_KEEP } from '../../src/js/native-engine/clock.js';
import { NativeEngine } from '../../src/js/native-engine.js';
import { makeEngine, ENGINE_OFFSET } from './helpers.mjs';

// deterministic pseudo-random jitter
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

test('the estimate is the minimum-rtt sample of the last 8 (jittery, asymmetric delays)', () => {
  const r = rng(42);
  const c = new ClockSync();
  const OFFSET = 123.456;
  let worst = 0;
  let perf = 1000;
  for (let k = 0; k < 400; k++) {
    perf += 2;
    // request and answer delays: 0.1..1 ms usually, with bursts of 5..40 ms (busy renderer / host)
    const up = (r() < 0.2 ? 5 + r() * 35 : 0.1 + r() * 0.9) / 1000;
    const down = (r() < 0.2 ? 5 + r() * 35 : 0.1 + r() * 0.9) / 1000;
    const t0 = perf;
    const te = t0 + up + OFFSET;
    const t1 = t0 + up + down;
    c.addSample(t0, te, t1);
    assert.ok(c.samples.length <= CLOCK_KEEP);
    const best = Math.min(...c.samples.map((s) => s.rtt));
    assert.equal(c.rtt, best, 'uses the min-rtt sample');
    const err = Math.abs(c.offset - OFFSET);
    assert.ok(err <= c.rtt / 2 + 1e-12, `error ${err} within rtt/2 ${c.rtt / 2}`);
    if (k >= 8) worst = Math.max(worst, err);
  }
  // with 8 samples, at least one ~1 ms round trip is almost always there: sub-ms accuracy
  assert.ok(worst < 0.005, `worst offset error ${(worst * 1000).toFixed(3)} ms`);
});

test('a late answer does not displace a good sample, and old samples age out', () => {
  const c = new ClockSync();
  c.addSample(0, 100.0005, 0.001);     // rtt 1 ms, offset 100.0000
  c.addSample(2, 102.030, 2.050);      // rtt 50 ms, biased offset
  assert.equal(c.rtt, 0.001);
  assert.ok(Math.abs(c.offset - 100) < 1e-9);
  for (let k = 0; k < 8; k++) c.addSample(4 + k, 104 + k + 0.01, 4 + k + 0.02);  // all 20 ms
  assert.equal(c.samples.length, 8);
  assert.ok(Math.abs(c.rtt - 0.02) < 1e-12, 'the 1 ms sample left the window');
});

test('connect runs 5 pings before device.open, then one every 2 s; engineNow() is on the engine clock', async () => {
  const t = await makeEngine(NativeEngine, { omOpts: { latency: 0.4 } });
  const cmds = t.host.commands.map((c) => c.cmd);
  const open = cmds.indexOf('device.open');
  assert.equal(cmds.slice(0, open).filter((c) => c === 'clock.ping').length, 5);
  assert.equal(t.engine.status, 'native');
  const before = t.host.cmds('clock.ping').length;
  for (let k = 0; k < 24; k++) {
    t.host.hb();                       // the host's heartbeat (else the liveness rule pings too)
    await t.clock.advance(250);
  }
  assert.equal(t.host.cmds('clock.ping').length - before, 3, 'every 2 s');
  // ports with 0.4 ms each way: the offset error is at most rtt/2
  const err = Math.abs(t.engine.engineNow() - (t.clock.now() / 1000 + ENGINE_OFFSET));
  assert.ok(err <= 0.0004 + 1e-9, `engineNow error ${err}`);
});
