// Tests of the native recording flow (owner: jsproxy, native/engine/SPEC.md §14, §17.9.3, §17.9.6):
// rec.start / rec.stop, then the Save dialog through window.omEngine; a
// cancelled or failed save KEEPS the file and offers "Show in folder"; write
// errors and unsaved recordings reach app.js through onEvent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEngine, stopAndSaveRecording, revealRecording, recordingStamp } from '../../src/js/native-engine.js';
import { makeEngine, makeOmEngine, makeWindow, FakeClock, drive } from './helpers.mjs';

const PATH = 'C:/data/recordings/OpenMix 2026-10-20 21h00.wav';

test('the stamp is the engine default name format', () => {
  assert.equal(recordingStamp(new Date(2026, 9, 20, 21, 5)), '2026-10-20 21h05');
});

test('REC: rec.start (wav24) -> rec.stop -> Save dialog -> saved where the user chose', async () => {
  const t = await makeEngine(NativeEngine);
  const r = await drive(t.clock, t.engine.startRecording());
  assert.equal(r.ok, true);
  assert.equal(r.path, PATH);
  assert.equal(t.host.cmds('rec.start')[0].format, 'wav24');
  assert.equal(t.engine.recording, true);
  const res = await drive(t.clock, stopAndSaveRecording(t.engine, t.om, '2026-10-20 21h00'));
  assert.equal(res.kind, 'saved');
  assert.equal(res.path, 'D:/Mixes/OpenMix 2026-10-20 21h00.wav');
  assert.deepEqual(t.om.calls.find((c) => c[0] === 'saveRecording'), ['saveRecording', PATH, 'OpenMix 2026-10-20 21h00.wav']);
  assert.equal(t.engine.recording, false);
});

test('REC: a cancelled save keeps the file and offers "Show in folder"', async () => {
  const clock = new FakeClock();
  const win = makeWindow();
  const om = makeOmEngine(clock, win, { saveResult: { ok: false, canceled: true } });
  const t = await makeEngine(NativeEngine, { clock, win, om });
  await drive(clock, t.engine.startRecording());
  const res = await drive(clock, stopAndSaveRecording(t.engine, om));
  assert.equal(res.kind, 'kept');
  assert.equal(res.path, PATH);
  assert.equal(res.canceled, true);
  assert.equal(await revealRecording(om, res.path), true);
  assert.deepEqual(om.calls.find((c) => c[0] === 'revealFile'), ['revealFile', PATH]);
});

test('REC: a failed copy keeps the file too (never deleted)', async () => {
  const clock = new FakeClock();
  const win = makeWindow();
  const om = makeOmEngine(clock, win, { saveResult: { ok: false, error: 'disk full' } });
  const t = await makeEngine(NativeEngine, { clock, win, om });
  await drive(clock, t.engine.startRecording());
  const res = await drive(clock, stopAndSaveRecording(t.engine, om));
  assert.deepEqual([res.kind, res.path, res.error, res.canceled], ['kept', PATH, 'disk full', false]);
});

test('a write error (rec.status {active:false, error}) reaches app.js', async () => {
  const t = await makeEngine(NativeEngine);
  await drive(t.clock, t.engine.startRecording());
  t.host.emit({ ev: 'rec.status', active: false, path: PATH, error: 'disk full', seconds: 12 });
  await t.clock.advance(1);
  const ev = t.events.find((e) => e.type === 'rec.status');
  assert.equal(ev.error, 'disk full');
  assert.equal(ev.path, PATH);
  assert.equal(t.engine.recording, false);
});

test('unsaved recordings found at startup (rec.list) are offered', async () => {
  const clock = new FakeClock();
  const win = makeWindow();
  const files = [{ path: 'C:/data/recordings/OpenMix 2026-10-19 23h10.wav', bytes: 1e8, seconds: 640, repaired: true }];
  const om = makeOmEngine(clock, win, { onHost: (h) => { h.recFiles = files; } });
  const t = await makeEngine(NativeEngine, { clock, win, om });
  const ev = t.events.find((e) => e.type === 'recordings-unsaved');
  assert.deepEqual(ev.files, files);
});

test('a fallback during a recording reports the kept file; stopping then offers it', async () => {
  const t = await makeEngine(NativeEngine);
  await drive(t.clock, t.engine.startRecording());
  t.engine._onExit({ code: 1 });
  await t.clock.advance(2000);
  const ev = t.events.find((e) => e.type === 'rec.status' && e.fallback);
  assert.equal(ev.path, PATH);
  const res = await drive(t.clock, stopAndSaveRecording(t.engine, t.om));
  assert.equal(res.kind, 'saved', 'the file the engine wrote is still offered');
  assert.equal(t.om.calls.find((c) => c[0] === 'saveRecording')[1], PATH);
});

test('reconnect after a renderer reload during a recording: it is finalized at connect, then offered by rec.list', async () => {
  // Found end to end (e2e-proxy; app.js reloads the page on a language change): after hello {reset} the
  // engine kept recording silence, the new page did not know it (REC answered "already recording")
  // and rec.list offered the file still being written.
  const clock = new FakeClock();
  const win = makeWindow();
  const om = makeOmEngine(clock, win, { onHost: (h) => {
    let active = true;
    h.recFiles = [{ path: PATH, bytes: 4096, seconds: 12, repaired: false }];
    const run = h._run.bind(h);
    h._run = (c) => {
      if (c.cmd === 'rec.status') { h.reply(c, true, { active, path: PATH, seconds: 12 }); return; }
      if (c.cmd === 'rec.stop') active = false;
      run(c);
    };
  } });
  const t = await makeEngine(NativeEngine, { clock, win, om });
  await drive(clock, t.engine.whenSettled);
  await clock.advance(10);
  assert.equal(t.engine.status, 'native');
  assert.deepEqual(t.host.commands.map((c) => c.cmd).filter((c) => c === 'rec.stop' || c === 'rec.list'), ['rec.stop', 'rec.list']);
  assert.ok(t.events.some((e) => e.type === 'recordings-unsaved' && e.files[0].path === PATH));
  assert.equal(t.engine.recording, false);
  // nothing running: nothing stopped
  const t2 = await makeEngine(NativeEngine);
  await drive(t2.clock, t2.engine.whenSettled);
  assert.equal(t2.host.cmds('rec.stop').length, 0);
});

test('REC pressed while the engine falls back: startRecording resolves {ok:false} (app.js shows recording_error)', async () => {
  // e2e-proxy: app.js used to take the MediaRecorder path then, with engine.recDest still null (TypeError)
  const t = await makeEngine(NativeEngine);
  t.host.silent = true;                       // hung host: the liveness rule starts the fallback
  await t.clock.advance(4300);              // 3 s silence + 1 s ping
  const during = t.engine.status;
  const r = await drive(t.clock, t.engine.startRecording({ name: 'x' }));
  assert.ok(during === 'falling-back' || during === 'web', during);
  assert.equal(r.ok, false);
  assert.equal(t.host.cmds('rec.start').length, 0);
});
