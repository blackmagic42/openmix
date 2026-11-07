// Tests of the output device mapping (owner: jsproxy, native/engine/SPEC.md §8.1, §17.5):
// Chromium pseudo-ids -> roles, "Default - " / "Communications - " prefixes
// stripped, duplicates told apart by nameIndex, the stored label used when
// labels are empty, and the saved device opened ONCE at connect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeOutputDevice, stripDevicePrefix, deviceFields, MASTER_DEVICE_KEY } from '../../src/js/native-engine/devices.js';
import { NativeEngine, rememberOutputDevices } from '../../src/js/native-engine.js';
import { makeEngine, drive, makeStorage } from './helpers.mjs';
import { safeStorage } from '../../src/js/native-engine/env.js';

const out = (deviceId, label) => ({ kind: 'audiooutput', deviceId, label, groupId: 'g' });
const LIST = [
  out('default', 'Default - Speakers (Realtek(R) Audio)'),
  out('communications', 'Communications - Headset (USB)'),
  out('h1', 'Speakers (Realtek(R) Audio)'),
  out('h2', 'Speakers (USB Audio Device)'),
  out('h3', 'Headset (USB)'),
  out('h4', 'Speakers (USB Audio Device)'),
  { kind: 'audioinput', deviceId: 'm1', label: 'Mic' }
];

test('pseudo-ids become roles that follow the Windows default', () => {
  assert.deepEqual(describeOutputDevice('', LIST), { id: '', role: 'console', followDefault: true });
  assert.deepEqual(describeOutputDevice('default', LIST), { id: 'default', role: 'console', followDefault: true });
  assert.deepEqual(describeOutputDevice('communications', LIST), { id: 'communications', role: 'communications', followDefault: true });
  assert.deepEqual(deviceFields(describeOutputDevice('default', LIST)), { role: 'console', followDefault: true });
});

test('prefixes are stripped', () => {
  assert.equal(stripDevicePrefix('Default - Speakers (Realtek(R) Audio)'), 'Speakers (Realtek(R) Audio)');
  assert.equal(stripDevicePrefix('Communications - Headset (USB)'), 'Headset (USB)');
  assert.equal(stripDevicePrefix('DDJ-FLX6'), 'DDJ-FLX6');
});

test('identical names are told apart by nameIndex (rank in Chromium order, pseudo-devices excluded)', () => {
  assert.deepEqual(describeOutputDevice('h2', LIST), { id: 'h2', name: 'Speakers (USB Audio Device)', nameIndex: 0 });
  assert.deepEqual(describeOutputDevice('h4', LIST), { id: 'h4', name: 'Speakers (USB Audio Device)', nameIndex: 1 });
  assert.deepEqual(describeOutputDevice('h1', LIST), { id: 'h1', name: 'Speakers (Realtek(R) Audio)', nameIndex: 0 });
  assert.deepEqual(deviceFields(describeOutputDevice('h4', LIST)), { name: 'Speakers (USB Audio Device)', nameIndex: 1 });
});

test('empty labels (no media permission yet): the stored descriptor of that id is used, else null', () => {
  const blank = LIST.map((d) => ({ ...d, label: '' }));
  const stored = { id: 'h4', name: 'Speakers (USB Audio Device)', nameIndex: 1 };
  assert.deepEqual(describeOutputDevice('h4', blank, stored), stored);
  assert.equal(describeOutputDevice('h2', blank, stored), null, 'another id: unknown');
  assert.equal(describeOutputDevice('zz', LIST, null), null, 'unplugged device');
});

test('connect opens the SAVED device once, by name + nameIndex; the startup setSinkId does not open it again', async () => {
  const t = await makeEngine(NativeEngine, { storage: { audioOutput: 'h4' }, devices: LIST, noConnect: true, mode: 'lowlatency' });
  // app.js's startup restore runs before the engine is connected
  const p = t.engine.ctx.setSinkId('h4');
  await t.clock.advance(50);
  await p;
  const host = t.om.host;
  const opens = host.cmds('device.open');
  assert.equal(opens.length, 1, 'one open');
  assert.equal(opens[0].name, 'Speakers (USB Audio Device)');
  assert.equal(opens[0].nameIndex, 1);
  assert.equal(opens[0].mode, 'lowlatency');
  // the descriptor is stored next to audioOutput (labels were known)
  assert.deepEqual(JSON.parse(t.storage.getItem(MASTER_DEVICE_KEY)), { id: 'h4', name: 'Speakers (USB Audio Device)', nameIndex: 1 });
});

test('startup with empty labels uses the stored label; exclusive mode for native-exclusive', async () => {
  const blank = LIST.map((d) => ({ ...d, label: '' }));
  const t = await makeEngine(NativeEngine, {
    storage: { audioOutput: 'h2', [MASTER_DEVICE_KEY]: JSON.stringify({ id: 'h2', name: 'Speakers (USB Audio Device)', nameIndex: 0 }) },
    devices: blank, mode: 'exclusive'
  });
  const opens = t.host.cmds('device.open');
  assert.equal(opens.length, 1);
  assert.equal(opens[0].name, 'Speakers (USB Audio Device)');
  assert.equal(opens[0].nameIndex, 0);
  assert.equal(opens[0].mode, 'exclusive');
});

test('picking another device in Settings opens it (await reply); the phones go through device.phones', async () => {
  const t = await makeEngine(NativeEngine, { devices: LIST });
  assert.equal(t.host.cmds('device.open')[0].role, 'console', 'no saved device: the default');
  await drive(t.clock, t.engine.ctx.setSinkId('h3'));
  assert.equal(t.host.cmds('device.open').length, 2);
  assert.equal(t.host.cmds('device.open')[1].name, 'Headset (USB)');
  const ok = await drive(t.clock, t.engine.setPhonesDevice('h2'));
  assert.equal(ok, true);
  assert.equal(t.engine.phonesDevice, 'h2');
  const ph = t.host.cmds('device.phones');
  assert.deepEqual([ph[0].name, ph[0].nameIndex], ['Speakers (USB Audio Device)', 0]);
  assert.equal(await drive(t.clock, t.engine.setPhonesDevice('')), true);
  assert.equal(t.host.cmds('device.phones')[1].name, null, 'no phones card');
  await assert.rejects(drive(t.clock, t.engine.ctx.setSinkId('unplugged')), /not found/);
});

test('decodes wait for the device rate (device.open reply) and use an OfflineAudioContext at that rate', async () => {
  const t = await makeEngine(NativeEngine, { noConnect: true, omOpts: { hostOpts: { sampleRate: 44100, deviceOpenDelay: 100 } } });
  const p = t.engine.ctx.decodeAudioData(new ArrayBuffer(8));
  let done = false;
  p.then(() => { done = true; });
  await t.clock.advance(50);
  assert.equal(t.engine.status, 'connecting');
  assert.equal(done, false, 'waits for the device rate');
  await t.clock.advance(100);
  assert.equal(done, true);
  const b = await p;
  assert.equal(b.sampleRate, 44100);
  assert.deepEqual(t.offline, [44100]);
  assert.equal(t.engine.ctx.sampleRate, 44100);
});

test('switching to the native engine in Settings stores the chosen outputs by name (labels known there)', async () => {
  const raw = makeStorage({ audioOutput: 'h4', phonesOutput: 'h3' });
  const n = await rememberOutputDevices({ storage: safeStorage(raw), mediaDevices: { enumerateDevices: async () => LIST }, win: null, omEngine: null });
  assert.equal(n, 2);
  assert.deepEqual(JSON.parse(raw.getItem(MASTER_DEVICE_KEY)), { id: 'h4', name: 'Speakers (USB Audio Device)', nameIndex: 1 });
  assert.deepEqual(JSON.parse(raw.getItem('phonesOutputDevice')), { id: 'h3', name: 'Headset (USB)', nameIndex: 0 });
});

test('a saved device that cannot be named at connect: default for now, the startup setSinkId tries again', async () => {
  const blank = LIST.map((d) => ({ ...d, label: '' }));
  let devices = blank;
  const t = await makeEngine(NativeEngine, { storage: { audioOutput: 'h4' }, noConnect: true,
    mediaDevices: { enumerateDevices: async () => devices } });
  await t.clock.advance(50);
  const host = t.om.host;
  assert.equal(host.cmds('device.open')[0].role, 'console', 'default for now');
  devices = LIST;                               // labels now known (permission granted meanwhile)
  await drive(t.clock, t.engine.ctx.setSinkId('h4'));
  const opens = host.cmds('device.open');
  assert.equal(opens.length, 2, 'the startup setSinkId opened the saved device');
  assert.deepEqual([opens[1].name, opens[1].nameIndex], ['Speakers (USB Audio Device)', 1]);
});
