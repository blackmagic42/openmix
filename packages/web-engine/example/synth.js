// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Demo tracks for the example page, synthesized in the browser: no audio file
// is shipped or fetched (DESIGN §2.9).
//
// - The drums are computed sample by sample into one stereo stem: fast, and
//   every hit starts on the exact sample of its step.
// - The bass, chord stabs, pads, lead and riser are a handful of PERSISTENT
//   Web Audio voices driven by automation: a few dozen nodes for the whole
//   track instead of several per note, so the render stays fast.
// - An OfflineAudioContext renders the mix, which is then normalized to a
//   −1 dBFS peak.
//
// Everything is deterministic (seeded noise): a preset rendered at a given
// sample rate always gives the same samples. The tracks have a rigid tempo, a
// clear key and a DJ-friendly structure (drums-only intro and outro, a
// breakdown in the middle), so the engine's BPM, grid and key analysis has
// something realistic to chew on.
//
// arrange() and renderDrums() are pure (no Web Audio) and also run in Node.

const TAU = 2 * Math.PI;
const STEPS = 16;          // sixteenth notes per bar
const TAIL = 1.2;          // seconds after the last bar (release of the last hits)
const DRUM_PARTS = ['kick', 'clap', 'hat', 'ohat', 'shaker', 'perc'];

/** MIDI note number → frequency in Hz (A4 = 69 = 440 Hz). */
const hz = (note) => 440 * Math.pow(2, (note - 69) / 12);

/** Mulberry32: small seeded PRNG, uniform values in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A section: `bars` bars during which the listed parts play. */
const section = (bars, ...parts) => Object.freeze({ bars, parts: Object.freeze(parts) });

const R = null; // a rest in the step patterns below

/**
 * The demo presets. Patterns are 16 steps per bar: 'X' accent, 'x' normal,
 * '.' rest. Bass and lead steps are semitone offsets (or R for a rest) from
 * the bar's bass root / the lead base note. Chords cycle one per bar.
 */
export const DEMO_TRACKS = Object.freeze([
  Object.freeze({
    id: 'house-124-am',
    title: 'House 124 BPM · A minor',
    bpm: 124,
    key: 'Am',
    first: 0.05,
    seed: 124,
    chords: [[57, 60, 64, 67], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67]], // Am7 Am7 Fmaj7 G
    patterns: {
      kick: 'X...X...X...X...',
      clap: '....X.......X...',
      ohat: '..x...x...x...x.',
      shaker: '.x.x.x.x.x.x.x.x'
    },
    bass: { roots: [33, 33, 29, 31], steps: [R, R, 0, R, R, R, 0, R, R, R, 0, R, R, R, 12, R], gate: 1.6 }, // A1 A1 F1 G1
    stab: { pattern: '...X..x....X..x.', gate: 0.9 },
    sections: [
      section(8, 'kick', 'ohat', 'shaker'),
      section(8, 'kick', 'ohat', 'shaker', 'clap', 'bass'),
      section(16, 'kick', 'ohat', 'shaker', 'clap', 'bass', 'stab', 'crash'),
      section(8, 'pad', 'shaker', 'riser'),
      section(4, 'kick', 'ohat', 'shaker', 'clap', 'bass', 'stab', 'pad', 'crash'),
      section(4, 'kick', 'ohat', 'shaker')
    ],
    sound: {
      kick: { f0: 150, f1: 47, pitchDecay: 0.03, decay: 0.24, click: 0.22 },
      bass: { wave: 'sawtooth', cutoff: 260, env: 1100, envDecay: 0.12, q: 7, gain: 0.3, sub: 0.55, sustain: 0.6 },
      stab: { wave: 'sawtooth', detune: 10, spread: 0.35, cutoff: [900, 2600], q: 2, gain: 0.05 },
      pad: { wave: 'triangle', detune: 7, cutoff: 1500, gain: 0.07 },
      duck: 0.5
    }
  }),
  Object.freeze({
    id: 'techno-128-fm',
    title: 'Techno 128 BPM · F minor',
    bpm: 128,
    key: 'Fm',
    first: 0.08,
    seed: 128,
    chords: [[53, 56, 60], [53, 56, 60], [49, 53, 56], [51, 55, 58]], // Fm Fm Db Eb
    patterns: {
      kick: 'X...X...X...X...',
      clap: '....X.......X...',
      hat: 'xxXxxxXxxxXxxxXx',
      ohat: '..x...x...x...x.',
      perc: '...x..x....x..x.'
    },
    bass: { roots: [29, 29, 25, 27], steps: [R, 0, 0, 0, R, 0, 0, 0, R, 0, 0, 0, R, 0, 0, 0], gate: 0.7 }, // F1 F1 Db1 Eb1
    lead: {
      base: 41, // F2
      steps: [0, R, 12, 0, 3, R, 15, 0, 7, R, 10, 12, 0, 3, R, 8],
      accent: 'X...X...X..X....',
      gate: 0.8
    },
    stab: { pattern: 'x..x..x...x..x..', gate: 0.6 },
    sections: [
      section(8, 'kick', 'hat'),
      section(8, 'kick', 'hat', 'bass', 'perc'),
      section(8, 'kick', 'hat', 'ohat', 'bass', 'perc', 'lead'),
      section(8, 'kick', 'hat', 'ohat', 'bass', 'perc', 'clap', 'lead', 'stab'),
      section(4, 'lead', 'pad', 'riser'),
      section(8, 'kick', 'hat', 'ohat', 'bass', 'perc', 'clap', 'lead', 'stab', 'crash'),
      section(4, 'kick', 'hat')
    ],
    sound: {
      kick: { f0: 190, f1: 50, pitchDecay: 0.022, decay: 0.2, click: 0.35 },
      bass: { wave: 'sawtooth', cutoff: 170, env: 420, envDecay: 0.06, q: 4, gain: 0.32, sub: 0.7, sustain: 0.5 },
      lead: { wave: 'sawtooth', cutoff: [320, 3400], env: 1800, envDecay: 0.09, q: 13, gain: 0.11, sustain: 0.45 },
      stab: { wave: 'square', detune: 8, spread: 0.45, cutoff: [1300, 3200], q: 3, gain: 0.04 },
      pad: { wave: 'sawtooth', detune: 9, cutoff: 900, gain: 0.05 },
      duck: 0.55
    }
  }),
  Object.freeze({
    id: 'deep-120-em',
    title: 'Deep House 120 BPM · E minor',
    bpm: 120,
    key: 'Em',
    first: 0.04,
    seed: 120,
    // Em7 Em7 Cmaj7 B7: the D# of B7 (leading tone) tells E minor from G major
    chords: [[52, 55, 59, 62], [52, 55, 59, 62], [48, 52, 55, 59], [47, 51, 54, 57]],
    patterns: {
      kick: 'X...X...X...X...',
      clap: '....x.......x...',
      ohat: '..x...x...x...x.',
      shaker: 'x.xxx.xxx.xxx.xx',
      perc: '.......x.......x'
    },
    bass: { roots: [40, 40, 36, 35], steps: [0, R, R, 0, R, R, 7, R, 0, R, R, 0, R, 12, R, R], gate: 1.8 }, // E2 E2 C2 B1
    stab: { pattern: '..X...x...X..x..', gate: 1.5 },
    sections: [
      section(8, 'kick', 'ohat', 'shaker'),
      section(8, 'kick', 'ohat', 'shaker', 'clap', 'bass', 'perc'),
      section(16, 'kick', 'ohat', 'shaker', 'clap', 'bass', 'perc', 'stab', 'pad', 'crash'),
      section(8, 'pad', 'shaker', 'riser'),
      section(4, 'kick', 'ohat', 'shaker', 'clap', 'bass', 'stab', 'crash'),
      section(4, 'kick', 'ohat', 'shaker')
    ],
    sound: {
      kick: { f0: 135, f1: 45, pitchDecay: 0.035, decay: 0.26, click: 0.16 },
      bass: { wave: 'triangle', cutoff: 420, env: 600, envDecay: 0.15, q: 3, gain: 0.36, sub: 0.6, sustain: 0.7 },
      stab: { wave: 'triangle', detune: 5, spread: 0.3, cutoff: [1400, 2600], q: 1, gain: 0.07 },
      pad: { wave: 'sine', detune: 5, cutoff: 2200, gain: 0.06 },
      duck: 0.45
    }
  })
]);

/**
 * Finds a preset by id.
 * @param {string} id
 * @returns {object | undefined}
 */
export function getDemoTrack(id) {
  return DEMO_TRACKS.find((p) => p.id === id);
}

// ------------------------------------------------------------ arrangement ----

const isHit = (c) => c === 'x' || c === 'X';

/**
 * Turns a preset into timed events (pure, no Web Audio).
 * @param {object} preset one of DEMO_TRACKS
 * @returns {{ bpm: number, seconds: number, bars: number, step: number, barLength: number,
 *   beats: number[], drums: Record<string, { t: number, vel: number }[]>,
 *   notes: { bass: object[], lead: object[], stab: object[] },
 *   chords: { t: number, notes: number[] }[], sections: { t: number, dur: number, parts: string[] }[],
 *   risers: { t: number, dur: number }[] }}
 *   beats = the true beat times (s); bass/lead notes are { t, dur, note, vel, cutoff? },
 *   stab notes are { t, dur, vel, chord }.
 */
export function arrange(preset) {
  const spb = 60 / preset.bpm;
  const step = spb / 4;
  const barLength = 4 * spb;
  const bars = preset.sections.reduce((n, s) => n + s.bars, 0);
  const drums = { kick: [], clap: [], hat: [], ohat: [], shaker: [], perc: [], crash: [] };
  const notes = { bass: [], lead: [], stab: [] };
  const chords = [];
  const sections = [];
  const risers = [];
  let bar = 0;
  for (const sec of preset.sections) {
    const has = (part) => sec.parts.includes(part);
    const secStart = preset.first + bar * barLength;
    const secDur = sec.bars * barLength;
    sections.push({ t: secStart, dur: secDur, parts: sec.parts });
    if (has('crash')) drums.crash.push({ t: secStart, vel: 1 });
    if (has('riser')) risers.push({ t: secStart, dur: secDur });
    for (let b = 0; b < sec.bars; b++, bar++) {
      const t0 = preset.first + bar * barLength;
      const chord = preset.chords[bar % preset.chords.length];
      const root = preset.bass ? preset.bass.roots[bar % preset.bass.roots.length] : 0;
      chords.push({ t: t0, notes: chord });
      for (let s = 0; s < STEPS; s++) {
        const t = t0 + s * step;
        for (const part of DRUM_PARTS) {
          const pattern = preset.patterns[part];
          if (!pattern || !has(part)) continue;
          const c = pattern[s];
          if (isHit(c)) drums[part].push({ t, vel: c === 'X' ? 1 : 0.72 });
        }
        if (has('bass') && preset.bass) {
          const off = preset.bass.steps[s];
          if (off != null) notes.bass.push({ t, note: root + off, vel: 1, gate: preset.bass.gate * step });
        }
        if (has('lead') && preset.lead) {
          const off = preset.lead.steps[s];
          if (off != null) {
            // The resonant filter opens along the section (an acid build-up)
            const progress = (t - secStart) / secDur;
            notes.lead.push({
              t,
              note: preset.lead.base + off,
              vel: isHit(preset.lead.accent[s]) ? 1 : 0.6,
              gate: preset.lead.gate * step,
              progress
            });
          }
        }
        if (has('stab') && preset.stab) {
          const c = preset.stab.pattern[s];
          // A stab never rings into the next bar: the chord changes there
          if (isHit(c)) {
            notes.stab.push({
              t,
              vel: c === 'X' ? 1 : 0.75,
              gate: Math.min(preset.stab.gate * step, t0 + barLength - t - 0.004),
              chord
            });
          }
        }
      }
    }
  }
  // Mono voices: a note must be silent before the next attack of the same
  // voice (the voice is re-triggered from 0, so no click is possible)
  for (const list of Object.values(notes)) {
    for (let i = 0; i < list.length; i++) {
      const next = i + 1 < list.length ? list[i + 1].t : Infinity;
      list[i].dur = Math.max(0.005, Math.min(list[i].gate, next - list[i].t - 0.004));
      delete list[i].gate;
    }
  }
  const beats = Array.from({ length: bars * 4 }, (_, k) => preset.first + k * spb);
  return {
    bpm: preset.bpm,
    seconds: preset.first + bars * barLength + TAIL,
    bars,
    step,
    barLength,
    beats,
    drums,
    notes,
    chords,
    sections,
    risers
  };
}

// ------------------------------------------------------------------ drums ----

function highpass(x, sampleRate, fc) {
  const rc = 1 / (TAU * fc);
  const a = rc / (rc + 1 / sampleRate);
  let y = 0;
  let px = 0;
  for (let i = 0; i < x.length; i++) {
    const v = a * (y + x[i] - px);
    px = x[i];
    y = v;
    x[i] = v;
  }
  return x;
}

function lowpass(x, sampleRate, fc) {
  const a = 1 - Math.exp((-TAU * fc) / sampleRate);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i] - y);
    x[i] = y;
  }
  return x;
}

function noise(n, rng) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rng() * 2 - 1;
  return x;
}

function fadeOut(x, sampleRate, seconds) {
  const n = Math.min(x.length, Math.round(seconds * sampleRate));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
  return x;
}

function normalizeTo(x, peak) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}

function kickSample(sampleRate, rng, k) {
  const n = Math.round(0.45 * sampleRate);
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = k.f1 + (k.f0 - k.f1) * Math.exp(-t / k.pitchDecay);
    x[i] = Math.sin(phase) * Math.exp(-t / k.decay);
    phase += (TAU * f) / sampleRate;
  }
  // Attack click: 3 ms of filtered noise, a precise transient on the beat
  const c = Math.round(0.003 * sampleRate);
  const click = lowpass(noise(c, rng), sampleRate, 4500);
  for (let i = 0; i < c; i++) x[i] += click[i] * k.click * (1 - i / c);
  // Gentle saturation for punch
  const drive = Math.tanh(1.6);
  for (let i = 0; i < n; i++) x[i] = Math.tanh(1.6 * x[i]) / drive;
  return normalizeTo(fadeOut(x, sampleRate, 0.012), 0.92);
}

function noiseHit(sampleRate, rng, { seconds, decay, hp, lp = 0, attack = 0, peak }) {
  const n = Math.round(seconds * sampleRate);
  const x = highpass(highpass(noise(n, rng), sampleRate, hp), sampleRate, hp);
  if (lp) lowpass(x, sampleRate, lp);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    x[i] *= (attack ? Math.min(1, t / attack) : 1) * Math.exp(-t / decay);
  }
  return normalizeTo(fadeOut(x, sampleRate, 0.005), peak);
}

function clapSample(sampleRate, rng) {
  const n = Math.round(0.35 * sampleRate);
  const src = lowpass(highpass(noise(n, rng), sampleRate, 900), sampleRate, 5200);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let env = 0;
    // three hands slightly apart, then the room
    for (const o of [0, 0.009, 0.018]) if (t >= o) env = Math.max(env, Math.exp(-(t - o) / 0.0035));
    if (t >= 0.022) env = Math.max(env, 0.75 * Math.exp(-(t - 0.022) / 0.07));
    x[i] = src[i] * env;
  }
  return normalizeTo(fadeOut(x, sampleRate, 0.01), 0.5);
}

function percSample(sampleRate, rng) {
  const n = Math.round(0.08 * sampleRate);
  const x = new Float32Array(n);
  const click = noise(n, rng);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    x[i] = (0.7 * Math.sin(TAU * 1650 * t) + 0.3 * Math.sin(TAU * 520 * t)) * Math.exp(-t / 0.012)
      + 0.3 * click[i] * Math.exp(-t / 0.002);
  }
  return normalizeTo(fadeOut(x, sampleRate, 0.005), 0.34);
}

/** One-shot samples of the kit, at `sampleRate`. */
function drumKit(sampleRate, rng, sound) {
  return {
    kick: kickSample(sampleRate, rng, sound.kick),
    clap: clapSample(sampleRate, rng),
    hat: noiseHit(sampleRate, rng, { seconds: 0.05, decay: 0.011, hp: 7000, peak: 0.24 }),
    ohat: noiseHit(sampleRate, rng, { seconds: 0.32, decay: 0.075, hp: 6500, peak: 0.22 }),
    shaker: noiseHit(sampleRate, rng, { seconds: 0.07, decay: 0.022, hp: 8500, attack: 0.004, peak: 0.14 }),
    perc: percSample(sampleRate, rng),
    crash: noiseHit(sampleRate, rng, { seconds: 2.4, decay: 0.65, hp: 4800, peak: 0.24 })
  };
}

// Stereo placement of the drum parts (−1 left … +1 right)
const DRUM_PAN = { kick: 0, clap: 0, hat: 0.25, ohat: -0.2, shaker: 0.35, perc: -0.3, crash: 0 };

/**
 * Mixes the drum stem of an arrangement (pure, no Web Audio).
 * @param {object} preset
 * @param {ReturnType<typeof arrange>} arrangement
 * @param {number} sampleRate
 * @returns {[Float32Array, Float32Array]} left and right
 */
export function renderDrums(preset, arrangement, sampleRate) {
  const rng = mulberry32(preset.seed);
  const kit = drumKit(sampleRate, rng, preset.sound);
  const n = Math.ceil(arrangement.seconds * sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (const [part, hits] of Object.entries(arrangement.drums)) {
    const tpl = kit[part];
    const angle = ((DRUM_PAN[part] + 1) * Math.PI) / 4;
    const gl = Math.SQRT2 * Math.cos(angle); // equal power, unity in the center
    const gr = Math.SQRT2 * Math.sin(angle);
    for (const hit of hits) {
      const s0 = Math.round(hit.t * sampleRate);
      const len = Math.min(tpl.length, n - s0);
      for (let i = 0; i < len; i++) {
        const v = tpl[i] * hit.vel;
        left[s0 + i] += v * gl;
        right[s0 + i] += v * gr;
      }
    }
  }
  return [left, right];
}

// ----------------------------------------------------------- Web Audio parts ----

/** Sidechain-style ducking: the harmonic parts dip under every kick. */
function scheduleDuck(param, kicks, depth) {
  param.setValueAtTime(1, 0);
  for (const k of kicks) {
    param.setValueAtTime(1, k.t);
    param.linearRampToValueAtTime(1 - depth, k.t + 0.008);
    param.linearRampToValueAtTime(1, k.t + 0.18);
  }
}

/**
 * Monophonic voice (bass, lead): ONE oscillator, filter and VCA for the whole
 * part. Each note starts from silence and ends at 0 before the next one, so
 * the frequency can jump at the attack without a click.
 */
function monoVoice(ctx, out, o, notes, end) {
  const osc = ctx.createOscillator();
  osc.type = o.wave;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = o.q || 1;
  const vca = ctx.createGain();
  vca.gain.value = 0;
  osc.connect(filter);
  filter.connect(vca);
  vca.connect(out);
  let sub = null;
  if (o.sub) {
    // Sine at the fundamental: body under the filtered wave
    sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    subGain.gain.value = o.sub;
    sub.connect(subGain);
    subGain.connect(vca);
  }
  const [c0, c1] = Array.isArray(o.cutoff) ? o.cutoff : [o.cutoff, o.cutoff];
  filter.frequency.value = c0;
  for (const n of notes) {
    const f = hz(n.note);
    const peak = o.gain * n.vel;
    const attack = Math.min(0.003, n.dur / 4);
    osc.frequency.setValueAtTime(f, n.t);
    if (sub) sub.frequency.setValueAtTime(f, n.t);
    vca.gain.setValueAtTime(0, n.t);
    vca.gain.linearRampToValueAtTime(peak, n.t + attack);
    vca.gain.linearRampToValueAtTime(peak * (o.sustain || 0.6), n.t + n.dur * 0.7);
    vca.gain.linearRampToValueAtTime(0, n.t + n.dur);
    const base = c0 * Math.pow(c1 / c0, n.progress || 0);
    filter.frequency.setValueAtTime(base + (o.env || 0) * n.vel, n.t);
    filter.frequency.exponentialRampToValueAtTime(base, n.t + Math.max(0.005, Math.min(n.dur, o.envDecay || 0.1)));
  }
  osc.start(0);
  osc.stop(end);
  if (sub) {
    sub.start(0);
    sub.stop(end);
  }
}

/** Detuned stereo oscillator pairs feeding `input`, one pair per chord tone. */
function chordVoices(ctx, input, o, count) {
  const voices = [];
  for (let v = 0; v < count; v++) {
    for (const side of [-1, 1]) {
      const osc = ctx.createOscillator();
      osc.type = o.wave;
      osc.detune.value = side * (o.detune || 0);
      const pan = ctx.createStereoPanner();
      pan.pan.value = side * (o.spread == null ? 0.4 : o.spread);
      osc.connect(pan);
      pan.connect(input);
      voices.push({ osc, v });
    }
  }
  return voices;
}

// Chord tone for voice v: chords with fewer notes double the root an octave up
const chordTone = (chord, v) => chord[v % chord.length] + (v >= chord.length ? 12 : 0);

/** Chord stabs: polyphonic, but one shared filter and VCA (stabs never overlap). */
function stabVoices(ctx, out, o, arr, chordSize, end) {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = o.q || 1;
  filter.frequency.value = o.cutoff[0];
  const vca = ctx.createGain();
  vca.gain.value = 0;
  filter.connect(vca);
  vca.connect(out);
  const voices = chordVoices(ctx, filter, o, chordSize);
  // The filter opens along each section that has stabs
  for (const sec of arr.sections) {
    if (!sec.parts.includes('stab')) continue;
    filter.frequency.setValueAtTime(o.cutoff[0], sec.t);
    filter.frequency.exponentialRampToValueAtTime(o.cutoff[1], sec.t + sec.dur);
  }
  for (const n of arr.notes.stab) {
    // Frequencies change at the attack, while the VCA is at 0
    for (const { osc, v } of voices) osc.frequency.setValueAtTime(hz(chordTone(n.chord, v)), n.t);
    const peak = o.gain * n.vel;
    vca.gain.setValueAtTime(0, n.t);
    vca.gain.linearRampToValueAtTime(peak, n.t + 0.002);
    vca.gain.linearRampToValueAtTime(peak * 0.45, n.t + n.dur * 0.6);
    vca.gain.linearRampToValueAtTime(0, n.t + n.dur);
  }
  for (const { osc } of voices) {
    osc.start(0);
    osc.stop(end);
  }
}

/** Pads: sustained chords with a short glide between bars, faded per section. */
function padVoices(ctx, out, o, arr, chordSize, end) {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.7;
  filter.frequency.value = o.cutoff;
  const vca = ctx.createGain();
  vca.gain.value = 0;
  filter.connect(vca);
  vca.connect(out);
  const voices = chordVoices(ctx, filter, o, chordSize);
  for (const sec of arr.sections) {
    if (!sec.parts.includes('pad')) continue;
    const secEnd = sec.t + sec.dur;
    let first = true;
    for (const c of arr.chords) {
      if (c.t < sec.t - 1e-9 || c.t >= secEnd - 1e-9) continue;
      for (const { osc, v } of voices) {
        const f = hz(chordTone(c.notes, v));
        // First chord of the section: set while silent; then a short glide
        if (first) osc.frequency.setValueAtTime(f, c.t);
        else osc.frequency.setTargetAtTime(f, c.t, 0.03);
      }
      first = false;
    }
    const fadeIn = Math.min(1.5, sec.dur / 3);
    vca.gain.setValueAtTime(0, sec.t);
    vca.gain.linearRampToValueAtTime(o.gain, sec.t + fadeIn);
    vca.gain.setValueAtTime(o.gain, secEnd - 0.35);
    vca.gain.linearRampToValueAtTime(0, secEnd);
  }
  for (const { osc } of voices) {
    osc.start(0);
    osc.stop(end);
  }
}

/** Noise riser over a breakdown, cut at the drop. */
function riser(ctx, out, r, sampleRate, rng) {
  const n = Math.max(1, Math.round(r.dur * sampleRate));
  const buf = ctx.createBuffer(1, n, sampleRate);
  buf.copyToChannel(noise(n, rng), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 2.5;
  band.frequency.setValueAtTime(350, r.t);
  band.frequency.exponentialRampToValueAtTime(7000, r.t + r.dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, r.t);
  gain.gain.linearRampToValueAtTime(0.2, r.t + r.dur - 0.01);
  gain.gain.linearRampToValueAtTime(0, r.t + r.dur);
  src.connect(band);
  band.connect(gain);
  gain.connect(out);
  src.start(r.t);
  src.stop(r.t + r.dur);
}

function normalizeBuffer(buffer, peakTarget) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  if (!(peak > 0)) return;
  const g = peakTarget / peak;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
}

/**
 * Renders a demo track with an OfflineAudioContext (silent: nothing reaches
 * the speakers).
 * @param {string | object} preset a preset id from DEMO_TRACKS, or a preset object
 * @param {{ sampleRate?: number }} [options] sampleRate default 48000 (use the
 *   engine's context rate to avoid resampling at playback)
 * @returns {Promise<AudioBuffer>} stereo, peak-normalized to −1 dBFS
 */
export async function renderDemoTrack(preset, { sampleRate = 48000 } = {}) {
  const p = typeof preset === 'string' ? getDemoTrack(preset) : preset;
  if (!p) throw new RangeError(`Unknown demo track: ${String(preset)}`);
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (typeof OAC !== 'function') throw new Error('This browser has no OfflineAudioContext');
  const arr = arrange(p);
  const length = Math.ceil(arr.seconds * sampleRate);
  const ctx = new OAC(2, length, sampleRate);
  const mix = ctx.createGain();
  mix.connect(ctx.destination);

  // 1. Drums: the whole stem as one buffer source
  const [left, right] = renderDrums(p, arr, sampleRate);
  const stem = ctx.createBuffer(2, length, sampleRate);
  stem.copyToChannel(left, 0);
  stem.copyToChannel(right, 1);
  const drums = ctx.createBufferSource();
  drums.buffer = stem;
  drums.connect(mix);
  drums.start(0);

  // 2. Harmonic parts on a bus that ducks under the kick
  const duck = ctx.createGain();
  duck.connect(mix);
  scheduleDuck(duck.gain, arr.drums.kick, p.sound.duck || 0);

  // 3. Voices
  const end = arr.seconds;
  const chordSize = Math.max(...p.chords.map((c) => c.length));
  if (arr.notes.bass.length) monoVoice(ctx, mix, p.sound.bass, arr.notes.bass, end);
  if (arr.notes.lead.length) monoVoice(ctx, duck, p.sound.lead, arr.notes.lead, end);
  if (arr.notes.stab.length) stabVoices(ctx, duck, p.sound.stab, arr, chordSize, end);
  if (arr.sections.some((s) => s.parts.includes('pad'))) padVoices(ctx, duck, p.sound.pad, arr, chordSize, end);
  const rng = mulberry32(p.seed + 1);
  for (const r of arr.risers) riser(ctx, mix, r, sampleRate, rng);

  const rendered = await ctx.startRendering();
  normalizeBuffer(rendered, 0.89);
  return rendered;
}
