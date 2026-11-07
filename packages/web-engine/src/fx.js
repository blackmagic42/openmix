// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Beat FX unit, echo / impulse / crush builders, and the FX tables (DESIGN §5.6, §5.12, §6.5).

import { clamp, hasOwn, isNum, startSource, stopSource, cancelStart } from './util.js';

// --- FX tables (they reproduce the OpenMix option lists exactly; the ids
// are the API, the labels are suggestions for UIs) ---

/** The beat-FX types, in the OpenMix menu order. */
export const FX_TYPES = Object.freeze([
  { id: 'delay', label: 'Delay' },
  { id: 'echo', label: 'Echo' },
  { id: 'spiral', label: 'Spiral' },
  { id: 'mtdelay', label: 'MT Delay' },
  { id: 'upecho', label: 'Up Echo' },
  { id: 'downecho', label: 'Down Echo' },
  { id: 'lowcut', label: 'Low Cut Echo' },
  { id: 'pingpong', label: 'Ping Pong' },
  { id: 'reverb', label: 'Reverb' },
  { id: 'flanger', label: 'Flanger' },
  { id: 'phaser', label: 'Phaser' },
  { id: 'pan', label: 'Pan' },
  { id: 'trans', label: 'Trans' },
  { id: 'filter', label: 'Filter' },
  { id: 'roll', label: 'Roll' },
  { id: 'robot', label: 'Robot' },
  { id: 'helix', label: 'Helix' },
  { id: 'crush', label: 'Crush' }
].map((t) => Object.freeze(t)));

/** The color-FX modes of the channel FILTER knobs. */
export const COLOR_FX_TYPES = Object.freeze([
  { id: 'filter', label: 'Filter' },
  { id: 'dubecho', label: 'Dub Echo' },
  { id: 'hpfecho', label: 'HPF Echo' },
  { id: 'lpfecho', label: 'LPF Echo' },
  { id: 'bpfecho', label: 'BPF Echo' },
  { id: 'crushecho', label: 'Crush Echo' },
  { id: 'reverb', label: 'Space' },
  { id: 'noise', label: 'Noise' },
  { id: 'crush', label: 'Crush' }
].map((t) => Object.freeze(t)));

// CONVENTIONAL range (by design): from 1/4 to 32 beats
/** Typical beat multiples for FX units. */
export const FX_BEATS = Object.freeze([0.25, 0.5, 0.75, 1, 2, 4, 8, 16, 32]);

// Share of the DRY sound removed when the effect is at full (the "nature" of
// the effect): an INSERT effect (gate, filter, crush, roll…) REPLACES the
// sound — at 100 % you only hear the effect; an echo/reverb ADDS to the
// sound (dry just compensated so it doesn't clip); flanger/phaser need
// the dry (the comb comes from mixing the two).
/** Share of the dry sound removed at full level, per FX type (default 0.45, see fxDryCut). */
export const FX_DRY_CUT = Object.freeze({
  trans: 1, filter: 1, crush: 1, robot: 1, pan: 1,
  roll: 0, // (the ROLL is dosed inside the deck itself: loop ↔ track)
  flanger: 0.5, phaser: 0.5, reverb: 0.3
});

/**
 * Share of the dry sound removed by an effect type at full level.
 * @param {string} type FxType
 * @returns {number} FX_DRY_CUT[type] ?? 0.45
 */
export const fxDryCut = (type) => (hasOwn(FX_DRY_CUT, type) ? FX_DRY_CUT[type] : 0.45);

// Level of the DRY sound while an FX pad is HELD (per effect type): "it's
// the sound being manipulated", it isn't layered on top. ROLL/SWEEP/
// TRANS replace everything, ECHO/DELAY cut with the tail, REVERB
// keeps a bed, FLANGER NEEDS the dry signal (it's the comb of the two).
/** Deck dry level while a pad FX of that type is held (default 1). */
export const PAD_FX_DRY = Object.freeze({ roll: 0, filter: 0, trans: 0, echo: 0.2, mtdelay: 0.25, reverb: 0.45, flanger: 1 });

// Rekordbox-style PAD FX: HOLD = the effect plays, RELEASE = it stops.
// beats = fraction of a beat (follows the master BPM), level = the pad's fixed amount
// Chosen selection: V.BRAKE and BACKSPIN kept ("turntable" effects: spin =
// handling the platter), plus 8 wet effects (echo, sweep…)
/** The OpenMix pad-FX bank (10 entries; spin entries go to deck.spinStart). */
export const DEFAULT_PAD_FX = Object.freeze([
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
].map((p) => Object.freeze(p)));

const FX_IDS = new Set(FX_TYPES.map((t) => t.id));
const COLOR_IDS = new Set(COLOR_FX_TYPES.map((t) => t.id));
export const isFxType = (t) => FX_IDS.has(t);
export const isColorFxType = (t) => COLOR_IDS.has(t);

// --- Feedback-loop latency (web-engine) ---
// An echo's feedback loop through a DelayNode is a CYCLE of the audio graph.
// The Web Audio spec only clamps such a delay to one render quantum at
// least, but Chromium processes the cycle one render quantum LATE: every trip
// around the loop adds 128 frames (2.67 ms at 48 kHz) to the delay. Measured
// in Chromium 150 (Electron 43): the first repeat exact, then +128 frames per
// repeat — a 1/4-beat echo at 124 BPM fell 21 ms behind the beat after 8
// repeats, a helix tail much further. (OpenMix drifts the same way.)
// The latency is measured ONCE per sample rate with a tiny offline render of a
// single-delay loop, and the beat-FX delay times compensate it: loop delay =
// D − latency, plus a fixed post-delay outside the cycle, so that EVERY repeat
// lands on the beat. A browser without that latency measures 0: nothing
// changes there. Every compensated cycle holds ONE delay node: with two
// delays in a cycle (the old ping-pong), Chromium puts the extra quantum on
// one edge or the other depending on the graph, so it cannot be compensated.
// (The flanger loop and the color-FX echoes keep their OpenMix timing: they
// are not beat-synced, and their sound must not change.)
const NO_FEEDBACK_LATENCY = Object.freeze({ loop: 0, loopPost: 0 });
// Beat-FX types whose output taps a single feedback loop
const LOOP_TYPES = new Set(['echo', 'delay', 'lowcut', 'spiral', 'upecho', 'downecho', 'helix']);
const feedbackLatencies = new Map(); // `${sampleRate}|${quantum}` → Promise

/**
 * Feedback-loop latency of this browser, measured once per sample rate:
 * `loop` = seconds added by each trip around a single-delay feedback loop,
 * `loopPost` = the post-delay that puts the first repeat back on time. All
 * zeros when it cannot be measured.
 * @param {number} sampleRate
 * @param {number} [quantum=128] render quantum size (frames)
 * @returns {Promise<{ loop: number, loopPost: number }>}
 */
export function measureFeedbackLatency(sampleRate, quantum = 128) {
  const key = `${sampleRate}|${quantum}`;
  let p = feedbackLatencies.get(key);
  if (!p) {
    p = Promise.resolve()
      .then(() => probeFeedbackLatency(sampleRate, quantum))
      .catch(() => NO_FEEDBACK_LATENCY);
    feedbackLatencies.set(key, p);
  }
  return p;
}

async function probeFeedbackLatency(sampleRate, quantum) {
  const OAC = globalThis.OfflineAudioContext;
  if (typeof OAC !== 'function' || !(sampleRate > 0) || !(quantum > 0)) return NO_FEEDBACK_LATENCY;
  const D = 2 * quantum;        // probe delay (frames): cycles need at least one quantum
  const LEN = 4 * D;
  const ctx = quantum === 128
    ? new OAC(1, LEN, sampleRate)
    : new OAC({ numberOfChannels: 1, length: LEN, sampleRate, renderSizeHint: quantum });
  const imp = ctx.createBuffer(1, 1, sampleRate);
  imp.getChannelData(0)[0] = 1;
  // the shape of the echo loops: input → d (tapped) → fb → d
  const src = ctx.createBufferSource();
  src.buffer = imp;
  const d = ctx.createDelay(1);
  d.delayTime.value = D / sampleRate;
  const g = ctx.createGain();
  g.gain.value = 0.5;
  src.connect(d);
  d.connect(ctx.destination);
  d.connect(g);
  g.connect(d);
  src.start(0);
  const out = await ctx.startRendering();
  const x = out.getChannelData(0);
  // Arrival (frame) of the impulse expected around n × D, or null
  const arrival = (n) => {
    let best = -1;
    let bestV = 0;
    for (let i = Math.max(0, n * D - 8); i < Math.min(x.length, n * D + D - 8); i++) {
      const v = Math.abs(x[i]);
      if (v > bestV) { bestV = v; best = i; }
    }
    return bestV > 0.1 ? best : null;
  };
  const first = arrival(1);
  const second = arrival(2);
  if (first == null || second == null) return NO_FEEDBACK_LATENCY;
  const a = first - D;            // first pass (exact in Chromium)
  const q = second - first - D;   // added by each trip around the cycle
  if (!(a >= 0 && q >= 0 && q - a >= 0 && q <= D - 16) || (a === 0 && q === 0)) return NO_FEEDBACK_LATENCY;
  return Object.freeze({ loop: q / sampleRate, loopPost: (q - a) / sampleRate });
}

// Generic echo loop: delay + feedback, with an optional filter and/or crush
// inside the loop (shared factory for the echo variants).
export function buildEchoLoop(ctx, { fb = 0.45, filter = null, crush = null, maxT = 4, time = 0.25 } = {}) {
  const d = ctx.createDelay(maxT);
  d.delayTime.value = time;
  const g = ctx.createGain();
  g.gain.value = fb;
  let node = d;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = filter.type;
    f.frequency.value = filter.freq;
    if (filter.q) f.Q.value = filter.q;
    node.connect(f);
    node = f;
  }
  if (crush) {
    const s = ctx.createWaveShaper();
    s.curve = crushCurve(crush);
    node.connect(s);
    node = s;
  }
  node.connect(g);
  g.connect(d);
  return { in: d, out: node, delay: d, fb: g, fbBase: fb };
}

// Synthetic impulse response for the reverb (exponentially decaying
// noise). MEMOIZED: an AudioBuffer is read-only on the Web
// Audio side, so all FX units can share the SAME one — we used to build
// up to 9 identical ones (4 units + master + pad FX), i.e. ~6.8 MB and 25 ms
// of computation for nothing. (AudioBuffers are not tied to a context: the
// cache is shared by every context of the same sample rate.)
const _impCache = new Map();
export function makeImpulse(ctx, seconds, decay) {
  const key = `${seconds}|${decay}|${ctx.sampleRate}`;
  const hit = _impCache.get(key);
  if (hit) return hit;
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  _impCache.set(key, buf);
  return buf;
}

export function crushCurve(steps) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

// Beat FX-style effects unit: one effect at a time, assignable to any deck(s),
// wired as a send (the dry sound keeps passing, the effect adds on top).
/**
 * A beat-FX unit. Created by the engine only (engine.fx, engine.masterFx,
 * pad FX); exported for instanceof checks and types.
 */
export class FxUnit {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} output where the wet signal goes
   * @param {(unit: FxUnit) => void} [onChange] called after setEnabled / setType,
   *   so the engine can update the deck sends
   */
  constructor(ctx, output, onChange) {
    this.ctx = ctx;
    this._onChange = typeof onChange === 'function' ? onChange : null;
    this.input = ctx.createGain();
    this.wet = ctx.createGain();
    // The FX ALWAYS starts at the lowest point (by design): the level is
    // raised with the stick, never a surprise on activation
    /** Wet level and intensity, 0..1 (default 0). */
    this.level = 0;
    this.wet.gain.value = this.level;
    this.wet.connect(output);
    /** Whether the unit is on (default false). */
    this.enabled = false;
    /** Current effect type (default 'echo'). */
    this.type = 'echo';
    // web-engine: beatDur / beatsMult renamed beatDuration / beats (DESIGN §5.6)
    /** Seconds per beat currently followed (default 0.5); follows the reference deck's BPM. */
    this.beatDuration = 0.5;
    /** Chosen beat multiple (¼, ½, 1, 2…; default 0.5). */
    this.beats = 0.5;

    // Echo (delay with feedback, low-cut inside the loop)
    this.echoDelay = ctx.createDelay(4);
    this.echoDelay.delayTime.value = 0.25;
    this.echoHp = ctx.createBiquadFilter();
    this.echoHp.type = 'highpass';
    this.echoHp.frequency.value = 120;
    this.echoFb = ctx.createGain();
    this.echoFb.gain.value = 0.45;
    this.echoDelay.connect(this.echoHp);
    this.echoHp.connect(this.echoFb);
    this.echoFb.connect(this.echoDelay);

    // Reverb
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = makeImpulse(ctx, 2.2, 2.5);

    // Flanger (short delay modulated by an LFO + feedback)
    this.flDelay = ctx.createDelay(0.05);
    this.flDelay.delayTime.value = 0.004;
    this.flFb = ctx.createGain();
    this.flFb.gain.value = 0.4;
    this.flDelay.connect(this.flFb);
    this.flFb.connect(this.flDelay);
    this.flLfo = ctx.createOscillator();
    this.flLfo.frequency.value = 0.25;
    this.flLfoGain = ctx.createGain();
    this.flLfoGain.gain.value = 0.0022;
    this.flLfo.connect(this.flLfoGain);
    this.flLfoGain.connect(this.flDelay.delayTime);
    // web-engine: the unit's permanent sources start through startSource: on
    // a context that has not started yet, on its first 'running' state (no
    // autoplay warning, see util.js)
    startSource(ctx, this.flLfo);

    // Crush (resolution reduction)
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = crushCurve(8);

    // (Simple Delay, Ping Pong, Low Cut, the echo variants and MT Delay are
    // built ON FIRST USE — see _chain/_mk below: each
    // createDelay(4) reserves ~1 MB as soon as it is created, and only one chain
    // runs at a time. That was ~50 MB of dead buffer at startup.)

    // Phaser (4 modulated all-pass filters)
    this.phStages = [350, 700, 1100, 1600].map((f) => {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = f;
      ap.Q.value = 0.6;
      return ap;
    });
    for (let s = 0; s < this.phStages.length - 1; s++) {
      this.phStages[s].connect(this.phStages[s + 1]);
    }
    this.phLfo = ctx.createOscillator();
    this.phLfo.frequency.value = 0.4;
    this.phLfoGain = ctx.createGain();
    this.phLfoGain.gain.value = 280;
    this.phLfo.connect(this.phLfoGain);
    this.phStages.forEach((ap) => this.phLfoGain.connect(ap.frequency));
    startSource(ctx, this.phLfo);

    // Trans (square rhythmic gate locked to the tempo)
    this.trGain = ctx.createGain();
    this.trGain.gain.value = 0;
    this.trConst = ctx.createConstantSource();
    this.trConst.offset.value = 0.5;
    this.trConst.connect(this.trGain.gain);
    startSource(ctx, this.trConst);
    this.trOsc = ctx.createOscillator();
    this.trOsc.type = 'square';
    this.trOsc.frequency.value = 4;
    this.trOscGain = ctx.createGain();
    this.trOscGain.gain.value = 0.5;
    this.trOsc.connect(this.trOscGain);
    this.trOscGain.connect(this.trGain.gain);
    startSource(ctx, this.trOsc);

    // Auto pan (left/right in rhythm)
    this.panNode = ctx.createStereoPanner();
    this.panLfo = ctx.createOscillator();
    this.panLfo.frequency.value = 1;
    this.panLfoGain = ctx.createGain();
    this.panLfoGain.gain.value = 0.9;
    this.panLfo.connect(this.panLfoGain);
    this.panLfoGain.connect(this.panNode.pan);
    startSource(ctx, this.panLfo);

    // Filter (band sweep synced to the tempo)
    this.fxbp = ctx.createBiquadFilter();
    this.fxbp.type = 'bandpass';
    this.fxbp.frequency.value = 800;
    this.fxbp.Q.value = 1.4;
    this.fxbpLfo = ctx.createOscillator();
    this.fxbpLfo.frequency.value = 0.5;
    this.fxbpLfoGain = ctx.createGain();
    this.fxbpLfoGain.gain.value = 650;
    this.fxbpLfo.connect(this.fxbpLfoGain);
    this.fxbpLfoGain.connect(this.fxbp.frequency);
    startSource(ctx, this.fxbpLfo);

    // Robot (ring modulation)
    this.rmGain = ctx.createGain();
    this.rmGain.gain.value = 0;
    this.rmOsc = ctx.createOscillator();
    this.rmOsc.frequency.value = 35;
    this.rmOsc.connect(this.rmGain.gain);
    startSource(ctx, this.rmOsc);

    // Delay lines to keep in time with the tempo: the ones that EXIST
    // (the others are born already in time, see _timeNow)
    this._delays = [this.echoDelay];
    // web-engine: kind of each line, for the feedback-latency compensation:
    // 'loop' (the delay of a feedback loop), 'loop2' (the ping-pong loop,
    // two beat multiples long), 'tap' (no cycle)
    this._delayKind = new Map([[this.echoDelay, 'loop']]);
    this._fbLat = NO_FEEDBACK_LATENCY;
    this._post = null;     // post-delay outside the loop (created when needed)
    this._lazy = {};
    // Feedbacks scaled by the LEVEL (the echo gets longer as it goes up)
    this._fbs = [{ g: this.echoFb, base: 0.45 }];
    // ROLL: played by the DECK (track loop locked to the grid), not
    // by a delay line — so the unit outputs nothing for it
    this._mute = ctx.createGain();
    this._mute.gain.value = 0;

    this._out = null;
    this._outTo = null;
    this._route();
  }

  // CURRENT delay time, without a ramp: a new chain must be born
  // in time, otherwise its 1st repeat starts at 0.25 s and "slides" toward the
  // tempo (audible doppler effect).
  _timeNow() { return clamp(this.beatDuration * this.beats, 0.02, 3.9); }

  // web-engine: delay time of a line of the given kind, the browser's
  // feedback-loop latency compensated (see measureFeedbackLatency)
  _delayTime(kind, t = this._timeNow()) {
    if (kind === 'loop') return Math.max(0, t - this._fbLat.loop);
    if (kind === 'loop2') return Math.max(0, 2 * t - this._fbLat.loop);
    return t;
  }

  _addDelay(node, kind) {
    this._delays.push(node);
    this._delayKind.set(node, kind);
  }

  // web-engine: post-delay of the current chain (outside its feedback loop)
  _postFor(type) {
    return LOOP_TYPES.has(type) ? this._fbLat.loopPost : 0;
  }

  // web-engine: the browser's feedback-loop latency, measured by the engine
  // once per sample rate: re-times the existing lines and re-routes
  _setFeedbackLatency(fb) {
    if (!fb || fb === this._fbLat) return;
    const same = ['loop', 'loopPost'].every((k) => (fb[k] || 0) === (this._fbLat[k] || 0));
    this._fbLat = fb;
    if (same) return;
    this._applyTime();
    this._route();
  }

  // Lazy factory: builds the chain on first use, keeps it
  _mk(key, build) {
    let v = this._lazy[key];
    if (!v) v = this._lazy[key] = build();
    return v;
  }

  _echo(opts) {
    const c = buildEchoLoop(this.ctx, { ...opts, time: this._delayTime('loop') });
    this._addDelay(c.delay, 'loop');
    this._fbs.push({ g: c.fb, base: c.fbBase });
    c.fb.gain.value = this._fbFor(c.fbBase);
    return c;
  }

  // Feedback according to the level: at low level the echo is short and
  // discreet, at full it takes its whole tail (capped below 1: never runs away)
  _fbFor(base) {
    return Math.min(0.97, base * (0.55 + 0.45 * this.level));
  }

  _chain() {
    switch (this.type) {
      case 'delay': {
        const d = this._mk('delay', () => {
          const n = this.ctx.createDelay(4);
          n.delayTime.value = this._delayTime('loop');
          const fb = this.ctx.createGain();
          fb.gain.value = this._fbFor(0.22);
          n.connect(fb);
          fb.connect(n);
          this._addDelay(n, 'loop');
          this._fbs.push({ g: fb, base: 0.22 });
          return n;
        });
        return [d, d];
      }
      case 'pingpong': {
        // web-engine: ONE delay in the feedback cycle. (OpenMix looped
        // L → R → fb → L: in Chromium, a cycle through two delays gets its
        // extra render quantum on either edge depending on the graph, so its
        // repeats could not be kept on the beat.) Same response: L taps at
        // D, 3D, 5D…, R taps at 2D, 4D…, feedback once per L+R round trip.
        const p = this._mk('pingpong', () => {
          const t = this._timeNow();
          const L = this.ctx.createDelay(4);
          const R = this.ctx.createDelay(4);
          L.delayTime.value = t;
          R.delayTime.value = t;
          const X = this.ctx.createGain();
          const loop = this.ctx.createDelay(8);
          loop.delayTime.value = this._delayTime('loop2', t);
          const fb = this.ctx.createGain();
          fb.gain.value = this._fbFor(0.42);
          this._fbs.push({ g: fb, base: 0.42 });
          const pL = this.ctx.createStereoPanner();
          pL.pan.value = -0.85;
          const pR = this.ctx.createStereoPanner();
          pR.pan.value = 0.85;
          const out = this.ctx.createGain();
          L.connect(X);
          X.connect(pL); pL.connect(out);
          X.connect(R);
          R.connect(pR); pR.connect(out);
          X.connect(loop); loop.connect(fb); fb.connect(X);
          this._addDelay(L, 'tap');
          this._addDelay(R, 'tap');
          this._addDelay(loop, 'loop2');
          return { in: L, out };
        });
        return [p.in, p.out];
      }
      case 'reverb': return [this.convolver, this.convolver];
      case 'flanger': return [this.flDelay, this.flDelay];
      case 'phaser': return [this.phStages[0], this.phStages[this.phStages.length - 1]];
      case 'trans': return [this.trGain, this.trGain];
      case 'crush': return [this.shaper, this.shaper];
      case 'lowcut': {
        // output = THE DELAY (the high-pass is in the feedback
        // loop, not at the output) — original routing kept
        const c = this._mk('lowcut', () => this._echo({ fb: 0.5, filter: { type: 'highpass', freq: 700 } }));
        return [c.delay, c.delay];
      }
      case 'spiral': {
        const c = this._mk('spiral', () => this._echo({ fb: 0.72, filter: { type: 'bandpass', freq: 900, q: 0.9 } }));
        return [c.in, c.out];
      }
      case 'upecho': {
        const c = this._mk('upecho', () => this._echo({ fb: 0.5, filter: { type: 'highpass', freq: 500 } }));
        return [c.in, c.out];
      }
      case 'downecho': {
        const c = this._mk('downecho', () => this._echo({ fb: 0.5, filter: { type: 'lowpass', freq: 1200 } }));
        return [c.in, c.out];
      }
      case 'roll': return [this._mute, this._mute];
      case 'helix': {
        const c = this._mk('helix', () => this._echo({ fb: 0.97 }));
        return [c.in, c.out];
      }
      case 'mtdelay': {
        const mt = this._mk('mtdelay', () => {
          const t = this._timeNow();
          const d1 = this.ctx.createDelay(4);
          const d2 = this.ctx.createDelay(4);
          const d3 = this.ctx.createDelay(4);
          d1.delayTime.value = t;
          d2.delayTime.value = t;
          d3.delayTime.value = t;
          const out = this.ctx.createGain();
          const g1 = this.ctx.createGain(); g1.gain.value = 0.8;
          const g2 = this.ctx.createGain(); g2.gain.value = 0.55;
          const g3 = this.ctx.createGain(); g3.gain.value = 0.35;
          d1.connect(g1); g1.connect(out); d1.connect(d2);
          d2.connect(g2); g2.connect(out); d2.connect(d3);
          d3.connect(g3); g3.connect(out);
          this._addDelay(d1, 'tap');
          this._addDelay(d2, 'tap');
          this._addDelay(d3, 'tap');
          return { in: d1, out };
        });
        return [mt.in, mt.out];
      }
      case 'pan': return [this.panNode, this.panNode];
      case 'filter': return [this.fxbp, this.fxbp];
      case 'robot': return [this.rmGain, this.rmGain];
      default: return [this.echoDelay, this.echoDelay];
    }
  }

  _route() {
    try { this.input.disconnect(); } catch { /* nothing */ }
    if (this._out) {
      try { this._out.disconnect(this._outTo || this.wet); } catch { /* nothing */ }
      this._out = null;
      this._outTo = null;
    }
    if (!this.enabled) return;
    const [cIn, cOut] = this._chain();
    this.input.connect(cIn);
    // web-engine: a feedback chain goes through the post-delay that
    // completes the latency compensation (none where the browser has none)
    const post = this._postFor(this.type);
    let to = this.wet;
    if (post > 0) {
      if (!this._post) {
        this._post = this.ctx.createDelay(1);
        this._post.connect(this.wet);
      }
      this._post.delayTime.value = post;
      to = this._post;
    }
    cOut.connect(to);
    this._out = cOut;
    this._outTo = to;
  }

  /**
   * Selects the effect.
   * @param {string} type an FX_TYPES id; RangeError otherwise
   */
  setType(type) {
    if (!isFxType(type)) throw new RangeError(`Unknown FX type: ${String(type)}`);
    this.type = type;
    this._route();
    if (this._onChange) this._onChange(this);
  }

  /**
   * Turns the unit on or off (the engine updates the deck sends automatically).
   * @param {boolean} on
   */
  setEnabled(on) {
    this.enabled = !!on;
    this._route();
    if (this._onChange) this._onChange(this);
  }

  /**
   * Wet level, 0..1. It also drives the effect itself (echo feedback,
   * filter-sweep depth, flanger feedback).
   * @param {number} v
   */
  setLevel(v) {
    if (!isNum(v)) return;
    this.level = clamp(v, 0, 1);
    const now = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(this.level, now, 0.02);
    // The INTENSITY also acts INSIDE the effect (not just on its volume):
    // echo tail, sweep depth, flanger feedback
    for (const f of this._fbs) f.g.gain.setTargetAtTime(this._fbFor(f.base), now, 0.05);
    this.fxbpLfoGain.gain.setTargetAtTime(650 * (0.35 + 0.65 * this.level), now, 0.05);
    this.flFb.gain.setTargetAtTime(0.15 + 0.5 * this.level, now, 0.05);
  }

  // BEAT ALIGNMENT: the modulations (TRANS gate, sweeps of the
  // flanger, phaser, filter, pan) restart EXACTLY on a beat
  // of the track — before, their oscillators ran with an arbitrary
  // phase: the gate chopped off the beat, "tied to nothing".
  // at = audio (ctx) time of the start of a beat / bar.
  alignTo(at) {
    const t = this._timeNow();
    if (!this._oscList) this._oscList = {};
    const swap = (key, type, freq, dest) => {
      // ALL still-running oscillators of this modulation stop
      // at "at" — the running one AND any replacement that hasn't
      // started yet (otherwise two LFOs added up: gate at 150 %)
      const list = this._oscList[key] || (this._oscList[key] = [this[key]]);
      for (const old of list) {
        // web-engine: one whose start is still pending (the context has not
        // run yet) never played: it is dropped, so it can never start later
        if (cancelStart(this.ctx, old)) {
          try { old.disconnect(); } catch { /* nothing */ }
          continue;
        }
        try { old.stop(at); } catch { /* already stopped */ }
        old.onended = () => { try { old.disconnect(); } catch { /* nothing */ } };
      }
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.connect(dest);
      startSource(this.ctx, o, at);
      this._oscList[key] = [o];
      this[key] = o;
    };
    switch (this.type) {
      case 'trans': swap('trOsc', 'square', clamp(1 / t, 0.25, 24), this.trOscGain); break;
      case 'flanger': swap('flLfo', 'sine', clamp(0.125 / t, 0.05, 4), this.flLfoGain); break;
      case 'phaser': swap('phLfo', 'sine', clamp(0.25 / t, 0.05, 6), this.phLfoGain); break;
      case 'pan': swap('panLfo', 'sine', clamp(0.5 / t, 0.05, 8), this.panLfoGain); break;
      case 'filter': swap('fxbpLfo', 'sine', clamp(0.5 / t, 0.05, 8), this.fxbpLfoGain); break;
      default: return false;
    }
    this._alignedDur = this.beatDuration;
    return true;
  }

  // Modulation period in BEATS (to choose where to restart)
  modPeriodBeats() {
    const m = this.beats;
    switch (this.type) {
      case 'trans': return m;
      case 'flanger': return 8 * m;
      case 'phaser': return 4 * m;
      case 'pan': case 'filter': return 2 * m;
      default: return null;
    }
  }

  /**
   * Beat multiple of the effect (> 0; typical values: FX_BEATS).
   * @param {number} beats
   */
  setBeats(beats) {
    // web-engine: ex setBeatsMult; non-positive values are ignored
    if (!isNum(beats) || !(beats > 0) || beats === Infinity) return;
    this.beats = beats;
    this._applyTime();
  }

  /**
   * Seconds per beat followed by the effect. tick() overrides it while a
   * reference deck with a BPM exists.
   * @param {number} seconds
   */
  setBeatDuration(seconds) {
    // web-engine: ex setBeatDur; non-positive values are ignored
    if (!isNum(seconds) || !(seconds > 0) || seconds === Infinity) return;
    // 0.05 % threshold (not 2 ms ≈ 0.5 %): an echo locked to a tempo that is
    // off by half a percent drifts with every repeat
    if (Math.abs(seconds - this.beatDuration) < this.beatDuration * 0.0005) return;
    this.beatDuration = seconds;
    this._applyTime();
  }

  _applyTime() {
    const now = this.ctx.currentTime;
    const t = clamp(this.beatDuration * this.beats, 0.02, 3.9);
    // Only the lines ACTUALLY built (the others will be born in
    // time) — and incidentally: 1 to 3 AudioParam events instead of 13
    // (web-engine: each line minus the feedback-loop latency of its kind)
    for (const d of this._delays) d.delayTime.setTargetAtTime(this._delayTime(this._delayKind.get(d) || 'tap', t), now, 0.08);
    // The gate closes/opens at each chosen interval
    this.trOsc.frequency.setTargetAtTime(clamp(1 / t, 0.25, 24), now, 0.05);
    // The modulations follow the tempo
    this.flLfo.frequency.setTargetAtTime(clamp(0.125 / t, 0.05, 4), now, 0.1);
    this.phLfo.frequency.setTargetAtTime(clamp(0.25 / t, 0.05, 6), now, 0.1);
    this.panLfo.frequency.setTargetAtTime(clamp(0.5 / t, 0.05, 8), now, 0.1);
    this.fxbpLfo.frequency.setTargetAtTime(clamp(0.5 / t, 0.05, 8), now, 0.1);
  }

  // web-engine: stops the unit's permanent oscillators (Engine.destroy)
  _dispose() {
    const oscs = new Set([this.flLfo, this.phLfo, this.trOsc, this.panLfo, this.fxbpLfo, this.rmOsc, this.trConst]);
    if (this._oscList) for (const list of Object.values(this._oscList)) for (const o of list) oscs.add(o);
    for (const o of oscs) {
      stopSource(this.ctx, o);
      try { o.disconnect(); } catch { /* nothing */ }
    }
    try { this.input.disconnect(); } catch { /* nothing */ }
    try { this.wet.disconnect(); } catch { /* nothing */ }
    if (this._post) {
      try { this._post.disconnect(); } catch { /* nothing */ }
    }
  }
}
