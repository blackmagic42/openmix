// Tests of the PCM handoff scheduler (owner: jsproxy, native/engine/SPEC.md §7.2, §17.7):
// float32 planar chunks filled by copyFromChannel into a pool of 2 reused
// buffers, posted WITHOUT a transfer list, chunks only after the pcm.begin
// reply, order around the position (+ the previous chunk), reorder at jumps,
// <= 8 in flight, NotFound retried once, abort on reload, headroom from the
// peaks (0 for stems / samples / multichannel), and the UI-thread cost of a
// 6-minute track (measured).
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { NativeEngine } from '../../src/js/native-engine.js';
import {
  PcmScheduler, chunkOrder, headroomFromPeaks, MAX_IN_FLIGHT, PCM_NOT_FOUND
} from '../../src/js/native-engine/pcm.js';
import { makeEngine, FakeAudioBuffer, FakeClock } from './helpers.mjs';

const CF = 65536;
const ramp = (c, i) => (c + 1) * 0.001 + (i % 1000) / 10000;   // distinct per channel and frame
const buf = (frames, opts = {}) => new FakeAudioBuffer({ length: frames, sampleRate: 48000, fill: ramp, ...opts });

/** A scheduler on a fake link whose pcm.begin reply the test releases. */
function schedOnFakeLink(clock, { autoBegin = true } = {}) {
  const posts = [];
  const sent = [];
  let releaseBegin;
  const beginGate = new Promise((r) => { releaseBegin = r; });
  const link = {
    request: (cmd) => { sent.push(cmd); return autoBegin ? Promise.resolve({ ok: true }) : beginGate.then(() => ({ ok: true })); },
    send: (cmd) => { sent.push(cmd); return 1; },
    postPcm: (...args) => posts.push(args)
  };
  const env = { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, queueMicrotask: (f) => queueMicrotask(f), log: console };
  const s = new PcmScheduler({ env, link, chunkFrames: CF });
  return { s, posts, sent, releaseBegin };
}

test('headroom: from the track peaks (max of top / -bottom, at least 1), 0 without peaks', () => {
  const peaks = { top: Float32Array.from([0.2, 0.9, 1.3, 0.1]), bottom: Float32Array.from([-0.4, -1.1, -0.2, -0.05]) };
  assert.deepEqual(headroomFromPeaks(peaks), { headroom: Math.fround(1.3), peak: Math.fround(1.3) });
  const quiet = { top: Float32Array.from([0.2, 0.5]), bottom: Float32Array.from([-0.6, -0.1]) };
  assert.deepEqual(headroomFromPeaks(quiet), { headroom: 1, peak: Math.fround(0.6) });
  assert.deepEqual(headroomFromPeaks(null), { headroom: 0, peak: 0 });
});

test('chunk order: the chunk under the position, the one before, forward to the end, then from 0', () => {
  assert.deepEqual(chunkOrder(8, [0]), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(chunkOrder(8, [5]), [5, 4, 6, 7, 0, 1, 2, 3]);
  assert.deepEqual(chunkOrder(8, [5], (c) => c === 6 || c === 1), [5, 4, 7, 0, 2, 3]);
  assert.deepEqual(chunkOrder(8, [5, 2]), [5, 4, 2, 1, 6, 7, 0, 3]);
});

test('pcm.begin first: no chunk before its reply; float32 planar chunks via copyFromChannel; no transfer list', async () => {
  const clock = new FakeClock();
  const { s, posts, sent, releaseBegin } = schedOnFakeLink(clock, { autoBegin: false });
  const b = buf(CF * 2 + 1000, { channels: 2 });
  const st = s.start({ kind: 'track', buffer: b, format: 's16', headroom: 1, peak: 1, focusSec: 0 });
  assert.equal(sent[0].cmd, 'pcm.begin');
  assert.equal(sent[0].frames, b.length);
  assert.equal(sent[0].sourceChannels, 2);
  s.frame();
  await clock.advance(10);
  assert.equal(posts.length, 0, 'nothing before the begin reply');
  releaseBegin();
  await clock.advance(1);
  assert.equal(posts.length, 3);
  for (const args of posts) assert.equal(args.length, 1, 'postMessage(msg) without a transfer list');
  const [m0, m1, m2] = posts.map((a) => a[0]);
  assert.deepEqual([m0.offset, m1.offset, m2.offset], [0, CF, 2 * CF]);
  assert.equal(m2.frames, 1000, 'last chunk is shorter');
  assert.ok(m0.data instanceof Float32Array);
  assert.equal(m0.data.length, 2 * CF);
  assert.equal(m2.data.length, 2 * 1000, 'planar with a stride of `frames`');
  assert.equal(b.copyCalls, 3 * 2, 'one copyFromChannel per channel and chunk');
  // planar content of the last chunk (its pool buffer may be reused: check right away)
  const L = b.getChannelData(0);
  const R = b.getChannelData(1);
  for (const i of [0, 1, 999]) {
    assert.equal(m2.data[i], L[2 * CF + i]);
    assert.equal(m2.data[1000 + i], R[2 * CF + i]);
  }
  assert.equal(st.pool.length, 2, 'a pool of 2 reused buffers');
});

test('the pool buffers are reused and chunks reach the host intact (structured clone at post time)', async () => {
  const t = await makeEngine(NativeEngine);
  const b = buf(CF * 5 + 10);
  t.engine.decks[0].loadTrack({ buffer: b, bpm: 120, track: { name: 'x' } });
  await t.clock.advance(20);
  const got = t.host.chunks.filter((m) => m.data);
  assert.equal(got.length, 6);
  const L = b.getChannelData(0);
  const R = b.getChannelData(1);
  for (const m of got) {
    for (const i of [0, 7, m.frames - 1]) {
      assert.equal(m.data[i], L[m.offset + i], `L @${m.offset + i}`);
      assert.equal(m.data[m.frames + i], R[m.offset + i], `R @${m.offset + i}`);
    }
  }
  const pcmPort = t.host.pcm.other;
  assert.ok(pcmPort.posts.every((a) => a.length === 1), 'no transfer list');
  // every chunk acknowledged -> end -> pcm.done; the stream releases its pool
  assert.ok(t.host.chunks.some((m) => m.end));
  const st = t.engine.decks[0]._stream;
  assert.equal(st.state, 'done');
  assert.equal(st.pool, null);
});

test('at most 8 chunks in flight per stream', async () => {
  const t = await makeEngine(NativeEngine);
  t.host.ackChunks = false;
  t.engine.decks[0].loadTrack({ buffer: buf(CF * 20), bpm: 120, track: { name: 'x' } });
  await t.clock.advance(100);
  t.engine.syncLock();
  await t.clock.advance(100);
  assert.equal(t.host.chunks.filter((m) => m.data).length, MAX_IN_FLIGHT);
});

test('the queue is reordered at every jump: the target chunk and the one before it first', async () => {
  const t = await makeEngine(NativeEngine);
  t.host.ackChunks = false;
  const d = t.engine.decks[0];
  d.loadTrack({ buffer: buf(CF * 40), bpm: 120, beatOffset: 0, track: { name: 'x' } });
  await t.clock.advance(5);
  const order0 = t.host.chunks.map((m) => m.offset / CF);
  assert.deepEqual(order0, [0, 1, 2, 3, 4, 5, 6, 7], 'fresh load: from 0');
  const ackAll = () => {
    for (const m of t.host.chunks.splice(0)) if (m.data) t.host.pcm.postMessage({ loadId: m.loadId, offset: m.offset, code: 0 });
  };
  // seek (hot cue, beat jump...) to chunk 30
  d.seek((30 * CF + 100) / 48000);
  ackAll();
  await t.clock.advance(5);
  const order1 = t.host.chunks.map((m) => m.offset / CF);
  assert.deepEqual(order1.slice(0, 3), [30, 29, 31]);
  // loop entry: the loop start chunk goes first too
  ackAll();
  d.setLoop((20 * CF + 5) / 48000, (21 * CF) / 48000);
  await t.clock.advance(5);
  const order2 = t.host.chunks.map((m) => m.offset / CF);
  assert.ok(order2.includes(20) && order2.includes(19), `loop start chunks early: ${order2}`);
  // play from a new position
  ackAll();
  d.exitLoop();
  d.seek((12 * CF) / 48000);
  ackAll();
  await t.clock.advance(5);
  assert.deepEqual(t.host.chunks.map((m) => m.offset / CF).slice(0, 2), [12, 11]);
});

test('a sync jump and a scratch release (snap) reorder the queue at the predicted target', async () => {
  const t = await makeEngine(NativeEngine);
  t.host.ackChunks = false;
  const [a, b] = t.engine.decks;
  a.loadTrack({ buffer: buf(48000 * 300), bpm: 120, beatOffset: 0, track: { name: 'a' } });
  b.loadTrack({ buffer: buf(48000 * 300), bpm: 128, beatOffset: 0, track: { name: 'b' } });
  await t.clock.advance(5);
  t.host.state();
  await t.clock.advance(1);
  a.seek(100);
  a.play();
  b.seek(200.3);
  const calls = [];
  const orig = t.engine.pcm.focus.bind(t.engine.pcm);
  t.engine.pcm.focus = (st, sec, extra) => { calls.push([st, sec]); return orig(st, sec, extra); };
  assert.equal(t.engine.sync(1), true);
  const c = calls.find(([st]) => st === b._stream);
  assert.ok(c, 'focus called for the synced deck');
  assert.ok(Math.abs(c[1] - b.currentTime()) < 1e-9, 'at the predicted target');
  assert.ok(Math.abs(b.currentTime() - 200.3) > 1e-6, 'the bar alignment moved the deck');
  // the head of the queue is the chunk under the target (or the next not sent yet)
  const st = b._stream;
  const next = st.queue.slice(st.qi).find((k) => st.sent[k] === 0);
  const under = Math.floor((b.currentTime() * 48000) / CF);
  assert.ok(next >= under && next <= under + 8, `next ${next}, target chunk ${under}`);
});

test('a chunk answered NotFound is retried once after 50 ms, then the stream is abandoned', async () => {
  const clock = new FakeClock();
  const { s, posts, sent } = schedOnFakeLink(clock);
  const fails = [];
  s.whenFailed = (st, err) => fails.push(err);
  const b = buf(CF * 2);
  const st = s.start({ kind: 'stem', buffer: b, focusSec: 0 });
  await clock.advance(1);
  assert.equal(posts.length, 2);
  s.onAck({ loadId: st.loadId, offset: 0, code: PCM_NOT_FOUND });
  await clock.advance(49);
  assert.equal(posts.length, 2, 'not before 50 ms');
  await clock.advance(2);
  assert.equal(posts.length, 3, 'retried');
  assert.equal(posts[2][0].offset, 0);
  s.onAck({ loadId: st.loadId, offset: 0, code: PCM_NOT_FOUND });
  await clock.advance(100);
  assert.equal(st.state, 'error');
  assert.deepEqual(fails, ['not found']);
  assert.ok(sent.some((c) => c.cmd === 'pcm.abort' && c.loadId === st.loadId));
});

test('a track whose stream is abandoned is reloaded once (new loadId), then the engine falls back', async () => {
  const t = await makeEngine(NativeEngine);
  const d = t.engine.decks[0];
  t.host.notFound.add(1);
  d.loadTrack({ buffer: buf(CF * 3), bpm: 120, track: { name: 'x' } });
  await t.clock.advance(200);
  assert.equal(t.host.cmds('deck.load').length, 2, 'reloaded with a new loadId');
  assert.equal(d._loadId, 2);
  assert.equal(t.engine.status, 'native');
  assert.equal(d._stream.state, 'done', 'the second stream went through');
  // a track that fails twice: Web engine
  const t2 = await makeEngine(NativeEngine);
  t2.host.notFound.add(1);
  t2.host.notFound.add(2);
  t2.engine.decks[0].loadTrack({ buffer: buf(CF * 3), bpm: 120, track: { name: 'y' } });
  await t2.clock.advance(400);
  assert.equal(t2.host.cmds('deck.load').length, 2);
  assert.equal(t2.engine.status, 'web');
  assert.match(t2.fallbacks[0], /could not take the track/);
});

test('loading another track aborts the incomplete stream first (same batch, before the new pcm.begin)', async () => {
  const t = await makeEngine(NativeEngine);
  t.host.ackChunks = false;
  const d = t.engine.decks[0];
  d.loadTrack({ buffer: buf(CF * 10), bpm: 120, track: { name: 'a' } });
  await t.clock.advance(5);
  const first = d._loadId;
  d.loadTrack({ buffer: buf(CF * 10), bpm: 121, track: { name: 'b' } });
  await t.clock.advance(5);
  const cmds = t.host.commands.map((c) => `${c.cmd}:${c.loadId ?? ''}`);
  const iAbort = cmds.indexOf(`pcm.abort:${first}`);
  const iBegin = cmds.indexOf(`pcm.begin:${d._loadId}`);
  const iLoad = cmds.indexOf(`deck.load:${d._loadId}`);
  assert.ok(iAbort >= 0 && iAbort < iBegin && iBegin < iLoad, cmds.join(' '));
});

test('headroom and format in pcm.begin: track from peaks, f32 for hi-res, 0 for stems / samples / multichannel', async () => {
  const t = await makeEngine(NativeEngine);
  const [d0, d1, d2] = t.engine.decks;
  const peaks = { top: Float32Array.from([0.5, 1.12]), bottom: Float32Array.from([-0.3, -0.9]) };
  d0.loadTrack({ buffer: buf(CF), bpm: 120, peaks, track: { name: 'a' } });
  d1.loadTrack({ buffer: buf(CF), bpm: 120, peaks, track: { name: 'b', bitsPerSample: 24 } });
  d2.loadTrack({ buffer: buf(CF, { channels: 6 }), bpm: 120, peaks, track: { name: 'c' } });
  await t.clock.advance(5);
  const begins = t.host.cmds('pcm.begin');
  assert.equal(begins[0].kind, 'track');
  assert.equal(begins[0].format, 's16');
  assert.ok(Math.abs(begins[0].headroom - 1.12) < 1e-6);
  assert.ok(Math.abs(begins[0].peak - 1.12) < 1e-6);
  assert.equal(begins[1].format, 'f32');
  assert.equal(begins[2].headroom, 0, 'multichannel: per-chunk headroom in the engine');
  assert.equal(begins[2].sourceChannels, 6);
  t.host.state();
  await t.clock.advance(1);
  d0.stems = { vocals: buf(CF), drums: buf(CF), bass: buf(CF), other: null };
  t.engine.preloadSample(buf(4800));
  await t.clock.advance(5);
  const later = t.host.cmds('pcm.begin').slice(3);
  assert.deepEqual(later.map((c) => [c.kind, c.headroom]), [['stem', 0], ['stem', 0], ['stem', 0], ['sample', 0]]);
});

test('a machine where ONE chunk exceeds the 2 ms budget still progresses (one chunk per frame window)', async () => {
  const clock = new FakeClock();
  const posts = [];
  let s;
  const link = {
    request: () => Promise.resolve({ ok: true }),
    send: () => 1,
    postPcm: (msg) => {
      posts.push(msg);
      if (!msg.end) clock.setTimeout(() => s.onAck({ loadId: msg.loadId, offset: msg.offset, code: 0 }), 1);
      else clock.setTimeout(() => s.onDone(msg.loadId), 1);
    }
  };
  const env = { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, queueMicrotask: (f) => queueMicrotask(f), log: console };
  s = new PcmScheduler({ env, link, chunkFrames: CF });
  const b = new FakeAudioBuffer({ length: CF * 6, sampleRate: 48000 });
  const copy = b.copyFromChannel.bind(b);
  b.copyFromChannel = (d, c, o) => { clock.t += 2.5; copy(d, c, o); };   // 5 ms per stereo chunk
  const st = s.start({ kind: 'track', buffer: b, focusSec: 0 });
  await clock.advance(200);
  assert.equal(st.state, 'done', `sent ${posts.length}`);
  assert.ok(s.stats.chunkMs > 4, 'the cost was learnt');
});

test('UI thread: a 6-minute track is handed off with <= ~2 ms per frame (measured)', async () => {
  // real clock: the budget is measured with performance.now(); chunks are structured-cloned like postMessage
  // does; the host acknowledges each chunk ~1 ms later (other process); one animation frame every 16.7 ms
  const frames = Math.round(360 * 48000);
  const b = new FakeAudioBuffer({ length: frames, sampleRate: 48000, fill: null });
  let s = null;
  let longestTask = 0;
  const task = (fn) => {
    const a = performance.now();
    fn();
    queueMicrotask(() => { longestTask = Math.max(longestTask, performance.now() - a); });
  };
  const link = {
    request: () => Promise.resolve({ ok: true }),
    send: () => 1,
    postPcm: (msg) => {
      const copy = structuredClone(msg);          // what MessagePort.postMessage does synchronously
      setTimeout(() => task(() => (copy.end ? s.onDone(copy.loadId) : s.onAck({ loadId: copy.loadId, offset: copy.offset, code: 0 }))), 1);
    }
  };
  const env = {
    now: () => performance.now(),
    setTimeout: (f, ms) => setTimeout(() => task(f), ms), clearTimeout: (h) => clearTimeout(h),
    queueMicrotask: (f) => queueMicrotask(f), log: console
  };
  let doneAt = 0;
  s = new PcmScheduler({ env, link, chunkFrames: CF, whenDone: () => { doneAt = performance.now(); } });
  const pumps = [];
  const pump = s.pump.bind(s);
  s.pump = () => {
    const a = performance.now();
    pump();
    pumps.push(performance.now() - a);
  };
  const t0 = performance.now();
  const st = s.start({ kind: 'track', buffer: b, format: 's16', headroom: 1, peak: 1, focusSec: 0 });
  let framesUsed = 0;
  const raf = setInterval(() => { framesUsed++; task(() => s.frame()); }, 16.7);
  await st.whenDone;
  clearInterval(raf);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(st.state, 'done');
  const total = doneAt - t0;
  const chunks = Math.ceil(frames / CF);
  const sorted = pumps.filter((x) => x > 0.05).sort((x, y) => x - y);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  console.log(`[measure] 6-min track (48 kHz stereo): ${chunks} chunks in ${total.toFixed(0)} ms (${framesUsed} frames); `
    + `longest UI task ${longestTask.toFixed(2)} ms, pump p95 ${p95.toFixed(2)} ms, longest pump ${s.stats.maxPumpMs.toFixed(2)} ms, `
    + `max UI time per 16.7 ms window ${s.stats.maxWindowMs.toFixed(2)} ms, ${s.stats.chunkMs.toFixed(3)} ms per stereo chunk, `
    + `${(s.stats.bytes / 1048576).toFixed(0)} MB copied`);
  // p95 within the 2 ms budget (+ timer resolution); the max may include a GC pause of the test's own clones
  assert.ok(p95 <= 2.3, `pump p95 ${p95} ms`);
  assert.ok(longestTask < 12, `longest task ${longestTask} ms`);
});

test('more than 8 channels: only the first two are handed off (the engine keeps those for other layouts)', async () => {
  const t = await makeEngine(NativeEngine);
  const b = buf(CF + 5, { channels: 10 });
  t.engine.decks[0].loadTrack({ buffer: b, bpm: 120, track: {} });
  await t.clock.advance(20);
  const begin = t.host.cmds('pcm.begin')[0];
  assert.equal(begin.sourceChannels, 2);
  assert.equal(begin.headroom, 0);
  const m = t.host.chunks.find((x) => x.data && x.offset === 0);
  assert.equal(m.channels, 2);
  assert.equal(m.data[CF + 3], b.getChannelData(1)[3]);
  assert.equal(t.engine.decks[0]._stream.state, 'done');
});
