// Tests of the stems and sampler handoff (owner: jsproxy, native/engine/SPEC.md §7.2.11-12, §17.8):
// stem buffers handed off (headroom 0) with deck.stems, replaced by stubs
// after their pcm.done (RAM), rebuilt from the cached separation on fallback;
// the sampler bank (WeakMap AudioBuffer -> slot, 32 slots, LRU) handed off at
// ready and on assignment, pad hits through the context shims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEngine } from '../../src/js/native-engine.js';
import { alignStems, decodeStemSet } from '../../src/js/stems.js';
import { makeEngine, FakeAudioBuffer, drive } from './helpers.mjs';

const buf = (sec, fill = null) => new FakeAudioBuffer({ length: Math.round(sec * 48000), sampleRate: 48000, fill });

async function withTrack(opts = {}) {
  const t = await makeEngine(NativeEngine, opts);
  const d = t.engine.decks[0];
  d.loadTrack({ buffer: buf(30), bpm: 120, track: { name: 'a', path: 'C:/m/a.mp3' } });
  await t.clock.advance(5);
  t.host.state();
  await t.clock.advance(1);
  return { ...t, d };
}

test('stems: three handoffs (headroom 0) then deck.stems in the same batch; stubs after the three pcm.done', async () => {
  const { d, host, clock, engine, log } = await withTrack();
  const st = { vocals: buf(30), drums: buf(30), bass: buf(30), other: null };
  host.commands.length = 0;
  d.stems = st;
  await clock.advance(1);
  const names = host.commands.map((c) => c.cmd);
  assert.deepEqual(names.slice(0, 4), ['pcm.begin', 'pcm.begin', 'pcm.begin', 'deck.stems']);
  const begins = host.cmds('pcm.begin');
  assert.ok(begins.every((c) => c.kind === 'stem' && c.headroom === 0));
  const ds = host.cmds('deck.stems')[0];
  assert.deepEqual([ds.vocals, ds.drums, ds.bass], begins.map((c) => c.loadId));
  await clock.advance(50);
  assert.equal(d.stems, st, 'same object for app.js');
  for (const k of ['vocals', 'drums', 'bass']) {
    assert.equal(typeof st[k].getChannelData, 'undefined', `${k} is a stub`);
    assert.deepEqual(Object.keys(st[k]).sort(), ['duration', 'length', 'numberOfChannels', 'sampleRate']);
    assert.equal(st[k].length, 30 * 48000);
  }
  assert.ok(log.lines.some((l) => /RAM after stems deck 1/.test(l)), 'RAM KPI logged');
  // loadStems with the stubs: stemsOn, gains back to 1; a gain ramp is a deck.stemGain command
  d.loadStems(d.stems);
  d.stemGains.vocals.gain.setTargetAtTime(0, engine.ctx.currentTime, 0.01);
  await clock.advance(1);
  assert.equal(host.cmds('deck.stemsOn').length, 1);
  assert.deepEqual(host.cmds('deck.stemGain').map((c) => [c.stem, c.v, c.tau]), [['vocals', 0, 0.01]]);
  assert.equal(d.stemsOn, true);
  assert.equal(d.stemGains.vocals.gain.value, 0);
  assert.equal(d.stemGains.drums.gain.value, 1);
});

test('stems are not stubbed when a handoff fails; a new track aborts the stems still in flight', async () => {
  const { d, host, clock } = await withTrack();
  host.ackChunks = false;
  const st = { vocals: buf(30), drums: buf(30), bass: buf(30), other: null };
  d.stems = st;
  await clock.advance(5);
  const ids = host.cmds('pcm.begin').slice(-3).map((c) => c.loadId);
  d.loadTrack({ buffer: buf(10), bpm: 128, track: { name: 'b' } });
  await clock.advance(1);
  const aborted = host.cmds('pcm.abort').map((c) => c.loadId);
  for (const id of ids) assert.ok(aborted.includes(id), `stem ${id} aborted`);
  assert.equal(typeof st.vocals.getChannelData, 'function', 'still real buffers');
  assert.equal(d.stems, null, 'engine.js loadTrack drops the stems');
});

test('fallback: stems rebuilt from the cached separation, re-enabled with their gains', async () => {
  const sep = { vocals: 'C:/c/v.wav', drums: 'C:/c/d.wav', bass: 'C:/c/b.wav', other: 'C:/c/o.wav' };
  const calls = [];
  const api = {
    stemsSeparate: async (p) => { calls.push(['separate', p]); return { ok: true, stems: sep }; },
    readFile: async (p) => { calls.push(['read', p]); return new Uint8Array(16); }
  };
  const { d, host, clock, engine, webLog } = await withTrack({ api });
  d.stems = { vocals: buf(30), drums: buf(30), bass: buf(30), other: null };
  await clock.advance(50);
  assert.equal(typeof d.stems.vocals.getChannelData, 'undefined', 'stubs before the fallback');
  d.loadStems(d.stems);
  d.stemGains.vocals.gain.setTargetAtTime(0, 0, 0.01);
  d.play();
  await clock.advance(1);
  host.play(0);
  host.state();
  await clock.advance(1);
  engine._onExit({ code: 1 });
  await clock.advance(3000);
  assert.equal(engine.status, 'web');
  assert.deepEqual(calls[0], ['separate', 'C:/m/a.mp3']);
  assert.equal(calls.filter((c) => c[0] === 'read').length, 4);
  const web = engine._web.decks[0];
  assert.ok(webLog.indexOf('deck0.loadStems') >= 0 && webLog.indexOf('deck0.loadStems') < webLog.indexOf('deck0.play'),
    'stems enabled before playback resumes');
  assert.equal(typeof web.stems.vocals.getChannelData, 'function', 'real buffers again');
  assert.equal(web.stemGains.vocals.gain.value, 0, 'muted vocals stay muted');
  assert.equal(web.stemGains.drums.gain.value, 1);
  assert.equal(d.stems, web.stems, 'the facade forwards');
});

test('stems.js: decodeStemSet merges bass + other and aligns to the track', async () => {
  // a track = sum of three "stems"; the decoded stems lag by 37 samples (encoder delay)
  const N = 48000 * 14;
  const sig = (seed) => (i) => Math.sin(i * 0.0137 * seed) * Math.sin(i * 0.00031 * (seed + 1)) + ((i * seed * 7919) % 13) / 100;
  const parts = [sig(1), sig(2), sig(3), sig(4)];
  const track = new FakeAudioBuffer({ length: N, sampleRate: 48000, fill: (c, i) => parts.reduce((a, f) => a + f(i), 0) });
  const lag = 37;
  const decoded = parts.map((f) => new FakeAudioBuffer({ length: N, sampleRate: 48000, fill: (c, i) => (i >= lag ? f(i - lag) : 0) }));
  let k = 0;
  const ctx = { decodeAudioData: async () => decoded[k++] };
  const out = await decodeStemSet({ vocals: 'v', drums: 'd', bass: 'b', other: 'o' }, ctx,
    { orig: track, readFile: async () => new Uint8Array(4) });
  assert.ok(Math.abs(out.lag * 48000 - lag) < 0.5, `lag ${out.lag * 48000}`);
  assert.equal(out.stems.other, null);
  const i = 20000;
  const bassPlusOther = parts[2](i) + parts[3](i);
  assert.ok(Math.abs(out.stems.bass.getChannelData(0)[i] - bassPlusOther) < 1e-5, 'bass + other merged and shifted');
  assert.equal(typeof alignStems, 'function');
});

test('sampler: preloadSample hands the sound off (headroom 0) with sampler.load in the same batch, once per buffer', async () => {
  const t = await makeEngine(NativeEngine);
  const b = buf(0.5);
  t.engine.preloadSample(b);
  t.engine.preloadSample(b);
  await t.clock.advance(1);
  const begins = t.host.cmds('pcm.begin');
  assert.equal(begins.length, 1);
  assert.equal(begins[0].kind, 'sample');
  assert.equal(begins[0].headroom, 0);
  const loads = t.host.cmds('sampler.load');
  assert.deepEqual([loads[0].slot, loads[0].loadId], [0, begins[0].loadId]);
  const all = t.host.commands.map((c) => c.cmd);
  assert.equal(all.indexOf('sampler.load'), all.indexOf('pcm.begin') + 1, 'same batch, right after its pcm.begin');
});

test('sampler: 32 slots, the least recently used one evicted', async () => {
  const t = await makeEngine(NativeEngine);
  const bufs = Array.from({ length: 33 }, () => buf(0.1));
  for (const b of bufs.slice(0, 32)) {
    t.engine.preloadSample(b);
    await t.clock.advance(1);
  }
  t.engine.preloadSample(bufs[0]);       // slot 0 used again: slot 1 is now the least recent
  await t.clock.advance(1);
  t.engine.preloadSample(bufs[32]);
  await t.clock.advance(1);
  const loads = t.host.cmds('sampler.load');
  assert.equal(loads.length, 33);
  assert.equal(loads[32].slot, 1, 'LRU slot reused');
  assert.equal(t.engine.sampler.map.get(bufs[1]), undefined, 'evicted buffer forgotten');
});

test('sampler: a pad hit through the context shims = sampler.play {slot, voice, gain}; stop = sampler.stop', async () => {
  const t = await makeEngine(NativeEngine);
  const { engine, host, clock } = t;
  const b = buf(0.5);
  engine.preloadSample(b);
  const g = engine.ctx.createGain();
  g.gain.value = 1;
  g.connect(engine.postBus);
  const src = engine.ctx.createBufferSource();
  src.buffer = b;
  src.connect(g);
  src.start();
  src.stop();
  const src2 = engine.ctx.createBufferSource();
  src2.buffer = buf(0.2);                  // never preloaded: handed off first, then played
  src2.connect(g);
  src2.start();
  await clock.advance(1);
  const plays = host.cmds('sampler.play');
  assert.deepEqual(plays.map((c) => [c.slot, c.voice, c.gain]), [[0, 0, 1], [1, 1, 1]]);
  assert.deepEqual(host.cmds('sampler.stop').map((c) => c.voice), [0]);
  const all = host.commands.map((c) => c.cmd);
  assert.ok(all.lastIndexOf('sampler.load') < all.lastIndexOf('sampler.play'), 'loaded before played');
});

test('sampler: a pad re-hit never stops another pad\'s voice (unique voice id per source, even after 16 hits)', async () => {
  // Review round of 7 Nov 2026, parity #1: ids were recycled modulo 16, and
  // app.js's samplerPress stops the pad's previous source on every re-hit.
  const t = await makeEngine(NativeEngine);
  const { engine, host, clock } = t;
  const a = buf(0.5);
  const b = buf(4);
  engine.preloadSample(a);
  engine.preloadSample(b);
  const g = engine.ctx.createGain();
  g.gain.value = 1;
  g.connect(engine.postBus);
  const slotSrc = {};
  // exactly samplerPress(): stop the pad's previous source, start a new one
  const press = (pad, buffer) => {
    if (slotSrc[pad]) { try { slotSrc[pad].stop(); } catch { /* already finished */ } }
    const src = engine.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(g);
    src.start();
    slotSrc[pad] = src;
  };
  press('A', a);
  for (let k = 0; k < 16; k++) press('B', b);
  await clock.advance(1);
  const bCurrent = host.cmds('sampler.play').at(-1).voice;   // pad B's sounding voice
  host.commands.length = 0;
  press('A', a);
  await clock.advance(1);
  const stops = host.cmds('sampler.stop').map((c) => c.voice);
  const plays = host.cmds('sampler.play').map((c) => c.voice);
  assert.equal(stops.length, 1, 'pad A stops its own previous source');
  assert.notEqual(stops[0], bCurrent, 'never pad B\'s current voice');
  assert.equal(stops[0], 0, 'pad A\'s first source');
  assert.notEqual(plays[0], bCurrent, 'the new voice does not reuse a live id either');
  assert.equal(plays[0], 17, 'ids grow: one per source');
});

test('sampler: sounds decoded before the engine is ready are handed off at ready', async () => {
  const t = await makeEngine(NativeEngine, { noConnect: true });
  t.engine.preloadSample(buf(0.3));
  t.engine.preloadSample(buf(0.3));
  await t.clock.advance(50);
  assert.equal(t.engine.status, 'native');
  assert.equal(t.om.host.cmds('sampler.load').length, 2);
});

test('the deck facade after fallback: stem gain shims forward to the Web deck', async () => {
  const t = await withTrack();
  t.engine._onExit({ code: 1 });
  await drive(t.clock, t.engine.whenSettled);
  await t.clock.advance(2000);
  const web = t.engine._web.decks[0];
  t.d.stemGains.drums.gain.value = 0.25;
  assert.equal(web.stemGains.drums.gain.value, 0.25);
});
