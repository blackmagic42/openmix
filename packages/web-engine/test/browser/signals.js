// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Seeded synthetic test signals for the browser suite (DESIGN §10.2).
// Pure functions returning Float32Arrays: no DOM, no Web Audio, so they also
// run in Node. Every random value comes from a seeded PRNG: a given seed
// always produces the same samples.

const TAU = 2 * Math.PI;

/**
 * Mulberry32: small, fast, seeded PRNG.
 * @param {number} seed
 * @returns {() => number} uniform values in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** MIDI note number → frequency (A4 = 69 = 440 Hz). */
export function midiToHz(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/**
 * Pure sine.
 * @param {{ frequency: number, seconds: number, sampleRate: number, amplitude?: number }} o
 */
export function sine({ frequency, seconds, sampleRate, amplitude = 0.5 }) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const w = (TAU * frequency) / sampleRate;
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(w * i);
  return out;
}

/**
 * Click track: one short decaying pulse per beat, louder on downbeats.
 * The pulse starts at full amplitude (instant attack) and decays with a
 * 0.5 ms time constant: sharp enough to time to a few microseconds, wide
 * enough for the WSOLA correlation search (step 4 samples) to see it.
 * The returned beat list holds the exact pulse start times (sample-aligned).
 * @param {{ bpm: number, seconds: number, sampleRate: number, first?: number,
 *           amplitude?: number, accent?: number, beatsPerBar?: number }} o
 * @returns {{ data: Float32Array, beats: number[] }}
 */
export function clickTrack({ bpm, seconds, sampleRate, first = 0.1, amplitude = 0.6, accent = 0.9, beatsPerBar = 4 }) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const period = 60 / bpm;
  const tau = 0.0005 * sampleRate;
  const len = Math.round(0.004 * sampleRate);
  const beats = [];
  for (let k = 0; ; k++) {
    const start = Math.round((first + k * period) * sampleRate);
    if (start >= n) break;
    beats.push(start / sampleRate);
    const amp = k % beatsPerBar === 0 ? accent : amplitude;
    for (let i = 0; i < len && start + i < n; i++) out[start + i] += amp * Math.exp(-i / tau);
  }
  return { data: out, beats };
}

/**
 * Impulse train: single-sample impulses every `interval` seconds, at exact
 * sample positions. `accents` maps an impulse index to its own amplitude.
 * @param {{ interval: number, seconds: number, sampleRate: number, amplitude?: number,
 *           accents?: Record<number, number> }} o
 * @returns {{ data: Float32Array, positions: number[] }} positions in samples
 */
export function impulseTrain({ interval, seconds, sampleRate, amplitude = 0.3, accents = {} }) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const positions = [];
  for (let k = 0; ; k++) {
    const p = Math.round(k * interval * sampleRate);
    if (p >= n) break;
    out[p] = accents[k] != null ? accents[k] : amplitude;
    positions.push(p);
  }
  return { data: out, positions };
}

/**
 * Kick + off-beat hi-hat loop at a constant tempo, like a DAW export.
 * The kick has an instant attack exactly on the beat (cosine start + a short
 * noise click), a pitch sweep from ~158 Hz down to 48 Hz and a 160 ms decay.
 * @param {{ bpm: number, seconds: number, sampleRate: number, first?: number, seed?: number,
 *           hats?: boolean, bass?: boolean }} o
 * @returns {{ data: Float32Array, beats: number[] }} beats = the true beat times (s)
 */
export function kickHatTrack({ bpm, seconds, sampleRate, first = 0.25, seed = 1, hats = true, bass = false }) {
  const sr = sampleRate;
  const rng = mulberry32(seed);
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const period = 60 / bpm;

  const kickLen = Math.round(0.35 * sr);
  const kick = new Float32Array(kickLen);
  let phase = 0;
  for (let i = 0; i < kickLen; i++) {
    const t = i / sr;
    const f = 48 + 110 * Math.exp(-t / 0.03);
    const body = Math.cos(phase) * Math.exp(-t / 0.16);
    phase += (TAU * f) / sr;
    const click = (rng() * 2 - 1) * Math.exp(-t / 0.0015) * 0.3;
    kick[i] = 0.75 * body + click;
  }

  const hatLen = Math.round(0.04 * sr);
  const hat = new Float32Array(hatLen);
  let prev = 0;
  for (let i = 0; i < hatLen; i++) {
    const r = rng() * 2 - 1;
    hat[i] = (r - prev) * 0.5 * Math.exp(-i / (0.01 * sr)) * 0.22;
    prev = r;
  }

  const add = (tpl, at, gain = 1) => {
    const s = Math.round(at * sr);
    for (let i = 0; i < tpl.length && s + i < n; i++) if (s + i >= 0) out[s + i] += tpl[i] * gain;
  };

  const beats = [];
  for (let k = 0; ; k++) {
    const t = first + k * period;
    if (t >= seconds) break;
    beats.push(t);
    add(kick, t);
    if (hats) add(hat, t + period / 2);
  }

  if (bass) {
    // Off-beat bass notes (A1 / C2 / G1 / E1 pattern) under the kicks
    const notes = [33, 33, 36, 31];
    for (let k = 0; k < beats.length; k++) {
      const t0 = beats[k] + period / 2;
      const f = midiToHz(notes[Math.floor(k / 4) % notes.length]);
      const len = Math.round(period * 0.45 * sr);
      const s = Math.round(t0 * sr);
      for (let i = 0; i < len && s + i < n; i++) {
        const t = i / sr;
        const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.12);
        out[s + i] += 0.3 * env * (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * 2 * f * t));
      }
    }
  }
  return { data: out, beats };
}

function addTone(out, sampleRate, start, duration, frequency, gain, harmonics, attack, release) {
  const s0 = Math.max(0, Math.round(start * sampleRate));
  const len = Math.round(duration * sampleRate);
  const end = Math.min(out.length, s0 + len);
  const relStart = duration - release;
  for (let i = s0; i < end; i++) {
    const t = (i - s0) / sampleRate;
    let env = t < attack ? t / attack : 1;
    if (t > relStart) env *= Math.max(0, (duration - t) / release);
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const f = frequency * (h + 1);
      if (f >= sampleRate / 2) break;
      v += harmonics[h] * Math.sin(TAU * f * t);
    }
    out[i] += gain * env * v;
  }
}

/**
 * A-minor material for key detection: an A2 pedal, A-minor triads (with the
 * iv and v chords of the natural minor scale) and a natural-minor melody that
 * mostly lands on chord tones. Normalized to a 0.8 peak.
 * @param {{ seconds: number, sampleRate: number, seed?: number }} o
 */
export function aMinorProgression({ seconds, sampleRate, seed = 7 }) {
  const rng = mulberry32(seed);
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  // A2 pedal for the whole duration
  addTone(out, sampleRate, 0, seconds, midiToHz(45), 0.35, [1, 0.35, 0.1], 0.05, 0.3);
  const chords = [
    [57, 60, 64], // Am: A3 C4 E4
    [57, 60, 64],
    [62, 65, 69], // Dm: D4 F4 A4
    [57, 60, 64],
    [64, 67, 71], // Em: E4 G4 B4
    [57, 60, 64],
    [62, 65, 69],
    [57, 60, 64]
  ];
  const scale = [69, 71, 72, 74, 76, 77, 79, 81]; // A natural minor, A4..A5
  const chordLen = 2;
  for (let c = 0, t = 0; t < seconds; c++, t += chordLen) {
    const chord = chords[c % chords.length];
    for (const note of chord) {
      addTone(out, sampleRate, t, Math.min(chordLen, seconds - t), midiToHz(note), 0.16, [1, 0.4, 0.15], 0.02, 0.15);
    }
    // Melody: eighth notes (0.25 s), 70 % chord tones (an octave up)
    for (let k = 0; k < chordLen / 0.25; k++) {
      const start = t + k * 0.25;
      if (start >= seconds) break;
      const note = rng() < 0.7
        ? chord[Math.floor(rng() * chord.length)] + 12
        : scale[Math.floor(rng() * scale.length)];
      addTone(out, sampleRate, start, 0.24, midiToHz(note), 0.12, [1, 0.3], 0.005, 0.08);
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] *= 0.8 / peak;
  return out;
}

/**
 * A sustained chord: each MIDI note with a few harmonics, plus an optional
 * bass note an octave or two below (which strengthens the root). Short
 * fades at both ends; normalized to a 0.8 peak.
 * @param {{ notes: number[], seconds: number, sampleRate: number, bass?: number | null,
 *           harmonics?: number[] }} o
 * @returns {Float32Array}
 */
export function chord({ notes, seconds, sampleRate, bass = null, harmonics = [1, 0.5, 0.3, 0.2, 0.12] }) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const voices = bass != null ? [...notes, bass] : notes;
  for (const note of voices) {
    const gain = note === bass ? 1.2 : 1;
    addTone(out, sampleRate, 0, seconds, midiToHz(note), gain, harmonics, 0.02, 0.05);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] *= 0.8 / peak;
  return out;
}

/**
 * Sum of pure sines (each { frequency, amplitude }).
 * @param {{ tones: { frequency: number, amplitude: number }[], seconds: number, sampleRate: number }} o
 * @returns {Float32Array}
 */
export function multiTone({ tones, seconds, sampleRate }) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (const { frequency, amplitude } of tones) {
    const w = (TAU * frequency) / sampleRate;
    for (let i = 0; i < n; i++) out[i] += amplitude * Math.sin(w * i);
  }
  return out;
}

/**
 * Encodes channels as a 16-bit PCM WAV file (for the decode path of loadFrom).
 * @param {Float32Array[]} channels same length each
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, sampleRate) {
  const nCh = channels.length;
  const n = channels[0].length;
  const bytes = 44 + n * nCh * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nCh * 2, true);
  v.setUint16(32, nCh * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, Math.round(s * 32767), true);
      o += 2;
    }
  }
  return buf;
}

/**
 * A two-channel test signal for the peaks test: a 100 Hz sine at `amplitude`
 * on the left, and on the right noise bursts that touch exactly −amplitude.
 * @param {{ seconds: number, sampleRate: number, amplitude?: number, seed?: number }} o
 * @returns {Float32Array[]} [left, right]
 */
export function peaksTestSignal({ seconds, sampleRate, amplitude = 0.8, seed = 11 }) {
  const rng = mulberry32(seed);
  const n = Math.round(seconds * sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) left[i] = amplitude * Math.sin((TAU * 100 * i) / sampleRate);
  for (let b = 0.5; b < seconds - 0.1; b += 0.5) {
    const s = Math.round(b * sampleRate);
    for (let i = 0; i < 2400 && s + i < n; i++) right[s + i] = (rng() * 2 - 1) * 0.5 * amplitude;
    right[s + 10] = -amplitude;
  }
  return [left, right];
}
