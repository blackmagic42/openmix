// Protocol compatibility with the REAL engine parser (owner: jsproxy, native/engine/SPEC.md §15):
// a scripted session makes the facade emit every command it can send (connect
// resync, loads with grids, stems, sampler, transport, loops, rolls, scratch,
// spin, strip, master, Color FX, FX units / pads / master FX / assignment,
// sync, grid, VST, recording, devices, clock) and every ctl message is fed to
// om_proto_check (test/native-engine/protocheck: the engine's protocol.cpp +
// json.cpp). An invalid field makes the engine refuse the WHOLE batch, so this
// guards the integration. Runs when OM_PROTO_CHECK points to the built
// validator; otherwise only the coverage of the session is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { NativeEngine } from '../../src/js/native-engine.js';
import { makeEngine, FakeAudioBuffer, drive } from './helpers.mjs';

const buf = (sec, ch = 2) => new FakeAudioBuffer({ length: Math.round(sec * 48000), sampleRate: 48000, channels: ch });

async function session() {
  const t = await makeEngine(NativeEngine, {
    devices: [{ kind: 'audiooutput', deviceId: 'h1', label: 'Speakers (USB)' }, { kind: 'audiooutput', deviceId: 'h2', label: 'DDJ-FLX6' }],
    storage: { vstSlot0: JSON.stringify({ plugin: { path: 'C:/VST3/A.vst3', uid: 'a', name: 'A' }, mix: 0.5, state: 'QUJD' }) }
  });
  const { engine, host, clock } = t;
  const [a, b] = engine.decks;
  const beats = Array.from({ length: 300 }, (_, k) => 0.12 + k * 0.4688);
  a.loadTrack({ buffer: buf(150), bpm: 128, beatOffset: 0.12, beats, gridShift: 0.003, barAnchor: 2, track: { name: 'a', path: 'C:/m/a.flac', bitsPerSample: 24 },
    peaks: { top: Float32Array.from([0.9]), bottom: Float32Array.from([-1.2]) }, hotCues: [1, null, 3] });
  b.loadTrack({ buffer: buf(150, 1), bpm: null, beatOffset: null, track: { name: 'b' } });
  await clock.advance(30);
  host.state();
  await clock.advance(1);
  // strip, master, color
  a.setVolume(0.7); a.setTrim(-0.2); a.setEq('low', -1); a.setEq('mid', 0.3); a.setEq('high', 0.1);
  engine.setDeckColor(0, 0.5); engine.setCuePfl(1, true); engine.setMasterVolume(0.8); engine.setMasterFilter(-0.4);
  engine.setCrossfader(0.3); engine.setColorType('crushecho'); engine.setColorEnabled(false); engine.setColorType('noise');
  // transport, key, loops, rolls, scratch, spin
  a.seek(12.5); a.play(); a.setTempo(1.03); a.setKey(-3); a.setKeylock(true); a.cuePoint = 4;
  a.setLoop(10, 12); a._loopBeats = 4; a.exitLoop(); a._loopBeats = null;
  a.startRoll(0.5, 1); a.setRollMix(0.5); a.stopRoll(true); a._padRoll = { beats: 0.25, mix: 1 }; a._padRoll = null;
  a._padDryHold = 0.2; a._padDryHold = null;
  a.pause(); a.scrubStart(); a.scrubMove(20); a.scrubEnd(); b.scrubMove(3); a.spinSound('vbrake'); a.stopSpinSound(); a.spinSound('backspin');
  a.cue(); a.togglePlay();
  // grid edits
  a.gridShift = 0.004; a.barAnchor = 3; a.bpm = 128.2; a.beats = beats.map((x) => x + 0.001); b.bpm = 140; b.beatOffset = 0;
  // FX units, assignment, pads, master FX
  const u = engine.fx[2];
  u.setType('pingpong'); u.setEnabled(true); u.setLevel(0.6); u.setBeatsMult(0.75);
  engine.fxAssign[2][0] = true; engine.updateFxSends();
  engine.setPadFx(1, { type: 'mtdelay', beats: 0.5, level: 0.75 }); engine.setPadFx(1, null);
  const m = engine.ensureMasterFx(); m.setType('roll'); m.setEnabled(true); m.setLevel(0.9); m.setBeatsMult(0.25);
  // sync
  engine.masterIdx = 0; engine.setMaster(0); engine.jogHold = true; engine.jogHold = false;
  b.bpm = 126; b.synced = true; b._syncBase = 1.01; b._syncRef = null; b._pllCorr = 0.0005;
  engine.sync(1); engine.snapToRef(1, 0.06); engine.reanchorSync(1);
  // engine settings (owner decisions of 2026-11-09)
  engine.setKeylockPrecision(true); engine.setKeylockPrecision(false);
  // stems, sampler
  a.stems = { vocals: buf(150), drums: buf(150), bass: buf(150), other: null };
  a.loadStems(a.stems); a.stemGains.vocals.gain.setTargetAtTime(0, 0, 0.01); a.stemGains.other.gain.value = 0.5;
  const s = buf(0.5);
  engine.preloadSample(s);
  const g = engine.ctx.createGain(); g.connect(engine.postBus);
  const src = engine.ctx.createBufferSource(); src.buffer = s; src.connect(g); src.start(); src.stop();
  engine.syncLock();
  await clock.advance(30);
  // devices, recording, VST, a new track on a loaded deck (abort)
  await drive(clock, engine.ctx.setSinkId('h1'));
  await drive(clock, engine.setPhonesDevice('h2'));
  await drive(clock, engine.setPhonesDevice(''));
  await drive(clock, engine.startRecording({ name: 'OpenMix 2026-10-20 21h00' }));
  await drive(clock, engine.stopRecording());
  const vh = engine.createVstHost();
  await drive(clock, vh.init());
  await drive(clock, vh.restore());
  vh.setMix(0, 0.25);
  await drive(clock, vh.openEditor(0));
  await drive(clock, vh.status(0));
  await drive(clock, vh.save(0));
  await drive(clock, vh.unload(0));
  host.ackChunks = false;
  b.loadTrack({ buffer: buf(300), bpm: 120, beatOffset: 0, track: { name: 'c' } });
  await clock.advance(5);
  b.loadTrack({ buffer: buf(300), bpm: 121, beatOffset: 0, track: { name: 'd' } });
  await clock.advance(30);
  return t;
}

const EXPECTED = ['hello', 'clock.ping', 'device.open', 'device.phones', 'master.volume', 'master.filter', 'xf.set', 'xf.sides',
  'color.type', 'color.enabled', 'deck.color', 'deck.pfl', 'deck.volume', 'deck.trim', 'deck.eq', 'deck.padDryHold',
  'fx.set', 'fx.assign', 'fx.sends', 'fx.pad', 'sampler.play', 'sampler.stop', 'vst.mix', 'deck.play', 'deck.pause',
  'deck.seek', 'deck.cuePoint', 'deck.tempo', 'deck.key', 'deck.keylock', 'deck.loop', 'deck.loopExit', 'deck.loopBeats',
  'deck.roll', 'deck.rollMix', 'deck.rollStop', 'deck.padRoll', 'deck.scratch', 'deck.spin', 'deck.stemsOn', 'deck.stemGain',
  'grid.offset', 'sync.master', 'sync.jogHold', 'sync.do', 'sync.snap', 'sync.reanchor', 'sync.arm', 'sync.base',
  'keylock.precision',
  'pcm.begin', 'pcm.abort', 'deck.load', 'deck.stems', 'deck.grid', 'sampler.load', 'rec.start', 'rec.stop', 'rec.list',
  'vst.load', 'vst.unload', 'vst.editor', 'vst.getState', 'vst.status'];

test('the session covers every command the facade can send', async () => {
  const t = await session();
  const sent = new Set(t.host.commands.map((c) => c.cmd));
  for (const c of EXPECTED) assert.ok(sent.has(c), `not exercised: ${c}`);
});

const checker = process.env.OM_PROTO_CHECK;
test('every ctl message is accepted by the engine parser (om_proto_check)', { skip: !checker || !existsSync(checker) ? 'OM_PROTO_CHECK not set' : false }, async () => {
  const t = await session();
  const input = `${t.host.batches.join('\n')}\n`;
  const r = spawnSync(checker, [], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, t.host.batches.length);
  const refused = lines.map((l, i) => [l, i]).filter(([l]) => !l.startsWith('OK'));
  assert.deepEqual(refused.map(([l, i]) => `${l} <- ${t.host.batches[i].slice(0, 200)}`), []);
  assert.equal(r.status, 0);
  const n = lines.reduce((acc, l) => acc + Number(l.split(' ')[1] || 0), 0);
  console.log(`[protocol] ${lines.length} messages, ${n} commands, all accepted by the engine parser`);
});
