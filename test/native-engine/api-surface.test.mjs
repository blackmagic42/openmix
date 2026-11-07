// API surface of the native facade (owner: jsproxy, native/engine/SPEC.md §16, §17.2): every
// engine.js member app.js, waveform.js, library.js, key.js and vst.js touch
// exists on NativeEngine / NativeDeck / NativeFxUnit / the context shim (a
// static scan of the sources, so a new use in app.js cannot be missed), and
// each row of the §16 tables sends its command and answers synchronously.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeEngine, NativeDeck, NativeFxUnit, createAudioEngine } from '../../src/js/native-engine.js';
import { makeEngine, FakeAudioBuffer, drive } from './helpers.mjs';

const src = (f) => readFileSync(new URL(`../../src/js/${f}`, import.meta.url), 'utf8');
const UI = ['app.js', 'waveform.js', 'library.js', 'key.js', 'vst.js', 'midi.js', 'gamepad.js'];
const uniq = (a) => [...new Set(a)];
const buf = (sec) => new FakeAudioBuffer({ length: Math.round(sec * 48000), sampleRate: 48000 });

test('static scan: every engine.X used by the UI exists on NativeEngine', async () => {
  const { engine } = await makeEngine(NativeEngine);
  const names = uniq(UI.flatMap((f) => [...src(f).matchAll(/\bengine\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])))
    .filter((n) => n !== 'js');    // "engine.js" in comments / imports
  assert.ok(names.length > 40);
  for (const n of names) assert.ok(n in engine, `engine.${n}`);
});

test('static scan: every engine.ctx.X exists on the context shim', async () => {
  const { engine } = await makeEngine(NativeEngine);
  const names = uniq(UI.flatMap((f) => [...src(f).matchAll(/\bengine\.ctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])));
  for (const n of names) assert.ok(n in engine.ctx, `engine.ctx.${n}`);
  // Library keeps engine.ctx and calls decodeAudioData on it
  assert.match(src('library.js'), /this\.audioCtx\.decodeAudioData/);
});

test('static scan: every deck member the UI touches exists on NativeDeck', async () => {
  const { engine } = await makeEngine(NativeEngine);
  const d = engine.decks[0];
  const expandos = new Set(['tempoRange', '_loopInPoint']);   // app.js's own fields on the deck object
  const fromApp = [
    ...[...src('app.js').matchAll(/engine\.decks\[[^\]]+\]\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...src('app.js').matchAll(/\bdeck\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...src('waveform.js').matchAll(/\bdeck\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...src('key.js').matchAll(/\bdeck\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  ];
  // the other local names app.js gives decks (d, dk, td, m, mstr), restricted to engine.js Deck members
  const deckMembers = new Set([...Object.getOwnPropertyNames(NativeDeck.prototype), ...Object.keys(d)]);
  for (const n of uniq(fromApp)) {
    if (expandos.has(n)) continue;
    assert.ok(n in d, `deck.${n}`);
  }
  for (const n of ['id', 'buffer', 'duration', 'track', 'peaks', 'musicKey', 'hotCues', 'onEnded', 'bpm', 'beatOffset',
    'beats', 'gridShift', 'barAnchor', 'effectiveBpm', 'loadTrack', 'play', 'pause', 'togglePlay', 'playing', 'currentTime',
    'seek', 'cue', 'cuePoint', 'setTempo', 'tempo', 'setLoop', 'exitLoop', 'looping', 'loopStart', 'loopEnd', '_loopBeats',
    'keyShift', 'setKey', 'keylock', 'setKeylock', 'synced', '_syncBase', '_syncRef', '_pllCorr', '_padRoll', '_padDryHold',
    'startRoll', 'stopRoll', 'stems', 'stemsOn', 'loadStems', 'stemGains', 'scrubStart', 'scrubMove', 'scrubEnd',
    'spinSound', 'stopSpinSound', 'setVolume', 'volume', 'setEq', 'eq', 'setTrim', 'trimVal', 'filterVal', 'cueOn',
    'meterPeak', 'setInsert']) {
    assert.ok(n in d, `§16.2 deck.${n}`);
  }
  assert.ok(deckMembers.size > 50);
});

test('§16.3 FxUnit members', async () => {
  const { engine, host, clock } = await makeEngine(NativeEngine);
  const u = engine.fx[1];
  assert.ok(u instanceof NativeFxUnit);
  u.setType('flanger');
  u.setEnabled(true);
  u.setLevel(1.7);
  u.setBeatsMult(2);
  u.setBeatDur(0.47);
  await clock.advance(1);
  assert.deepEqual([u.type, u.enabled, u.level, u.beatsMult, u.beatDur], ['flanger', true, 1, 2, 0.47]);
  const sets = host.cmds('fx.set').filter((c) => c.unit === 'fx1' && Object.keys(c).length <= 5);
  assert.deepEqual(sets.slice(-4).map((c) => Object.keys(c).filter((k) => !['cmd', 'unit', 'seq', 'at'].includes(k))[0]),
    ['type', 'enabled', 'level', 'beats']);
  assert.equal(host.cmds('fx.set').filter((c) => c.beatDur != null).length, 0, 'setBeatDur sends nothing (engine beat clocks)');
  u.setLevel(1);
  await clock.advance(1);
  assert.equal(host.cmds('fx.set').filter((c) => c.unit === 'fx1' && c.level != null).length, 2, 'not resent when unchanged');
});

test('§16.1 AudioEngine rows: commands and synchronous answers', async () => {
  const t = await makeEngine(NativeEngine);
  const { engine, host, clock } = t;
  const sent = (name) => host.cmds(name);
  // mixer
  engine.setMasterVolume(0.5);
  engine.setMasterFilter(-0.3);
  engine.setCrossfader(0.75);
  engine.setCuePfl(2, true);
  engine.setDeckColor(1, -0.6);
  engine.setColorType('dubecho');
  engine.setColorEnabled(false);
  assert.deepEqual([engine.masterVolume, engine.masterFilterVal, engine.crossfader, engine.decks[2].cueOn,
    engine.decks[1].filterVal, engine.colorType, engine.colorEnabled], [0.5, -0.3, 0.75, true, -0.6, 'dubecho', false]);
  // master FX, pad FX
  assert.equal(engine.masterFx, null);
  const m = engine.ensureMasterFx();
  assert.equal(engine.masterFx, m);
  assert.equal(engine.ensureMasterFx(), m, 'created once');
  assert.equal(engine.padFx[3], null);
  engine.setPadFx(3, { type: 'echo', beats: 0.5, level: 0.8 });
  assert.ok(engine.padFx[3] instanceof NativeFxUnit);
  assert.deepEqual([engine.padFx[3].type, engine.padFx[3].enabled, engine.padFx[3].level], ['echo', true, 0.8]);
  engine.setPadFx(3, null);
  assert.equal(engine.padFx[3].enabled, false);
  // master / jog
  engine.setMaster(2);
  assert.equal(engine.masterIdx, 2);
  engine.setMaster(2);
  assert.equal(engine.masterIdx, null, 'toggle');
  engine.masterIdx = 1;
  engine.jogHold = true;
  assert.equal(engine.jogHold, true);
  await clock.advance(1);
  assert.equal(sent('master.volume').at(-1).v, 0.5);
  assert.equal(sent('master.filter').at(-1).v, -0.3);
  assert.equal(sent('xf.set').at(-1).x, 0.75);
  assert.deepEqual([sent('deck.pfl').at(-1).deck, sent('deck.pfl').at(-1).on], [2, true]);
  assert.deepEqual([sent('deck.color').at(-1).deck, sent('deck.color').at(-1).v], [1, -0.6]);
  assert.equal(sent('color.type').at(-1).type, 'dubecho');
  assert.equal(sent('color.enabled').at(-1).on, false);
  assert.ok(sent('fx.set').some((c) => c.unit === 'master' && Object.keys(c).length === 4), 'fx.set {unit:"master"} = ensure');
  assert.deepEqual(sent('fx.pad').map((c) => c.preset && c.preset.type), ['echo', null]);
  assert.deepEqual(sent('sync.master').map((c) => c.deck), [2, null, 1]);
  assert.equal(sent('sync.jogHold').at(-1).on, true);
  // context shim and the rest
  assert.equal(engine.ctx.sampleRate, 48000);
  assert.ok(Math.abs(engine.ctx.currentTime - engine.engineNow()) < 1e-9, 'ctx.currentTime = engine clock');
  assert.equal(engine.ctx.state, 'running');
  assert.equal(engine.resume(), undefined);
  assert.equal(engine._wireOutput(), undefined, '_wireOutput is a no-op');
  assert.equal(engine.recDest, null, 'no MediaStream: REC goes through rec.start');
  assert.ok(engine.postBus);
  assert.equal(engine.masterPeak(), 0);
  assert.equal(engine.phonesOk, false);
  assert.equal(engine.isNative, true);
  assert.equal(engine.status, 'native');
  assert.equal(typeof engine.createVstHost().init, 'function');
  assert.equal(typeof engine.preloadSample, 'function');
  assert.equal(typeof engine.shadowStats().count, 'number');
  // snapshot-backed answers
  host.state({ mixer: { masterPeak: 0.42 }, device: { mode: 3, rate: 48000, channels: 4, period: 240, latency: 0.02, cueRouted: true } });
  await clock.advance(1);
  assert.ok(Math.abs(engine.masterPeak() - 0.42) < 1e-9);
  assert.equal(engine.phonesOk, true);
  const info = engine.nativeInfo();
  assert.equal(info.period, 240);
  assert.equal(info.mode, 'lowlatency');
});

test('§16.1 sync rows: sync(i) predicts on the mirrors, sync.do executes; snapToRef / reanchorSync / getMasterDeck', async () => {
  const t = await makeEngine(NativeEngine);
  const { engine, host, clock } = t;
  const [a, b] = engine.decks;
  a.loadTrack({ buffer: buf(300), bpm: 120, beatOffset: 0, track: { name: 'a' } });
  b.loadTrack({ buffer: buf(300), bpm: 125, beatOffset: 0.1, track: { name: 'b' } });
  await clock.advance(5);
  host.state();
  await clock.advance(1);
  a.seek(60);
  a.play();
  b.seek(90);
  await clock.advance(1);
  host.seek(0, 60);
  host.play(0);
  host.seek(1, 90);
  host.state();
  await clock.advance(200);
  assert.equal(engine.getMasterDeck(1), a);
  assert.equal(engine.sync(1), true);
  assert.ok(Math.abs(b.tempo - 120 / 125) < 1e-9, 'predicted tempo = _syncRatio on the mirrors');
  assert.equal(b.synced, true);
  assert.equal(b._syncBase, b.tempo);
  // bar alignment predicted: same phase in the bar as the master
  assert.ok(Math.abs(engine._barPhase(a) - engine._barPhase(b)) < 1e-6 || Math.abs(Math.abs(engine._barPhase(a) - engine._barPhase(b)) - 1) < 1e-6);
  await clock.advance(1);
  assert.equal(host.cmds('sync.do').at(-1).deck, 1);
  assert.equal(engine.sync(3), false, 'no BPM: false, nothing sent');
  engine.reanchorSync(1);
  assert.equal(typeof engine.snapToRef(1), 'boolean');
  await clock.advance(1);
  assert.equal(host.cmds('sync.reanchor').at(-1).deck, 1);
  assert.equal(host.cmds('sync.snap').at(-1).maxErr, 0.06);
  assert.equal(host.cmds('sync.do').length, 1);
  assert.ok(engine._localPeriod(a) > 0.49 && engine._localPeriod(a) < 0.51);
  assert.equal(typeof engine._beatPhase(a), 'number');
  assert.equal(engine.fxRefDeck(0), a);
});

test('§16.2 deck rows: grid setters coalesce into ONE deck.grid per task (beats only when the array changed)', async () => {
  const t = await makeEngine(NativeEngine);
  const { engine, host, clock } = t;
  const d = engine.decks[0];
  const beats = Array.from({ length: 100 }, (_, k) => k * 0.5);
  d.loadTrack({ buffer: buf(60), bpm: 120, beatOffset: 0, beats, track: {} });
  await clock.advance(1);
  assert.deepEqual(host.cmds('deck.load')[0].grid.beats.length, 100);
  d.gridShift += 0.002;
  d.barAnchor = 4;
  d.bpm = 120.5;
  await clock.advance(1);
  const g = host.cmds('deck.grid');
  assert.equal(g.length, 1, 'coalesced');
  assert.deepEqual([g[0].gridShift, g[0].barAnchor, g[0].bpm], [0.002, 4, 120.5]);
  assert.equal('beats' in g[0], false, 'beats unchanged: omitted');
  d.beats = beats.map((x) => x + 0.01);
  d.synced = false;
  d._syncBase = null;
  d._pllCorr = 0;
  await clock.advance(1);
  const g2 = host.cmds('deck.grid');
  assert.equal(g2.length, 2);
  assert.equal(g2[1].beats.length, 100, 'new array identity: sent');
  assert.equal(host.cmds('sync.arm').at(-1).on, false);
  assert.ok(host.cmds('sync.base').some((c) => c.base === null));
  assert.equal(d.effectiveBpm, 120.5);
});

test('§16.2 deck rows: transport, cue, loops, key, rolls, scratch, spin, strip, meters', async () => {
  const t = await makeEngine(NativeEngine);
  const { engine, host, clock } = t;
  const d = engine.decks[1];
  assert.equal(d.id, 1);
  assert.equal(d.currentTime(), 0);
  d.loadTrack({ buffer: buf(100), bpm: 120, beatOffset: 0, track: { name: 'x' }, hotCues: [3, null, 7, 9, 1, 2, 4, 5, 6] });
  assert.equal(d.duration, 100);
  assert.deepEqual(d.hotCues, [3, null, 7, 9, 1, 2, 4, 5]);
  d.hotCues[1] = 12;                        // mutated in place by app.js
  assert.equal(d.hotCues[1], 12);
  await clock.advance(1);
  host.state();
  await clock.advance(1);
  // cue(): paused away from the cue point -> sets it
  d.seek(10);
  d.cue();
  assert.equal(d.cuePoint, 10);
  // cue(): at the cue point -> re-seek; playing -> pause + back to the cue
  d.seek(20);
  d.play();
  d.cue();
  assert.equal(d.playing, false);
  assert.equal(d.currentTime(), 10);
  d.togglePlay();
  assert.equal(d.playing, true);
  d.togglePlay();
  // tempo, key, keylock
  d.setTempo(2);
  assert.equal(d.tempo, 1.6, 'clamped');
  d.setKey(9.4);
  assert.equal(d.keyShift, 7, 'rounded, clamped');
  d.setKeylock(1);
  assert.equal(d.keylock, true);
  // loops
  d.setLoop(4, 4.005);
  assert.equal(d.looping, false, 'shorter than 10 ms: ignored');
  d.setLoop(4, 8);
  d._loopBeats = 8;
  assert.deepEqual([d.looping, d.loopStart, d.loopEnd, d._loopBeats], [true, 4, 8, 8]);
  d.seek(50);
  assert.equal(d.looping, false, 'seek out of the loop disables it');
  assert.equal(d._loopBeats, null);
  // roll (engine.js preconditions: playing with a grid)
  assert.equal(d.startRoll(0.5), false, 'not playing');
  d.play();
  assert.equal(d.startRoll(0.5, 1), true);
  assert.equal(d.startRoll(0.5, 0.5), true, 'same slice: mix only');
  d.stopRoll();
  d._padRoll = { beats: 0.25, mix: 1 };
  d._padRoll = null;
  d._padDryHold = 0.2;
  // scratch
  d.pause();
  d.scrubStart();
  d.scrubMove(30);
  assert.equal(d.currentTime(), 30, 'position = t at once');
  d.scrubEnd();
  d.scrubMove(31);                          // without scrubStart: engine.js "offset = t" -> deck.seek
  assert.equal(d.currentTime(), 31);
  // spin
  d.spinSound('backspin');
  d.stopSpinSound();
  // strip
  d.setVolume(1.4);
  d.setEq('low', -2);
  d.setTrim(0.25);
  assert.deepEqual([d.volume, d.eq.low, d.trimVal], [1, -1, 0.25]);
  assert.equal(d.toggleBassKill(), true);
  d.setInsert({}, 0.01);                    // VST lives in the engine: warning only
  await clock.advance(1);
  const has = (cmd, pred = () => true) => host.cmds(cmd).some(pred);
  assert.ok(has('deck.cuePoint', (c) => c.t === 10));
  assert.ok(has('deck.play') && has('deck.pause'));
  assert.ok(has('deck.seek', (c) => c.t === 20 && typeof c.at === 'number'));
  assert.ok(has('deck.tempo', (c) => c.r === 1.6));
  assert.ok(has('deck.key', (c) => c.semi === 7));
  assert.ok(has('deck.keylock', (c) => c.on === true));
  assert.ok(has('deck.loop', (c) => c.start === 4 && c.end === 8));
  assert.ok(has('deck.loopBeats', (c) => c.beats === 8));
  assert.ok(has('deck.roll', (c) => c.beats === 0.5 && c.mix === 1));
  assert.ok(has('deck.rollMix', (c) => c.mix === 0.5));
  assert.ok(has('deck.rollStop'));
  assert.deepEqual(host.cmds('deck.padRoll').map((c) => c.beats), [0.25, null]);
  assert.ok(has('deck.padDryHold', (c) => c.dry === 0.2));
  assert.deepEqual(host.cmds('deck.scratch').map((c) => c.phase), ['start', 'move', 'end']);
  assert.ok(has('deck.seek', (c) => c.t === 31));
  assert.deepEqual(host.cmds('deck.spin').map((c) => c.kind), ['backspin', 'none']);
  assert.ok(has('deck.volume', (c) => c.v === 1));
  assert.ok(has('deck.eq', (c) => c.band === 'low' && c.v === -1));
  assert.ok(has('deck.trim', (c) => c.v === 0.25));
  assert.ok(t.log.lines.some((l) => /setInsert\(\) ignored/.test(l)));
  // meters
  host.decks[1].peak = 0.9;
  host.state();
  await clock.advance(1);
  assert.ok(Math.abs(d.meterPeak() - 0.9) < 1e-9);
});

test('createAudioEngine: "web" (default) builds engine.js exactly as before; "native" a NativeEngine', async () => {
  const { makeStorage, makeFakeWebEngineClass } = await import('./helpers.mjs');
  const { safeStorage } = await import('../../src/js/native-engine/env.js');
  const Base = makeFakeWebEngineClass([]);
  class Web extends Base { constructor() { super(); this.kind = 'web'; } }
  const web = createAudioEngine({ env: { storage: safeStorage(makeStorage()), AudioEngine: Web, omEngine: null, win: null } });
  assert.equal(web.kind, 'web');
  const web2 = createAudioEngine({ env: { storage: safeStorage(makeStorage({ audioEngine: 'web' })), AudioEngine: Web, omEngine: null, win: null } });
  assert.ok(web2 instanceof Web);
  const nat = createAudioEngine({ env: { storage: safeStorage(makeStorage({ audioEngine: 'native-exclusive' })), AudioEngine: Web, omEngine: null, win: null, log: { warn() {}, log() {}, error() {} } } });
  assert.ok(nat instanceof NativeEngine);
  assert.equal(nat.mode, 'exclusive');
  await drive({ advance: async () => { await new Promise((r) => setTimeout(r, 1)); } }, nat.whenSettled, 200);
  assert.equal(nat.status, 'web', 'no bridge: Web engine');
  assert.ok(nat._web instanceof Web);
});
