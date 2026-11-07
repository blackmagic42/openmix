// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Real-time pitch shifter (two delay lines swept as sawtooth waves and
// crossfaded): changes the key without changing the speed.
// Used when AudioWorklet is unavailable (insecure context, old browser) or
// disabled (engine option keylock: false): lower quality than the WSOLA
// worklet, and no read-ahead (no latency compensation).

import { startSource, stopSource } from './util.js';

export class PitchShifter {
  constructor(ctx) {
    this.ctx = ctx;
    this.T = 0.1;      // grain duration (s)
    this.base = 0.006; // minimum delay
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dA = ctx.createDelay(1);
    this.dB = ctx.createDelay(1);
    this.fA = ctx.createGain();
    this.fA.gain.value = 0;
    this.fB = ctx.createGain();
    this.fB.gain.value = 0;
    this.mA = ctx.createGain();
    this.mA.gain.value = 0;
    this.mB = ctx.createGain();
    this.mB.gain.value = 0;
    this.input.connect(this.dA);
    this.input.connect(this.dB);
    this.dA.connect(this.fA);
    this.dB.connect(this.fB);
    this.fA.connect(this.output);
    this.fB.connect(this.output);

    // web-engine: the looping sources are kept so destroy() can stop them
    this._sources = [];
    const mkSrc = (tri, phase, target) => {
      const sr = ctx.sampleRate;
      const len = Math.max(8, Math.round(this.T * sr));
      const buf = ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const ph = (i / len + phase) % 1;
        d[i] = tri ? 1 - Math.abs(2 * ph - 1) : ph;
      }
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.connect(target);
      // web-engine: on a context that has not started yet, on its first
      // 'running' state (no autoplay warning, see util.js)
      startSource(ctx, s);
      this._sources.push(s);
    };
    mkSrc(false, 0, this.mA);
    this.mA.connect(this.dA.delayTime);
    mkSrc(false, 0.5, this.mB);
    this.mB.connect(this.dB.delayTime);
    mkSrc(true, 0, this.fA.gain);
    mkSrc(true, 0.5, this.fB.gain);
    this.dA.delayTime.value = this.base;
    this.dB.delayTime.value = this.base;
  }

  // r = frequency ratio (2^(semitones/12))
  setRatio(r) {
    const now = this.ctx.currentTime;
    const D = (1 - r) * this.T;
    const base = this.base + Math.max(0, -D);
    this.dA.delayTime.setTargetAtTime(base, now, 0.02);
    this.dB.delayTime.setTargetAtTime(base, now, 0.02);
    this.mA.gain.setTargetAtTime(D, now, 0.02);
    this.mB.gain.setTargetAtTime(D, now, 0.02);
  }

  _dispose() {
    for (const s of this._sources) {
      stopSource(this.ctx, s);
      try { s.disconnect(); } catch { /* nothing */ }
    }
    this._sources = [];
    try { this.output.disconnect(); } catch { /* nothing */ }
  }
}
