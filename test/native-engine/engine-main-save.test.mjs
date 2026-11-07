// Tests of how engine-main.js saves a native recording (owner: host, native/engine/SPEC.md §14,
// review round of 7 Nov 2026, process / IPC #5): a rename on the same drive (instant, atomic),
// a verified copy only across drives (EXDEV) through "<dest>.part", and a copy still running at
// quit aborted with its partial file deleted (never a truncated file that looks finished).
// Plain Node: engine-main.js is required without starting Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { makeRecordingMover, shutdown } = require('../../engine-main.js');

const MIB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scratch(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'om-save-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function recording(dir, name, bytes) {
  const p = path.join(dir, name);
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) b[i] = (i * 31 + 7) & 255;
  await fsp.writeFile(p, b);
  return { p, b };
}

const exdevFor = (src) => async (a, b) => {
  if (a === src) {
    const e = new Error('EXDEV: cross-device link not permitted');
    e.code = 'EXDEV';
    throw e;
  }
  return fsp.rename(a, b);
};

test('same drive: the recording is renamed (instant), nothing copied', async (t) => {
  const dir = await scratch(t);
  const { p, b } = await recording(dir, 'OpenMix set.wav', 3 * MIB + 17);
  const dest = path.join(dir, 'saved', 'My set.wav');
  await fsp.mkdir(path.dirname(dest));
  let opened = 0;
  const mover = makeRecordingMover({ open: (f, m) => { opened++; return fsp.open(f, m); } });
  assert.equal(await mover.moveRecording(p, dest, b.length), 'renamed');
  assert.equal(opened, 0, 'no copy');
  assert.ok(!fs.existsSync(p));
  assert.ok((await fsp.readFile(dest)).equals(b));
});

test('another drive (EXDEV only): copied into "<dest>.part", verified, renamed; the original stays for the caller to delete', async (t) => {
  const dir = await scratch(t);
  const { p, b } = await recording(dir, 'OpenMix set.wav', 9 * MIB + 5);   // three 4 MiB chunks
  const dest = path.join(dir, 'Other drive set.wav');
  const mover = makeRecordingMover({ rename: exdevFor(p) });
  assert.equal(await mover.moveRecording(p, dest, b.length), 'copied');
  assert.ok((await fsp.readFile(dest)).equals(b));
  assert.ok(!fs.existsSync(`${dest}.part`));
  assert.ok(fs.existsSync(p), 'deleted by the caller only after the verified copy');
  assert.equal(mover.running(), 0);
});

test('any other rename error is not turned into a copy: the error goes back, the original is kept', async (t) => {
  const dir = await scratch(t);
  const { p, b } = await recording(dir, 'OpenMix set.wav', MIB);
  const mover = makeRecordingMover({
    rename: async () => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; }
  });
  await assert.rejects(mover.moveRecording(p, path.join(dir, 'x.wav'), b.length), /EPERM/);
  assert.ok(fs.existsSync(p));
  assert.ok(!fs.existsSync(path.join(dir, 'x.wav')) && !fs.existsSync(path.join(dir, 'x.wav.part')));
});

test('quit during a cross-drive copy: aborted between two chunks, the partial file deleted, the original kept', async (t) => {
  const dir = await scratch(t);
  const { p, b } = await recording(dir, 'OpenMix long set.wav', 16 * MIB);  // 4 chunks
  const dest = path.join(dir, 'Slow drive set.wav');
  // a slow destination drive: every read of the original takes 60 ms
  const slowOpen = async (f, m) => {
    const h = await fsp.open(f, m);
    if (f === p && m === 'r') {
      const read = h.read.bind(h);
      h.read = async (...a) => { await sleep(60); return read(...a); };
    }
    return h;
  };
  const mover = makeRecordingMover({ rename: exdevFor(p), open: slowOpen });
  const moving = mover.moveRecording(p, dest, b.length);
  await sleep(90);                                     // the copy is under way
  assert.equal(mover.running(), 1);
  assert.ok(fs.existsSync(`${dest}.part`), 'the partial file exists while copying');
  const t0 = Date.now();
  assert.equal(await mover.abortCopies(2000), 1);
  assert.ok(Date.now() - t0 < 1000, 'stops at the next chunk, not at the end of the copy');
  await assert.rejects(moving, /aborted/);
  assert.ok(!fs.existsSync(`${dest}.part`), 'no truncated file left behind');
  assert.ok(!fs.existsSync(dest));
  assert.ok((await fsp.readFile(p)).equals(b), 'the original is intact');
  assert.equal(mover.running(), 0);
});

test('the exported shutdown() is awaitable before anything is installed (merge note: app.exit paths await it)', async () => {
  assert.equal(typeof shutdown, 'function');
  assert.equal(await shutdown(), undefined);
});
