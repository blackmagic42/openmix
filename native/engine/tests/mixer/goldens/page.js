// Renders of the mixer parity golden suite (owner: mixer; dsp-parity
// campaign), run inside the hidden page of make_mixer_goldens.js:
// OfflineAudioContext only (silent). Every case uses engine.js's own classes
// (Deck, AudioEngine), so the node setups, curves and AudioParam calls are
// the Web engine's. For every case it writes, in the output folder:
//   <case>.input.wav   the signals fed (float32; 2 channels per fed deck)
//   <case>.wav         Chromium's stereo output (float32)
//   <case>.json        kind, rate, frames, decks fed, options, the calls
//                      {frame, time, call, args} at exact render-quantum frames
// and manifest.json (case list, Chromium version).
//
// Kinds (how a test replays a case natively):
//  - strip:   engine.js Deck -> destination, input into deck.trim (calls
//             deck.setEq / setFilter / setTrim / setVolume);
//  - master:  AudioEngine, input into masterGain (setMasterVolume,
//             setMasterFilter): masterGain -> dryComp -> postBus -> mFilter
//             -> limiter -> destination;
//  - limiter: AudioEngine, input into the limiter (DynamicsCompressor of
//             engine.js); `segments` give the level steps of the input sine;
//  - engine:  AudioEngine, signals into decks[d].trim; the calls are the
//             AudioEngine / Deck / FxUnit methods app.js uses. Options:
//             identityFx (every FX unit, pad and master units included, is
//             made an identity: input -> wet gain, the wet gain still driven
//             by FxUnit.setLevel), identityColor (the Color bus is an
//             identity for the bus types), noDryCut (syncLock is never
//             called: no dry cut / dry compensation in this render).
// Event frames are multiples of the 128-frame render quantum where
// ceil(frame / rate * rate) == frame in double arithmetic, so a `.value =`
// step (the DJ filters) lands on that very frame in Chromium too.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ipcRenderer } = require('electron');

const q = new URLSearchParams(location.search);
const OUT = q.get('out');
const ROOT = q.get('root');
const ONLY = q.get('only') || '';
const log = (m) => ipcRenderer.send('log', m);
const Q = 128;

function xorshift(seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    return x / 4294967296;
  };
}

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

// ---------------------------------------------------------------------------
// Frames and signals
// ---------------------------------------------------------------------------
const okFrame = (F, rate) => Math.ceil((F / rate) * rate) === F;
function gridFrame(sec, rate) {
  let F = Math.round((sec * rate) / Q) * Q;
  while (!okFrame(F, rate)) F += Q;
  return F;
}
const db2lin = (d) => Math.pow(10, d / 20);

function noise(frames, seed, amp) {
  const r = xorshift(seed);
  const a = new Float32Array(frames);
  for (let i = 0; i < frames; i++) a[i] = (r() * 2 - 1) * amp;
  return a;
}
// The host's strip / master signal: stereo white noise +-0.25 (seeds 0x1234567 / 0x7654321).
const stereoNoise = (frames, amp = 0.25) => [noise(frames, 0x1234567, amp), noise(frames, 0x7654321, amp)];
// Music-like: 6 harmonics of f0 with a slow envelope, a high sine per side, a little noise.
function musicLike(frames, rate, seed, f0, amp) {
  const r = xorshift(seed);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 1.7 * t);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t + h) / h;
    const n = (r() * 2 - 1) * 0.05;
    L[i] = amp * (0.5 * env * v + 0.1 * Math.sin(2 * Math.PI * 3520 * t)) + n;
    R[i] = amp * (0.45 * env * v + 0.1 * Math.sin(2 * Math.PI * 3150 * t + 1)) - n;
  }
  return [L, R];
}
// A sine whose amplitude steps at the given times: segments [[sec, amp], ...].
function sineLevels(frames, rate, freq, segments) {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  let s = -1;
  for (let i = 0; i < frames; i++) {
    while (s + 1 < segments.length && i >= Math.round(segments[s + 1][0] * rate)) s++;
    const v = s >= 0 ? segments[s][1] * Math.sin((2 * Math.PI * freq * i) / rate) : 0;
    L[i] = v;
    R[i] = v;
  }
  return [L, R];
}

// ---------------------------------------------------------------------------
// engine.js objects on an OfflineAudioContext
// ---------------------------------------------------------------------------
let mod = null;
// engine.js AudioEngine built on `ctx` (its constructor calls new AudioContext()).
// OfflineAudioContext has no MediaStream destination (the recorder tap): a
// silent gain stands in. The WSOLA worklet is not loaded (idle decks: their
// transposed path is muted). Math.random is seeded while the engine builds
// its impulses and noise buffer (none of them reaches these renders).
function makeEngine(ctx) {
  if (!ctx.createMediaStreamDestination) ctx.createMediaStreamDestination = () => Object.assign(ctx.createGain(), { stream: null });
  const savedCtx = window.AudioContext;
  const savedLoad = mod.AudioEngine.prototype._loadPitchWorklet;
  const savedRandom = Math.random;
  window.AudioContext = function OfflineAlias() {
    return ctx;
  };
  mod.AudioEngine.prototype._loadPitchWorklet = async function () {};
  Math.random = xorshift(0xc0ffee);
  try {
    return new mod.AudioEngine();
  } finally {
    window.AudioContext = savedCtx;
    mod.AudioEngine.prototype._loadPitchWorklet = savedLoad;
    Math.random = savedRandom;
  }
}
// An FxUnit whose chain is an identity: input -> unity gain -> wet. Its wet
// gain still follows setLevel (setTargetAtTime(level, now, 0.02)) and its
// routing setEnabled (disabled = input and chain output disconnected).
function identityUnit(ctx, unit) {
  if (!unit || unit._idGain) return;
  unit._idGain = ctx.createGain();
  unit._chain = function () {
    return [this._idGain, this._idGain];
  };
  unit._route();
}
// The Color bus as an identity for the bus types (engine.js _routeColor with
// the chain replaced by a unity gain); 'filter' and 'noise' keep no bus.
function identityColor(ctx, engine) {
  engine._idColor = ctx.createGain();
  engine._routeColor = function () {
    try { this.colorBus.disconnect(); } catch { /* nothing */ }
    if (this._colorOut) {
      try { this._colorOut.disconnect(this.colorWet); } catch { /* nothing */ }
      this._colorOut = null;
    }
    const bus = !!this._colorDefs[this.colorType] || this.colorType === 'reverb' || this.colorType === 'crush';
    if (bus) {
      this.colorBus.connect(this._idColor);
      this._idColor.connect(this.colorWet);
      this._colorOut = this._idColor;
    }
  };
  engine._routeColor();
}

function playInto(ctx, chans, dest) {
  const b = ctx.createBuffer(chans.length, chans[0].length, ctx.sampleRate);
  chans.forEach((d, c) => b.copyToChannel(d, c));
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.connect(dest);
  src.start(0);
}

function engineCall(ctx, engine, opts, call, args) {
  const unit = (u) => (u === 'master' ? engine.masterFx : engine.fx[u]);
  switch (call) {
    case 'engine.setDeckEq': engine.decks[args[0]].setEq(args[1], args[2]); break;
    case 'engine.setDeckTrim': engine.decks[args[0]].setTrim(args[1]); break;
    case 'engine.setDeckVolume': engine.decks[args[0]].setVolume(args[1]); break;
    case 'engine.setDeckColor': engine.setDeckColor(args[0], args[1]); break;
    case 'engine.setCrossfader': engine.setCrossfader(args[0]); break;
    case 'engine.setXfSide':
      engine.xfSides[args[0]] = args[1];
      engine.applyCrossfader();
      break;
    case 'engine.setMasterVolume': engine.setMasterVolume(args[0]); break;
    case 'engine.setMasterFilter': engine.setMasterFilter(args[0]); break;
    case 'engine.setColorType': engine.setColorType(args[0]); break;
    case 'engine.setColorEnabled': engine.setColorEnabled(args[0]); break;
    case 'engine.setFxAssign': engine.fxAssign[args[0]][args[1]] = !!args[2]; break;
    case 'engine.updateFxSends': engine.updateFxSends(); break;
    case 'engine.ensureMasterFx':
      engine.ensureMasterFx();
      if (opts.identityFx) identityUnit(ctx, engine.masterFx);
      break;
    case 'engine.setPadFx':
      engine.setPadFx(args[0], args[1]);
      if (opts.identityFx) identityUnit(ctx, engine.padFx[args[0]]);
      break;
    case 'engine.setPadDryHold': engine.decks[args[0]]._padDryHold = args[1]; break;
    case 'engine.syncLock': engine.syncLock(); break;
    case 'fx.setType': unit(args[0]).setType(args[1]); break;
    case 'fx.setLevel': unit(args[0]).setLevel(args[1]); break;
    case 'fx.setEnabled': unit(args[0]).setEnabled(args[1]); break;
    case 'fx.setBeatsMult': unit(args[0]).setBeatsMult(args[1]); break;
    default: throw new Error(`unknown call ${call}`);
  }
}

// ---------------------------------------------------------------------------
// Cases. `events`: [[seconds, call, args], ...] (several calls at one time
// keep their order); `feeds(frames, rate)`: the signals ([L, R] per fed deck).
// ---------------------------------------------------------------------------
const CASES = [];
const stripCase = (name, rate, moves) =>
  CASES.push({
    name, kind: 'strip', rate, seconds: 0.25 * (moves.length + 2),
    inputDesc: 'stereo white noise +-0.25, xorshift32 seeds 0x1234567 (L) / 0x7654321 (R)',
    feeds: (frames) => [stereoNoise(frames)],
    events: moves.map(([call, args], i) => [0.25 * (i + 1), call, args])
  });
const EQ_VALUES = [0.5, 1, -0.25, -1, 0.75, 0];  // +3 dB, +6 dB boost, -10 dB, -40 dB kill, +4.5 dB, flat
const KILLS = [['deck.setEq', ['low', -1]], ['deck.setEq', ['mid', -1]], ['deck.setEq', ['high', -1]],
  ['deck.setEq', ['low', 0]], ['deck.setEq', ['mid', 0.5]], ['deck.setEq', ['high', 0]]];
const FILTER_VALUES = [-1, -0.6, -0.3, -0.035, 0.02, 0.3, 0.6, 1, 0];  // through the 0.04 dead zone
// A. the strip at 44.1 kHz (every host case) and 96 kHz (kills, filter)
for (const b of ['low', 'mid', 'high']) stripCase(`s44_eq_${b}_sweep`, 44100, EQ_VALUES.map((v) => ['deck.setEq', [b, v]]));
stripCase('s44_eq_kill_all', 44100, KILLS);
stripCase('s44_filter_sweep', 44100, FILTER_VALUES.map((v) => ['deck.setFilter', [v]]));
stripCase('s44_trim_steps', 44100, [-1, -0.5, 0.25, 1, 0].map((v) => ['deck.setTrim', [v]]));
stripCase('s44_fader_steps', 44100, [0, 0.3, 1, 0.85].map((v) => ['deck.setVolume', [v]]));
stripCase('s96_eq_kill_all', 96000, KILLS);
stripCase('s96_filter_sweep', 96000, FILTER_VALUES.map((v) => ['deck.setFilter', [v]]));
// B. the master chain at 44.1 kHz
for (const [name, call, vals] of [['m44_volume_steps', 'engine.setMasterVolume', [0.5, 1, 0.2, 0.9]],
  ['m44_filter_sweep', 'engine.setMasterFilter', [-1, -0.4, -0.02, 0.4, 1, 0]]]) {
  CASES.push({
    name, kind: 'master', rate: 44100, seconds: 0.25 * (vals.length + 2),
    inputDesc: 'stereo white noise +-0.25 into engine.masterGain',
    feeds: (frames) => [stereoNoise(frames)],
    events: vals.map((v, i) => [0.25 * (i + 1), call, [v]])
  });
}
CASES.push({
  name: 'm44_crossfader_curve', kind: 'engine', rate: 44100, seconds: 1.75, decks: [0, 1],
  inputDesc: 'deck 0 gets [L, L], deck 1 gets [R, R] of the stereo noise +-0.25',
  feeds: (frames) => {
    const [L, R] = stereoNoise(frames);
    return [[L, L], [R, R]];
  },
  events: [0, 0.25, 0.5, 0.75, 1].map((x, i) => [0.25 * (i + 1), 'engine.setCrossfader', [x]])
});
// C. the limiter: static curve (staircase -24 .. +12 dBFS in 3 dB steps), attack and release (steps)
for (const rate of [48000, 44100]) {
  const segs = [];
  for (let k = 0; k <= 12; k++) segs.push([0.05 + 0.3 * k, db2lin(-24 + 3 * k)]);
  CASES.push({
    name: `l${rate === 48000 ? 48 : 44}_staircase`, kind: 'limiter', rate, seconds: 4.0, freq: 1000, segments: segs,
    inputDesc: '1 kHz sine, -24 to +12 dBFS in 3 dB steps of 0.3 s from 0.05 s (static curve)',
    feeds: (frames, r) => [sineLevels(frames, r, 1000, segs)], events: []
  });
}
for (const rate of [48000, 44100, 96000]) {
  const segs = [[0.05, db2lin(-20)], [0.55, db2lin(6)], [1.05, db2lin(-20)], [2.05, db2lin(12)], [2.35, db2lin(-20)]];
  CASES.push({
    name: `l${rate === 48000 ? 48 : rate === 44100 ? 44 : 96}_attack_release`, kind: 'limiter', rate, seconds: 3.4, freq: 1000,
    segments: segs,
    inputDesc: '1 kHz sine: -20 dBFS, +6 dBFS at 0.55 s, -20 at 1.05 s, +12 at 2.05 s, -20 at 2.35 s (attack, release, look-ahead)',
    feeds: (frames, r) => [sineLevels(frames, r, 1000, segs)], events: []
  });
}
// D. the whole engine.js graph through AudioEngine's API, loud enough to compress
for (const rate of [48000, 44100]) {
  CASES.push({
    name: `f${rate === 48000 ? 48 : 44}_full_chain`, kind: 'engine', rate, seconds: 4.0, decks: [0, 1, 2],
    inputDesc: 'deck 0: music-like 110 Hz x 0.5 (seed 0xABCDEF); deck 1: music-like 87.3 Hz x 0.45 (seed 0x13579B); deck 2: noise +-0.3',
    feeds: (frames, r) => [musicLike(frames, r, 0xabcdef, 110, 0.5), musicLike(frames, r, 0x13579b, 87.3, 0.45),
      [noise(frames, 0x2468ace, 0.3), noise(frames, 0x1357bdf, 0.3)]],
    events: [
      [0.25, 'engine.setDeckEq', [0, 'low', -1]], [0.25, 'engine.setDeckEq', [1, 'high', 1]],
      [0.5, 'engine.setDeckTrim', [1, 0.5]], [0.5, 'engine.setDeckVolume', [0, 1]],
      [0.75, 'engine.setCrossfader', [0.25]],
      [1.0, 'engine.setDeckColor', [0, -0.5]],
      [1.25, 'engine.setMasterVolume', [1]],
      [1.5, 'engine.setDeckEq', [0, 'low', 0.5]], [1.5, 'engine.setDeckEq', [2, 'mid', -0.6]],
      [1.75, 'engine.setXfSide', [2, 'B']],
      [2.0, 'engine.setCrossfader', [0.9]],
      [2.25, 'engine.setMasterFilter', [0.35]],
      [2.5, 'engine.setDeckColor', [0, 0.3]], [2.5, 'engine.setDeckVolume', [2, 0.5]],
      [2.75, 'engine.setMasterFilter', [-0.6]],
      [3.0, 'engine.setDeckTrim', [0, -0.5]], [3.0, 'engine.setCrossfader', [0.5]],
      [3.25, 'engine.setMasterFilter', [0]], [3.25, 'engine.setDeckColor', [0, 0]],
      [3.5, 'engine.setMasterVolume', [0.9]]
    ]
  });
}
// E. FX sends / returns / pad sends / master FX send (identity units, no dry cut),
//    then the dry cut and the master dry compensation (syncLock when the wets are settled)
const threeDecks = (frames, r) => [musicLike(frames, r, 0xabcdef, 110, 0.3), musicLike(frames, r, 0x13579b, 87.3, 0.3),
  [noise(frames, 0x2468ace, 0.2), noise(frames, 0x1357bdf, 0.2)]];
for (const rate of [48000, 44100]) {
  const tag = rate === 48000 ? 48 : 44;
  CASES.push({
    name: `x${tag}_fx_paths`, kind: 'engine', rate, seconds: 4.5, decks: [0, 1, 2], identityFx: true, noDryCut: true,
    inputDesc: 'decks 0 / 1: music-like x 0.3; deck 2: noise +-0.2',
    feeds: threeDecks,
    events: [
      [0.25, 'fx.setEnabled', [0, true]], [0.25, 'fx.setLevel', [0, 0.7]],
      [0.5, 'engine.updateFxSends', []],
      [1.0, 'engine.setMasterVolume', [0.6]],
      [1.5, 'engine.setFxAssign', [1, 0, true]], [1.5, 'fx.setEnabled', [1, true]], [1.5, 'fx.setLevel', [1, 0.5]],
      [1.5, 'engine.updateFxSends', []],
      [2.0, 'engine.setPadFx', [2, { type: 'delay', beats: 1, level: 0.8 }]],
      [2.5, 'engine.setPadFx', [2, null]],
      [2.75, 'engine.ensureMasterFx', []], [2.75, 'fx.setType', ['master', 'echo']], [2.75, 'fx.setLevel', ['master', 0.5]],
      [2.75, 'fx.setEnabled', ['master', true]],
      [3.25, 'fx.setLevel', [0, 0.2]], [3.25, 'engine.setCrossfader', [0.8]],
      [3.75, 'fx.setEnabled', [1, false]], [3.75, 'engine.updateFxSends', []],
      // re-enabled: its sends were frozen at 1 (input disconnected) and resume there
      [4.0, 'fx.setEnabled', [1, true]], [4.0, 'engine.updateFxSends', []],
      [4.2, 'engine.setPadFx', [2, { type: 'delay', beats: 1, level: 0.8 }]]
    ]
  });
  CASES.push({
    name: `x${tag}_dry_cut`, kind: 'engine', rate, seconds: 4.5, decks: [0, 1, 2], identityFx: true,
    inputDesc: 'decks 0 / 1: music-like x 0.3; deck 2: noise +-0.2',
    notes: 'syncLock is called right after each change that moves a dry target, while every wet involved is settled (the native mixer re-evaluates the dry cut every block, engine.js every animation frame)',
    feeds: threeDecks,
    events: [
      [0.25, 'fx.setType', [0, 'flanger']], [0.25, 'fx.setLevel', [0, 0.8]],
      [0.75, 'fx.setEnabled', [0, true]], [0.75, 'engine.updateFxSends', []], [0.75, 'engine.syncLock', []],
      [1.25, 'fx.setType', [1, 'trans']], [1.25, 'fx.setLevel', [1, 0.5]],
      [1.75, 'engine.setFxAssign', [1, 0, true]], [1.75, 'fx.setEnabled', [1, true]], [1.75, 'engine.updateFxSends', []],
      [1.75, 'engine.syncLock', []],
      [2.25, 'engine.setPadFx', [2, { type: 'echo', beats: 1, level: 0.7 }]], [2.25, 'engine.setPadDryHold', [2, 0.3]],
      [2.25, 'engine.syncLock', []],
      [2.75, 'engine.setPadFx', [2, null]], [2.75, 'engine.syncLock', []],
      [3.0, 'engine.ensureMasterFx', []], [3.0, 'fx.setType', ['master', 'reverb']], [3.0, 'fx.setLevel', ['master', 0.6]],
      [3.5, 'fx.setEnabled', ['master', true]], [3.5, 'engine.syncLock', []],
      [4.0, 'fx.setEnabled', [1, false]], [4.0, 'engine.updateFxSends', []], [4.0, 'engine.syncLock', []]
    ]
  });
  // F. Color FX sends: |knob| x colorWet 0.85 -> fxReturn (identity bus), type switches, on / off
  CASES.push({
    name: `c${tag}_color_sends`, kind: 'engine', rate, seconds: 4.5, decks: [0, 1], identityColor: true,
    inputDesc: 'decks 0 / 1: music-like x 0.3',
    feeds: (frames, r) => threeDecks(frames, r).slice(0, 2),
    events: [
      [0.25, 'engine.setColorType', ['dubecho']],
      [0.5, 'engine.setDeckColor', [0, 0.6]],
      [0.75, 'engine.setDeckColor', [1, -0.35]],
      [1.25, 'engine.setMasterVolume', [0.5]],
      [1.75, 'engine.setColorType', ['reverb']],
      [2.25, 'engine.setColorEnabled', [false]],
      [2.75, 'engine.setColorEnabled', [true]],
      [3.25, 'engine.setColorType', ['filter']],
      [3.75, 'engine.setDeckColor', [0, -0.8]],
      [4.0, 'engine.setColorType', ['crush']]
    ]
  });
}

// ---------------------------------------------------------------------------
async function renderCase(c) {
  const rate = c.rate;
  const frames = gridFrame(c.seconds, rate);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate: rate });
  const feeds = c.feeds(frames, rate);
  const opts = { identityFx: !!c.identityFx, identityColor: !!c.identityColor };
  let run;  // (call, args) -> void
  if (c.kind === 'strip') {
    const deck = new mod.Deck(ctx, ctx.destination, 0);
    playInto(ctx, feeds[0], deck.trim);
    run = (call, args) => {
      const m = call.replace('deck.', '');
      if (!['setEq', 'setFilter', 'setTrim', 'setVolume'].includes(m)) throw new Error(`unknown call ${call}`);
      deck[m](...args);
    };
  } else {
    const engine = makeEngine(ctx);
    if (c.kind === 'master') {
      playInto(ctx, feeds[0], engine.masterGain);
    } else if (c.kind === 'limiter') {
      playInto(ctx, feeds[0], engine.limiter);
    } else {
      if (opts.identityFx) engine.fx.forEach((u) => identityUnit(ctx, u));
      if (opts.identityColor) identityColor(ctx, engine);
      feeds.forEach((f, i) => playInto(ctx, f, engine.decks[c.decks[i]].trim));
    }
    run = (call, args) => engineCall(ctx, engine, opts, call, args);
  }
  const events = c.events.map(([sec, call, args]) => ({ frame: sec === 0 ? 0 : gridFrame(sec, rate), call, args }));
  const byFrame = new Map();
  for (const e of events) {
    if (!byFrame.has(e.frame)) byFrame.set(e.frame, []);
    byFrame.get(e.frame).push(e);
  }
  for (const [frame, list] of byFrame) {
    if (frame === 0) list.forEach((e) => run(e.call, e.args));
    else ctx.suspend(frame / rate).then(() => {
      list.forEach((e) => run(e.call, e.args));
      ctx.resume();
    });
  }
  const out = await ctx.startRendering();
  const chans = [];
  for (const [L, R] of feeds) chans.push(L, R);
  writeWav(path.join(OUT, `${c.name}.input.wav`), chans, rate);
  writeWav(path.join(OUT, `${c.name}.wav`), [out.getChannelData(0), out.getChannelData(1)], rate);
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = out.getChannelData(ch);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  const meta = {
    suite: 'mixer',
    case: c.name,
    kind: c.kind,
    sampleRate: rate,
    channels: 2,
    frames,
    decks: c.kind === 'engine' ? c.decks : [0],
    identityFx: opts.identityFx,
    identityColor: opts.identityColor,
    noDryCut: !!c.noDryCut,
    freq: c.freq || 0,
    segments: (c.segments || []).map(([sec, amp]) => ({ frame: Math.round(sec * rate), amp })),
    events: events.map((e) => ({ frame: e.frame, time: e.frame / rate, call: e.call, args: e.args })),
    input: `${c.name}.input.wav`,
    inputDesc: c.inputDesc || '',
    notes: c.notes || '',
    peak,
    generator: 'native/engine/tests/mixer/goldens/make_mixer_goldens.js',
    chromium: navigator.userAgent,
    electron: process.versions.electron
  };
  fs.writeFileSync(path.join(OUT, `${c.name}.json`), JSON.stringify(meta, null, 1));
  return { frames, peak };
}

(async () => {
  try {
    mod = await import(pathToFileURL(path.join(ROOT, 'src', 'js', 'engine.js')).href);
    const names = [];
    for (const c of CASES) {
      if (ONLY && !c.name.includes(ONLY)) continue;
      const t0 = performance.now();
      const r = await renderCase(c);
      names.push(c.name);
      log(`  ${c.name}: ${r.frames} frames at ${c.rate} Hz, peak ${r.peak.toFixed(3)}, ${(performance.now() - t0).toFixed(0)} ms`);
    }
    if (!ONLY) {
      fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
        suite: 'mixer',
        generator: 'native/engine/tests/mixer/goldens/make_mixer_goldens.js',
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        cases: names
      }, null, 1));
    }
    ipcRenderer.send('done', { ok: true, cases: names.length });
  } catch (e) {
    ipcRenderer.send('done', { ok: false, error: String((e && e.stack) || e) });
  }
})();
