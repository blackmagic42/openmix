// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// High-precision waveforms: real signal envelope (high AND low peak
// per 2.5 ms slice), colored by frequency (lows -> R, mids -> G,
// highs -> B), drawn pixel by pixel (no big blocks).

import { isAudioBufferLike } from '../util.js';

/**
 * Computes the 3-band peaks of a track (ex computeBandPeaks).
 * @param {AudioBuffer} buffer
 * @param {{ perSecond?: number, fine?: boolean }} [options] perSecond default 400;
 *   fine default true (4000 points/s fine envelope for deep zooms)
 * @returns {Promise<object>} Peaks
 */
export async function computePeaks(buffer, options = {}) {
  if (!isAudioBufferLike(buffer)) throw new TypeError('computePeaks: expected an AudioBuffer');
  const o = options || {};
  const perSecond = typeof o.perSecond === 'number' && o.perSecond > 0 && o.perSecond !== Infinity ? o.perSecond : 400;
  const OAC = globalThis.OfflineAudioContext;
  if (typeof OAC !== 'function') throw new Error('computePeaks needs OfflineAudioContext');
  // Render the 3 bands at 16 kHz: enough for the color, 3x less memory
  const bandSr = 16000;
  // web-engine: at least 1 frame (an empty buffer must not throw)
  const off = new OAC(3, Math.max(1, Math.ceil(buffer.duration * bandSr)), bandSr);
  const src = off.createBufferSource();
  src.buffer = buffer;

  const low = off.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 200;

  const mid = off.createBiquadFilter();
  mid.type = 'bandpass';
  mid.frequency.value = 630;   // geometric center of 200–2000 Hz
  mid.Q.value = 0.35;

  const high = off.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = 2000;

  const merger = off.createChannelMerger(3);
  src.connect(low);
  src.connect(mid);
  src.connect(high);
  low.connect(merger, 0, 0);
  mid.connect(merger, 0, 1);
  high.connect(merger, 0, 2);
  merger.connect(off.destination);
  src.start(0);

  const rendered = await off.startRendering();
  const chans = [rendered.getChannelData(0), rendered.getChannelData(1), rendered.getChannelData(2)];
  const orig = buffer.getChannelData(0);
  const orig2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : orig;

  const total = Math.max(1, Math.ceil(buffer.duration * perSecond));
  // EXACT-TIME SLICING: a WHOLE number of samples per slice
  // (the old floor) accumulated ~0.23% drift — the wave slid to
  // the right along the track ("the bass starts at the red line but
  // shows up after it"). Each slice is bounded by round(b × sr / pps).
  const sr = buffer.sampleRate;

  // Real envelope: signed min and max of the signal per slice
  const top = new Float32Array(total);
  const bottom = new Float32Array(total);
  const bands = [new Float32Array(total), new Float32Array(total), new Float32Array(total)];

  for (let b = 0; b < total; b++) {
    let start = Math.round(b * sr / perSecond);
    let end = Math.min(Math.round((b + 1) * sr / perSecond), orig.length);
    let hi = 0;
    let lo = 0;
    for (let i = start; i < end; i++) {
      // Envelope PER CHANNEL (no L+R average: on stereo tracks in
      // phase opposition — typical of drops — the sum CANCELS OUT and
      // the drop looked silent on screen)
      const a = orig[i];
      const c2 = orig2[i];
      const mx = a > c2 ? a : c2;
      const mn = a < c2 ? a : c2;
      if (mx > hi) hi = mx;
      if (mn < lo) lo = mn;
    }
    top[b] = hi;
    bottom[b] = lo;

    start = Math.round(b * bandSr / perSecond);
    end = Math.min(Math.round((b + 1) * bandSr / perSecond), chans[0].length);
    for (let c = 0; c < 3; c++) {
      const d = chans[c];
      let m = 0;
      for (let i = start; i < end; i++) {
        const v = Math.abs(d[i]);
        if (v > m) m = v;
      }
      bands[c][b] = m;
    }
  }

  // FINE envelope (4000 pts/s, stored as Int8: ~2 MB for 4 min) —
  // computed ONCE here so that drawing when zoomed in no longer re-reads
  // the raw samples every frame (that brought old machines to their
  // knees: choppy waves, stuttering audio)
  const FINE_PPS = 4000;
  // options.fine === false: the caller (library thumbnail, 150 px)
  // does NOT use it — saves ~1 million slices and 2 MB per
  // track during the scan
  const fineTotal = o.fine === false ? 0 : Math.max(1, Math.ceil(buffer.duration * FINE_PPS));
  const fineTop = new Int8Array(fineTotal);
  const fineBottom = new Int8Array(fineTotal);
  for (let b = 0; b < fineTotal; b++) {
    // same anti-drift rule: exact-time bounds
    const start = Math.round(b * sr / FINE_PPS);
    const end = Math.min(Math.round((b + 1) * sr / FINE_PPS), orig.length);
    let hi = 0;
    let lo = 0;
    for (let i = start; i < end; i++) {
      // Same rule as the main envelope: per channel, never an
      // average (phase cancellation hid the drops)
      const a = orig[i];
      const c2 = orig2[i];
      const mx = a > c2 ? a : c2;
      const mn = a < c2 ? a : c2;
      if (mx > hi) hi = mx;
      if (mn < lo) lo = mn;
    }
    fineTop[b] = Math.max(-127, Math.min(127, Math.round(hi * 127)));
    fineBottom[b] = Math.max(-127, Math.min(127, Math.round(lo * 127)));
  }

  return {
    top, bottom,
    low: bands[0], mid: bands[1], high: bands[2],
    fineTop, fineBottom, finePps: fineTotal ? FINE_PPS : 0,
    perSecond,
    duration: buffer.duration
  };
}
