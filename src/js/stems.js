// Stems of a deck (vocals / drums / bass / other from the AI separation):
// decoding a separated set, merging bass + other into the INST stem, and
// aligning the stems to the track sample-exactly. Shared by app.js (ensureStems)
// and by the native engine's fallback to the Web engine, which rebuilds the
// stems from the cached separation (native/engine/SPEC.md §17.1, §17.8).
// Owner: jsproxy. Nothing here touches a browser global at import time.
//
// RAM phase 3 (planned, §17.8): when the renderer stops keeping the track's
// samples, alignStems needs another reference than deck.buffer: either a
// decimated mono copy kept at load time (the coarse search already works on
// x8-decimated sums; the fine +-8-sample step then runs on the stems against
// that copy, ~1/16 of the stereo float32 track), or an engine request
// returning the middle 4 s window of the track (like the shadow decoder's
// reference window). Until then decodeStemSet takes the AudioBuffer.

// ALIGNING THE STEMS TO THE TRACK. Demucs decodes the mp3 with ffmpeg, the
// app with Chromium's decoder: depending on the encoder, the two
// timelines differ by a few tens of ms (LAME encoder delay).
// Without correction, enabling VOX/DRM/INST shifted the sound off the grid and
// the sync. We measure the offset by cross-correlation (sum of stems ≈ track)
// and shift the stem buffers to the exact sample.
export function alignStems(orig, bufs) {
  const sr = orig.sampleRate;
  const n = Math.min(orig.length, ...bufs.map((b) => b.length));
  if (n < sr * 12) return 0;
  // We ONLY work on a window in the middle of the track (4 s + margins):
  // a few milliseconds of computation, no UI freeze
  const D = 8;
  const maxLag = Math.floor(0.12 * sr);
  const win = Math.floor(4 * sr);
  const r0 = Math.floor(n / 2) - (win >> 1) - maxLag - 2 * D;
  const len = win + 2 * maxLag + 4 * D;
  if (r0 < 0 || r0 + len > n) return 0;
  const o = orig.getChannelData(0).subarray(r0, r0 + len);
  const sum = new Float32Array(len);
  for (const b of bufs) {
    const c = b.getChannelData(0).subarray(r0, r0 + len);
    for (let k = 0; k < len; k++) sum[k] += c[k];
  }
  const from = maxLag + 2 * D; // start of the useful window within the region
  const corrAt = (a, b, f, l, lag) => {
    let acc = 0;
    for (let k = f; k < f + l; k++) acc += a[k] * b[k + lag];
    return acc;
  };
  // 1) coarse: decimated ×8, ±120 ms
  const dec = (src) => {
    const out = new Float32Array(Math.floor(len / D));
    for (let k = 0; k < out.length; k++) {
      let s2 = 0;
      for (let j = 0; j < D; j++) s2 += src[k * D + j];
      out[k] = s2;
    }
    return out;
  };
  const oD = dec(o);
  const sD = dec(sum);
  let best = 0;
  let bestV = -Infinity;
  const mD = Math.floor(maxLag / D);
  for (let L = -mD; L <= mD; L++) {
    const v = corrAt(oD, sD, Math.floor(from / D), Math.floor(win / D), L);
    if (v > bestV) { bestV = v; best = L * D; }
  }
  // 2) fine: to the exact sample, ±D around, over 1 s
  let fine = best;
  let fineV = -Infinity;
  for (let L = best - D; L <= best + D; L++) {
    const v = corrAt(o, sum, from, Math.floor(sr), L);
    if (v > fineV) { fineV = v; fine = L; }
  }
  if (!fine) return 0;
  // stem[k + fine] ≈ track[k]: shift the stems by "fine" samples
  for (const b of bufs) {
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      if (fine > 0) {
        d.copyWithin(0, fine);
        d.fill(0, d.length - fine);
      } else {
        d.copyWithin(-fine, 0, d.length + fine);
        d.fill(0, 0, -fine);
      }
    }
  }
  return fine / sr;
}

/** INST = bass + melodies: muted and restored together, so merged into one buffer (−25 % memory). */
export function mergeInto(bass, other) {
  for (let c = 0; c < bass.numberOfChannels; c++) {
    const a = bass.getChannelData(c);
    const b = other.getChannelData(Math.min(c, other.numberOfChannels - 1));
    const n = Math.min(a.length, b.length);
    for (let k = 0; k < n; k++) a[k] += b[k];
  }
  return bass;
}

/**
 * Decodes a separated set ({vocals, drums, bass, other} file paths, as
 * returned by window.api.stemsSeparate), merges bass + other and aligns the
 * three stems to `orig` (the track's AudioBuffer).
 *   ctx: anything with decodeAudioData (an AudioContext or engine.ctx)
 *   opts.orig: the track buffer (no alignment without it)
 *   opts.readFile: (path) -> Promise<Uint8Array> (default window.api.readFile)
 *   opts.isCancelled: () -> bool, checked after the decode
 * Resolves with { stems: {vocals, drums, bass, other: null}, lag } (lag in
 * seconds, 0 when nothing was shifted) or null when cancelled.
 */
export async function decodeStemSet(paths, ctx, opts = {}) {
  const readFile = opts.readFile || ((p) => globalThis.window.api.readFile(p));
  const decode = async (file) => {
    const raw = await readFile(file);
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    return ctx.decodeAudioData(ab);
  };
  const [vocals, drums, bass, other] = await Promise.all(
    ['vocals', 'drums', 'bass', 'other'].map((k) => decode(paths[k])));
  mergeInto(bass, other);
  if (opts.isCancelled && opts.isCancelled()) return null;
  const lag = opts.orig ? alignStems(opts.orig, [vocals, drums, bass]) : 0;
  return { stems: { vocals, drums, bass, other: null }, lag };
}
