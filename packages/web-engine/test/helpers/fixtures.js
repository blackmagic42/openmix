// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Test fixtures: synthetic buffers, beat lists and signals (no audio files).

import { FakeAudioBuffer } from './fake-audio.js';

/** Deterministic PRNG (mulberry32). */
export function prng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A silent AudioBuffer-like object. */
export function silentBuffer({ seconds = 10, sampleRate = 48000, channels = 2 } = {}) {
  return new FakeAudioBuffer({ numberOfChannels: channels, length: Math.round(seconds * sampleRate), sampleRate });
}

/** Beat list: `count` beats every 60/bpm s from `first`. */
export function beatList({ bpm = 120, first = 0, count = 64 } = {}) {
  const p = 60 / bpm;
  return Array.from({ length: count }, (_, k) => first + k * p);
}

/** Beat list until `seconds`. */
export function beatsFor({ bpm = 120, first = 0, seconds = 60 } = {}) {
  const p = 60 / bpm;
  const out = [];
  for (let t = first; t < seconds; t += p) out.push(Math.round(t * 1e9) / 1e9);
  return out;
}

/**
 * Click track: a short decaying burst at every `times` + `delay` (stereo).
 * Used to test alignImportedGrid.
 */
export function clickBuffer({ times, seconds, sampleRate = 44100, delay = 0, amplitude = 0.8 }) {
  const b = new FakeAudioBuffer({ numberOfChannels: 2, length: Math.round(seconds * sampleRate), sampleRate });
  const L = b.getChannelData(0);
  const R = b.getChannelData(1);
  const burst = Math.round(0.004 * sampleRate);
  for (const t of times) {
    const i0 = Math.round((t + delay) * sampleRate);
    for (let j = 0; j < burst && i0 + j < L.length; j++) {
      if (i0 + j < 0) continue;
      const v = amplitude * Math.exp(-j / (burst / 4)) * (j % 2 ? -1 : 1);
      L[i0 + j] = v;
      R[i0 + j] = v;
    }
  }
  return b;
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Synthetic A-minor piece at `sampleRate` (8 kHz for keyFromMono): an A pedal,
 * Am / Dm / Em / Am triads and a natural-minor melody. Mono Float32Array.
 */
export function aMinorSignal({ seconds = 30, sampleRate = 8000, seed = 21 } = {}) {
  const rnd = prng(seed);
  const n = Math.round(seconds * sampleRate);
  const x = new Float32Array(n);
  // chord progression (MIDI notes), 2 s per chord
  const chords = [
    [57, 60, 64], // Am
    [62, 65, 69], // Dm
    [64, 67, 71], // Em
    [57, 60, 64], // Am
    [53, 57, 60], // F
    [55, 59, 62], // G
    [57, 60, 64], // Am
    [57, 60, 64]  // Am
  ];
  const scale = [69, 71, 72, 74, 76, 77, 79, 81]; // A natural minor
  const tone = (freq, t0, t1, amp) => {
    const i0 = Math.max(0, Math.round(t0 * sampleRate));
    const i1 = Math.min(n, Math.round(t1 * sampleRate));
    const w = 2 * Math.PI * freq / sampleRate;
    const len = i1 - i0;
    for (let i = i0; i < i1; i++) {
      const k = i - i0;
      const env = Math.min(1, k / 80) * Math.min(1, (len - k) / 400);
      x[i] += amp * env * (Math.sin(w * k) + 0.3 * Math.sin(2 * w * k));
    }
  };
  // A pedal (A2) all along
  tone(midiHz(45), 0, seconds, 0.25);
  for (let t = 0, c = 0; t < seconds; t += 2, c++) {
    for (const m of chords[c % chords.length]) tone(midiHz(m), t, Math.min(seconds, t + 2), 0.12);
  }
  // melody: quarter notes from the A natural minor scale, tonic-heavy
  for (let t = 0; t < seconds; t += 0.5) {
    const r = rnd();
    const m = r < 0.35 ? 69 : scale[Math.floor(rnd() * scale.length)];
    tone(midiHz(m), t, Math.min(seconds, t + 0.45), 0.1);
  }
  return x;
}

/**
 * An AudioBuffer-like object whose sample data is only allocated on demand
 * (long tracks for the timing tests, without the memory).
 */
export function lazyBuffer({ seconds = 120, sampleRate = 48000, channels = 2 } = {}) {
  const length = Math.round(seconds * sampleRate);
  const data = [];
  return {
    sampleRate,
    length,
    duration: length / sampleRate,
    numberOfChannels: channels,
    getChannelData(c) {
      if (!(c >= 0 && c < channels)) throw new RangeError(`channel ${c}`);
      if (!data[c]) data[c] = new Float32Array(length);
      return data[c];
    }
  };
}
