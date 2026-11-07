// Tests of the shadow decode trigger (owner: jsproxy, native/engine/SPEC.md §7.4): after a local
// track's pcm.done the proxy cuts the reference window (the middle 30 s, folded
// to mono) from the AudioBuffer and asks main for a native decode; one job at
// a time, at most one pending; a crashed decoder skips that path; statistics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEngine } from '../../src/js/native-engine.js';
import { cutReferenceWindow } from '../../src/js/native-engine/shadow.js';
import { makeEngine, makeOmEngine, makeWindow, FakeClock, FakeAudioBuffer } from './helpers.mjs';

const R = 48000;
const ramp = (c, i) => (c ? -1 : 1) * ((i % 48000) / 48000);
const buf = (sec) => new FakeAudioBuffer({ length: Math.round(sec * R), sampleRate: R, fill: ramp });

test('reference window: the middle 30 s folded to mono (L+R)/2, one buffer as both channels; or the whole track', () => {
  // the child compares mono (L+R)/2 (SPEC.md §7.4): one buffer, cloned once (e2e: 8-10 ms instead of 18-21 ms on the UI thread)
  const b = new FakeAudioBuffer({ length: 100 * R, sampleRate: R, fill: (c, i) => (c ? 0.25 : 0.75) * ((i % 48000) / 48000) });
  const w = cutReferenceWindow(b);
  assert.equal(w.left.length, 30 * R);
  assert.equal(w.windowStart, 35 * R);
  assert.equal(w.frames, 100 * R);
  assert.equal(w.rate, R);
  const i = 35 * R + 1234;
  assert.ok(Math.abs(w.left[1234] - 0.5 * (b.getChannelData(0)[i] + b.getChannelData(1)[i])) < 1e-7);
  assert.equal(w.right, w.left, 'the same Float32Array for both channels');
  const s = cutReferenceWindow(buf(12));
  assert.equal(s.left.length, 12 * R);
  assert.equal(s.windowStart, 0);
});

test('after pcm.done of a local track: one shadowDecode job with the window; stats; one line per track', async () => {
  const t = await makeEngine(NativeEngine);
  const d = t.engine.decks[0];
  d.loadTrack({ buffer: buf(40), bpm: 120, track: { name: 'a', path: 'C:/m/a.mp3' } });
  await t.clock.advance(50);
  const jobs = t.om.calls.filter((c) => c[0] === 'shadowDecode').map((c) => c[1]);
  assert.equal(jobs.length, 1);
  const j = jobs[0];
  assert.equal(j.path, 'C:/m/a.mp3');
  assert.equal(j.frames, 40 * R);
  assert.equal(j.windowStart, 5 * R);
  assert.equal(j.left.length, 30 * R);
  assert.equal(j.loadId, d._loadId);
  const st = t.engine.shadowStats();
  assert.equal(st.count, 1);
  assert.equal(st.within1ms, 1);
  assert.ok(t.log.lines.some((l) => /shadow decode a\.mp3: offset 0\.20 ms/.test(l)));
});

test('one job at a time, at most one pending (the newest wins); a crash skips the path; the setting turns it off', async () => {
  const clock = new FakeClock();
  const win = makeWindow();
  const om = makeOmEngine(clock, win);
  const results = [];
  om.shadowDecode = (job) => {
    om.calls.push(['shadowDecode', job]);
    return new Promise((resolve) => results.push(resolve));
  };
  const t = await makeEngine(NativeEngine, { clock, win, om });
  const [d0, d1, d2, d3] = t.engine.decks;
  d0.loadTrack({ buffer: buf(31), bpm: 120, track: { name: 'a', path: 'C:/m/a.flac' } });
  await clock.advance(50);
  d1.loadTrack({ buffer: buf(31), bpm: 120, track: { name: 'b', path: 'C:/m/b.mp3' } });
  await clock.advance(50);
  d2.loadTrack({ buffer: buf(31), bpm: 120, track: { name: 'c', path: 'C:/m/c.mp3' } });
  await clock.advance(50);
  assert.equal(results.length, 1, 'one job running');
  results[0]({ ok: false, error: 'crashed' });
  await clock.advance(1);
  const paths = om.calls.filter((c) => c[0] === 'shadowDecode').map((c) => c[1].path);
  assert.deepEqual(paths, ['C:/m/a.flac', 'C:/m/c.mp3'], 'b was replaced by c while pending');
  results[1]({ ok: true, offsetMs: -51.2, lengthDiffMs: -51, rmsDiffDb: -12, correlation: 0.97 });
  await clock.advance(1);
  const st = t.engine.shadowStats();
  assert.deepEqual([st.count, st.within1ms, st.failed], [1, 0, 1]);
  assert.equal(st.worst.mp3, 51.2);
  assert.deepEqual(st.skipped, ['C:/m/a.flac']);
  // the crashed path is skipped for the session
  d3.loadTrack({ buffer: buf(31), bpm: 120, track: { name: 'a', path: 'C:/m/a.flac' } });
  await clock.advance(50);
  assert.equal(om.calls.filter((c) => c[0] === 'shadowDecode').length, 2);
  // setting nativeShadow = '0'
  t.storage.setItem('nativeShadow', '0');
  d1.loadTrack({ buffer: buf(31), bpm: 120, track: { name: 'e', path: 'C:/m/e.mp3' } });
  await clock.advance(50);
  assert.equal(om.calls.filter((c) => c[0] === 'shadowDecode').length, 2);
});

test('no shadow decode for tracks without a local path', async () => {
  const t = await makeEngine(NativeEngine);
  t.engine.decks[0].loadTrack({ buffer: buf(31), bpm: 120, track: { name: 'stream' } });
  await t.clock.advance(50);
  assert.equal(t.om.calls.filter((c) => c[0] === 'shadowDecode').length, 0);
});
