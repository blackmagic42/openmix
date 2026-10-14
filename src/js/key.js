// Detection of a track's KEY, and harmonic mixing tools
// (Camelot wheel). Principle: spectrum of the whole track → "chroma" (energy
// of each of the 12 notes, all octaves combined) → correlation with the
// major and minor key profiles → the most likely key.
//
// Each frame is normalized (a melodic break counts as much as a drop)
// and silences/fades are discarded.

const SR = 8000;         // the chroma only needs 65 Hz – 2 kHz
const N = 8192;          // ~1 Hz per bin: separates the low notes
const HOP = 4096;
const MAX_FRAMES = 1400; // ~12 min analyzed at the full hop, sampled beyond that
const MIDI_LO = 36;      // C2 (65 Hz)
const SEMIS = 60;        // 5 octaves: C2 → B6
const SUB = 3;           // 3 sub-bins per semitone (tuning to ±1/3)
const NB = SEMIS * SUB;

// KeyFinder key profiles (Ibrahim Sha'ath — the ones used by Mixxx and
// most DJ software), with a slight MINOR BIAS: electronic
// music is overwhelmingly in minor keys. Settings chosen on a
// test bench against rekordbox analyses of real tracks (16/28
// identical, 19/28 harmonically compatible — versus 4/28 before).
const PROFILES = {
  major: [7.23900502618145, 3.5035183304246, 3.5844599761337, 2.84511477063833,
    5.81898391564628, 4.55865043428244, 2.4477861994943, 6.99473684210526,
    3.39106280193237, 4.55614242247193, 4.0739247311828, 4.45932095553986],
  minor: [7.00255325900951, 3.14360210696459, 4.35904551201406, 5.4041866908751,
    3.67234855610808, 4.08971222914409, 3.9079187555457, 6.2068325136939,
    3.63167721694189, 2.87065311391596, 5.35643002212298, 3.83555012908213]
};
const MINOR_BIAS = 0.1;

// --- In-place radix-2 FFT (tables precomputed once) ---
let fftTables = null;
function tables() {
  if (fftTables) return fftTables;
  const rev = new Uint32Array(N);
  const bits = Math.log2(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(N / 2);
  const sin = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / N);
    sin[i] = -Math.sin((2 * Math.PI * i) / N);
  }
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  // FFT bin → two neighboring semitone sub-bins (linear
  // interpolation: a note between two bins is not lost)
  const kMax = Math.min(N / 2 - 1, Math.ceil((440 * Math.pow(2, (MIDI_LO + SEMIS - 69) / 12) * N) / SR) + 2);
  const binJ = new Int16Array(kMax + 1).fill(-1);
  const binW = new Float32Array(kMax + 1);
  for (let k = 2; k <= kMax; k++) {
    const f = (k * SR) / N;
    const midi = 69 + 12 * Math.log2(f / 440);
    // sub-bin j: center = MIDI_LO + (j − 1)/3 → j = 3s + 1 lands exactly on the note
    const u = (midi - MIDI_LO) * SUB + 1;
    const j0 = Math.floor(u);
    if (j0 < -1 || j0 >= NB) continue;
    binJ[k] = j0;
    binW[k] = u - j0;
  }
  fftTables = { rev, cos, sin, win, binJ, binW, kMax };
  return fftTables;
}

function fft(re, im, T) {
  const { rev, cos, sin } = T;
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

function pearson(a, b) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// Chroma → key. Returns { code, confidence } with code = tonic
// (0 = C … 11 = B) + 12 if MINOR.
export function keyFromChroma(chroma) {
  const scores = [];
  for (let mode = 0; mode < 2; mode++) {
    const p = mode ? PROFILES.minor : PROFILES.major;
    for (let t = 0; t < 12; t++) {
      const rot = new Array(12);
      for (let i = 0; i < 12; i++) rot[i] = p[(i - t + 12) % 12];
      scores.push({ code: t + mode * 12, s: pearson(chroma, rot) + (mode ? MINOR_BIAS : 0) });
    }
  }
  scores.sort((a, b) => b.s - a.s);
  return { code: scores[0].code, confidence: scores[0].s - scores[1].s, score: scores[0].s };
}

// Core computation on a MONO signal sampled at 8 kHz. `yieldEvery`:
// yields to the browser every N frames (no UI freeze).
export async function keyFromMono(x, sr = SR, yieldEvery = 0) {
  if (sr !== SR) throw new Error('keyFromMono: expected an 8 kHz signal');
  const T = tables();
  const total = Math.floor((x.length - N) / HOP) + 1;
  if (total < 8) return null;
  const stride = Math.max(1, total / MAX_FRAMES);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const S = new Float64Array(NB);
  const C36 = new Float64Array(SUB * 12);
  // Each frame → its normalized contribution (36 sub-bins) and its
  // spectral energy; silences/fades (< 10 % of the median) are
  // discarded at the end
  const contrib = [];
  const energy = [];
  let done = 0;
  for (let f = 0; f < total; f += stride) {
    const o = Math.floor(f) * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = x[o + i] * T.win[i];
      im[i] = 0;
    }
    fft(re, im, T);
    S.fill(0);
    for (let k = 2; k <= T.kMax; k++) {
      const j = T.binJ[k];
      if (j < -1) continue;
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const w = T.binW[k];
      if (j >= 0) S[j] += m * (1 - w);
      if (j + 1 < NB) S[j + 1] += m * w;
    }
    let sum = 0;
    for (let j = 0; j < NB; j++) sum += S[j];
    if (sum > 0) {
      // every frame weighs the same: a melodic break counts as much as a
      // drop (no whitening: on the test bench, it made the result worse)
      const c = new Float32Array(SUB * 12);
      for (let j = 0; j < NB; j++) c[j % (SUB * 12)] += S[j] / sum;
      contrib.push(c);
      energy.push(sum);
    }
    done++;
    if (yieldEvery && done % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const med = [...energy].sort((p, q) => p - q)[energy.length >> 1] || 0;
  let used = 0;
  for (let n = 0; n < contrib.length; n++) {
    if (energy[n] < med * 0.1) continue; // silence / fade
    for (let j = 0; j < SUB * 12; j++) C36[j] += contrib[n][j];
    used++;
  }
  if (used < 4) return null;
  // TUNING: the sub-bin offset (−1/3, 0, +1/3 of a semitone) that
  // concentrates the most energy — a track tuned to 432 Hz or slowed down
  // is still read in the right key
  let off = 1;
  let best = -1;
  for (let o = 0; o < SUB; o++) {
    let e = 0;
    for (let c = 0; c < 12; c++) e += C36[c * SUB + o];
    if (e > best) { best = e; off = o; }
  }
  // C36 indexed from C2: bin c*3+off is note c (0 = C)
  const chroma = new Array(12);
  for (let c = 0; c < 12; c++) chroma[c] = C36[c * SUB + off];
  const res = keyFromChroma(chroma);
  return { ...res, tuning: (off - 1) / SUB };
}

// Browser version: native resampling to 8 kHz mono (off the main
// thread), then a chunked computation so the UI never freezes.
export async function detectKey(buffer) {
  const dur = Math.min(buffer.duration, 900);
  const off = new OfflineAudioContext(1, Math.ceil(dur * SR), SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  return keyFromMono(rendered.getChannelData(0), SR, 12);
}

// --- Notation and Camelot wheel ---
const NAMES_MAJ = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const NAMES_MIN = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

// code 0..23 → { num 1..12, letter 'A' (minor) | 'B' (major) }
export function camelot(code) {
  if (code == null || code < 0) return null;
  const minor = code >= 12;
  const t = code % 12;
  // the relative major of a minor key has the same number
  const maj = minor ? (t + 3) % 12 : t;
  const num = ((maj * 7) % 12 + 7) % 12 + 1; // C major = 8B
  return { num, letter: minor ? 'A' : 'B' };
}

export function camelotLabel(code) {
  const c = camelot(code);
  return c ? `${c.num}${c.letter}` : '';
}

export function keyName(code) {
  if (code == null || code < 0) return '';
  return code >= 12 ? NAMES_MIN[code % 12] : NAMES_MAJ[code % 12];
}

// Transpose a key by n semitones
export function shiftKey(code, semis) {
  if (code == null || code < 0) return code;
  const minor = code >= 12;
  const t = (((code % 12) + Math.round(semis)) % 12 + 12) % 12;
  return t + (minor ? 12 : 0);
}

// Harmonic compatibility (Camelot wheel): 0 = same key,
// 1 = direct neighbor (±1 or relative), 2 = ±2 / diagonal ("energy"),
// 3 = dissonant
export function keyDistance(a, b) {
  const ca = camelot(a);
  const cb = camelot(b);
  if (!ca || !cb) return null;
  const dn = Math.min((ca.num - cb.num + 12) % 12, (cb.num - ca.num + 12) % 12);
  if (ca.letter === cb.letter) return dn === 0 ? 0 : dn === 1 ? 1 : dn === 2 ? 2 : 3;
  if (dn === 0) return 1;
  if (dn === 1) return 2;
  return 3;
}

// The key a deck is HEARD in: the track's key + KEY transposition
// + the effect of tempo when keylock is off (speeding up = pitching up).
// Returns { code, cents } — cents = deviation from the in-tune note (±50).
export function heardKey(deck) {
  if (deck.musicKey == null) return null;
  let semis = deck.keyShift || 0;
  if (!deck.keylock && deck.tempo) semis += 12 * Math.log2(deck.tempo);
  const r = Math.round(semis);
  return { code: shiftKey(deck.musicKey, r), cents: Math.round((semis - r) * 100) };
}
