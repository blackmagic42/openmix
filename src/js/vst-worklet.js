// VST3 INSERT — AudioWorklet side.
//
// Each 128-frame block of the deck is written into a shared ring buffer;
// the native host (native/vsthost) runs the plugin on it from its own
// real-time thread and writes the result into the output ring. The block
// played now is the one written L blocks ago: L covers the sound card's
// callback bursts (Chromium renders ~4 blocks back to back every 10 ms).
// That fixed latency is reported to the engine, which reads the track
// that much ahead — the deck stays on the beat grid.
//
// If the plugin is late (heavy CPU, plugin crashed, slot not attached),
// the DRY sound delayed by the same L blocks is played instead: no hole,
// no timing jump. `mix` blends dry/wet; mix 0 = bypass (latency unchanged,
// so the sync never moves).

const H_IN = 0;
const H_OUT = 1;
const H_UNDER = 3;
const HDR_INTS = 16;

class VstInsertProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }

  constructor(options) {
    super();
    const o = options.processorOptions;
    this.B = o.frames;
    this.N = o.blocks;
    this.L = o.latencyBlocks;
    this.hdr = new Int32Array(o.sab, 0, HDR_INTS);
    const ring = this.N * 2 * this.B;
    this.inRing = new Float32Array(o.sab, HDR_INTS * 4, ring);
    this.outRing = new Float32Array(o.sab, HDR_INTS * 4 + ring * 4, ring);
    this.dry = new Float32Array(ring);
    this.k = Atomics.load(this.hdr, H_IN);
    this.zero = new Float32Array(this.B);
  }

  process(inputs, outputs, parameters) {
    const B = this.B;
    const N = this.N;
    const inp = inputs[0] || [];
    const left = inp[0] || this.zero;
    const right = inp[1] || left;
    const k = this.k;
    const base = ((k % N) + N) % N * 2 * B;
    this.inRing.set(left, base);
    this.inRing.set(right, base + B);
    this.dry.set(left, base);
    this.dry.set(right, base + B);
    // block k is ready for the native thread
    Atomics.store(this.hdr, H_IN, (k + 1) | 0);
    this.k = (k + 1) | 0;

    const out = outputs[0];
    const want = (k - this.L) | 0;
    const wb = ((want % N) + N) % N * 2 * B;
    const done = Atomics.load(this.hdr, H_OUT);
    // processed blocks = done: block `want` is ready when done > want
    const ready = ((done - want) | 0) > 0 && ((k - done) | 0) < N - 1;
    const mix = parameters.mix[0];
    for (let ch = 0; ch < out.length; ch++) {
      const dst = out[ch];
      const off = wb + Math.min(ch, 1) * B;
      if (ready && mix > 0) {
        if (mix >= 1) {
          for (let i = 0; i < B; i++) dst[i] = this.outRing[off + i];
        } else {
          const d = 1 - mix;
          for (let i = 0; i < B; i++) dst[i] = mix * this.outRing[off + i] + d * this.dry[off + i];
        }
      } else {
        for (let i = 0; i < B; i++) dst[i] = this.dry[off + i];
      }
    }
    if (!ready && mix > 0) Atomics.add(this.hdr, H_UNDER, 1);
    return true;
  }
}

registerProcessor('vst-insert', VstInsertProcessor);
