// Real-time pitch shifting (WSOLA) — the engine behind KEYLOCK and KEY ±.
//
// Principle: the audio is cut into windowed (Hann) grains that are read back
// FASTER or SLOWER (which raises or lowers the pitch), then stitched back
// together at the ORIGINAL RATE (which preserves the duration). Before placing
// a grain, we look for the spot where its waveform EXACTLY CONTINUES that of
// the previous grain (correlation): that is WSOLA, and it is what avoids the
// doubled / flanged sound of a simple two-tap delay.
//
// TWO RULES that make the difference (v2):
//  1. 50% overlap: each output sample mixes EXACTLY
//     two grains, and those two have been aligned with each other. At 4×
//     (the old version) each grain also overlapped the two before it,
//     never compared: their waveforms partly cancelled out — the "badly
//     layered", slightly flanged sound of KEY +n.
//  2. FIXED and KNOWN LATENCY (LAT samples, announced to the main thread):
//     an event entering at instant i comes out at i + LAT, whatever the
//     ratio, including 1 (plain exact delay). The deck reads its track
//     that far ahead: what we HEAR lands right on the grid. Before, the
//     latency (~110 ms) was not compensated: a deck in KEY or keylock
//     sounded late compared to the others.
//
// Runs in the real-time audio thread: no allocation here.

const N = 1536;          // 32 ms grain: long enough for the bass
const HS = N >> 1;       // hop = half a grain (Hann sums to 1)
const OVL = N - HS;      // overlap zone being compared
const SEARCH = 480;      // ± samples: one full period of 50 Hz
const R_MIN = 0.5;
const R_MAX = 1.8;       // KEY +7 with keylock at −6% ≈ 1.6
// Minimum latency to read a whole grain at the maximum ratio, search
// window included, without ever going past what has already arrived
const LAT = Math.ceil((N * (R_MAX + 1)) / 2 + SEARCH + 16);
const RING = 16384;      // input memory (power of 2)
const ACC = 4096;        // output accumulator (power of 2)
const RM = RING - 1;
const AM = ACC - 1;

class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor(options) {
    super();
    // strength of the alignment penalty (tunable for test benches)
    const po = options && options.processorOptions;
    this.pen = po && po.pen != null ? po.pen : 0.1;
    this.win = new Float32Array(N);
    // PERIODIC Hann: two windows offset by N/2 sum exactly to 1
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.L = { ring: new Float32Array(RING), acc: new Float32Array(ACC) };
    this.R = { ring: new Float32Array(RING), acc: new Float32Array(ACC) };
    this.inW = 0;      // input samples received (absolute)
    this.outP = 0;     // output samples emitted (absolute)
    this.nextG = 0;    // output position of the next grain
    this.prevS = null; // read start of the previous grain
    this.prevR = 1;
    this.port.postMessage({ lat: LAT });
  }

  // Normalized correlation between the natural continuation of the previous
  // grain (cont) and a candidate (s), over the overlap zone, in mono (L+R)
  _score(cont, s, r, step) {
    const rl = this.L.ring;
    const rr = this.R.ring;
    let dot = 0;
    let en = 1e-9;
    let er = 1e-9;
    for (let k = 0; k < OVL; k += step) {
      const pc = (cont + k * r) | 0;
      const ps = (s + k * r) | 0;
      const ref = rl[pc & RM] + rr[pc & RM];
      const v = rl[ps & RM] + rr[ps & RM];
      dot += v * ref;
      en += v * v;
      er += ref * ref;
    }
    // TRULY normalized correlation (−1…1): the offset penalty
    // keeps the same weight whatever the track's volume
    return dot / Math.sqrt(en * er);
  }

  _grain(G, r) {
    // "Ideal" position: the grain's center comes out LAT later
    const S0 = G - LAT - (N * (r - 1)) / 2;
    let S = S0;
    if (this.prevS !== null) {
      const cont = this.prevS + HS * this.prevR;
      if (Math.abs(r - 1) < 1e-4 && Math.abs(this.prevR - 1) < 1e-4 && Math.abs(cont - S0) < 0.5) {
        S = S0; // nothing to shift: plain exact delay, no search
      } else {
        // coarse (step of 4) over the whole window, then fine at 1/1
        let best = 0;
        let bestS = -Infinity;
        // Slight PENALTY on large offsets: without it, on a kick
        // attack, the alignment preferred extending the tail of the previous
        // grain and DELAYED the kick by ~10 ms (measured on the test bench:
        // delay brought down to ±1-4 ms, attack just as sharp)
        for (let d = -SEARCH; d <= SEARCH; d += 4) {
          const sc = this._score(cont, S0 + d, r, 4) - (this.pen * Math.abs(d)) / SEARCH;
          if (sc > bestS) { bestS = sc; best = d; }
        }
        let fine = best;
        let fineS = -Infinity;
        for (let d = best - 3; d <= best + 3; d++) {
          const sc = this._score(cont, S0 + d, r, 2);
          if (sc > fineS) { fineS = sc; fine = d; }
        }
        S = S0 + fine;
      }
    }
    const w = this.win;
    const rl = this.L.ring;
    const rr = this.R.ring;
    const al = this.L.acc;
    const ar = this.R.acc;
    for (let k = 0; k < N; k++) {
      const p = S + k * r;
      const i0 = Math.floor(p);
      const fr = p - i0;
      const j0 = i0 & RM;
      const j1 = (i0 + 1) & RM;
      const o = (G + k) & AM;
      al[o] += (rl[j0] + (rl[j1] - rl[j0]) * fr) * w[k];
      ar[o] += (rr[j0] + (rr[j1] - rr[j0]) * fr) * w[k];
    }
    this.prevS = S;
    this.prevR = r;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const n = output[0].length;
    const inL = input && input[0] ? input[0] : null;
    const inR = input && input[1] ? input[1] : inL;
    let r = params.ratio[0];
    if (!(r > 0)) r = 1;
    r = Math.min(R_MAX, Math.max(R_MIN, r));

    // 1) Input → rings
    const rl = this.L.ring;
    const rr = this.R.ring;
    for (let i = 0; i < n; i++) {
      const p = (this.inW + i) & RM;
      rl[p] = inL ? inL[i] : 0;
      rr[p] = inR ? inR[i] : 0;
    }
    this.inW += n;

    // 2) Grains needed to cover this output block
    while (this.nextG < this.outP + n) {
      this._grain(this.nextG, r);
      this.nextG += HS;
    }

    // 3) Output, and reset of the consumed slots
    const oL = output[0];
    const oR = output[1] || null;
    const aL = this.L.acc;
    const aR = this.R.acc;
    for (let i = 0; i < n; i++) {
      const o = (this.outP + i) & AM;
      oL[i] = aL[o];
      if (oR) oR[i] = aR[o];
      aL[o] = 0;
      aR[o] = 0;
    }
    for (let ci = 2; ci < output.length; ci++) output[ci].set(oL);
    this.outP += n;
    return true;
  }
}

registerProcessor('pitch-shift', PitchProcessor);
