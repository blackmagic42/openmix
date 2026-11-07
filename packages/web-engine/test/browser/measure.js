// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Measurement helpers for the browser suite: event timing, frequency, levels
// and statistics. Pure functions on Float32Arrays (they also run in Node).

/** Median of a list of numbers (NaN when empty). */
export function median(values) {
  return percentile(values, 50);
}

/**
 * Percentile with linear interpolation between order statistics.
 * @param {number[]} values
 * @param {number} p 0..100
 */
export function percentile(values, p) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Arithmetic mean (NaN when empty). */
export function mean(values) {
  if (!values.length) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/**
 * Least-squares line y = slope × x + intercept.
 * @returns {{ slope: number, intercept: number }}
 */
export function linearRegression(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: NaN, intercept: NaN };
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  const slope = sxx > 0 ? sxy / sxx : NaN;
  return { slope, intercept: my - slope * mx };
}

/** RMS of x over [startSec, endSec). */
export function rms(x, sampleRate, startSec = 0, endSec = x.length / sampleRate) {
  const a = Math.max(0, Math.floor(startSec * sampleRate));
  const b = Math.min(x.length, Math.ceil(endSec * sampleRate));
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}

/** Linear amplitude → dBFS (floored at −240 dB for digital silence). */
export function toDb(v) {
  return 20 * Math.log10(Math.max(1e-12, v));
}

/** Largest absolute sample value. */
export function peakAbs(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]);
    if (v > m) m = v;
  }
  return m;
}

/**
 * Detects short events (clicks, kicks) and times them.
 * An event starts when |x| reaches `threshold` × the channel peak; its time is
 * the ENERGY CENTROID of x² over [start − pre, start + post]. The centroid is
 * stable even when an effect smears a transient into several close copies
 * (WSOLA grains), and equals the true time for a symmetric pulse. `onset` is
 * the interpolated threshold crossing, reported as a second opinion.
 * @param {Float32Array} x
 * @param {number} sampleRate
 * @param {{ threshold?: number, refractory?: number, pre?: number, post?: number }} [o]
 * @returns {{ time: number, onset: number, peak: number }[]} times in seconds
 */
export function detectEvents(x, sampleRate, { threshold = 0.2, refractory = 0.05, pre = 0.002, post = 0.006 } = {}) {
  const max = peakAbs(x);
  if (!(max > 0)) return [];
  const th = threshold * max;
  const preN = Math.round(pre * sampleRate);
  const postN = Math.round(post * sampleRate);
  const refrN = Math.max(1, Math.round(refractory * sampleRate));
  const out = [];
  for (let i = 1; i < x.length; i++) {
    const b = Math.abs(x[i]);
    if (b < th) continue;
    const a = Math.abs(x[i - 1]);
    const frac = b > a ? Math.min(1, Math.max(0, (th - a) / (b - a))) : 0;
    const j0 = Math.max(0, i - preN);
    const j1 = Math.min(x.length, i + postN);
    let e = 0;
    let et = 0;
    let peak = 0;
    for (let j = j0; j < j1; j++) {
      const v = x[j] * x[j];
      e += v;
      et += v * j;
      const av = Math.abs(x[j]);
      if (av > peak) peak = av;
    }
    out.push({ time: et / e / sampleRate, onset: (i - 1 + frac) / sampleRate, peak });
    i += refrN;
  }
  return out;
}

/**
 * Pairs every event of `a` inside [from, to] with the nearest event of `b`.
 * @param {{ time: number }[]} a reference events (sorted)
 * @param {{ time: number }[]} b other events (sorted)
 * @param {{ from?: number, to?: number, maxDistance?: number, key?: 'time' | 'onset' }} [o]
 * @returns {{ pairs: { t: number, offset: number }[], unmatched: number, total: number }}
 *   offset = b − a in seconds
 */
export function pairEvents(a, b, { from = -Infinity, to = Infinity, maxDistance = 0.1, key = 'time' } = {}) {
  const pairs = [];
  let unmatched = 0;
  let total = 0;
  let j = 0;
  for (const ea of a) {
    const ta = ea[key];
    if (ta < from || ta > to) continue;
    total++;
    while (j + 1 < b.length && b[j + 1][key] <= ta) j++;
    let best = null;
    for (let k = Math.max(0, j - 1); k <= Math.min(b.length - 1, j + 2); k++) {
      const d = b[k][key] - ta;
      if (best == null || Math.abs(d) < Math.abs(best)) best = d;
    }
    if (best != null && Math.abs(best) <= maxDistance) pairs.push({ t: ta, offset: best });
    else unmatched++;
  }
  return { pairs, unmatched, total };
}

/**
 * Locates isolated impulses with sub-sample precision: the |x|-weighted
 * centroid of the 5 samples around each local maximum (linear interpolation by
 * a resampling source spreads one impulse over two samples).
 * @param {Float32Array} x
 * @param {{ threshold?: number, refractory?: number }} [o] threshold is absolute
 * @returns {{ position: number, sum: number }[]} position in samples, sum = Σ|x| (≈ the impulse amplitude)
 */
export function detectImpulses(x, { threshold = 0.05, refractory = 1000 } = {}) {
  const out = [];
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) < threshold) continue;
    let pk = i;
    for (let j = i; j < Math.min(x.length, i + 4); j++) if (Math.abs(x[j]) > Math.abs(x[pk])) pk = j;
    let w = 0;
    let wp = 0;
    for (let j = Math.max(0, pk - 2); j <= Math.min(x.length - 1, pk + 2); j++) {
      const v = Math.abs(x[j]);
      w += v;
      wp += v * j;
    }
    out.push({ position: wp / w, sum: w });
    i = pk + refractory;
  }
  return out;
}

/**
 * In-place iterative radix-2 complex FFT.
 * @param {Float64Array} re
 * @param {Float64Array} im
 */
export function fft(re, im) {
  const n = re.length;
  if (n & (n - 1)) throw new RangeError('FFT size must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    const wr = Math.cos(step);
    const wi = Math.sin(step);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Deviation of `frequency` from `reference`, in cents. */
export function cents(frequency, reference) {
  return 1200 * Math.log2(frequency / reference);
}

/**
 * Dominant frequency near `expected`, from a Hann-windowed FFT of the largest
 * power-of-two block inside [startSec, endSec), refined by Gaussian
 * (log-parabolic) interpolation of the peak bin. Also returns a zero-crossing
 * estimate over the whole span as a second opinion.
 * @param {Float32Array} x
 * @param {number} sampleRate
 * @param {{ startSec: number, endSec: number, expected: number, rangeCents?: number }} o
 * @returns {{ frequency: number, zeroCrossing: number, fftSize: number }}
 */
export function estimateFrequency(x, sampleRate, { startSec, endSec, expected, rangeCents = 300 }) {
  const a = Math.max(0, Math.floor(startSec * sampleRate));
  const b = Math.min(x.length, Math.floor(endSec * sampleRate));
  let size = 1;
  while (size * 2 <= b - a) size *= 2;
  if (size < 4096) return { frequency: NaN, zeroCrossing: NaN, fftSize: size };
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    re[i] = x[a + i] * w;
  }
  fft(re, im);
  const binHz = sampleRate / size;
  const lo = Math.max(1, Math.floor((expected * Math.pow(2, -rangeCents / 1200)) / binHz));
  const hi = Math.min(size / 2 - 2, Math.ceil((expected * Math.pow(2, rangeCents / 1200)) / binHz));
  let k = lo;
  let best = -1;
  for (let i = lo; i <= hi; i++) {
    const m = re[i] * re[i] + im[i] * im[i];
    if (m > best) { best = m; k = i; }
  }
  const mag = (i) => Math.log(Math.max(1e-300, Math.sqrt(re[i] * re[i] + im[i] * im[i])));
  const y1 = mag(k - 1);
  const y2 = mag(k);
  const y3 = mag(k + 1);
  const den = y1 - 2 * y2 + y3;
  const delta = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y1 - y3)) / den)) : 0;
  const frequency = (k + delta) * binHz;

  // Rising zero crossings, linearly interpolated
  let first = null;
  let last = null;
  let count = 0;
  for (let i = a + 1; i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + (-x[i - 1]) / (x[i] - x[i - 1]);
      if (first == null) first = t;
      last = t;
      count++;
    }
  }
  const zeroCrossing = count > 1 ? ((count - 1) * sampleRate) / (last - first) : NaN;
  return { frequency, zeroCrossing, fftSize: size };
}

/**
 * Amplitude of the sinusoid at exactly `frequency` over [startSec, endSec):
 * a single-bin DFT, 2/N × |Σ x[n] e^(−iωn)|. Exact (no leakage) for tones
 * that make a whole number of cycles in the window.
 * @param {Float32Array} x
 * @param {number} sampleRate
 * @param {number} frequency
 * @param {number} startSec
 * @param {number} endSec
 * @returns {number}
 */
export function toneAmplitude(x, sampleRate, frequency, startSec, endSec) {
  const a = Math.max(0, Math.round(startSec * sampleRate));
  const b = Math.min(x.length, Math.round(endSec * sampleRate));
  if (b <= a) return 0;
  const w = (2 * Math.PI * frequency) / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = a; i < b; i++) {
    re += x[i] * Math.cos(w * i);
    im -= x[i] * Math.sin(w * i);
  }
  return (2 * Math.sqrt(re * re + im * im)) / (b - a);
}

/**
 * Rounds a metric for display and JSON (keeps integers, 4 significant decimals).
 * @param {number} v
 * @param {number} [digits]
 */
export function round(v, digits = 4) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
