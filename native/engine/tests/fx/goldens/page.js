// Renders of the FX golden suite (owner: fx), run inside the hidden page of
// make_fx_goldens.js: OfflineAudioContext only (silent). For every case it
// writes, in the output folder:
//   <case>.input.wav   the stereo signal fed to the unit (float32)
//   <case>.wav         Chromium's output (float32)
//   <case>.json        unit kind, rate, impulse, parameter events (frames),
//                      compareFrames (first-repeat cases)
// and manifest.json (case list, Chromium version, measured feedback-cycle
// latency). Beat-FX cases use engine.js's own FxUnit, except the feedback
// echoes, deliberately drift-free in the native engine (SPEC.md §20):
//  - "compensated": the engine.js graphs with Chromium's one-quantum latency
//    per trip around a DelayNode cycle compensated (loop delay minus the
//    measured latency, the same latency added after the loop, a single entry
//    into every cycle), at integer delays so that the single-precision read
//    positions of DelayNode do not depend on the different geometry;
//  - "first_*": engine.js's own graphs at fractional delays, compared up to
//    their first repeat (Chromium's drift starts with the second).
// The input source is kept pulled (Chromium stops a source nothing pulls).
// Diagnostic modes (--probe-delay / --probe-osc / --probe-param in
// make_fx_goldens.js) measure the Chromium details the native fx reproduces.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ipcRenderer } = require('electron');

const q = new URLSearchParams(location.search);
const OUT = q.get('out');
const ROOT = q.get('root');
const ONLY = q.get('only') || '';
const log = (m) => ipcRenderer.send('log', m);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function writeWav(file, channels, sampleRate) {
  const n = channels[0].length;
  const ch = channels.length;
  const dataBytes = n * ch * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);  // IEEE float
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * ch * 4, 28);
  buf.writeUInt16LE(ch * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      buf.writeFloatLE(channels[c][i], o);
      o += 4;
    }
  }
  fs.writeFileSync(file, buf);
}

// om::makeImpulse's generator: xorshift32, uniform = x / 2^32, sample =
// (u * 2 - 1) * (1 - i / len)^decay, left then right (NOT normalized here:
// the ConvolverNode normalizes it, as for engine.js makeImpulse).
function seededImpulse(ctx, seconds, decay, seed) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s / 4294967296;
  };
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (next() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

// engine.js crushCurve (verbatim)
function crushCurve(steps) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

// Deterministic stereo test signal: silence for `lead` s, then a noise burst
// (L) with a chirp (R), tone bursts, clicks and a centred noise burst.
function makeInput(frames, rate, seed, lead) {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  let x = (seed >>> 0) || 0x9e3779b9;
  const rnd = () => {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    return x / 4294967296;
  };
  const at = (sec) => Math.round((lead + sec) * rate);
  const fade = (i, a, b, f) => {
    const k = Math.min(i - a, b - 1 - i);
    return k < f ? 0.5 - 0.5 * Math.cos((Math.PI * k) / f) : 1;
  };
  {
    const a = at(0), b = at(0.25), f = Math.round(0.003 * rate);
    for (let i = a; i < b && i < frames; i++) {
      const w = fade(i, a, b, f);
      const t = (i - a) / rate;
      L[i] = 0.4 * w * (rnd() * 2 - 1);
      R[i] = 0.4 * w * Math.sin(2 * Math.PI * (100 * t + 7800 * t * t));  // 100 Hz -> 4 kHz
    }
  }
  {
    const a = at(0.6), b = at(0.8), f = Math.round(0.005 * rate);
    for (let i = a; i < b && i < frames; i++) {
      const w = fade(i, a, b, f);
      const t = (i - a) / rate;
      L[i] = 0.3 * w * Math.sin(2 * Math.PI * 440 * t);
      R[i] = 0.3 * w * Math.sin(2 * Math.PI * 1000 * t);
    }
  }
  if (at(1.2) < frames) L[at(1.2)] = 0.5;
  if (at(1.25) < frames) R[at(1.25)] = -0.5;
  {
    const a = at(1.6), b = at(1.7), f = Math.round(0.002 * rate);
    for (let i = a; i < b && i < frames; i++) {
      const v = 0.3 * fade(i, a, b, f) * (rnd() * 2 - 1);
      L[i] = v;
      R[i] = v;
    }
  }
  return [L, R];
}

// Chromium's feedback-cycle latency (as measured by the web engine): a
// single-delay loop, impulse in; the first pass and each further trip.
async function probeLoopLatency(rate) {
  const D = 256;
  const LEN = 4 * D;
  const ctx = new OfflineAudioContext(1, LEN, rate);
  const imp = ctx.createBuffer(1, 1, rate);
  imp.getChannelData(0)[0] = 1;
  const src = ctx.createBufferSource();
  src.buffer = imp;
  const d = ctx.createDelay(1);
  d.delayTime.value = D / rate;
  const g = ctx.createGain();
  g.gain.value = 0.5;
  src.connect(d);
  d.connect(ctx.destination);
  d.connect(g);
  g.connect(d);
  src.start(0);
  const x = (await ctx.startRendering()).getChannelData(0);
  const arrival = (n) => {
    let best = -1;
    let bestV = 0;
    for (let i = Math.max(0, n * D - 8); i < Math.min(x.length, n * D + D - 8); i++) {
      const v = Math.abs(x[i]);
      if (v > bestV) {
        bestV = v;
        best = i;
      }
    }
    return bestV > 0.1 ? best : null;
  };
  const first = arrival(1);
  const second = arrival(2);
  return { firstPass: first - D, perTrip: second - first - D };
}

// Diagnostic (--probe-delay): precision of DelayNode's fractional read in
// each of Chromium's processing paths (static delayTime, automated, after the
// automation converged, AudioParam input). One click late in the buffer, one
// delay, and the two output samples it lands on give the interpolation factor
// Chromium used, against the exact fraction.
async function probeDelayPrecision(rate) {
  const D = 11612.902879714966;  // frames (a float delay time at 48 kHz)
  const c0 = 150000;
  const N = c0 + Math.ceil(D) + 512;
  const rows = [];
  for (const mode of ['static', 'setValueAtTime', 'converged', 'linearRamp', 'connected', 'static-cycle']) {
    const ctx = new OfflineAudioContext(1, N, rate);
    const imp = ctx.createBuffer(1, N, rate);
    imp.getChannelData(0)[c0] = 1;
    const src = ctx.createBufferSource();
    src.buffer = imp;
    const d = ctx.createDelay(4);
    const sec = D / rate;
    if (mode === 'static' || mode === 'static-cycle') d.delayTime.value = sec;
    if (mode === 'setValueAtTime') d.delayTime.setValueAtTime(sec, 0);
    if (mode === 'linearRamp') {
      d.delayTime.setValueAtTime(sec + 0.01, 0);
      d.delayTime.linearRampToValueAtTime(sec, 1.0);  // over long before the click
    }
    if (mode === 'converged') {
      d.delayTime.value = sec + 0.01;
      d.delayTime.setTargetAtTime(sec, 0, 0.08);  // converged long before the click
    }
    if (mode === 'connected') {
      d.delayTime.value = sec;
      const k = ctx.createConstantSource();
      k.offset.value = 0;
      k.connect(d.delayTime);
      k.start(0);
    }
    src.connect(d);
    d.connect(ctx.destination);
    if (mode === 'static-cycle') {
      const g = ctx.createGain();
      g.gain.value = 0;  // a cycle that adds nothing
      d.connect(g);
      g.connect(d);
    }
    src.start(0);
    const y = (await ctx.startRendering()).getChannelData(0);
    let k = 0;
    for (let i = 0; i < N; i++) if (Math.abs(y[i]) > Math.abs(y[k])) k = i;
    const a = y[k - 1], b = y[k], c = y[k + 1];
    const pair = Math.abs(a) > Math.abs(c) ? [k - 1, a, b] : [k, b, c];
    const f = pair[2];  // weight on the later sample
    const exact = (c0 + D) - Math.floor(c0 + D);
    rows.push(`${mode}: taps ${pair[0]}/${pair[0] + 1} weights ${pair[1].toFixed(8)} ${pair[2].toFixed(8)} -> factor ${f.toFixed(8)} (exact ${exact.toFixed(8)}, x32 = ${(f * 32).toFixed(4)})`);
  }
  return rows;
}

// engine.js FxUnit for the feedback echoes (echo, delay, pingpong, lowcut,
// spiral, upecho, downecho, helix) and mtdelay, with Chromium's per-trip
// latency Q compensated: the loop DelayNode reads t - Q, a per-chain
// DelayNode(Q) after the chain completes the first pass, every cycle is
// entered at one node (ping-pong: L -> R(t - Q) -> fb -> L, the right tap
// taken by its own DelayNode(t) outside the cycle). Same parameters, taus and
// routing as engine.js (lazy chains, frozen when not routed).
class CompUnit {
  constructor(ctx, output, Q) {
    this.ctx = ctx;
    this.Q = Q;
    this.input = ctx.createGain();
    this.wet = ctx.createGain();
    this.level = 0;
    this.wet.gain.value = this.level;
    this.wet.connect(output);
    this.enabled = false;
    this.type = 'echo';
    this.beatDur = 0.5;
    this.beatsMult = 0.5;
    this.echoDelay = ctx.createDelay(4);
    this.echoDelay.delayTime.value = 0.25 - Q;
    this.echoHp = ctx.createBiquadFilter();
    this.echoHp.type = 'highpass';
    this.echoHp.frequency.value = 120;
    this.echoFb = ctx.createGain();
    this.echoFb.gain.value = 0.45;
    this.echoDelay.connect(this.echoHp);
    this.echoHp.connect(this.echoFb);
    this.echoFb.connect(this.echoDelay);
    this.echoPost = this._post(this.echoDelay);
    this._delays = [{ d: this.echoDelay, kind: 'loop' }];
    this._lazy = {};
    this._fbs = [{ g: this.echoFb, base: 0.45 }];
    this._mute = ctx.createGain();
    this._mute.gain.value = 0;
    this._out = null;
    this._route();
  }
  _post(from) {
    const p = this.ctx.createDelay(1);
    p.delayTime.value = this.Q;
    from.connect(p);
    return p;
  }
  _timeNow() { return clamp(this.beatDur * this.beatsMult, 0.02, 3.9); }
  _time(kind, t) { return kind === 'loop' ? t - this.Q : t; }
  _fbFor(base) { return Math.min(0.97, base * (0.55 + 0.45 * this.level)); }
  _mk(key, build) {
    let v = this._lazy[key];
    if (!v) v = this._lazy[key] = build();
    return v;
  }
  _echo(opts, postFromFilter) {
    const ctx = this.ctx;
    const d = ctx.createDelay(4);
    d.delayTime.value = this._timeNow() - this.Q;
    const g = ctx.createGain();
    g.gain.value = this._fbFor(opts.fb);
    let node = d;
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = opts.filter.type;
      f.frequency.value = opts.filter.freq;
      if (opts.filter.q) f.Q.value = opts.filter.q;
      node.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(d);
    this._delays.push({ d, kind: 'loop' });
    this._fbs.push({ g, base: opts.fb });
    const post = this._post(postFromFilter ? node : d);
    return { in: d, out: post };
  }
  _chain() {
    const ctx = this.ctx;
    switch (this.type) {
      case 'delay': {
        const c = this._mk('delay', () => {
          const n = ctx.createDelay(4);
          n.delayTime.value = this._timeNow() - this.Q;
          const fb = ctx.createGain();
          fb.gain.value = this._fbFor(0.22);
          n.connect(fb);
          fb.connect(n);
          this._delays.push({ d: n, kind: 'loop' });
          this._fbs.push({ g: fb, base: 0.22 });
          return { in: n, out: this._post(n) };
        });
        return [c.in, c.out];
      }
      case 'pingpong': {
        const p = this._mk('pingpong', () => {
          const t = this._timeNow();
          const L = ctx.createDelay(4);
          const R = ctx.createDelay(4);
          const Rtap = ctx.createDelay(4);
          L.delayTime.value = t;
          R.delayTime.value = t - this.Q;
          Rtap.delayTime.value = t;
          const fb = ctx.createGain();
          fb.gain.value = this._fbFor(0.42);
          this._fbs.push({ g: fb, base: 0.42 });
          const pL = ctx.createStereoPanner();
          pL.pan.value = -0.85;
          const pR = ctx.createStereoPanner();
          pR.pan.value = 0.85;
          const out = ctx.createGain();
          L.connect(pL); pL.connect(out);
          L.connect(R);
          R.connect(fb); fb.connect(L);
          L.connect(Rtap); Rtap.connect(pR); pR.connect(out);
          this._delays.push({ d: L, kind: 'tap' }, { d: R, kind: 'loop' }, { d: Rtap, kind: 'tap' });
          return { in: L, out };
        });
        return [p.in, p.out];
      }
      case 'lowcut': {
        const c = this._mk('lowcut', () => this._echo({ fb: 0.5, filter: { type: 'highpass', freq: 700 } }, false));
        return [c.in, c.out];
      }
      case 'spiral': {
        const c = this._mk('spiral', () => this._echo({ fb: 0.72, filter: { type: 'bandpass', freq: 900, q: 0.9 } }, true));
        return [c.in, c.out];
      }
      case 'upecho': {
        const c = this._mk('upecho', () => this._echo({ fb: 0.5, filter: { type: 'highpass', freq: 500 } }, true));
        return [c.in, c.out];
      }
      case 'downecho': {
        const c = this._mk('downecho', () => this._echo({ fb: 0.5, filter: { type: 'lowpass', freq: 1200 } }, true));
        return [c.in, c.out];
      }
      case 'helix': {
        const c = this._mk('helix', () => this._echo({ fb: 0.97 }, true));
        return [c.in, c.out];
      }
      case 'mtdelay': {  // no cycle: engine.js verbatim
        const mt = this._mk('mtdelay', () => {
          const t = this._timeNow();
          const d1 = ctx.createDelay(4);
          const d2 = ctx.createDelay(4);
          const d3 = ctx.createDelay(4);
          d1.delayTime.value = t;
          d2.delayTime.value = t;
          d3.delayTime.value = t;
          const out = ctx.createGain();
          const g1 = ctx.createGain(); g1.gain.value = 0.8;
          const g2 = ctx.createGain(); g2.gain.value = 0.55;
          const g3 = ctx.createGain(); g3.gain.value = 0.35;
          d1.connect(g1); g1.connect(out); d1.connect(d2);
          d2.connect(g2); g2.connect(out); d2.connect(d3);
          d3.connect(g3); g3.connect(out);
          this._delays.push({ d: d1, kind: 'tap' }, { d: d2, kind: 'tap' }, { d: d3, kind: 'tap' });
          return { in: d1, out };
        });
        return [mt.in, mt.out];
      }
      case 'roll': return [this._mute, this._mute];
      default: return [this.echoDelay, this.echoPost];
    }
  }
  _route() {
    try { this.input.disconnect(); } catch { /* nothing */ }
    if (this._out) {
      try { this._out.disconnect(this.wet); } catch { /* nothing */ }
      this._out = null;
    }
    if (!this.enabled) return;
    const [cIn, cOut] = this._chain();
    this.input.connect(cIn);
    cOut.connect(this.wet);
    this._out = cOut;
  }
  setType(t) { this.type = t; this._route(); }
  setEnabled(b) { this.enabled = b; this._route(); }
  setLevel(v) {
    this.level = clamp(v, 0, 1);
    const now = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(this.level, now, 0.02);
    for (const f of this._fbs) f.g.gain.setTargetAtTime(this._fbFor(f.base), now, 0.05);
  }
  setBeatsMult(m) {
    this.beatsMult = m;
    this._applyTime();
  }
  setBeatDur(sec) {
    if (Math.abs(sec - this.beatDur) < this.beatDur * 0.0005) return;
    this.beatDur = sec;
    this._applyTime();
  }
  _applyTime() {
    const now = this.ctx.currentTime;
    const t = clamp(this.beatDur * this.beatsMult, 0.02, 3.9);
    for (const { d, kind } of this._delays) d.delayTime.setTargetAtTime(this._time(kind, t), now, 0.08);
  }
}

// engine.js Color FX bus (_colorDefs, cReverb, cCrush, _routeColor), the
// echo loops compensated like CompUnit's; the output is the bus wet before
// the 0.85 colorWet gain.
class CompColorBus {
  constructor(ctx, output, Q, impulse) {
    this.ctx = ctx;
    this.Q = Q;
    this.output = output;
    this.bus = ctx.createGain();
    this.defs = {
      dubecho: { fb: 0.55, filter: { type: 'highpass', freq: 250 }, time: 0.35 },
      hpfecho: { fb: 0.5, filter: { type: 'highpass', freq: 900 }, time: 0.3 },
      lpfecho: { fb: 0.5, filter: { type: 'lowpass', freq: 650 }, time: 0.3 },
      bpfecho: { fb: 0.55, filter: { type: 'bandpass', freq: 1000, q: 1 }, time: 0.3 },
      crushecho: { fb: 0.5, crush: 6, time: 0.3 }
    };
    this.chains = {};
    this.reverb = ctx.createConvolver();
    if (impulse) this.reverb.buffer = impulse;
    this.crush = ctx.createWaveShaper();
    this.crush.curve = crushCurve(5);
    this.type = 'filter';
    this._out = null;
    this._route();
  }
  _echoLoop({ fb = 0.45, filter = null, crush = null, maxT = 4, time = 0.25 }) {  // buildEchoLoop, compensated
    const ctx = this.ctx;
    const d = ctx.createDelay(maxT);
    d.delayTime.value = time - this.Q;
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
    const post = ctx.createDelay(1);
    post.delayTime.value = this.Q;
    node.connect(post);
    return { in: d, out: post };
  }
  _route() {
    try { this.bus.disconnect(); } catch { /* nothing */ }
    if (this._out) {
      try { this._out.disconnect(this.output); } catch { /* nothing */ }
      this._out = null;
    }
    let io = null;
    if (this.defs[this.type]) {
      let c = this.chains[this.type];
      if (!c) c = this.chains[this.type] = this._echoLoop(this.defs[this.type]);
      io = [c.in, c.out];
    } else if (this.type === 'reverb') {
      io = [this.reverb, this.reverb];
    } else if (this.type === 'crush') {
      io = [this.crush, this.crush];
    }
    if (io) {
      this.bus.connect(io[0]);
      io[1].connect(this.output);
      this._out = io[1];
    }
  }
  setType(t) {
    this.type = t;
    this._route();
  }
}

// ---------------------------------------------------------------------------
// Cases (event frames are multiples of the 128-frame render quantum). The
// tempo comes first, as in the native engine where the beat clock is current
// before any FX command (a lazily built chain is born on time).
//  - compensated: drift-free graphs, INTEGER delays (128 BPM at 65536 Hz) so
//    that Chromium's single-precision read positions are exact whatever the
//    buffer geometry; compared in full;
//  - first-repeat cases: engine.js's own graphs (fractional delays, 124 BPM,
//    the exact DelayNode geometry of the native lines), a short burst, and a
//    comparison that stops before the second repeat, where Chromium's drift
//    (+128 frames per trip) begins.
// ---------------------------------------------------------------------------
const B124 = 60 / 124;
const B128 = 60 / 128;
const at = (sec, rate) => Math.round((sec * rate) / 128) * 128;
const unitEv = (type, beats, level, beatDur) => [
  [0, 'setBeatDur', beatDur], [0, 'setType', type], [0, 'setBeatsMult', beats], [0, 'setLevel', level], [0, 'setEnabled', true]
];
const FX_REVERB = { seconds: 2.2, decay: 2.5, seed: 0x0f00d5ed };
const COLOR_REVERB = { seconds: 2.8, decay: 2.2, seed: 0x0c0102ed };
const R65 = 65536;  // compensated graphs: 128 / 65536 s is exact in float, so the loop reads exactly t - 128 frames
// first repeat only: [0, lead + 2 * delay) minus a margin
const firstRepeat = (lead, delaySec) => (r) => Math.floor((lead + 2 * delaySec) * r) - 16;
const tOf = (beatDur, beats) => Math.min(Math.max(beatDur * beats, 0.02), 3.9);

const CASES = [
  // --- delay family: compensated (drift-free) graphs, integer delays, full comparison ---
  { name: 'echo_b05_128', family: 'delay', compensated: true, rate: R65, seconds: 6, lead: 1.0, events: unitEv('echo', 0.5, 0.8, B128) },
  {
    name: 'echo_level_moves', family: 'delay', compensated: true, rate: R65, seconds: 6, lead: 0.5,
    events: (r) => [...unitEv('echo', 0.5, 0.8, 0.5), [at(1.3, r), 'setLevel', 0.3], [at(2.1, r), 'setLevel', 1]]
  },
  { name: 'delay_b05_128', family: 'delay', compensated: true, rate: R65, seconds: 6, lead: 0.5, events: unitEv('delay', 0.5, 1, B128) },
  { name: 'pingpong_b05_128', family: 'delay', compensated: true, rate: R65, seconds: 6, lead: 0.5, events: unitEv('pingpong', 0.5, 0.8, B128) },
  { name: 'lowcut_b075_128', family: 'delay', compensated: true, rate: R65, seconds: 6, lead: 0.5, events: unitEv('lowcut', 0.75, 0.9, B128) },
  { name: 'spiral_b025_128', family: 'delay', compensated: true, rate: R65, seconds: 6, lead: 0.5, events: unitEv('spiral', 0.25, 0.7, B128) },
  { name: 'upecho_b05_128', family: 'delay', compensated: true, rate: R65, seconds: 6, lead: 0.5, events: unitEv('upecho', 0.5, 1, B128) },
  { name: 'downecho_b05_128', family: 'delay', compensated: true, rate: R65, seconds: 6, lead: 0.5, events: unitEv('downecho', 0.5, 1, B128) },
  { name: 'helix_b025_128', family: 'delay', compensated: true, rate: R65, seconds: 8, lead: 0.5, events: unitEv('helix', 0.25, 1, B128) },
  {
    name: 'delay_switches', family: 'delay', compensated: true, rate: R65, seconds: 7, lead: 0.5,
    events: (r) => [...unitEv('echo', 0.5, 0.8, 0.5), [at(1.4, r), 'setType', 'delay'], [at(2.4, r), 'setType', 'echo'],
      [at(3.2, r), 'setEnabled', false], [at(3.9, r), 'setEnabled', true], [at(4.6, r), 'setType', 'pingpong']]
  },
  // --- delay family: engine.js itself, fractional delays, up to the first repeat ---
  ...[['echo', 0.5, 0.8, 1.0], ['delay', 0.5, 1, 0.3], ['pingpong', 0.5, 0.8, 0.3], ['lowcut', 0.75, 0.9, 0.3],
    ['spiral', 0.25, 0.7, 0.3], ['upecho', 0.5, 1, 0.3], ['downecho', 0.5, 1, 0.3], ['helix', 0.25, 1, 0.3]]
    .map(([type, beats, level, lead]) => ({
      name: `first_${type}_124`, family: 'delay', rate: 48000, seconds: lead + 2 * tOf(B124, beats) + 0.05, lead, input: 'burst',
      compare: firstRepeat(lead, tOf(B124, beats)), events: unitEv(type, beats, level, B124)
    })),
  { name: 'mtdelay_b05_124', family: 'delay', rate: 48000, seconds: 5, lead: 0.5, events: unitEv('mtdelay', 0.5, 1, B124) },
  // --- modulation family (engine.js FxUnit) ---
  { name: 'flanger_b2_l05', family: 'modulation', rate: 48000, seconds: 5, lead: 0.3, events: unitEv('flanger', 2, 0.5, 0.5) },
  { name: 'flanger_b05_l1', family: 'modulation', rate: 48000, seconds: 5, lead: 0.3, events: unitEv('flanger', 0.5, 1, 0.5) },
  { name: 'phaser_b1_l08', family: 'modulation', rate: 48000, seconds: 5, lead: 0.3, events: unitEv('phaser', 1, 0.8, 0.5) },
  { name: 'phaser_b025_124', family: 'modulation', rate: 48000, seconds: 5, lead: 0.3, events: unitEv('phaser', 0.25, 1, B124) },
  { name: 'trans_b05', family: 'modulation', rate: 48000, seconds: 4, lead: 0.3, events: unitEv('trans', 0.5, 1, 0.5) },
  { name: 'trans_b025', family: 'modulation', rate: 48000, seconds: 4, lead: 0.3, events: unitEv('trans', 0.25, 1, 0.5) },
  { name: 'trans_b4_124', family: 'modulation', rate: 48000, seconds: 5, lead: 0.3, events: unitEv('trans', 4, 0.9, B124) },
  { name: 'pan_b1', family: 'modulation', rate: 48000, seconds: 4, lead: 0.3, events: unitEv('pan', 1, 1, 0.5) },
  { name: 'pan_b05_124', family: 'modulation', rate: 48000, seconds: 4, lead: 0.3, events: unitEv('pan', 0.5, 0.7, B124) },
  { name: 'filter_b4', family: 'modulation', rate: 48000, seconds: 5, lead: 0.3, events: unitEv('filter', 4, 1, 0.5) },
  {
    name: 'filter_level_moves', family: 'modulation', rate: 48000, seconds: 5, lead: 0.3,
    events: (r) => [...unitEv('filter', 1, 0.5, 0.5), [at(0.9, r), 'setLevel', 1], [at(1.8, r), 'setLevel', 0.2]]
  },
  {
    name: 'mod_switches', family: 'modulation', rate: 48000, seconds: 6, lead: 0.3,
    events: (r) => [...unitEv('flanger', 1, 0.8, 0.5), [at(0.8, r), 'setType', 'phaser'], [at(1.3, r), 'setType', 'flanger'],
      [at(1.9, r), 'setEnabled', false], [at(2.3, r), 'setEnabled', true], [at(2.6, r), 'setBeatsMult', 0.5],
      [at(3.0, r), 'setType', 'pan'], [at(3.5, r), 'setType', 'trans']]
  },
  // --- other (engine.js FxUnit) ---
  { name: 'reverb_l08', family: 'other', rate: 48000, seconds: 6, lead: 0.3, impulse: FX_REVERB, events: unitEv('reverb', 0.5, 0.8, 0.5) },
  {
    name: 'reverb_switches', family: 'other', rate: 48000, seconds: 6, lead: 0.3, impulse: FX_REVERB,
    events: (r) => [...unitEv('reverb', 0.5, 1, 0.5), [at(0.9, r), 'setType', 'crush'], [at(1.6, r), 'setType', 'reverb']]
  },
  { name: 'robot_l1', family: 'other', rate: 48000, seconds: 3, lead: 0.3, events: unitEv('robot', 0.5, 1, 0.5) },
  { name: 'crush_l09', family: 'other', rate: 48000, seconds: 3, lead: 0.3, events: unitEv('crush', 0.5, 0.9, 0.5) },
  { name: 'roll_l1', family: 'other', rate: 48000, seconds: 3, lead: 0.3, events: unitEv('roll', 0.5, 1, 0.5) },
  // --- Color FX bus: engine.js graphs, the echoes up to their first repeat ---
  ...[['dubecho', 0.35], ['hpfecho', 0.3], ['lpfecho', 0.3], ['bpfecho', 0.3], ['crushecho', 0.3]].map(([type, time]) => ({
    name: `color_${type}_first`, family: 'color', kind: 'color', rate: 48000, seconds: 0.3 + 2 * time + 0.05, lead: 0.3,
    input: 'burst', compare: firstRepeat(0.3, time), events: [[0, 'colorType', type]]
  })),
  {
    // dub echo frozen for 0.1 s by a switch to crush: its first repeat comes 0.1 s later
    name: 'color_switches_first', family: 'color', kind: 'color', rate: 48000, seconds: 1.3, lead: 0.3, input: 'burst',
    compare: (r) => Math.floor((0.3 + 0.1 + 2 * 0.35) * r) - 16,
    events: (r) => [[0, 'colorType', 'dubecho'], [at(0.4, r), 'colorType', 'crush'], [at(0.5, r), 'colorType', 'dubecho']]
  },
  { name: 'color_reverb', family: 'color', kind: 'color', rate: 48000, seconds: 6, lead: 0.3, impulse: COLOR_REVERB, events: [[0, 'colorType', 'reverb']] },
  { name: 'color_crush', family: 'color', kind: 'color', rate: 48000, seconds: 3, lead: 0.3, events: [[0, 'colorType', 'crush']] },
  // --- 44.1 kHz (the DDJ-FLX6's rate; dsp-parity campaign): engine.js itself, in the families above ---
  ...[['echo', 0.5, 0.8, 1.0], ['delay', 0.5, 1, 0.3], ['pingpong', 0.5, 0.8, 0.3], ['lowcut', 0.75, 0.9, 0.3],
    ['spiral', 0.25, 0.7, 0.3], ['upecho', 0.5, 1, 0.3], ['downecho', 0.5, 1, 0.3], ['helix', 0.25, 1, 0.3]]
    .map(([type, beats, level, lead]) => ({
      name: `first_${type}_124_r44`, family: 'delay', rate: 44100, seconds: lead + 2 * tOf(B124, beats) + 0.05, lead, input: 'burst',
      compare: firstRepeat(lead, tOf(B124, beats)), events: unitEv(type, beats, level, B124)
    })),
  { name: 'mtdelay_b05_124_r44', family: 'delay', rate: 44100, seconds: 5, lead: 0.5, events: unitEv('mtdelay', 0.5, 1, B124) },
  { name: 'flanger_b05_l1_r44', family: 'modulation', rate: 44100, seconds: 5, lead: 0.3, events: unitEv('flanger', 0.5, 1, 0.5) },
  { name: 'phaser_b1_l08_r44', family: 'modulation', rate: 44100, seconds: 5, lead: 0.3, events: unitEv('phaser', 1, 0.8, 0.5) },
  { name: 'trans_b025_r44', family: 'modulation', rate: 44100, seconds: 4, lead: 0.3, events: unitEv('trans', 0.25, 1, 0.5) },
  { name: 'pan_b05_124_r44', family: 'modulation', rate: 44100, seconds: 4, lead: 0.3, events: unitEv('pan', 0.5, 0.7, B124) },
  {
    name: 'filter_level_moves_r44', family: 'modulation', rate: 44100, seconds: 5, lead: 0.3,
    events: (r) => [...unitEv('filter', 1, 0.5, 0.5), [at(0.9, r), 'setLevel', 1], [at(1.8, r), 'setLevel', 0.2]]
  },
  {
    name: 'mod_switches_r44', family: 'modulation', rate: 44100, seconds: 6, lead: 0.3,
    events: (r) => [...unitEv('flanger', 1, 0.8, 0.5), [at(0.8, r), 'setType', 'phaser'], [at(1.3, r), 'setType', 'flanger'],
      [at(1.9, r), 'setEnabled', false], [at(2.3, r), 'setEnabled', true], [at(2.6, r), 'setBeatsMult', 0.5],
      [at(3.0, r), 'setType', 'pan'], [at(3.5, r), 'setType', 'trans']]
  },
  { name: 'reverb_l08_r44', family: 'other', rate: 44100, seconds: 6, lead: 0.3, impulse: FX_REVERB, events: unitEv('reverb', 0.5, 0.8, 0.5) },
  { name: 'robot_l1_r44', family: 'other', rate: 44100, seconds: 3, lead: 0.3, events: unitEv('robot', 0.5, 1, 0.5) },
  { name: 'crush_l09_r44', family: 'other', rate: 44100, seconds: 3, lead: 0.3, events: unitEv('crush', 0.5, 0.9, 0.5) },
  ...[['dubecho', 0.35], ['hpfecho', 0.3], ['lpfecho', 0.3], ['bpfecho', 0.3], ['crushecho', 0.3]].map(([type, time]) => ({
    name: `color_${type}_first_r44`, family: 'color', kind: 'color', rate: 44100, seconds: 0.3 + 2 * time + 0.05, lead: 0.3,
    input: 'burst', compare: firstRepeat(0.3, time), events: [[0, 'colorType', type]]
  })),
  { name: 'color_reverb_r44', family: 'color', kind: 'color', rate: 44100, seconds: 6, lead: 0.3, impulse: COLOR_REVERB, events: [[0, 'colorType', 'reverb']] },
  { name: 'color_crush_r44', family: 'color', kind: 'color', rate: 44100, seconds: 3, lead: 0.3, events: [[0, 'colorType', 'crush']] },
  // --- 96 kHz (family "rate96", replayed by test_fx_parity.cpp) ---
  { name: 'flanger_b05_l1_r96', family: 'rate96', rate: 96000, seconds: 4, lead: 0.3, events: unitEv('flanger', 0.5, 1, 0.5) },
  { name: 'phaser_b1_l08_r96', family: 'rate96', rate: 96000, seconds: 4, lead: 0.3, events: unitEv('phaser', 1, 0.8, 0.5) },
  { name: 'trans_b05_r96', family: 'rate96', rate: 96000, seconds: 3, lead: 0.3, events: unitEv('trans', 0.5, 1, 0.5) },
  { name: 'pan_b1_r96', family: 'rate96', rate: 96000, seconds: 3, lead: 0.3, events: unitEv('pan', 1, 1, 0.5) },
  { name: 'filter_b4_r96', family: 'rate96', rate: 96000, seconds: 4, lead: 0.3, events: unitEv('filter', 4, 1, 0.5) },
  {
    name: 'first_echo_124_r96', family: 'rate96', rate: 96000, seconds: 1.0 + 2 * tOf(B124, 0.5) + 0.05, lead: 1.0, input: 'burst',
    compare: firstRepeat(1.0, tOf(B124, 0.5)), events: unitEv('echo', 0.5, 0.8, B124)
  },
  { name: 'robot_l1_r96', family: 'rate96', rate: 96000, seconds: 3, lead: 0.3, events: unitEv('robot', 0.5, 1, 0.5) },
  { name: 'crush_l09_r96', family: 'rate96', rate: 96000, seconds: 3, lead: 0.3, events: unitEv('crush', 0.5, 0.9, 0.5) },
  { name: 'reverb_l08_r96', family: 'rate96', rate: 96000, seconds: 4, lead: 0.3, impulse: FX_REVERB, events: unitEv('reverb', 0.5, 0.8, 0.5) },
  { name: 'color_crush_r96', family: 'rate96', kind: 'color', rate: 96000, seconds: 3, lead: 0.3, events: [[0, 'colorType', 'crush']] },
  // --- echo timing (family "timing", measured by test_fx_parity.cpp, never nulled): engine.js's own
  //     graphs WITHOUT compensation, a single click in, many repeats: Chromium's +128 frames per trip ---
  // (the echo line exists from the start at 0.25 s and glides to the beat: its click comes once it has settled)
  ...[['echo', 0.25, 1.0], ['delay', 0.5, 0.1], ['pingpong', 0.5, 0.1], ['lowcut', 0.75, 0.1], ['spiral', 0.25, 0.1],
    ['upecho', 0.5, 0.1], ['downecho', 0.5, 0.1], ['helix', 0.25, 0.1]].map(([type, beats, lead]) => ({
    name: `timing_${type}_124`, family: 'timing', rate: 48000, seconds: lead + 9 * tOf(B124, beats) + 0.1, lead, input: 'click',
    events: unitEv(type, beats, 1, B124)
  })),
  ...[['delay', 0.5], ['helix', 0.25]].map(([type, beats]) => ({
    name: `timing_${type}_124_r44`, family: 'timing', rate: 44100, seconds: 0.1 + 9 * tOf(B124, beats) + 0.1, lead: 0.1, input: 'click',
    events: unitEv(type, beats, 1, B124)
  })),
  ...[['dubecho', 0.35], ['hpfecho', 0.3], ['lpfecho', 0.3], ['bpfecho', 0.3], ['crushecho', 0.3]].map(([type, time]) => ({
    name: `timing_color_${type}`, family: 'timing', kind: 'color', rate: 48000, seconds: 0.1 + 7 * time + 0.1, lead: 0.1, input: 'click',
    events: [[0, 'colorType', type]]
  }))
];

// A short burst for the first-repeat cases: 40 ms of noise (L), a 40 ms chirp (R).
function makeBurst(frames, rate, seed, lead) {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  let x = (seed >>> 0) || 0x9e3779b9;
  const rnd = () => {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    return x / 4294967296;
  };
  const a = Math.round(lead * rate), b = Math.round((lead + 0.04) * rate), f = Math.round(0.002 * rate);
  for (let i = a; i < b && i < frames; i++) {
    const k = Math.min(i - a, b - 1 - i);
    const w = k < f ? 0.5 - 0.5 * Math.cos((Math.PI * k) / f) : 1;
    const t = (i - a) / rate;
    L[i] = 0.4 * w * (rnd() * 2 - 1);
    R[i] = 0.4 * w * Math.sin(2 * Math.PI * (200 * t + 40000 * t * t));  // 200 Hz -> 3.4 kHz
  }
  return [L, R];
}

async function renderCase(c, mod, latency) {
  const rate = c.rate;
  const frames = Math.round(c.seconds * rate);
  const events = typeof c.events === 'function' ? c.events(rate) : c.events;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate: rate });
  let L, R;
  if (c.input === 'click') {
    // a single click at `lead` (timing cases): every repeat is the loop's impulse response
    L = new Float32Array(frames);
    R = new Float32Array(frames);
    L[Math.round(c.lead * rate)] = 0.5;
    R[Math.round(c.lead * rate)] = 0.5;
  } else {
    [L, R] = c.input === 'burst' ? makeBurst(frames, rate, 0x51ed + frames, c.lead) : makeInput(frames, rate, 0x51ed + frames, c.lead);
  }
  const buf = ctx.createBuffer(2, frames, rate);
  buf.copyToChannel(L, 0);
  buf.copyToChannel(R, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // Keep the source pulled whatever the unit does: an AudioBufferSourceNode
  // that nothing pulls stops advancing in Chromium (in OpenMix the decks are
  // always pulled by the master, so the FX input never stalls).
  const keep = ctx.createGain();
  keep.gain.value = 0;
  src.connect(keep);
  keep.connect(ctx.destination);
  const Q = latency.perTrip / rate;
  let unit;
  if (c.kind === 'color') {
    unit = new CompColorBus(ctx, ctx.destination, c.compensated ? Q : 0,
      c.impulse ? seededImpulse(ctx, c.impulse.seconds, c.impulse.decay, c.impulse.seed) : null);
    src.connect(unit.bus);
  } else {
    if (c.compensated) {
      unit = new CompUnit(ctx, ctx.destination, Q);
    } else {
      unit = new mod.FxUnit(ctx, ctx.destination);
      if (c.impulse) {
        unit.convolver = ctx.createConvolver();
        unit.convolver.buffer = seededImpulse(ctx, c.impulse.seconds, c.impulse.decay, c.impulse.seed);
      }
    }
    src.connect(unit.input);
  }
  src.start(0);
  const apply = ([, op, value]) => {
    if (op === 'colorType') unit.setType(value);
    else unit[op](value);
  };
  const byFrame = new Map();
  for (const e of events) {
    if (e[0] % 128 !== 0) throw new Error(`${c.name}: event frame ${e[0]} is not on a render quantum`);
    if (!byFrame.has(e[0])) byFrame.set(e[0], []);
    byFrame.get(e[0]).push(e);
  }
  for (const [frame, list] of byFrame) {
    if (frame === 0) list.forEach(apply);
    else ctx.suspend(frame / rate).then(() => { list.forEach(apply); ctx.resume(); });
  }
  const out = await ctx.startRendering();
  const compareFrames = c.compare ? Math.min(frames, c.compare(rate)) : frames;
  return { frames, events, compareFrames, L, R, outL: out.getChannelData(0), outR: out.getChannelData(1) };
}

// Diagnostic (--probe-osc): Chromium's "sine" and "square" PeriodicWave
// tables: an OscillatorNode at rate / N Hz advances exactly one table entry
// per frame (increment 1.0, interpolation factor 0), so its output IS the
// table. Written as <out>/osc_<type>_<rate>.wav (mono float32).
async function probeOscTables() {
  const rows = [];
  for (const rate of [22050, 48000, 96000]) {
    const N = rate <= 24000 ? 2048 : (rate <= 88200 ? 4096 : 16384);
    for (const type of ['sine', 'square']) {
      const ctx = new OfflineAudioContext(1, N, rate);
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = rate / N;
      o.connect(ctx.destination);
      o.start(0);
      const y = (await ctx.startRendering()).getChannelData(0);
      writeWav(path.join(OUT, `osc_${type}_${rate}.wav`), [y], rate);
      rows.push(`${type} ${rate} Hz: N ${N}, y[N/4] ${y[N / 4]}, y[1] ${y[1]}`);
    }
  }
  return rows;
}

// Diagnostic (--probe-param): the values of AudioParam.setTargetAtTime, a
// ConstantSourceNode(1) through a GainNode whose gain carries the automation
// (the output IS the param), for a few taus and start times. Written as
// <out>/param_<tau>_<start>.wav (mono float32, 48 kHz).
async function probeParam() {
  const rows = [];
  const rate = 48000;
  for (const [tau, start, v0, v1] of [[0.05, 0, 4, 8], [0.08, 0, 0.25, 0.2419354838709677], [0.1, 0, 0.25, 0.5],
    [0.05, 1024 / rate, 0.45, 0.2475], [0.02, 0, 0, 0.8], [0.02, 0, 0.8, 0], [0.05, 0, 100, 1]]) {
    const N = Math.round(1.5 * rate);
    const ctx = new OfflineAudioContext(1, N, rate);
    const k = ctx.createConstantSource();
    const g = ctx.createGain();
    g.gain.value = v0;
    k.connect(g);
    g.connect(ctx.destination);
    if (start === 0) g.gain.setTargetAtTime(v1, 0, tau);
    else ctx.suspend(start).then(() => { g.gain.setTargetAtTime(v1, ctx.currentTime, tau); ctx.resume(); });
    k.start(0);
    const y = (await ctx.startRendering()).getChannelData(0);
    writeWav(path.join(OUT, `param_${tau}_${Math.round(start * rate)}.wav`), [y], rate);
    let conv = -1;
    for (let i = 1; i < N; i++) if (y[i] === Math.fround(v1) && y[i - 1] !== Math.fround(v1)) conv = i;
    rows.push(`tau ${tau} start ${start}: first frame at the target ${conv} (${(conv / rate).toFixed(5)} s = ${((conv / rate - start) / tau).toFixed(3)} tau)`);
  }
  // A param whose node is only processed from `late` on (connected then): does
  // its automation resume from its last value, and when does it converge?
  for (const [tau, late, v0, v1] of [[0.1, 0.8, 0.4, 0.5], [0.05, 0.3, 0.45, 0.2475]]) {
    const N = Math.round(2.5 * rate);
    const ctx = new OfflineAudioContext(1, N, rate);
    const k = ctx.createConstantSource();
    const g = ctx.createGain();
    g.gain.value = v0;
    k.connect(g);
    g.gain.setTargetAtTime(v1, 0, tau);
    ctx.suspend(late).then(() => { g.connect(ctx.destination); ctx.resume(); });
    k.start(0);
    const y = (await ctx.startRendering()).getChannelData(0);
    writeWav(path.join(OUT, `param_late_${tau}_${Math.round(late * rate)}.wav`), [y], rate);
    const i0 = Math.round(late * rate);
    let conv = -1;
    for (let i = i0 + 1; i < N; i++) if (y[i] === Math.fround(v1) && y[i - 1] !== Math.fround(v1)) conv = i;
    rows.push(`late tau ${tau} from ${late}: y[late] ${y[i0]} y[late+1] ${y[i0 + 1]}, target from ${conv} (${(conv / rate).toFixed(5)} s)`);
  }
  return rows;
}

(async () => {
  try {
    if (q.get('probe') === 'param') {
      for (const row of await probeParam()) log(row);
      ipcRenderer.send('done', { ok: true, cases: 0 });
      return;
    }
    if (q.get('probe') === 'osc') {
      for (const row of await probeOscTables()) log(row);
      ipcRenderer.send('done', { ok: true, cases: 0 });
      return;
    }
    if (q.get('probe') === 'delay') {
      for (const rate of [48000, R65]) for (const row of await probeDelayPrecision(rate)) log(`${rate} Hz ${row}`);
      ipcRenderer.send('done', { ok: true, cases: 0 });
      return;
    }
    const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'js', 'engine.js')).href);
    const latency = {};
    for (const rate of [48000, R65, 44100, 96000]) {
      latency[rate] = await probeLoopLatency(rate);
      log(`feedback-cycle latency at ${rate} Hz: first pass ${latency[rate].firstPass} frames, +${latency[rate].perTrip} frames per trip`);
    }
    if (latency[R65].firstPass !== 0 || latency[R65].perTrip !== 128) {
      throw new Error(`unexpected feedback-cycle latency ${JSON.stringify(latency[R65])}: the compensated graphs assume 0 / 128`);
    }
    const names = [];
    for (const c of CASES) {
      if (ONLY && !c.name.includes(ONLY)) continue;
      const t0 = performance.now();
      const r = await renderCase(c, mod, latency[c.rate]);
      writeWav(path.join(OUT, `${c.name}.input.wav`), [r.L, r.R], c.rate);
      writeWav(path.join(OUT, `${c.name}.wav`), [r.outL, r.outR], c.rate);
      let peak = 0;
      for (let i = 0; i < r.frames; i++) peak = Math.max(peak, Math.abs(r.outL[i]), Math.abs(r.outR[i]));
      const meta = {
        suite: 'fx',
        case: c.name,
        family: c.family,
        kind: c.kind || 'unit',
        sampleRate: c.rate,
        frames: r.frames,
        impulse: c.impulse || null,
        compensated: !!c.compensated,
        compareFrames: r.compareFrames,
        loopLatency: latency[c.rate],
        events: r.events.map(([frame, op, value]) => ({ frame, op, value })),
        input: `${c.name}.input.wav`,
        output: `${c.name}.wav`,
        peak,
        chrome: process.versions.chrome,
        electron: process.versions.electron
      };
      fs.writeFileSync(path.join(OUT, `${c.name}.json`), JSON.stringify(meta, null, 1));
      names.push(c.name);
      log(`  ${c.name}: ${r.frames} frames at ${c.rate} Hz, peak ${peak.toFixed(3)}, ${(performance.now() - t0).toFixed(0)} ms`);
    }
    if (!ONLY) {
      fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
        suite: 'fx',
        generator: 'native/engine/tests/fx/goldens/make_fx_goldens.js',
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        loopLatency: latency,
        cases: names
      }, null, 1));
    }
    ipcRenderer.send('done', { ok: true, cases: names.length });
  } catch (e) {
    ipcRenderer.send('done', { ok: false, error: String((e && e.stack) || e) });
  }
})();
