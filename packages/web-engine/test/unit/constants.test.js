// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Constants and FX tables (DESIGN §5.12): they reproduce the OpenMix lists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERSION, TEMPO_MIN, TEMPO_MAX, KEY_SHIFT_MIN, KEY_SHIFT_MAX, PRE_ROLL,
  WSOLA_LATENCY_SAMPLES, PITCH_PROCESSOR_NAME, HOT_CUE_COLORS, FX_BEATS,
  FX_TYPES, COLOR_FX_TYPES, FX_DRY_CUT, fxDryCut, PAD_FX_DRY, DEFAULT_PAD_FX, WAVE_PALETTES
} from '../../src/index.js';

test('numeric constants', () => {
  assert.equal(VERSION, '0.1.0');
  assert.deepEqual([TEMPO_MIN, TEMPO_MAX, KEY_SHIFT_MIN, KEY_SHIFT_MAX, PRE_ROLL], [0.5, 1.6, -7, 7, 3600]);
  assert.equal(WSOLA_LATENCY_SAMPLES, 2647);
  assert.equal(PITCH_PROCESSOR_NAME, 'openmix-pitch-shift');
  assert.deepEqual([...HOT_CUE_COLORS], ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#5ac8fa', '#3b82f7', '#af52de', '#ff2d55']);
  assert.deepEqual([...FX_BEATS], [0.25, 0.5, 0.75, 1, 2, 4, 8, 16, 32]);
  assert.deepEqual([...WAVE_PALETTES], ['rgb', 'mono', 'blueorange', 'neon', 'club']);
});

test('FX_TYPES (18) and COLOR_FX_TYPES (9), in the OpenMix order', () => {
  assert.deepEqual(FX_TYPES.map((t) => [t.id, t.label]), [
    ['delay', 'Delay'], ['echo', 'Echo'], ['spiral', 'Spiral'], ['mtdelay', 'MT Delay'],
    ['upecho', 'Up Echo'], ['downecho', 'Down Echo'], ['lowcut', 'Low Cut Echo'], ['pingpong', 'Ping Pong'],
    ['reverb', 'Reverb'], ['flanger', 'Flanger'], ['phaser', 'Phaser'], ['pan', 'Pan'],
    ['trans', 'Trans'], ['filter', 'Filter'], ['roll', 'Roll'], ['robot', 'Robot'],
    ['helix', 'Helix'], ['crush', 'Crush']
  ]);
  assert.deepEqual(COLOR_FX_TYPES.map((t) => [t.id, t.label]), [
    ['filter', 'Filter'], ['dubecho', 'Dub Echo'], ['hpfecho', 'HPF Echo'], ['lpfecho', 'LPF Echo'],
    ['bpfecho', 'BPF Echo'], ['crushecho', 'Crush Echo'], ['reverb', 'Space'], ['noise', 'Noise'], ['crush', 'Crush']
  ]);
  assert.ok(Object.isFrozen(FX_TYPES) && Object.isFrozen(FX_TYPES[0]));
});

test('dry tables and the pad bank', () => {
  assert.deepEqual({ ...FX_DRY_CUT }, { trans: 1, filter: 1, crush: 1, robot: 1, pan: 1, roll: 0, flanger: 0.5, phaser: 0.5, reverb: 0.3 });
  assert.equal(fxDryCut('roll'), 0);
  assert.equal(fxDryCut('delay'), 0.45);
  assert.deepEqual({ ...PAD_FX_DRY }, { roll: 0, filter: 0, trans: 0, echo: 0.2, mtdelay: 0.25, reverb: 0.45, flanger: 1 });
  assert.deepEqual(DEFAULT_PAD_FX.map((p) => ({ ...p })), [
    { label: 'ROLL ½', type: 'roll', beats: 0.5, level: 0.9 },
    { label: 'SWEEP', type: 'filter', beats: 4, level: 0.9 },
    { label: 'FLANGER', type: 'flanger', beats: 2, level: 0.85 },
    { label: 'TRANS', type: 'trans', beats: 0.5, level: 1 },
    { label: 'V.BRAKE', spin: 'brake' },
    { label: 'ECHO ¼', type: 'echo', beats: 0.25, level: 0.7 },
    { label: 'ECHO ½', type: 'echo', beats: 0.5, level: 0.7 },
    { label: 'MT DELAY', type: 'mtdelay', beats: 0.5, level: 0.75 },
    { label: 'REVERB', type: 'reverb', beats: 1, level: 0.75 },
    { label: 'BACKSPIN', spin: 'backspin' }
  ]);
});
