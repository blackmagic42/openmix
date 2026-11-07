// Tests of the fallback to the Web engine (owner: jsproxy, native/engine/SPEC.md §17.6):
// kill awaited first, transport frozen, outputs set before any sound, WSOLA
// nodes awaited before key / keylock, playback resumed for every deck at the
// same instant, VST suspects skipped, the same facade identities (the context
// shim held by Library included), onFallback(reason).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEngine } from '../../src/js/native-engine.js';
import { SUSPECTS_KEY } from '../../src/js/native-engine/vst-host.js';
import { makeEngine, makeOmEngine, makeWindow, FakeClock, FakeAudioBuffer, drive } from './helpers.mjs';

const buf = (sec) => new FakeAudioBuffer({ length: Math.round(sec * 48000), sampleRate: 48000 });

function fakeVstHostClass(log) {
  return class FakeWebVstHost {
    constructor(engine) { this.engine = engine; this.slots = [null, null, null, null]; this.plugins = []; this.available = false; }
    async init() { this.available = true; log.push('vst.init'); return true; }
    async load(i, plugin) { log.push(`vst.load ${i} ${plugin.path}`); this.slots[i] = { plugin, mix: 1 }; return { ok: true, name: plugin.name }; }
    setMix(i, m) { log.push(`vst.mix ${i} ${m}`); }
  };
}

/** A native session: 2 decks loaded, deck 0 playing with keylock, outputs chosen, a VST on deck 1. */
async function session(opts = {}) {
  const clock = new FakeClock();
  const win = makeWindow();
  const om = makeOmEngine(clock, win);
  const order = [];
  const kill = om.kill;
  om.kill = () => new Promise((resolve) => {
    order.push('kill requested');
    clock.setTimeout(() => { order.push('host exited'); resolve(kill()); }, 300);
  });
  const vstLog = [];
  const t = await makeEngine(NativeEngine, {
    clock, win, om, wsolaAfterMs: 400,
    storage: {
      audioOutput: 'h1',
      vstSlot1: JSON.stringify({ plugin: { path: 'C:/VST3/Crashy.vst3', uid: 'c', name: 'Crashy' }, mix: 1, state: null }),
      vstSlot2: JSON.stringify({ plugin: { path: 'C:/VST3/Good.vst3', uid: 'g', name: 'Good' }, mix: 0.5, state: 'AAA' })
    },
    devices: [{ kind: 'audiooutput', deviceId: 'h1', label: 'Speakers' }, { kind: 'audiooutput', deviceId: 'p1', label: 'DDJ-FLX6' }],
    VstHost: fakeVstHostClass(vstLog),
    ...opts
  });
  const { engine, host } = t;
  // the web engine log shares the order log
  const webLog = t.webLog;
  const [d0, d1] = engine.decks;
  d0.loadTrack({ buffer: buf(120), bpm: 124, beatOffset: 0.1, track: { name: 'A', path: 'C:/m/a.mp3' }, hotCues: [5, null, 9] });
  d1.loadTrack({ buffer: buf(200), bpm: 126, beatOffset: 0, track: { name: 'B', path: 'C:/m/b.mp3' } });
  d0.setKeylock(true);
  d0.setKey(2);
  d0.setTempo(1.04);
  d1.setVolume(0.4);
  d1.setEq('low', -1);
  engine.setCrossfader(0.25);
  engine.setMasterVolume(0.7);
  engine.fx[0].setType('reverb');
  engine.fx[0].setEnabled(true);
  engine.fxAssign[0][1] = true;
  engine.updateFxSends();
  await drive(clock, engine.setPhonesDevice('p1'));
  await clock.advance(5);
  host.state();
  await clock.advance(1);
  d0.seek(30);
  d0.play();
  await clock.advance(1);
  host.seek(0, 30);
  host.play(0);
  host.state();
  await clock.advance(1);
  // a VST on deck 1, loaded natively
  const vh = engine.createVstHost();
  await drive(clock, vh.init());
  await drive(clock, vh.load(1, { path: 'C:/VST3/Crashy.vst3', uid: 'c', name: 'Crashy' }));
  await clock.advance(500);
  host.state();
  await clock.advance(1);
  return { ...t, order, webLog, vstLog, vh, d0, d1 };
}

test('engine exit: kill awaited first, outputs before any sound, WSOLA before key/keylock, frozen positions, same identities', async () => {
  const s = await session();
  const { engine, clock, order, webLog, d0, d1 } = s;
  const ctxShim = engine.ctx;
  const fx0 = engine.fx[0];
  const posAtDeath = d0.currentTime();
  assert.ok(posAtDeath > 30, `playing: ${posAtDeath}`);
  // the engine host dies
  s.om.exitCb({ code: 3221225477 });
  await clock.advance(100);
  assert.equal(engine.status, 'falling-back');
  assert.deepEqual(order, ['kill requested'], 'nothing before the host exited');
  assert.equal(webLog.length, 0, 'no Web engine while the host may still play');
  await clock.advance(2000);
  assert.equal(engine.status, 'web');
  assert.equal(order[1], 'host exited');
  const idx = (re) => webLog.findIndex((l) => re.test(l));
  assert.equal(idx(/^new AudioEngine/), 0);
  assert.ok(idx(/^setSinkId h1/) > 0, 'master output');
  assert.ok(idx(/^setPhonesDevice p1/) > idx(/^setSinkId/), 'headphones');
  const firstPlay = idx(/\.play$/);
  assert.ok(firstPlay > idx(/^setPhonesDevice/), 'outputs set before any playback');
  assert.ok(idx(/^wsola ready/) >= 0 && idx(/^wsola ready/) < idx(/deck0\.setKeylock/), 'WSOLA nodes before keylock');
  assert.match(webLog[idx(/deck0\.setKeylock/)], /wsola=true/);
  assert.match(webLog[idx(/deck0\.setKey /)], /setKey 2 wsola=true/);
  assert.ok(idx(/deck0\.loadTrack/) < idx(/deck0\.seek/) && idx(/deck0\.seek/) < firstPlay);
  assert.ok(idx(/deck0\.setTempo 1\.04/) > idx(/deck0\.loadTrack/));
  // frozen when the kill completed (step 2 after step 1: 300 ms at tempo 1.04 after the exit event),
  // not later: the restore itself (WSOLA wait, 400 ms) does not move it
  const seekLine = webLog[idx(/deck0\.seek/)];
  const resumed = Number(seekLine.split(' ')[1]);
  const expected = posAtDeath + 0.3 * 1.04;
  assert.ok(Math.abs(resumed - expected) < 0.002, `resumed at ${resumed}, expected ${expected}`);
  assert.ok(idx(/deck1\.play/) < 0, 'deck 1 was not playing');
  // mixer and FX re-applied
  assert.ok(webLog.includes('setCrossfader 0.25'));
  assert.ok(webLog.includes('setMasterVolume 0.7'));
  assert.ok(webLog.includes('fx0.setType reverb') && webLog.includes('fx0.setEnabled true'));
  assert.ok(webLog.includes('updateFxSends'));
  // identities: the same facades, now forwarding
  const web = engine._web;
  assert.equal(engine.decks[0], d0);
  assert.equal(engine.decks[1], d1);
  assert.equal(engine.ctx, ctxShim);
  assert.equal(engine.fx[0], fx0);
  assert.equal(d0.playing, true);
  assert.equal(d0.buffer, web.decks[0].buffer);
  assert.deepEqual(d0.hotCues.slice(0, 3), [5, null, 9]);
  assert.equal(fx0.type, 'reverb');
  assert.equal(web.fxAssign[0][1], true);
  assert.equal(engine.crossfader, 0.25);
  const decoded = await ctxShim.decodeAudioData(new ArrayBuffer(4));
  assert.equal(decoded.web, true, "Library's context shim now decodes with the Web engine");
  assert.equal(engine.recDest.stream, 'web-stream');
  assert.equal(s.fallbacks.length, 1);
  assert.match(s.fallbacks[0], /engine host exited/);
});

test('VST: the plugin loaded when the engine died is a suspect and is skipped by the fallback restore', async () => {
  const s = await session();
  const { engine, clock, vstLog, vh, storage } = s;
  s.om.exitCb({ code: 1 });
  await clock.advance(3000);
  assert.equal(engine.status, 'web');
  const suspects = JSON.parse(storage.getItem(SUSPECTS_KEY));
  assert.deepEqual(suspects, [{ deck: 1, path: 'C:/VST3/Crashy.vst3' }]);
  assert.ok(vstLog.includes('vst.init'));
  assert.ok(!vstLog.some((l) => /Crashy/.test(l)), 'suspect skipped');
  assert.ok(vstLog.includes('vst.load 2 C:/VST3/Good.vst3'), 'the others are restored');
  assert.ok(vstLog.includes('vst.mix 2 0.5'));
  assert.equal(vh.lastCrash, 'Crashy');
  assert.equal(vh.slots, vh._web.slots, 'the same NativeVstHost object, forwarding');
});

test('hello timeout (10 s): the UI stays usable on the mirrors meanwhile, then everything goes to the Web engine', async () => {
  const clock = new FakeClock();
  const win = makeWindow();
  const om = makeOmEngine(clock, win, { neverPorts: true });
  const t = await makeEngine(NativeEngine, { clock, win, om, noConnect: true });
  const { engine } = t;
  engine.setCrossfader(0.8);
  engine.decks[2].setVolume(0.3);
  engine.decks[2].setEq('mid', 0.5);
  assert.equal(engine.crossfader, 0.8, 'mirrors answer at once');
  assert.equal(engine.decks[2].volume, 0.3);
  const decode = engine.ctx.decodeAudioData(new ArrayBuffer(4));
  await clock.advance(9000);
  assert.equal(engine.status, 'connecting');
  await clock.advance(1500);
  assert.equal(engine.status, 'web');
  assert.match(t.fallbacks[0], /hello timeout/);
  assert.ok(t.webLog.includes('setCrossfader 0.8'));
  assert.equal(engine._web.decks[2].volume, 0.3);
  assert.equal((await decode).web, true, 'the pending decode went to the Web engine');
  assert.ok(om.calls.includes('kill'), 'the half-started host is killed');
});

test('no native module: immediate fallback, nothing killed', async () => {
  const clock = new FakeClock();
  const win = makeWindow();
  const om = makeOmEngine(clock, win, { available: false });
  const t = await makeEngine(NativeEngine, { clock, win, om });
  assert.equal(t.engine.status, 'web');
  assert.match(t.fallbacks[0], /unavailable/);
  assert.ok(!om.calls.includes('kill'));
  assert.ok(!om.calls.includes('connect'));
});

test('device.open failure -> fallback; device {stalled} -> fallback', async () => {
  const clock = new FakeClock();
  const win = makeWindow();
  const om = makeOmEngine(clock, win, { onHost: (h) => { h.deviceOpen = { ok: false, error: 'AUDCLNT_E_DEVICE_INVALIDATED' }; } });
  const t = await makeEngine(NativeEngine, { clock, win, om });
  assert.equal(t.engine.status, 'web');
  assert.match(t.fallbacks[0], /device\.open failed/);

  const t2 = await makeEngine(NativeEngine);
  t2.host.emit({ ev: 'device', reason: 'stalled', status: {} });
  await t2.clock.advance(2000);
  assert.equal(t2.engine.status, 'web');
  assert.match(t2.fallbacks[0], /stalled/);
});

test('one fallback per session: later triggers are ignored', async () => {
  const s = await session();
  s.om.exitCb({ code: 1 });
  s.host.emit({ ev: 'device', reason: 'stalled' });
  await s.clock.advance(3000);
  s.om.exitCb({ code: 2 });
  await s.clock.advance(100);
  assert.equal(s.fallbacks.length, 1);
  assert.equal(s.webLog.filter((l) => l === 'new AudioEngine').length, 1);
});

test('VST: the engine dies WHILE a plugin is loading: that plugin stays a suspect and is not loaded by the fallback', async () => {
  const vstLog = [];
  const t = await makeEngine(NativeEngine, {
    storage: { vstSlot0: JSON.stringify({ plugin: { path: 'C:/VST3/Hang.vst3', uid: 'h', name: 'Hang' }, mix: 1, state: null }) },
    VstHost: fakeVstHostClass(vstLog)
  });
  const vh = t.engine.createVstHost();
  await drive(t.clock, vh.init());
  t.host.silent = true;                         // the load never answers: the host hangs in the plugin
  const p = vh.load(0, { path: 'C:/VST3/Hang.vst3', uid: 'h', name: 'Hang' });
  await t.clock.advance(3500);                  // liveness: 3 s silence + 1 s ping
  await t.clock.advance(1500);
  assert.equal(t.engine.status, 'web');
  const r = await p;
  assert.equal(r.ok, false);
  assert.deepEqual(JSON.parse(t.storage.getItem(SUSPECTS_KEY)), [{ deck: 0, path: 'C:/VST3/Hang.vst3' }]);
  assert.ok(!vstLog.some((l) => /Hang/.test(l)), 'not reloaded on the Web engine');
  assert.equal(vh.lastCrash, 'Hang');
});

test('VST stays opt-in in native mode: vst-info "disabled" (Settings > VST3 off) = no scan, no load, no restore', async () => {
  // Found by e2e-proxy (merge with the hardening branch, owner decision 5): NativeVstHost.init()
  // never asked window.api.vstInfo(), so the engine scanned and loaded plugins with VST3 turned off.
  const calls = [];
  const api = {
    vstInfo: async () => { calls.push('vstInfo'); return { available: false, reason: 'disabled' }; },
    vstListFiles: async () => { calls.push('vstListFiles'); return ['C:/VST3/Good.vst3']; }
  };
  const t = await makeEngine(NativeEngine, { api, storage: { vstSlot0: JSON.stringify({ plugin: { path: 'C:/VST3/Good.vst3', uid: 'g', name: 'Good' }, mix: 1 }) } });
  const vh = t.engine.createVstHost();
  assert.equal(await drive(t.clock, vh.init()), false);
  assert.equal(vh.available, false);
  assert.equal(vh.error, 'disabled');
  assert.deepEqual(await drive(t.clock, vh.scan()), []);
  await drive(t.clock, vh.restore());
  assert.ok(!calls.includes('vstListFiles'), 'no plugin file listed or scanned');
  assert.equal(t.host.cmds('vst.load').length, 0, 'nothing loaded in the engine');
  // any other reason (e.g. the old Web-engine host module not built) leaves the native host available
  const t2 = await makeEngine(NativeEngine, { api: { vstInfo: async () => ({ available: false, reason: 'native host not built (npm run build:vst)' }) } });
  const vh2 = t2.engine.createVstHost();
  assert.equal(await drive(t2.clock, vh2.init()), true);
});

test('VST underruns(): the vst.late events counted by the proxy when the snapshot has no insert counter', async () => {
  // before the first snapshot that reports the plugin (or an engine that leaves insert at {state:0, late:0})
  const t = await makeEngine(NativeEngine);
  const vh = t.engine.createVstHost();
  await drive(t.clock, vh.init());
  assert.equal((await drive(t.clock, vh.load(1, { path: 'C:/VST3/Slow.vst3', uid: 's', name: 'Slow' }))).ok, true);
  t.host.emit({ ev: 'vst.late', deck: 1, count: 3 });
  t.host.emit({ ev: 'vst.late', deck: 1, count: 2 });
  t.host.state();
  await t.clock.advance(5);
  assert.equal(vh.underruns(1), 5);
  assert.equal(vh.underruns(0), 0);
});

test('VST underruns(): the snapshot insert counter once it reports the plugin (SPEC 15.5)', async () => {
  // integration (7 Nov): the core fills state.decks[i].insert {state, late} every block from VstHost::insertState()
  const t = await makeEngine(NativeEngine);
  const vh = t.engine.createVstHost();
  await drive(t.clock, vh.init());
  assert.equal((await drive(t.clock, vh.load(1, { path: 'C:/VST3/Slow.vst3', uid: 's', name: 'Slow' }))).ok, true);
  t.host.emit({ ev: 'vst.late', deck: 1, count: 2 });   // events come at most once per second: they undercount
  t.host.decks[1].insert = { state: 3, late: 42 };      // OM_INSERT_LATE, 42 late blocks
  t.host.state();
  await t.clock.advance(5);
  assert.equal(vh.underruns(1), 42);
  t.host.decks[1].insert = { state: 2, late: 42 };      // bypassed: the counter stays
  t.host.state();
  await t.clock.advance(5);
  assert.equal(vh.underruns(1), 42);
  assert.equal(vh.underruns(0), 0);
});

test('PCM memory limit (review round, process / IPC #6): a track refused "memory" is reloaded once, then the fallback carries code "memory" for a translated reason; stems / sampler sounds refused tell app.js once', async () => {
  const t = await makeEngine(NativeEngine);
  t.host.beginReply = { ok: false, error: 'memory' };
  // a sampler sound refused: one 'pcm-memory' event, not repeated within 10 s
  t.engine.preloadSample(buf(0.5));
  await t.clock.advance(5);
  t.engine.preloadSample(buf(0.4));
  await t.clock.advance(5);
  assert.deepEqual(t.events.filter((e) => e.type === 'pcm-memory').map((e) => e.kind), ['sample']);
  assert.ok(t.log.lines.some((l) => /PCM memory limit reached: sample refused \(\d+ MB held by the engine\)/.test(l)));
  assert.equal(t.engine.status, 'native', 'a refused sampler sound is no reason to fall back');
  // a track refused: reloaded once (a new pcm.begin), refused again: fallback with the code
  const begins0 = t.host.cmds('pcm.begin').filter((c) => c.kind === 'track').length;
  t.engine.decks[0].loadTrack({ buffer: buf(30), bpm: 120, track: { name: 'big' } });
  await drive(t.clock, t.engine.whenSettled);
  await t.clock.advance(3000);
  assert.equal(t.host.cmds('pcm.begin').filter((c) => c.kind === 'track').length - begins0, 2, 'sent, then reloaded once');
  assert.equal(t.engine.status, 'web');
  assert.equal(t.engine.fallbackCode, 'memory');
  assert.equal(t.fallbacks.length, 1);
  assert.deepEqual(t.fallbackCodes, ['memory'], 'onFallback(reason, code)');
});
