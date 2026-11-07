// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// DESIGN §10.1 #5: key detection and the Camelot tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  camelot, camelotLabel, keyName, shiftKey, keyDistance, heardKey,
  keyFromChroma, keyFromMono, analyzeTrack, analyzeKey, analyzeBpm
} from '../../src/analysis/index.js';
import { aMinorSignal, silentBuffer } from '../helpers/fixtures.js';

const MAJOR_LABELS = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const MINOR_LABELS = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

test('all 24 Camelot labels (C major = 8B, A minor = 8A)', () => {
  for (let c = 0; c < 12; c++) {
    assert.equal(camelotLabel(c), MAJOR_LABELS[c], `major ${c}`);
    assert.equal(camelotLabel(12 + c), MINOR_LABELS[c], `minor ${c}`);
  }
  assert.deepEqual(camelot(0), { num: 8, letter: 'B' });
  assert.deepEqual(camelot(21), { num: 8, letter: 'A' });
  assert.equal(camelot(null), null);
  assert.equal(camelotLabel(null), '');
  assert.equal(camelotLabel(24), '');
});

test('keyName', () => {
  for (let c = 0; c < 12; c++) {
    assert.equal(keyName(c), MAJOR_NAMES[c]);
    assert.equal(keyName(12 + c), MINOR_NAMES[c]);
  }
  assert.equal(keyName(null), '');
});

test('shiftKey wraps around and keeps the mode', () => {
  assert.equal(shiftKey(11, 1), 0);      // B → C
  assert.equal(shiftKey(0, -1), 11);     // C → B
  assert.equal(shiftKey(21, 3), 12);     // Am → Cm
  assert.equal(shiftKey(12, -1), 23);    // Cm → Bm
  assert.equal(shiftKey(5, 24), 5);
  assert.equal(shiftKey(7, 2.4), 9);     // rounded semitones
  assert.equal(shiftKey(null, 3), null);
});

test('keyDistance cases', () => {
  assert.equal(keyDistance(21, 21), 0);  // same
  assert.equal(keyDistance(21, 0), 1);   // relative (8A / 8B)
  assert.equal(keyDistance(21, 16), 1);  // 8A / 9A (Em)
  assert.equal(keyDistance(21, 14), 1);  // 8A / 7A (Dm)
  assert.equal(keyDistance(21, 23), 2);  // 8A / 10A (Bm): energy
  assert.equal(keyDistance(21, 7), 2);   // 8A / 9B (G): diagonal
  assert.equal(keyDistance(21, 18), 3);  // 8A / 11A (F#m): clash
  assert.equal(keyDistance(0, 6), 3);    // 8B / 2B
  assert.equal(keyDistance(null, 3), null);
});

test('heardKey with and without keylock', () => {
  const deck = { musicKey: 21, keyShift: 2, keylock: true, tempo: 1.06 };
  assert.deepEqual(heardKey(deck), { code: 23, cents: 0 }); // Am + 2 = Bm, tempo ignored
  // without keylock: +6 % ≈ +1.009 semitone → Cm, +1 cent
  assert.deepEqual(heardKey({ ...deck, keylock: false }), { code: 12, cents: 1 });
  assert.deepEqual(heardKey({ musicKey: 0, tempo: Math.pow(2, -0.4 / 12) }), { code: 0, cents: -40 });
  assert.equal(heardKey({ musicKey: null, keyShift: 3 }), null);
});

test('keyFromChroma on rotated profiles returns that key', () => {
  // KeyFinder profiles (the ones in analysis/key.js)
  const major = [7.23900502618145, 3.5035183304246, 3.5844599761337, 2.84511477063833,
    5.81898391564628, 4.55865043428244, 2.4477861994943, 6.99473684210526,
    3.39106280193237, 4.55614242247193, 4.0739247311828, 4.45932095553986];
  const minor = [7.00255325900951, 3.14360210696459, 4.35904551201406, 5.4041866908751,
    3.67234855610808, 4.08971222914409, 3.9079187555457, 6.2068325136939,
    3.63167721694189, 2.87065311391596, 5.35643002212298, 3.83555012908213];
  for (let t = 0; t < 12; t++) {
    const rot = (p) => Array.from({ length: 12 }, (_, i) => p[(i - t + 12) % 12]);
    const ma = keyFromChroma(rot(major));
    const mi = keyFromChroma(rot(minor));
    assert.equal(ma.code, t, `major tonic ${t}`);
    assert.equal(mi.code, 12 + t, `minor tonic ${t}`);
    assert.ok(ma.confidence > 0 && mi.confidence > 0);
  }
});

test('keyFromMono on a synthetic 8 kHz A-minor signal returns 21 (Am)', async () => {
  const res = await keyFromMono(aMinorSignal({ seconds: 30, sampleRate: 8000 }), 8000, 12);
  assert.ok(res);
  assert.equal(res.code, 21);
  assert.equal(res.tuning, 0);
  assert.ok(res.confidence > 0);
});

test('keyFromMono: 8 kHz only, null when too short', async () => {
  await assert.rejects(keyFromMono(new Float32Array(100000), 44100));
  assert.equal(await keyFromMono(new Float32Array(8000), 8000), null);
});

test('without OfflineAudioContext, analysis rejects but analyzeTrack never does', async () => {
  const buffer = silentBuffer({ seconds: 6, sampleRate: 8000, channels: 1 });
  const saved = globalThis.OfflineAudioContext;
  delete globalThis.OfflineAudioContext;
  try {
    await assert.rejects(analyzeBpm(buffer), /OfflineAudioContext/);
    await assert.rejects(analyzeKey(buffer), /OfflineAudioContext/);
    const res = await analyzeTrack(buffer);
    assert.deepEqual(res, {
      bpm: null, beats: null, beatOffset: null, barAnchor: 0, rigid: false,
      musicKey: null, keyConfidence: null, peaks: null
    });
    await assert.rejects(analyzeTrack({}), TypeError);
  } finally {
    if (saved) globalThis.OfflineAudioContext = saved;
  }
});
